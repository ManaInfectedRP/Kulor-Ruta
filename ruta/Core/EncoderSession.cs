using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO.Pipes;
using System.Text;

namespace Ruta.Core;

public sealed record AudioInput(AudioTap Tap, double Volume);

public sealed record EncodeSpec
{
    public required int Width { get; init; }
    public required int Height { get; init; }
    public required int Fps { get; init; }
    public required string Encoder { get; init; }
    public required int Quality { get; init; }
    public int OutputHeight { get; init; }
    public bool MixAudio { get; init; } = true;
    public IReadOnlyList<AudioInput> Audio { get; init; } = [];

    /// <summary>Output file, or a pattern containing %05d when SegmentCount is set.</summary>
    public required string OutputPath { get; init; }
    public int SegmentCount { get; init; }
    public int SegmentSeconds { get; init; } = 2;
}

/// <summary>
/// One running ffmpeg process fed through named pipes: a bounded frame queue with its own writer
/// thread, plus one unbounded PCM queue per audio source. A spike in the encoder never stalls capture.
/// </summary>
public sealed class EncoderSession : IFrameSink, IDisposable
{
    private const int PipeBuffer = 1 << 24;

    private readonly EncodeSpec _spec;
    private readonly string _pipeId = Guid.NewGuid().ToString("N")[..12];
    private readonly BlockingCollection<Frame> _frames;
    private readonly bool _nv12;
    private readonly List<AudioPump> _audio = [];
    private readonly StringBuilder _stderr = new();

    private NamedPipeServerStream? _videoPipe;
    private Thread? _videoThread;
    private Process? _process;
    private long _missed;
    private long _written;
    private long _overflows;
    private readonly CancellationTokenSource _cancel = new();
    private volatile bool _accepting;
    private volatile bool _failed;
    private volatile bool _stopping;

    public long FramesWritten => Interlocked.Read(ref _written);
    /// <summary>Ticks where the queue was full. Each one is repaired by repeating a frame.</summary>
    public long Overflows => Interlocked.Read(ref _overflows);
    public bool Failed => _failed;
    public string ErrorText { get { lock (_stderr) return _stderr.ToString().Trim(); } }

    /// <summary>Raised on a pool thread if ffmpeg dies while the session runs.</summary>
    public event Action? Failure;

    public EncoderSession(EncodeSpec spec)
    {
        _spec = spec;
        _nv12 = spec.Encoder != "ffv1";
        // Must span the encoder's startup, which is around 0.7 s for NVENC. Frames repeated on a still
        // screen share one buffer, so the memory is only spent when every queued frame really differs.
        _frames = new BlockingCollection<Frame>(spec.Fps * 3 / 2);
    }

    public void Start()
    {
        string videoPipeName = $"ruta_v_{_pipeId}";
        _videoPipe = new NamedPipeServerStream(videoPipeName, PipeDirection.Out, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 0, PipeBuffer);

        for (int i = 0; i < _spec.Audio.Count; i++)
            _audio.Add(new AudioPump(_spec.Audio[i].Tap, $"ruta_a{i}_{_pipeId}"));

        var psi = new ProcessStartInfo(Ffmpeg.Executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardInput = true,
        };
        foreach (var a in BuildArguments(_spec, $@"\\.\pipe\{videoPipeName}", _audio.Select(p => p.Path).ToList()))
            psi.ArgumentList.Add(a);

        _process = Process.Start(psi) ?? throw new InvalidOperationException("Kunde inte starta ffmpeg.");
        _process.ErrorDataReceived += (_, e) =>
        {
            if (string.IsNullOrWhiteSpace(e.Data)) return;
            lock (_stderr)
            {
                if (_stderr.Length > 8192) _stderr.Remove(0, 4096);
                _stderr.AppendLine(e.Data);
            }
        };
        _process.BeginErrorReadLine();

        _process.EnableRaisingEvents = true;
        _process.Exited += (_, _) => OnProcessExited();

        // ffmpeg reads a first packet from each input before it opens the next one, so waiting here
        // for every pipe would deadlock. Each writer thread connects on its own and data waits in
        // its queue, which also means both streams keep the same start instant.
        _accepting = true;
        _videoThread = new Thread(WriteVideo) { Name = "Ruta video writer", IsBackground = true, Priority = ThreadPriority.AboveNormal };
        _videoThread.Start();
        foreach (var pump in _audio) pump.Start(_cancel.Token);
    }

    private void OnProcessExited()
    {
        if (_stopping) return;
        _accepting = false;
        _cancel.Cancel();
        MarkFailed($"ffmpeg stannade oväntat. {ErrorText}");
        Failure?.Invoke();
    }

