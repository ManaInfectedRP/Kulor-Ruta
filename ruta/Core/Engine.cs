using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using NAudio.CoreAudioApi;

namespace Ruta.Core;

/// <summary>Owns capture, audio, recording, replay and benchmark. Everything the UI and hotkeys call.</summary>
public sealed class Engine : IDisposable
{
    private readonly Lock _gate = new();
    private readonly Dictionary<string, AudioTap> _taps = [];

    private DesktopCapture? _capture;
    private EncoderSession? _recording;
    private string _recordingPath = "";
    private DateTime _recordingStarted;
    private ReplayBuffer? _replay;
    private Benchmark? _benchmark;

    public Settings Settings { get; }
    public IReadOnlyList<VideoEncoderDef> Encoders { get; private set; } = [];

    public bool IsRecording => _recording is not null;
    public bool IsReplayActive => _replay is not null;
    public bool IsBenchmarking => _benchmark is not null;
    public int CurrentFps => _capture?.CurrentFps ?? 0;
    public TimeSpan RecordingTime => IsRecording ? DateTime.UtcNow - _recordingStarted : TimeSpan.Zero;
    public TimeSpan BenchmarkTime => _benchmark?.Elapsed ?? TimeSpan.Zero;
    public long RecordingOverflows => _recording?.Overflows ?? 0;
    public long RecordingFrames => _recording?.FramesWritten ?? 0;
    public long ReplayOverflows => _replay?.Overflows ?? 0;
    public string RecordingPath => _recordingPath;
    public string ActiveEncoder { get; private set; } = "";

    /// <summary>Raised on a background thread whenever a state shown in the UI flips.</summary>
    public event Action? StateChanged;

    public Engine(Settings settings) => Settings = settings;

    [DllImport("winmm.dll")] private static extern uint timeBeginPeriod(uint period);
    [DllImport("winmm.dll")] private static extern uint timeEndPeriod(uint period);

    public void Start()
    {
        timeBeginPeriod(1);
        ReplayBuffer.SweepStaleFolders();
        Encoders = Ffmpeg.ProbeEncoders();
        ActiveEncoder = ResolveEncoder();
        Log.Write($"Encoders som fungerar här: {string.Join(", ", Encoders.Select(e => e.Id))}");

        _capture = new DesktopCapture(Settings.MonitorDevice, Settings.Fps, Settings.CaptureCursor);
        _capture.SizeChanged += OnSizeChanged;
        _capture.Start();

        if (Settings.ReplayEnabled)
            StartReplay();
    }

    /// <summary>Applies settings that can change while idle. Returns false during an active recording.</summary>
    public bool ApplySettings()
    {
        lock (_gate)
        {
            if (IsRecording) return false;
            ActiveEncoder = ResolveEncoder();
            StopReplayCore();
            _capture?.Configure(Settings.MonitorDevice, Settings.Fps, Settings.CaptureCursor);
            CloseTaps();
            if (Settings.ReplayEnabled) StartReplayCore();
            return true;
        }
    }

    private string ResolveEncoder()
    {
        if (Settings.Encoder != "auto" && Encoders.Any(e => e.Id == Settings.Encoder))
            return Settings.Encoder;
        return Encoders.FirstOrDefault(e => e.HardwareAccelerated)?.Id
            ?? Encoders.FirstOrDefault()?.Id
            ?? throw new InvalidOperationException("Ingen videoencoder fungerar i ffmpeg.");
    }

    private void OnSizeChanged()
    {
        // Runs on the capture thread, and the sessions are built around one fixed frame size.
        Task.Run(() =>
        {
            Log.Write("Skärmläget ändrades, avslutar pågående inspelning.");
            StopRecording();
            lock (_gate)
            {
                StopReplayCore();
                if (Settings.ReplayEnabled) StartReplayCore();
            }
        });
    }

    private bool WaitForCaptureSize()
    {
        for (int i = 0; i < 400 && _capture!.Width == 0; i++) Thread.Sleep(10);
        return _capture!.Width != 0;
    }

