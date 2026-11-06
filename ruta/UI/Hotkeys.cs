using System.Runtime.InteropServices;

namespace Ruta.UI;

/// <summary>Global hotkeys through RegisterHotKey, delivered as WM_HOTKEY to the owner window.</summary>
internal sealed class Hotkeys(IntPtr window)
{
    public const int WmHotkey = 0x0312;
    private const uint ModAlt = 1, ModControl = 2, ModShift = 4, ModNoRepeat = 0x4000;

    private readonly Dictionary<int, Action> _actions = [];
    private int _nextId = 1;

    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool RegisterHotKey(IntPtr hwnd, int id, uint modifiers, uint vk);

    [DllImport("user32.dll")]
    private static extern bool UnregisterHotKey(IntPtr hwnd, int id);

    /// <summary>Returns false when another program already owns the key.</summary>
    public bool Register(Keys key, Action action)
    {
        uint mods = ModNoRepeat;
        if (key.HasFlag(Keys.Control)) mods |= ModControl;
        if (key.HasFlag(Keys.Shift)) mods |= ModShift;
        if (key.HasFlag(Keys.Alt)) mods |= ModAlt;

        int id = _nextId++;
        if (!RegisterHotKey(window, id, mods, (uint)(key & Keys.KeyCode)))
            return false;
        _actions[id] = action;
        return true;
    }

    public void Clear()
    {
        foreach (int id in _actions.Keys) UnregisterHotKey(window, id);
        _actions.Clear();
    }

    public void Handle(int id)
    {
        if (_actions.TryGetValue(id, out var action)) action();
    }
}