    /// <summary>Attaches audio and video in one step so both streams start on the same instant.</summary>
    public void Attach(DesktopCapture capture)
    {
        foreach (var pump in _audio) pump.Attach();
        capture.AddSink(this);
    }

    public void Detach(DesktopCapture capture)
    {
        capture.RemoveSink(this);
        foreach (var pump in _audio) pump.Detach();
    }

    public void Push(Frame frame)
    {
        if (!_accepting) return;
        frame.AddRef();
        if (!_frames.TryAdd(frame))
        {
            frame.Release();
            // The stream is constant frame rate: a lost tick would slide video against audio. Remember
            // it and let the writer repeat a frame when it catches up.
            Interlocked.Increment(ref _missed);
            Interlocked.Increment(ref _overflows);
        }
    }

    private void WriteVideo()
    {
        try
        {
            _videoPipe!.WaitForConnectionAsync(_cancel.Token).GetAwaiter().GetResult();
            foreach (var frame in _frames.GetConsumingEnumerable())
            {
                try
                {
                    if (!_failed)
                    {
                        WriteFrame(frame);
                        long repeats = Interlocked.Exchange(ref _missed, 0);
                        for (long i = 0; i < repeats && _accepting; i++) WriteFrame(frame);
                    }
                }
                finally
                {
                    frame.Release();
                }
            }
        }
        catch (OperationCanceledException)
        {
            // ffmpeg went away before connecting; OnProcessExited has already reported it.
        }
        catch (IOException e)
        {
            MarkFailed(e.Message);
        }
        finally
        {
            DrainFrames();
        }
    }

    private void DrainFrames()
    {
        while (_frames.TryTake(out var left)) left.Release();
    }

    private void WriteFrame(Frame frame)
    {
        try
        {
            byte[] data = _nv12 ? frame.Nv12() : frame.Data;
            _videoPipe!.Write(data, 0, data.Length);
            Interlocked.Increment(ref _written);
        }
        catch (Exception e) when (e is IOException or ObjectDisposedException)
        {
            MarkFailed(e.Message);
        }
    }

    private void MarkFailed(string reason)
    {
        if (_failed) return;
        _failed = true;
        Log.Write($"Kodningen avbröts: {reason}");
    }

    /// <summary>Stops feeding, lets ffmpeg finish the file and returns its exit code.</summary>
    public int Stop(DesktopCapture capture)
    {
        Detach(capture);
        _stopping = true;
        _accepting = false;
        _frames.CompleteAdding();
        if (_videoThread?.Join(TimeSpan.FromSeconds(10)) == false)
        {
            _cancel.Cancel();
            _videoThread.Join(TimeSpan.FromSeconds(2));
        }
        DrainFrames();
        foreach (var pump in _audio) pump.Stop();
        _videoPipe?.Dispose();

        if (_process is null) return -1;
        if (!_process.WaitForExit(TimeSpan.FromSeconds(30)))
        {
            Log.Write("ffmpeg stängde inte i tid och avbröts.");
            _process.Kill(entireProcessTree: true);
            return -1;
        }
        _process.WaitForExit(); // flushes the asynchronous stderr reader
        return _process.ExitCode;
    }

    public void Dispose()
    {
        _videoPipe?.Dispose();
        foreach (var pump in _audio) pump.Dispose();
        _process?.Dispose();
        _frames.Dispose();
        _cancel.Dispose();
    }