    private EncodeSpec BuildSpec(string outputPath)
    {
        if (!WaitForCaptureSize())
            throw new InvalidOperationException("Skärmfångsten kom aldrig igång.");

        var audio = new List<AudioInput>();
        TryAddTap(audio, Settings.RecordSystemAudio, $"sys:{Settings.SystemDeviceId}",
            () => AudioTap.OpenLoopback(Settings.SystemDeviceId), Settings.SystemVolume);
        TryAddTap(audio, Settings.RecordMicrophone, $"mic:{Settings.MicDeviceId}",
            () => AudioTap.OpenMicrophone(Settings.MicDeviceId), Settings.MicVolume);

        return new EncodeSpec
        {
            Width = _capture!.Width,
            Height = _capture.Height,
            Fps = Settings.Fps,
            Encoder = ActiveEncoder,
            Quality = Settings.Quality,
            OutputHeight = Settings.OutputHeight,
            MixAudio = Settings.MixAudio,
            Audio = audio,
            OutputPath = outputPath,
        };
    }

    private void TryAddTap(List<AudioInput> audio, bool enabled, string key, Func<AudioTap> open, double volume)
    {
        if (!enabled) return;
        try
        {
            if (!_taps.TryGetValue(key, out var tap))
                _taps[key] = tap = open();
            audio.Add(new AudioInput(tap, volume));
        }
        catch (Exception e) when (e is COMException or InvalidOperationException or NotSupportedException or ArgumentException)
        {
            // A missing headset should cost the audio track, not the whole recording.
            Log.Write($"Ljudkällan kunde inte öppnas och hoppas över: {e.Message}");
        }
    }

    private void CloseTaps()
    {
        if (IsRecording || IsReplayActive) return;
        foreach (var tap in _taps.Values) tap.Dispose();
        _taps.Clear();
    }

    public void ToggleRecording()
    {
        if (IsRecording) StopRecording();
        else StartRecording();
    }

    public void StartRecording()
    {
        lock (_gate)
        {
            if (IsRecording || _capture is null) return;
            Directory.CreateDirectory(Settings.OutputFolder);
            _recordingPath = Path.Combine(Settings.OutputFolder, $"Ruta_{DateTime.Now:yyyy-MM-dd_HH-mm-ss}.mkv");

            var session = new EncoderSession(BuildSpec(_recordingPath));
            session.Failure += () => Task.Run(StopRecording);
            try
            {
                session.Start();
            }
            catch
            {
                session.Dispose();
                throw;
            }
            session.Attach(_capture);
            _recording = session;
            _recordingStarted = DateTime.UtcNow;
            Log.Write($"Inspelning startad med {ActiveEncoder}: {_recordingPath}");
        }
        StateChanged?.Invoke();
    }

    /// <summary>Stops recording and returns the finished file, or null when nothing usable came out.</summary>
    public string? StopRecording()
    {
        EncoderSession? session;
        string path;
        lock (_gate)
        {
            session = _recording;
            path = _recordingPath;
            _recording = null;
        }
        if (session is null) return null;
        StateChanged?.Invoke();

        int code = session.Stop(_capture!);
        string errors = session.ErrorText;
        long overflows = session.Overflows;
        session.Dispose();

        if (code != 0 || !File.Exists(path))
        {
            Log.Write($"ffmpeg avslutade med fel ({code}): {errors}");
            StateChanged?.Invoke();
            return null;
        }
        if (overflows > 0)
            Log.Write($"Encodern hann inte med {overflows} bildrutor, de fylldes med upprepningar.");

        string final = path;
        if (Settings.Container == "mp4" && ActiveEncoder != "ffv1")
            final = Remux(path);
        Log.Write($"Sparad: {final}");
        CloseTaps();
        StateChanged?.Invoke();
        return final;
    }

    /// <summary>MKV survives a crash mid-recording, MP4 plays everywhere. Record the first, deliver the second.</summary>
    private static string Remux(string mkv)
    {
        string mp4 = Path.ChangeExtension(mkv, ".mp4");
        string? error = null;
        int code = Ffmpeg.Run(["-hide_banner", "-loglevel", "error", "-y", "-i", mkv, "-map", "0", "-c", "copy",
            "-movflags", "+faststart", mp4], TimeSpan.FromMinutes(10), e => error = e);
        if (code != 0)
        {
            Log.Write($"Kunde inte göra om till MP4, behåller MKV: {error}");
            return mkv;
        }
        File.Delete(mkv);
        return mp4;
    }

    public void ToggleReplay()
    {
        lock (_gate)
        {
            Settings.ReplayEnabled = !IsReplayActive;
            if (IsReplayActive) StopReplayCore();
            else StartReplayCore();
        }
        Settings.Save();
        StateChanged?.Invoke();
    }

    private void StartReplay()
    {
        lock (_gate) StartReplayCore();
        StateChanged?.Invoke();
    }

