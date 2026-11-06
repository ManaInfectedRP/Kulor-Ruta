using System.Diagnostics;
using System.Text.Json;
using Ruta.Core;
using Ruta.UI;

namespace Ruta;

internal static class Program
{
    [STAThread]
    private static int Main(string[] args)
    {
        ApplicationConfiguration.Initialize();
        Application.SetColorMode(SystemColorMode.Dark);

        if (args.Length >= 2 && args[0] == "--selftest")
            return SelfTest(args[1]);

        var settings = Settings.Load();
        using var engine = new Engine(settings);
        try
        {
            engine.Start();
        }
        catch (Exception e) when (e is FileNotFoundException or InvalidOperationException)
        {
            MessageBox.Show(e.Message, "Ruta", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
        Application.Run(new MainForm(engine));
        return 0;
    }

    /// <summary>
    /// Runs every feature for real against the desktop while a small animated window keeps the
    /// screen changing, and writes the files plus a JSON report to the given folder.
    /// </summary>
    private static int SelfTest(string folder)
    {
        Directory.CreateDirectory(folder);
        Settings.FilePath = Path.Combine(folder, "settings.json");
        var settings = new Settings
        {
            OutputFolder = folder,
            ReplayEnabled = true,
            ReplaySeconds = 6,
            RecordSystemAudio = true,
            RecordMicrophone = Environment.GetEnvironmentVariable("RUTA_TEST_MIC") == "1",
        };

        var report = new Dictionary<string, object?>();
        using var animation = new Form { Text = "Ruta selftest", Size = new Size(320, 200), TopMost = true, StartPosition = FormStartPosition.CenterScreen };
        var timer = new System.Windows.Forms.Timer { Interval = 15 };
        int hue = 0;
        timer.Tick += (_, _) =>
        {
            hue = (hue + 7) % 255;
            animation.BackColor = Color.FromArgb(hue, 255 - hue, hue / 2);
        };
        animation.Shown += async (_, _) =>
        {
            timer.Start();
            try
            {
                await Task.Run(async () =>
                {
                    using var engine = new Engine(settings);
                    engine.Start();
                    report["encoder"] = engine.ActiveEncoder;

                    await Task.Delay(9000); // fills the replay buffer past its 6 seconds
                    report["desktop_fps"] = engine.CurrentFps;

                    report["replay"] = engine.SaveReplay();
                    report["replay_overflows"] = engine.ReplayOverflows;
                    report["screenshot"] = await engine.TakeScreenshot();

                    engine.ToggleBenchmark();
                    var clock = Stopwatch.StartNew();
                    engine.StartRecording();
                    await Task.Delay(5000);
                    var bench = engine.ToggleBenchmark();
                    report["benchmark"] = bench;
                    report["overflows"] = engine.RecordingOverflows;
                    report["frames_written"] = engine.RecordingFrames;
                    report["recording"] = engine.StopRecording();
                    report["record_seconds"] = clock.Elapsed.TotalSeconds;

                    // Every other output path. A virtual microphone keeps real room sound out of the test.
                    var virtualMic = Engine.Microphones().FirstOrDefault(d =>
                        d.Name.Contains("virtual", StringComparison.OrdinalIgnoreCase) || d.Name.Contains("voicemod", StringComparison.OrdinalIgnoreCase));
                    settings.MicDeviceId = virtualMic?.Id ?? "";
                    settings.RecordMicrophone = virtualMic is not null;
                    report["virtual_mic"] = virtualMic?.Name;

                    var variants = new (string Encoder, int Height, string Container, bool Mix)[]
                    {
                        ("libx264", 720, "mp4", true),
                        ("hevc_nvenc", 0, "mkv", false),
                        ("ffv1", 0, "mkv", true),
                    };
                    foreach (var v in variants)
                    {
                        settings.Encoder = v.Encoder;
                        settings.OutputHeight = v.Height;
                        settings.Container = v.Container;
                        settings.MixAudio = v.Mix;
                        settings.ReplayEnabled = false;
                        engine.ApplySettings();
                        await Task.Delay(1100); // file names carry whole seconds
                        engine.StartRecording();
                        await Task.Delay(2500);
                        long overflows = engine.RecordingOverflows;
                        report[$"variant_{v.Encoder}"] = new { file = engine.StopRecording(), overflows };
                    }
                });
                report["ok"] = true;
            }
            catch (Exception e)
            {
                report["ok"] = false;
                report["error"] = e.ToString();
            }
            animation.Close();
        };
        Application.Run(animation);

        File.WriteAllText(Path.Combine(folder, "report.json"), JsonSerializer.Serialize(report, new JsonSerializerOptions { WriteIndented = true }));
        return report["ok"] is true ? 0 : 1;
    }
}
