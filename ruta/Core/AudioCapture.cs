using NAudio.CoreAudioApi;
using NAudio.Wave;

namespace Ruta.Core;

public sealed record AudioDevice(string Id, string Name)
{
    public override string ToString() => Name;
}

/// <summary>Consumes raw PCM from a tap. Called on the WASAPI thread, so it must not block.</summary>
public interface IAudioSink
{
    void Write(byte[] buffer, int count);
}

/// <summary>A running WASAPI device with any number of subscribers.</summary>
public sealed class AudioTap : IDisposable
{
    private readonly WasapiCapture _capture;
    private readonly WasapiOut? _keepAlive;
    private volatile IAudioSink[] _sinks = [];
    private readonly Lock _gate = new();

    public WaveFormat Format => _capture.WaveFormat;
    public string Name { get; }

    /// <summary>The ffmpeg raw sample format that matches this device.</summary>
    public string FfmpegSampleFormat
    {
        get
        {
            bool isFloat = Format.Encoding == WaveFormatEncoding.IeeeFloat
                || (Format is WaveFormatExtensible ext && ext.SubFormat == NAudio.Dmo.AudioMediaSubtypes.MEDIASUBTYPE_IEEE_FLOAT);
            return (Format.BitsPerSample, isFloat) switch
            {
                (32, true) => "f32le",
                (64, true) => "f64le",
                (16, _) => "s16le",
                (24, _) => "s24le",
                (32, _) => "s32le",
                _ => throw new NotSupportedException($"Ljudformatet stöds inte: {Format}"),
            };
        }
    }

    private AudioTap(WasapiCapture capture, WasapiOut? keepAlive, string name)
    {
        _capture = capture;
        _keepAlive = keepAlive;
        Name = name;
        _capture.DataAvailable += (_, e) =>
        {
            foreach (var sink in _sinks)
                sink.Write(e.Buffer, e.BytesRecorded);
        };
        _capture.RecordingStopped += (_, e) =>
        {
            if (e.Exception is not null) Log.Write($"Ljudkällan \"{Name}\" stannade: {e.Exception.Message}");
        };
        _capture.StartRecording();
        _keepAlive?.Play();
    }

    /// <summary>
    /// Loopback delivers nothing while the device is silent, which would break timing against the
    /// video. Rendering inaudible silence to the same device keeps the stream running.
    /// </summary>
    public static AudioTap OpenLoopback(string deviceId)
    {
        using var enumerator = new MMDeviceEnumerator();
        var device = deviceId.Length > 0
            ? enumerator.GetDevice(deviceId)
            : enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);

        var keepAlive = new WasapiOut(device, AudioClientShareMode.Shared, true, 100);
        keepAlive.Init(new SilenceProvider(device.AudioClient.MixFormat));
        return new AudioTap(new WasapiLoopbackCapture(device), keepAlive, device.FriendlyName);
    }

    public static AudioTap OpenMicrophone(string deviceId)
    {
        using var enumerator = new MMDeviceEnumerator();
        var device = deviceId.Length > 0
            ? enumerator.GetDevice(deviceId)
            : enumerator.GetDefaultAudioEndpoint(DataFlow.Capture, Role.Communications);
        return new AudioTap(new WasapiCapture(device), null, device.FriendlyName);
    }

    public static List<AudioDevice> ListDevices(DataFlow flow)
    {
        using var enumerator = new MMDeviceEnumerator();
        return enumerator.EnumerateAudioEndPoints(flow, DeviceState.Active)
            .Select(d => new AudioDevice(d.ID, d.FriendlyName))
            .ToList();
    }

    public void Subscribe(IAudioSink sink)
    {
        lock (_gate) _sinks = [.. _sinks, sink];
    }

    public void Unsubscribe(IAudioSink sink)
    {
        lock (_gate) _sinks = _sinks.Where(s => s != sink).ToArray();
    }

    public void Dispose()
    {
        _capture.StopRecording();
        _keepAlive?.Stop();
        _keepAlive?.Dispose();
        _capture.Dispose();
    }
}
