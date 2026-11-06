using System.Diagnostics;
using NAudio.CoreAudioApi;
using Ruta.Core;

namespace Ruta.UI;

internal sealed class MainForm : Form
{
    private static readonly Color Panel = Color.FromArgb(30, 32, 36);
    private static readonly Color Accent = Color.FromArgb(255, 214, 10);
    private static readonly Color Muted = Color.FromArgb(150, 155, 165);
    private static readonly Color Red = Color.FromArgb(255, 80, 80);

    private readonly Engine _engine;
    private readonly Settings _s;
    private readonly System.Windows.Forms.Timer _timer = new() { Interval = 200 };
    // A slider fires for every step, and applying settings restarts the replay encoder.
    private readonly System.Windows.Forms.Timer _applyTimer = new() { Interval = 500 };

    private readonly Label _state = new() { AutoSize = true, Font = new Font("Segoe UI Semibold", 20f), ForeColor = Accent };
    private readonly Label _fps = new() { AutoSize = true, Font = new Font("Consolas", 30f, FontStyle.Bold), ForeColor = Accent, Anchor = AnchorStyles.Right };
    private readonly Label _detail = new() { AutoSize = true, ForeColor = Muted };
    private readonly Button _record = new() { Text = "Spela in", Height = 36, Dock = DockStyle.Fill };
    private readonly Button _shot = new() { Text = "Skärmdump", Height = 36, Dock = DockStyle.Fill };
    private readonly Button _replay = new() { Text = "Spara replay", Height = 36, Dock = DockStyle.Fill };
    private readonly Button _bench = new() { Text = "Benchmark", Height = 36, Dock = DockStyle.Fill };
    private readonly ListBox _log = new() { Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, IntegralHeight = false, HorizontalScrollbar = true };
    private readonly ComboBox _encoder = Combo();

    private Hotkeys? _hotkeys;
    private Overlay? _overlay;
    private bool _loading = true;

    public MainForm(Engine engine)
    {
        _engine = engine;
        _s = engine.Settings;
        Text = "Ruta";
        ClientSize = new Size(620, 780);
        MinimumSize = new Size(560, 640);
        StartPosition = FormStartPosition.CenterScreen;

        var root = new TableLayoutPanel { Dock = DockStyle.Fill, RowCount = 3, ColumnCount = 1, Padding = new Padding(14) };
        root.RowStyles.Add(new RowStyle(SizeType.AutoSize));
        root.RowStyles.Add(new RowStyle(SizeType.Percent, 100));
        root.RowStyles.Add(new RowStyle(SizeType.Absolute, 110));
        root.Controls.Add(BuildHeader(), 0, 0);
        root.Controls.Add(BuildSettings(), 0, 1);
        root.Controls.Add(_log, 0, 2);
        Controls.Add(root);

        _log.Items.AddRange(Log.History());
        Log.Line += OnLogLine;
        _engine.StateChanged += () => BeginInvokeSafe(UpdateStatus);
        _timer.Tick += (_, _) => UpdateStatus();
        _applyTimer.Tick += (_, _) => ApplyPending();
        _record.Click += (_, _) => GuardedInBackground(_engine.ToggleRecording);
        _shot.Click += (_, _) => Screenshot();
        _replay.Click += (_, _) => SaveOrToggleReplay();
        _bench.Click += (_, _) => GuardedInBackground(() => _engine.ToggleBenchmark());
    }

    protected override void OnLoad(EventArgs e)
    {
        base.OnLoad(e);
        _loading = false;
        _hotkeys = new Hotkeys(Handle);
        RegisterHotkeys();
        FillEncoders();
        SyncOverlay();
        _timer.Start();
    }