    private void StartReplayCore()
    {
        if (_replay is not null || _capture is null) return;
        try
        {
            var replay = new ReplayBuffer(_capture, BuildSpec("unused"), Settings.ReplaySeconds);
            replay.Start();
            _replay = replay;
            Log.Write($"Instant replay igång: sparar de senaste {Settings.ReplaySeconds} sekunderna.");
        }
        catch (Exception e) when (e is InvalidOperationException or IOException)
        {
            Log.Write($"Instant replay kunde inte startas: {e.Message}");
        }
    }

    private void StopReplayCore()
    {
        var replay = _replay;
        _replay = null;
        if (replay is null) return;
        replay.Stop();
        replay.Dispose();
    }

    /// <summary>Saves the replay buffer. Returns the saved file or null.</summary>
    public string? SaveReplay()
    {
        var replay = _replay;
        if (replay is null)
        {
            Log.Write("Instant replay är inte igång.");
            return null;
        }
        Directory.CreateDirectory(Settings.OutputFolder);
        string path = Path.Combine(Settings.OutputFolder, $"Replay_{DateTime.Now:yyyy-MM-dd_HH-mm-ss}.mp4");
        if (!replay.Save(path))
        {
            Log.Write("Replay-bufferten är tom ännu, vänta ett par sekunder.");
            return null;
        }
        Log.Write($"Replay sparad: {path}");
        return path;
    }

    /// <summary>Starts or stops benchmarking. Returns the result when stopping.</summary>
    public BenchmarkResult? ToggleBenchmark()
    {
        if (_capture is null) return null;
        if (_benchmark is null)
        {
            var benchmark = new Benchmark();
            _capture.FrameTime += benchmark.Add;
            _benchmark = benchmark;
            Log.Write("Benchmark startad.");
            StateChanged?.Invoke();
            return null;
        }

        var running = _benchmark;
        _capture.FrameTime -= running.Add;
        _benchmark = null;
        var result = running.Finish(Settings.BenchmarkFolder);
        Log.Write($"Benchmark klar: {result.Frames} bilder på {result.Seconds:0.0} s, " +
                  $"min {result.Min:0} / max {result.Max:0} / snitt {result.Avg:0.0} / 1% låg {result.Low1Percent:0.0} FPS.");
        StateChanged?.Invoke();
        return result;
    }

    /// <summary>Takes a screenshot on the next tick. The returned task finishes when the file is on disk.</summary>
    public Task<string> TakeScreenshot()
    {
        var done = new TaskCompletionSource<string>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (_capture is null)
        {
            done.SetException(new InvalidOperationException("Skärmfångsten är inte igång."));
            return done.Task;
        }

        Directory.CreateDirectory(Settings.ScreenshotFolder);
        string format = Settings.ScreenshotFormat;
        string path = Path.Combine(Settings.ScreenshotFolder, $"Ruta_{DateTime.Now:yyyy-MM-dd_HH-mm-ss-fff}.{format}");

        _capture.RequestStill(frame => Task.Run(() =>
        {
            try
            {
                SaveImage(frame, path, format);
                Log.Write($"Skärmdump: {path}");
                done.SetResult(path);
            }
            catch (Exception e) when (e is IOException or ExternalException or UnauthorizedAccessException)
            {
                done.SetException(e);
            }
            finally
            {
                frame.Release();
            }
        }));
        return done.Task;
    }

    private static unsafe void SaveImage(Frame frame, string path, string format)
    {
        fixed (byte* p = frame.Data)
        {
            // PixelFormat32bppRGB: the alpha byte of a desktop frame carries no meaning.
            using var bitmap = new Bitmap(frame.Width, frame.Height, frame.Stride, PixelFormat.Format32bppRgb, (IntPtr)p);
            bitmap.Save(path, format switch
            {
                "jpg" => ImageFormat.Jpeg,
                "bmp" => ImageFormat.Bmp,
                _ => ImageFormat.Png,
            });
        }
    }

    public static List<AudioDevice> SystemDevices() => AudioTap.ListDevices(DataFlow.Render);
    public static List<AudioDevice> Microphones() => AudioTap.ListDevices(DataFlow.Capture);

    public void Dispose()
    {
        StopRecording();
        lock (_gate) StopReplayCore();
        if (_benchmark is not null) ToggleBenchmark();
        CloseTaps();
        _capture?.Dispose();
        _capture = null;
        timeEndPeriod(1);
    }
}
