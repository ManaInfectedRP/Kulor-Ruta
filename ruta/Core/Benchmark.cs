using System.Diagnostics;
using System.Globalization;
using System.Text;

namespace Ruta.Core;

public sealed record BenchmarkResult(int Frames, double Seconds, double Min, double Max, double Avg, double Low1Percent, string Folder);

/// <summary>Collects frame times and writes frametimes, per-second FPS and a min/max/avg summary as CSV.</summary>
public sealed class Benchmark
{
    private readonly List<double> _frameTimes = new(100_000);
    private readonly Stopwatch _clock = Stopwatch.StartNew();
    private readonly Lock _gate = new();

    public TimeSpan Elapsed => _clock.Elapsed;

    /// <summary>Called on the capture thread.</summary>
    public void Add(double seconds)
    {
        lock (_gate) _frameTimes.Add(seconds);
    }

    public BenchmarkResult Finish(string folder)
    {
        _clock.Stop();
        double[] times;
        lock (_gate) times = [.. _frameTimes];

        Directory.CreateDirectory(folder);
        string stamp = DateTime.Now.ToString("yyyy-MM-dd_HH-mm-ss");
        var inv = CultureInfo.InvariantCulture;

        var frametimes = new StringBuilder("frame,time_ms,frametime_ms\n");
        var perSecond = new List<int>();
        double total = 0;
        for (int i = 0; i < times.Length; i++)
        {
            total += times[i];
            frametimes.Append(i + 1).Append(',')
                .Append((total * 1000).ToString("0.###", inv)).Append(',')
                .Append((times[i] * 1000).ToString("0.###", inv)).Append('\n');
            int second = (int)total;
            while (perSecond.Count <= second) perSecond.Add(0);
            perSecond[second]++;
        }
        File.WriteAllText(Path.Combine(folder, $"{stamp}_frametimes.csv"), frametimes.ToString());

        // The last second is usually partial and would drag "min" down.
        var whole = perSecond.Count > 1 ? perSecond.Take(perSecond.Count - 1).ToList() : perSecond;
        var fps = new StringBuilder("second,fps\n");
        for (int i = 0; i < whole.Count; i++) fps.Append(i + 1).Append(',').Append(whole[i]).Append('\n');
        File.WriteAllText(Path.Combine(folder, $"{stamp}_fps.csv"), fps.ToString());

        double avg = total > 0 ? times.Length / total : 0;
        double min = whole.Count > 0 ? whole.Min() : 0;
        double max = whole.Count > 0 ? whole.Max() : 0;

        double low1 = 0;
        if (times.Length > 0)
        {
            var slowest = times.OrderDescending().Take(Math.Max(1, times.Length / 100)).ToArray();
            low1 = slowest.Length / slowest.Sum();
        }

        File.WriteAllText(Path.Combine(folder, $"{stamp}_minmaxavg.csv"),
            "frames,seconds,min_fps,max_fps,avg_fps,low_1pct_fps\n" +
            string.Create(inv, $"{times.Length},{total:0.###},{min:0.#},{max:0.#},{avg:0.#},{low1:0.#}\n"));

        return new BenchmarkResult(times.Length, total, min, max, avg, low1, folder);
    }
}