    internal static List<string> BuildArguments(EncodeSpec s, string videoPath, IReadOnlyList<string> audioPaths)
    {
        // Everything but FFV1 gets NV12 that the app already converted: swscale was the bottleneck
        // here, and with a raw NV12 input ffmpeg hands the frames straight to the encoder.
        bool lossless = s.Encoder == "ffv1";
        int width = lossless ? s.Width : s.Width & ~1;
        int height = lossless ? s.Height : s.Height & ~1;

        var a = new List<string>
        {
            "-hide_banner", "-loglevel", "warning", "-nostats", "-nostdin", "-y",
            "-thread_queue_size", "256",
            "-probesize", "32", "-analyzeduration", "0",
            "-f", "rawvideo", "-pix_fmt", lossless ? "bgra" : "nv12",
            "-video_size", $"{width}x{height}", "-framerate", s.Fps.ToString(),
        };
        if (!lossless)
            a.AddRange(["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]);
        a.AddRange(["-i", videoPath]);

        for (int i = 0; i < s.Audio.Count; i++)
        {
            var format = s.Audio[i].Tap.Format;
            // Everything about raw input is already known. Left at its default, ffmpeg would spend five
            // seconds analysing each stream before it reads a single video frame.
            a.AddRange(["-thread_queue_size", "4096", "-probesize", "32", "-analyzeduration", "0", "-f", s.Audio[i].Tap.FfmpegSampleFormat,
                "-ar", format.SampleRate.ToString(), "-ac", format.Channels.ToString(), "-i", audioPaths[i]]);
        }

        var graph = new List<string>();
        var maps = new List<string>();
        if (lossless)
        {
            graph.Add("[0:v]format=bgr0[v]");
            maps.AddRange(["-map", "[v]"]);
        }
        else if (s.OutputHeight > 0 && s.OutputHeight < s.Height)
        {
            graph.Add($"[0:v]scale=-2:{s.OutputHeight}:flags=bicubic[v]");
            maps.AddRange(["-map", "[v]"]);
        }
        else
        {
            maps.AddRange(["-map", "0:v"]);
        }

        for (int i = 0; i < s.Audio.Count; i++)
        {
            string volume = s.Audio[i].Volume.ToString("0.###", System.Globalization.CultureInfo.InvariantCulture);
            graph.Add($"[{i + 1}:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,volume={volume}[a{i}]");
        }
        if (s.Audio.Count > 1 && s.MixAudio)
        {
            graph.Add($"{string.Concat(Enumerable.Range(0, s.Audio.Count).Select(i => $"[a{i}]"))}amix=inputs={s.Audio.Count}:normalize=0:duration=longest[mix]");
            maps.AddRange(["-map", "[mix]"]);
        }
        else
        {
            for (int i = 0; i < s.Audio.Count; i++) maps.AddRange(["-map", $"[a{i}]"]);
        }

        if (graph.Count > 0)
            a.AddRange(["-filter_complex", string.Join(';', graph)]);
        a.AddRange(maps);

        int keyframeInterval = s.SegmentCount > 0 ? s.Fps * s.SegmentSeconds : s.Fps * 2;
        a.AddRange(Ffmpeg.VideoArgs(s.Encoder, s.Quality, keyframeInterval));
        if (!lossless)
            a.AddRange(["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"]);
        if (s.Audio.Count > 0)
            a.AddRange(["-c:a", "aac", "-b:a", "192k"]);

        if (s.SegmentCount > 0)
        {
            a.AddRange(["-f", "segment", "-segment_time", s.SegmentSeconds.ToString(), "-segment_wrap", s.SegmentCount.ToString(),
                "-segment_format", "mpegts", "-reset_timestamps", "0"]);
        }
        a.Add(s.OutputPath);
        return a;
    }

    /// <summary>Moves PCM from the WASAPI thread to one ffmpeg pipe.</summary>
    private sealed class AudioPump(AudioTap tap, string pipeName) : IAudioSink, IDisposable
    {
        private readonly NamedPipeServerStream _pipe = new(pipeName, PipeDirection.Out, 1, PipeTransmissionMode.Byte,
            PipeOptions.Asynchronous, 0, 1 << 20);
        private readonly BlockingCollection<byte[]> _queue = new();
        private Thread? _thread;

        public string Path => $@"\\.\pipe\{pipeName}";

        public void Attach() => tap.Subscribe(this);
        public void Detach() => tap.Unsubscribe(this);

        public void Start(CancellationToken cancel)
        {
            _thread = new Thread(() => Pump(cancel)) { Name = "Ruta audio writer", IsBackground = true, Priority = ThreadPriority.AboveNormal };
            _thread.Start();
        }

        public void Write(byte[] buffer, int count)
        {
            if (_queue.IsAddingCompleted) return;
            var copy = new byte[count];
            Buffer.BlockCopy(buffer, 0, copy, 0, count);
            _queue.TryAdd(copy);
        }

        private void Pump(CancellationToken cancel)
        {
            try
            {
                _pipe.WaitForConnectionAsync(cancel).GetAwaiter().GetResult();
                foreach (var chunk in _queue.GetConsumingEnumerable(cancel))
                    _pipe.Write(chunk, 0, chunk.Length);
            }
            catch (OperationCanceledException)
            {
                // The session ended before ffmpeg got this far.
            }
            catch (IOException e)
            {
                Log.Write($"Ljudröret stängdes: {e.Message}");
            }
        }

        public void Stop()
        {
            _queue.CompleteAdding();
            _thread?.Join(TimeSpan.FromSeconds(5));
            _pipe.Dispose();
        }

        public void Dispose()
        {
            _pipe.Dispose();
            _queue.Dispose();
        }
    }
}
