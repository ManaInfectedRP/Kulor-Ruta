using System.Diagnostics;

namespace Ruta.Core;

public sealed record VideoEncoderDef(string Id, string Label, bool HardwareAccelerated, bool LosslessMkvOnly = false);

public static class Ffmpeg
{
    private static string? _path;

    /// <summary>Candidates in the order "Auto" prefers them.</summary>
    public static readonly VideoEncoderDef[] Known =
    [
        new("h264_nvenc", "H.264 (NVIDIA NVENC)", true),
        new("hevc_nvenc", "H.265 (NVIDIA NVENC)", true),
        new("h264_amf", "H.264 (AMD AMF)", true),
        new("hevc_amf", "H.265 (AMD AMF)", true),
        new("h264_qsv", "H.264 (Intel Quick Sync)", true),
        new("hevc_qsv", "H.265 (Intel Quick Sync)", true),
        new("libx264", "H.264 (x264, CPU)", false),
        new("ffv1", "FFV1 förlustfri (CPU, stora filer)", false, LosslessMkvOnly: true),
    ];

    /// <summary>Finds ffmpeg next to the exe or on PATH.</summary>
    public static string Executable => _path ??= Locate()
        ?? throw new FileNotFoundException("Hittar inte ffmpeg. Lägg ffmpeg.exe i PATH eller bredvid Ruta.exe.");

    private static string? Locate()
    {
        var local = Path.Combine(AppContext.BaseDirectory, "ffmpeg.exe");
        if (File.Exists(local)) return local;
        foreach (var dir in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(';', StringSplitOptions.RemoveEmptyEntries))
        {
            var candidate = Path.Combine(dir.Trim(), "ffmpeg.exe");
            if (File.Exists(candidate)) return candidate;
        }
        return null;
    }

    /// <summary>Encodes a few frames with each encoder; ffmpeg listing one does not mean the GPU can run it.</summary>
    public static List<VideoEncoderDef> ProbeEncoders()
    {
        var working = new List<VideoEncoderDef>();
        foreach (var enc in Known)
        {
            var args = new List<string>
            {
                "-hide_banner", "-loglevel", "error",
                "-f", "lavfi", "-i", "color=black:s=1280x720:r=30:d=0.1",
            };
            args.AddRange(VideoArgs(enc.Id, 23, 30));
            args.AddRange(["-f", "null", "-"]);
            if (Run(args, TimeSpan.FromSeconds(10)) == 0)
                working.Add(enc);
        }
        return working;
    }

    public static int Run(IEnumerable<string> args, TimeSpan timeout, Action<string>? onError = null)
    {
        var psi = new ProcessStartInfo(Executable)
        {
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardError = true,
            RedirectStandardOutput = true,
        };
        foreach (var a in args) psi.ArgumentList.Add(a);

        using var p = Process.Start(psi)!;
        var stdout = p.StandardOutput.ReadToEndAsync();
        var stderr = p.StandardError.ReadToEndAsync();
        if (!p.WaitForExit(timeout))
        {
            p.Kill(entireProcessTree: true);
            onError?.Invoke("ffmpeg svarade inte inom tidsgränsen.");
            return -1;
        }
        if (p.ExitCode != 0)
            onError?.Invoke(stderr.GetAwaiter().GetResult().Trim());
        _ = stdout;
        return p.ExitCode;
    }

    /// <summary>The encoder half of an ffmpeg command line. keyframeInterval is in frames.</summary>
    public static IEnumerable<string> VideoArgs(string encoder, int quality, int keyframeInterval)
    {
        string q = quality.ToString();
        string g = keyframeInterval.ToString();
        return encoder switch
        {
            "h264_nvenc" or "hevc_nvenc" =>
                ["-c:v", encoder, "-preset", "p4", "-rc", "vbr", "-cq", q, "-b:v", "0", "-bf", "0", "-g", g],
            "h264_amf" or "hevc_amf" =>
                ["-c:v", encoder, "-usage", "lowlatency", "-rc", "cqp", "-qp_i", q, "-qp_p", q, "-g", g],
            "h264_qsv" or "hevc_qsv" =>
                ["-c:v", encoder, "-preset", "veryfast", "-global_quality", q, "-g", g],
            "libx264" =>
                ["-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency", "-crf", q, "-g", g],
            "ffv1" =>
                ["-c:v", "ffv1", "-level", "3", "-g", "1", "-slices", "24", "-slicecrc", "0"],
            _ => throw new ArgumentException($"Okänd encoder: {encoder}", nameof(encoder)),
        };
    }
}
