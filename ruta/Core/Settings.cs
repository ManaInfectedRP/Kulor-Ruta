using System.Text.Json;
using System.Text.Json.Serialization;

namespace Ruta.Core;

public enum OverlayCorner { TopLeft, TopRight, BottomLeft, BottomRight }

/// <summary>User settings, persisted as JSON in %APPDATA%\Ruta\settings.json.</summary>
public sealed class Settings
{
    // Capture
    public string MonitorDevice { get; set; } = "";
    public int Fps { get; set; } = 60;
    public bool CaptureCursor { get; set; } = true;

    // Encoding
    public string Encoder { get; set; } = "auto";
    public int Quality { get; set; } = 21;
    /// <summary>Output height in pixels, 0 keeps the monitor's native size.</summary>
    public int OutputHeight { get; set; } = 0;
    public string Container { get; set; } = "mp4";

    // Audio
    public bool RecordSystemAudio { get; set; } = true;
    public string SystemDeviceId { get; set; } = "";
    public double SystemVolume { get; set; } = 1.0;
    public bool RecordMicrophone { get; set; } = false;
    public string MicDeviceId { get; set; } = "";
    public double MicVolume { get; set; } = 1.0;
    /// <summary>True mixes both sources into one track, false keeps one track per source.</summary>
    public bool MixAudio { get; set; } = true;

    // Overlay
    public bool ShowOverlay { get; set; } = true;
    public OverlayCorner OverlayCorner { get; set; } = OverlayCorner.TopRight;
    public bool OverlayInRecording { get; set; } = false;

    // Instant replay
    public bool ReplayEnabled { get; set; } = false;
    public int ReplaySeconds { get; set; } = 30;

    // Screenshots
    public string ScreenshotFormat { get; set; } = "png";

    // Output
    public string OutputFolder { get; set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.MyVideos), "Ruta");

    // Hotkeys, stored as System.Windows.Forms.Keys values
    public int HotkeyRecord { get; set; } = (int)Keys.F9;
    public int HotkeyScreenshot { get; set; } = (int)Keys.F10;
    public int HotkeyBenchmark { get; set; } = (int)Keys.F11;
    public int HotkeyReplay { get; set; } = (int)Keys.F8;
    public int HotkeyOverlay { get; set; } = (int)Keys.F7;

    [JsonIgnore]
    public string ScreenshotFolder => Path.Combine(OutputFolder, "Skärmdumpar");
    [JsonIgnore]
    public string BenchmarkFolder => Path.Combine(OutputFolder, "Benchmarks");

    private static readonly JsonSerializerOptions Options = new() { WriteIndented = true };

    public static string FilePath { get; set; } =
        Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Ruta", "settings.json");

    public static Settings Load()
    {
        try
        {
            if (File.Exists(FilePath))
                return JsonSerializer.Deserialize<Settings>(File.ReadAllText(FilePath), Options) ?? new Settings();
        }
        catch (Exception e) when (e is JsonException or IOException)
        {
            // A damaged settings file must not stop the app from starting.
            Log.Write($"Kunde inte läsa inställningarna, använder standardvärden: {e.Message}");
        }
        return new Settings();
    }

    public void Save()
    {
        Directory.CreateDirectory(Path.GetDirectoryName(FilePath)!);
        File.WriteAllText(FilePath, JsonSerializer.Serialize(this, Options));
    }
}

/// <summary>Small process-wide log that the UI can subscribe to.</summary>
public static class Log
{
    private static readonly List<string> Recent = [];

    public static event Action<string>? Line;

    public static void Write(string message)
    {
        var line = $"{DateTime.Now:HH:mm:ss}  {message}";
        Console.WriteLine(line);
        lock (Recent)
        {
            Recent.Add(line);
            if (Recent.Count > 200) Recent.RemoveAt(0);
        }
        Line?.Invoke(line);
    }

    /// <summary>Lines written before the UI existed.</summary>
    public static string[] History()
    {
        lock (Recent) return [.. Recent];
    }
}