    private Control BuildHeader()
    {
        var top = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 2, RowCount = 3 };
        top.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        top.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));
        top.Controls.Add(_state, 0, 0);
        top.Controls.Add(_fps, 1, 0);
        top.SetRowSpan(_fps, 2);
        top.Controls.Add(_detail, 0, 1);

        var buttons = new TableLayoutPanel { Dock = DockStyle.Top, AutoSize = true, ColumnCount = 4, Margin = new Padding(0, 8, 0, 8) };
        for (int i = 0; i < 4; i++) buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 25));
        buttons.Controls.AddRange([_record, _shot, _replay, _bench]);
        top.Controls.Add(buttons, 0, 2);
        top.SetColumnSpan(buttons, 2);
        return top;
    }

    private Control BuildSettings()
    {
        var host = new Panel { Dock = DockStyle.Fill, AutoScroll = true, BackColor = Panel };
        var table = new TableLayoutPanel
        {
            Dock = DockStyle.Top,
            AutoSize = true,
            ColumnCount = 2,
            Padding = new Padding(12, 6, 24, 12),
            BackColor = Panel,
        };
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute, 170));
        table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));

        Section(table, "Video");
        var monitors = Combo();
        var monitorList = DesktopCapture.EnumerateMonitors();
        monitors.Items.AddRange([.. monitorList]);
        monitors.SelectedItem = monitorList.FirstOrDefault(m => m.Device == _s.MonitorDevice) ?? monitorList.FirstOrDefault();
        monitors.SelectedIndexChanged += (_, _) => Change(() => _s.MonitorDevice = ((MonitorInfo)monitors.SelectedItem!).Device);
        Row(table, "Skärm", monitors);

        Row(table, "Bildfrekvens", Choice([("30 FPS", 30), ("60 FPS", 60), ("120 FPS", 120), ("144 FPS", 144)], _s.Fps, v => _s.Fps = v));
        Row(table, "Encoder", _encoder);
        Row(table, "Kvalitet", Choice([("Högsta (större filer)", 17), ("Hög", 21), ("Balanserad", 25), ("Liten fil", 30)], _s.Quality, v => _s.Quality = v));
        Row(table, "Upplösning", Choice([("Skärmens egen", 0), ("Max 1440p", 1440), ("Max 1080p", 1080), ("Max 720p", 720)], _s.OutputHeight, v => _s.OutputHeight = v));
        Row(table, "Filformat", Choice([("MP4", "mp4"), ("MKV", "mkv")], _s.Container, v => _s.Container = v));
        Row(table, "", Check("Fånga muspekaren", _s.CaptureCursor, v => _s.CaptureCursor = v));

        Section(table, "Ljud");
        Row(table, "", Check("Spela in systemljud", _s.RecordSystemAudio, v => _s.RecordSystemAudio = v));
        Row(table, "Högtalare", Devices(DataFlow.Render, _s.SystemDeviceId, v => _s.SystemDeviceId = v));
        Row(table, "Volym systemljud", Volume(_s.SystemVolume, v => _s.SystemVolume = v));
        Row(table, "", Check("Spela in mikrofon", _s.RecordMicrophone, v => _s.RecordMicrophone = v));
        Row(table, "Mikrofon", Devices(DataFlow.Capture, _s.MicDeviceId, v => _s.MicDeviceId = v));
        Row(table, "Volym mikrofon", Volume(_s.MicVolume, v => _s.MicVolume = v));
        Row(table, "", Check("Mixa till ett ljudspår (annars ett spår per källa)", _s.MixAudio, v => _s.MixAudio = v));

        Section(table, "FPS-overlay");
        Row(table, "", Check("Visa overlay", _s.ShowOverlay, v => { _s.ShowOverlay = v; SyncOverlay(); }));
        Row(table, "Hörn", Choice([("Uppe till höger", OverlayCorner.TopRight), ("Uppe till vänster", OverlayCorner.TopLeft),
            ("Nere till höger", OverlayCorner.BottomRight), ("Nere till vänster", OverlayCorner.BottomLeft)],
            _s.OverlayCorner, v => { _s.OverlayCorner = v; SyncOverlay(); }));
        Row(table, "", Check("Ta med overlayen i inspelningar", _s.OverlayInRecording, v => { _s.OverlayInRecording = v; SyncOverlay(); }));

        Section(table, "Instant replay");
        Row(table, "", Check("Buffra alltid det senaste", _s.ReplayEnabled, v => _s.ReplayEnabled = v));
        Row(table, "Längd", Choice([("15 sekunder", 15), ("30 sekunder", 30), ("1 minut", 60), ("2 minuter", 120), ("5 minuter", 300)], _s.ReplaySeconds, v => _s.ReplaySeconds = v));

        Section(table, "Filer");
        Row(table, "Skärmdumpar som", Choice([("PNG", "png"), ("JPG", "jpg"), ("BMP", "bmp")], _s.ScreenshotFormat, v => _s.ScreenshotFormat = v));
        var folder = new TextBox { Text = _s.OutputFolder, Dock = DockStyle.Fill, ReadOnly = true };
        var pick = new Button { Text = "Välj mapp…", AutoSize = true };
        pick.Click += (_, _) =>
        {
            using var dialog = new FolderBrowserDialog { SelectedPath = _s.OutputFolder };
            if (dialog.ShowDialog(this) != DialogResult.OK) return;
            _s.OutputFolder = dialog.SelectedPath;
            folder.Text = dialog.SelectedPath;
            _s.Save();
        };
        var open = new Button { Text = "Öppna", AutoSize = true };
        open.Click += (_, _) =>
        {
            Directory.CreateDirectory(_s.OutputFolder);
            Process.Start(new ProcessStartInfo(_s.OutputFolder) { UseShellExecute = true });
        };
        var folderRow = new TableLayoutPanel { Dock = DockStyle.Fill, AutoSize = true, ColumnCount = 3, Margin = Padding.Empty };
        folderRow.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100));
        folderRow.Controls.AddRange([folder, pick, open]);
        Row(table, "Spara i", folderRow);

        Section(table, "Kortkommandon (klicka och tryck en tangent)");
        Row(table, "Starta/stoppa inspelning", Hotkey(() => _s.HotkeyRecord, v => _s.HotkeyRecord = v));
        Row(table, "Skärmdump", Hotkey(() => _s.HotkeyScreenshot, v => _s.HotkeyScreenshot = v));
        Row(table, "Benchmark", Hotkey(() => _s.HotkeyBenchmark, v => _s.HotkeyBenchmark = v));
        Row(table, "Spara replay", Hotkey(() => _s.HotkeyReplay, v => _s.HotkeyReplay = v));
        Row(table, "Visa/dölj overlay", Hotkey(() => _s.HotkeyOverlay, v => _s.HotkeyOverlay = v));

        host.Controls.Add(table);
        return host;
    }

    private static ComboBox Combo() => new() { DropDownStyle = ComboBoxStyle.DropDownList, Dock = DockStyle.Fill };

    private static void Section(TableLayoutPanel table, string title)
    {
        var label = new Label
        {
            Text = title,
            AutoSize = true,
            ForeColor = Accent,
            Font = new Font("Segoe UI Semibold", 10.5f),
            Margin = new Padding(0, 14, 0, 4),
        };
        table.Controls.Add(label);
        table.SetColumnSpan(label, 2);
    }

    private static void Row(TableLayoutPanel table, string label, Control control)
    {
        table.Controls.Add(new Label { Text = label, AutoSize = true, Anchor = AnchorStyles.Left, Margin = new Padding(0, 6, 0, 6) });
        control.Margin = new Padding(0, 3, 0, 3);
        table.Controls.Add(control);
    }

    private ComboBox Choice<T>((string Label, T Value)[] options, T current, Action<T> apply)
    {
        var combo = Combo();
        foreach (var option in options) combo.Items.Add(option.Label);
        int index = Array.FindIndex(options, o => EqualityComparer<T>.Default.Equals(o.Value, current));
        combo.SelectedIndex = index >= 0 ? index : 0;
        combo.SelectedIndexChanged += (_, _) => Change(() => apply(options[combo.SelectedIndex].Value));
        return combo;
    }

    private CheckBox Check(string text, bool current, Action<bool> apply)
    {
        var box = new CheckBox { Text = text, Checked = current, AutoSize = true };
        box.CheckedChanged += (_, _) => Change(() => apply(box.Checked));
        return box;
    }

    private ComboBox Devices(DataFlow flow, string current, Action<string> apply)
    {
        var devices = new List<AudioDevice> { new("", "Standardenhet") };
        devices.AddRange(flow == DataFlow.Render ? Engine.SystemDevices() : Engine.Microphones());
        var combo = Combo();
        combo.Items.AddRange([.. devices]);
        combo.SelectedItem = devices.FirstOrDefault(d => d.Id == current) ?? devices[0];
        combo.SelectedIndexChanged += (_, _) => Change(() => apply(((AudioDevice)combo.SelectedItem!).Id));
        return combo;
    }

    private TrackBar Volume(double current, Action<double> apply)
    {
        var bar = new TrackBar { Minimum = 0, Maximum = 200, TickFrequency = 25, Value = (int)Math.Clamp(current * 100, 0, 200), Dock = DockStyle.Fill, AutoSize = false, Height = 28 };
        bar.ValueChanged += (_, _) => Change(() => apply(bar.Value / 100.0));
        return bar;
    }

    private Button Hotkey(Func<int> get, Action<int> set)
    {
        var button = new Button { Text = KeyName(get()), Dock = DockStyle.Fill, Height = 28 };
        button.Click += (_, _) =>
        {
            button.Text = "Tryck en tangent…";
            _hotkeys?.Clear(); // otherwise the key being assigned would fire its old action
            button.Focus();
        };
        button.PreviewKeyDown += (_, e) => e.IsInputKey = true;
        button.KeyDown += (_, e) =>
        {
            if (e.KeyCode is Keys.ControlKey or Keys.ShiftKey or Keys.Menu) return;
            e.SuppressKeyPress = true;
            if (e.KeyCode == Keys.Escape)
            {
                button.Text = KeyName(get());
            }
            else if (button.Text.EndsWith('…'))
            {
                set((int)e.KeyData);
                button.Text = KeyName(get());
                _s.Save();
            }
            RegisterHotkeys();
        };
        return button;
    }

    private static string KeyName(int key) => new KeysConverter().ConvertToString((Keys)key) ?? "";

    private void RegisterHotkeys()
    {
        if (_hotkeys is null) return;
        _hotkeys.Clear();
        var bindings = new (string Name, int Key, Action Action)[]
        {
            ("inspelning", _s.HotkeyRecord, () => GuardedInBackground(_engine.ToggleRecording)),
            ("skärmdump", _s.HotkeyScreenshot, Screenshot),
            ("benchmark", _s.HotkeyBenchmark, () => GuardedInBackground(() => _engine.ToggleBenchmark())),
            ("replay", _s.HotkeyReplay, () => GuardedInBackground(() => _engine.SaveReplay())),
            ("overlay", _s.HotkeyOverlay, ToggleOverlay),
        };
        foreach (var (name, key, action) in bindings)
            if (!_hotkeys.Register((Keys)key, action))
                Log.Write($"Kortkommandot för {name} ({KeyName(key)}) är upptaget av ett annat program.");
    }

    protected override void WndProc(ref Message m)
    {
        if (m.Msg == Hotkeys.WmHotkey)
            _hotkeys?.Handle((int)m.WParam);
        base.WndProc(ref m);
    }

    private void Change(Action apply)
    {
        if (_loading) return;
        apply();
        _s.Save();
        _applyTimer.Stop();
        _applyTimer.Start();
    }

    private void ApplyPending()
    {
        _applyTimer.Stop();
        GuardedInBackground(() =>
        {
            if (!_engine.ApplySettings())
                Log.Write("Ändringen börjar gälla vid nästa inspelning.");
        });
    }

    private void FillEncoders()
    {
        _loading = true;
        var items = new List<(string Label, string Id)> { ("Automatiskt", "auto") };
        items.AddRange(_engine.Encoders.Select(e => (e.Label, e.Id)));
        _encoder.Items.Clear();
        foreach (var item in items) _encoder.Items.Add(item.Label);
        int index = items.FindIndex(i => i.Id == _s.Encoder);
        _encoder.SelectedIndex = index >= 0 ? index : 0;
        _encoder.SelectedIndexChanged += (_, _) => Change(() => _s.Encoder = items[_encoder.SelectedIndex].Id);
        _loading = false;
    }

    private void ToggleOverlay()
    {
        _s.ShowOverlay = !_s.ShowOverlay;
        _s.Save();
        SyncOverlay();
    }

    private void SyncOverlay()
    {
        if (_s.ShowOverlay)
        {
            _overlay ??= new Overlay(_engine);
            if (!_overlay.Visible) _overlay.Show();
            _overlay.ApplyPlacement();
        }
        else
        {
            _overlay?.Hide();
        }
    }

    private void Screenshot() => _ = ScreenshotAsync();

    private async Task ScreenshotAsync()
    {
        try
        {
            await _engine.TakeScreenshot();
        }
        catch (Exception e) when (e is IOException or InvalidOperationException or UnauthorizedAccessException)
        {
            Log.Write($"Skärmdumpen misslyckades: {e.Message}");
        }
    }

    private void SaveOrToggleReplay()
    {
        if (_engine.IsReplayActive) GuardedInBackground(() => _engine.SaveReplay());
        else GuardedInBackground(_engine.ToggleReplay);
    }

    /// <summary>Starting and stopping talks to ffmpeg and can take seconds, which the window must not feel.</summary>
    private void GuardedInBackground(Action action) => Task.Run(() =>
    {
        try
        {
            action();
        }
        catch (Exception e) when (e is InvalidOperationException or IOException or FileNotFoundException or UnauthorizedAccessException)
        {
            Log.Write($"Fel: {e.Message}");
        }
        BeginInvokeSafe(UpdateStatus);
    });

    private void UpdateStatus()
    {
        _fps.Text = _engine.CurrentFps.ToString();
        if (_engine.IsRecording)
        {
            _state.Text = $"● {_engine.RecordingTime:hh\\:mm\\:ss}";
            _state.ForeColor = Red;
            long size = 0;
            try { if (File.Exists(_engine.RecordingPath)) size = new FileInfo(_engine.RecordingPath).Length; }
            catch (IOException) { /* ffmpeg holds the file, the size simply waits for the next tick */ }
            _detail.Text = $"{_engine.ActiveEncoder}   {size / 1048576.0:0.0} MB   {_engine.RecordingFrames} bilder" +
                           (_engine.RecordingOverflows > 0 ? $"   {_engine.RecordingOverflows} upprepade" : "");
            _record.Text = "Stoppa";
        }
        else
        {
            _state.Text = "Redo";
            _state.ForeColor = Accent;
            _detail.Text = $"{_engine.ActiveEncoder}   {_s.Fps} FPS" + (_engine.IsReplayActive ? $"   Replay buffrar {_s.ReplaySeconds} s" : "");
            _record.Text = "Spela in";
        }
        _bench.Text = _engine.IsBenchmarking ? $"Stoppa {_engine.BenchmarkTime:mm\\:ss}" : "Benchmark";
        _replay.Text = _engine.IsReplayActive ? "Spara replay" : "Starta replay";
    }

    private void OnLogLine(string line) => BeginInvokeSafe(() =>
    {
        _log.Items.Add(line);
        while (_log.Items.Count > 200) _log.Items.RemoveAt(0);
        _log.TopIndex = _log.Items.Count - 1;
    });

    private void BeginInvokeSafe(Action action)
    {
        if (IsHandleCreated && !IsDisposed) BeginInvoke(action);
    }

    protected override void OnFormClosing(FormClosingEventArgs e)
    {
        _timer.Stop();
        _applyTimer.Stop();
        Log.Line -= OnLogLine;
        _hotkeys?.Clear();
        _overlay?.Close();
        base.OnFormClosing(e);
    }
}
