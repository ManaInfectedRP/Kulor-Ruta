using System.Drawing.Drawing2D;
using System.Drawing.Text;
using System.Runtime.InteropServices;
using Ruta.Core;

namespace Ruta.UI;

/// <summary>
/// Click-through FPS display in a screen corner. It floats above windowed and borderless games;
/// exclusive fullscreen shuts every overlay out, Desktop Duplication still records those games.
/// </summary>
internal sealed class Overlay : Form
{
    private const int WsExTransparent = 0x20;
    private const int WsExLayered = 0x80000;
    private const int WsExToolWindow = 0x80;
    private const int WsExNoActivate = 0x8000000;
    private const uint WdaNone = 0;
    private const uint WdaExcludeFromCapture = 0x11;
    private static readonly Color Key = Color.FromArgb(1, 0, 1);

    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 250 };
    private readonly Font _font = new("Consolas", 26f, FontStyle.Bold, GraphicsUnit.Pixel);
    private readonly Font _small = new("Consolas", 15f, FontStyle.Bold, GraphicsUnit.Pixel);
    private readonly Engine _engine;

    private string _shown = "";
    private string _status = "";

    [DllImport("user32.dll")]
    private static extern bool SetWindowDisplayAffinity(IntPtr hwnd, uint affinity);

    public Overlay(Engine engine)
    {
        _engine = engine;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        TopMost = true;
        StartPosition = FormStartPosition.Manual;
        BackColor = Key;
        TransparencyKey = Key;
        Size = new Size(180, 64);
        DoubleBuffered = true;
        _timer.Tick += (_, _) => Refresh(force: false);
    }

    protected override bool ShowWithoutActivation => true;

    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.ExStyle |= WsExTransparent | WsExLayered | WsExToolWindow | WsExNoActivate;
            return cp;
        }
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        ApplyPlacement();
        _timer.Start();
    }

    public void ApplyPlacement()
    {
        var s = _engine.Settings;
        var screen = Screen.AllScreens.FirstOrDefault(x => x.DeviceName == s.MonitorDevice) ?? Screen.PrimaryScreen!;
        var area = screen.Bounds;
        const int margin = 12;
        Location = s.OverlayCorner switch
        {
            OverlayCorner.TopLeft => new Point(area.Left + margin, area.Top + margin),
            OverlayCorner.TopRight => new Point(area.Right - Width - margin, area.Top + margin),
            OverlayCorner.BottomLeft => new Point(area.Left + margin, area.Bottom - Height - margin),
            _ => new Point(area.Right - Width - margin, area.Bottom - Height - margin),
        };
        SetWindowDisplayAffinity(Handle, s.OverlayInRecording ? WdaNone : WdaExcludeFromCapture);
        Refresh(force: true);
    }

    private void Refresh(bool force)
    {
        string fps = _engine.CurrentFps.ToString();
        string status = _engine.IsRecording ? $"● REC {_engine.RecordingTime:mm\\:ss}"
            : _engine.IsBenchmarking ? $"BENCH {_engine.BenchmarkTime:mm\\:ss}"
            : _engine.IsReplayActive ? "REPLAY" : "";
        if (!force && fps == _shown && status == _status) return;
        _shown = fps;
        _status = status;
        Invalidate();
    }

    protected override void OnPaint(PaintEventArgs e)
    {
        // Antialiased edges would blend with the colour key, so glyphs are drawn hard edged.
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.None;
        g.TextRenderingHint = TextRenderingHint.SingleBitPerPixelGridFit;

        bool right = _engine.Settings.OverlayCorner is OverlayCorner.TopRight or OverlayCorner.BottomRight;
        using var format = new StringFormat { Alignment = right ? StringAlignment.Far : StringAlignment.Near };
        var box = new RectangleF(0, 0, Width, 34);
        DrawOutlined(g, _shown, _font, Color.Yellow, box, format);

        if (_status.Length > 0)
        {
            var color = _engine.IsRecording ? Color.FromArgb(255, 70, 70)
                : _engine.IsBenchmarking ? Color.FromArgb(90, 220, 255) : Color.LightGray;
            DrawOutlined(g, _status, _small, color, new RectangleF(0, 36, Width, 24), format);
        }
    }

    private static void DrawOutlined(Graphics g, string text, Font font, Color color, RectangleF box, StringFormat format)
    {
        using var outline = new SolidBrush(Color.Black);
        for (int dx = -2; dx <= 2; dx += 2)
            for (int dy = -2; dy <= 2; dy += 2)
                if (dx != 0 || dy != 0)
                    g.DrawString(text, font, outline, new RectangleF(box.X + dx, box.Y + dy, box.Width, box.Height), format);
        using var fill = new SolidBrush(color);
        g.DrawString(text, font, fill, box, format);
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _timer.Dispose();
            _font.Dispose();
            _small.Dispose();
        }
        base.Dispose(disposing);
    }
}
