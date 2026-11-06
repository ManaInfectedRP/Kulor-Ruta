namespace Ruta.Core;

/// <summary>
/// Instant replay. Frames are encoded all the time into a ring of short MPEG-TS files on disk; RAM use
/// stays flat however long the buffer is. Saving joins the newest finished segments into one file.
/// </summary>
public sealed class ReplayBuffer : IDisposable
{
    public const int SegmentSeconds = 2;

    private readonly EncoderSession _session;
    private readonly string _folder;
    private readonly int _seconds;
    private readonly DesktopCapture _capture;

    public ReplayBuffer(DesktopCapture capture, EncodeSpec template, int seconds)
    {
        _capture = capture;
        _seconds = seconds;
        _folder = Path.Combine(Path.GetTempPath(), "Ruta", $"replay-{Environment.ProcessId}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(_folder);

        // Two spare segments: one is being written and cannot be read, one covers the rounding.
        int count = seconds / SegmentSeconds + 3;
        _session = new EncoderSession(template with
        {
            OutputPath = Path.Combine(_folder, "seg%05d.ts"),
            SegmentCount = count,
            SegmentSeconds = SegmentSeconds,
        });
    }

    public long Overflows => _session.Overflows;
    public bool Failed => _session.Failed;

    public void Start()
    {
        try
        {
            _session.Start();
        }
        catch
        {
            Dispose();
            throw;
        }
        _session.Attach(_capture);
    }

    /// <summary>Removes buffers left behind by a crashed run. The folder name carries the process id.</summary>
    public static void SweepStaleFolders()
    {
        string root = Path.Combine(Path.GetTempPath(), "Ruta");
        if (!Directory.Exists(root)) return;
        foreach (string folder in Directory.GetDirectories(root, "replay-*"))
        {
            string[] parts = Path.GetFileName(folder).Split('-');
            if (parts.Length > 1 && int.TryParse(parts[1], out int pid) && IsRunning(pid)) continue;
            try { Directory.Delete(folder, recursive: true); }
            catch (IOException) { /* still in use: the next start gets it */ }
        }
    }

    private static bool IsRunning(int pid)
    {
        try
        {
            using var process = System.Diagnostics.Process.GetProcessById(pid);
            return process.ProcessName.Equals("Ruta", StringComparison.OrdinalIgnoreCase);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }

    /// <summary>Writes the last N seconds to destination. Returns false if there is nothing to save yet.</summary>
    public bool Save(string destination)
    {
        var finished = new DirectoryInfo(_folder).GetFiles("seg*.ts")
            .OrderBy(f => f.LastWriteTimeUtc)
            .SkipLast(1) // the newest file is still open in ffmpeg
            .Where(f => f.Length > 0)
            .ToList();
        if (finished.Count == 0) return false;

        int wanted = (int)Math.Ceiling(_seconds / (double)SegmentSeconds);
        var chosen = finished.TakeLast(wanted).ToList();

        // MPEG-TS can be joined byte by byte, timestamps carry straight across the seams.
        string joined = Path.Combine(_folder, $"joined-{Guid.NewGuid():N}.tmp.ts");
        try
        {
            using (var output = File.Create(joined))
            {
                foreach (var file in chosen)
                {
                    using var input = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
                    input.CopyTo(output);
                }
            }

            string? error = null;
            int code = Ffmpeg.Run(
                ["-hide_banner", "-loglevel", "error", "-y", "-i", joined, "-map", "0", "-c", "copy",
                 "-movflags", "+faststart", destination],
                TimeSpan.FromSeconds(60), e => error = e);
            if (code != 0) throw new IOException($"Kunde inte spara replay: {error}");
            return true;
        }
        finally
        {
            File.Delete(joined);
        }
    }

    public void Stop()
    {
        _session.Stop(_capture);
    }

    public void Dispose()
    {
        _session.Dispose();
        try { Directory.Delete(_folder, recursive: true); }
        catch (IOException e) { Log.Write($"Kunde inte städa replay-mappen: {e.Message}"); }
    }
}
