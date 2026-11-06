using System.Diagnostics;
using System.Runtime.InteropServices;
using SharpGen.Runtime;
using Vortice.Direct3D;
using Vortice.Direct3D11;
using Vortice.DXGI;

namespace Ruta.Core;

public sealed record MonitorInfo(string Device, int Width, int Height, int AdapterIndex, int OutputIndex, string Adapter)
{
    public override string ToString() => $"{Device.Replace(@"\\.\", "")}  {Width}×{Height}  ({Adapter})";
}

/// <summary>
/// Desktop Duplication capture. One thread acquires every desktop update, which also drives the FPS
/// counter. While something wants frames, the same thread paces them out at a constant frame rate:
/// unchanged ticks reuse the previous frame, so a still screen costs almost nothing.
/// </summary>
public sealed unsafe class DesktopCapture : IDisposable
{
    // DXGI_OUTDUPL_POINTER_SHAPE_TYPE
    private const uint ShapeMonochrome = 1, ShapeColor = 2, ShapeMaskedColor = 4;

    private readonly Lock _gate = new();
    private readonly Thread _thread;
    private volatile bool _stop;
    private volatile bool _reinit;
    private volatile IFrameSink[] _sinks = [];
    private volatile Action<Frame>? _stillRequest;

    private string _monitorDevice;
    private int _fps;
    private volatile bool _drawCursor;

    private ID3D11Device? _device;
    private ID3D11DeviceContext? _context;
    private IDXGIOutputDuplication? _duplication;
    private ID3D11Texture2D? _gpuLatest;
    private ID3D11Texture2D? _staging;

    private FramePool? _pool;
    private byte[] _desktop = [];
    private bool _hasImage;
    private bool _desktopDirty;
    private bool _gpuDirty;
    private Frame? _published;

    private bool _pointerVisible;
    private int _pointerX, _pointerY;
    private byte[] _pointerShape = [];
    private OutduplPointerShapeInfo _pointerInfo;

    // FPS bookkeeping
    private long _windowStart;
    private long _windowPresents;
    private volatile int _currentFps;
    private long _lastPresentQpc;

    public int Width { get; private set; }
    public int Height { get; private set; }
    public int CurrentFps => _currentFps;
    public long PacedFrames { get; private set; }

    /// <summary>Raised on the capture thread with the seconds between two presents.</summary>
    public event Action<double>? FrameTime;
    /// <summary>Raised on the capture thread when the monitor mode changed and sizes differ.</summary>
    public event Action? SizeChanged;

    public DesktopCapture(string monitorDevice, int fps, bool drawCursor)
    {
        _monitorDevice = monitorDevice;
        _fps = fps;
        _drawCursor = drawCursor;
        _thread = new Thread(Loop) { Name = "Ruta capture", IsBackground = true, Priority = ThreadPriority.AboveNormal };
    }

    public void Start() => _thread.Start();

    public void Configure(string monitorDevice, int fps, bool drawCursor)
    {
        lock (_gate)
        {
            _reinit |= monitorDevice != _monitorDevice;
            _monitorDevice = monitorDevice;
            _fps = fps;
            _drawCursor = drawCursor;
        }
    }

    public void AddSink(IFrameSink sink)
    {
        lock (_gate)
        {
            bool wasIdle = _sinks.Length == 0;
            _sinks = [.. _sinks, sink];
            // Duplication only reports changes; a fresh one hands us the full desktop on a still screen.
            if (wasIdle) _reinit = true;
        }
    }

    public void RemoveSink(IFrameSink sink)
    {
        lock (_gate) _sinks = _sinks.Where(s => s != sink).ToArray();
    }

    /// <summary>Delivers the next composed frame, including cursor, to the callback.</summary>
    public void RequestStill(Action<Frame> onFrame)
    {
        lock (_gate)
        {
            if (_sinks.Length == 0) _reinit = true;
            _stillRequest = onFrame;
        }
    }

    public static List<MonitorInfo> EnumerateMonitors()
    {
        var list = new List<MonitorInfo>();
        DXGI.CreateDXGIFactory1(out IDXGIFactory1? factory).CheckError();
        using (factory)
        {
            for (uint a = 0; factory!.EnumAdapters1(a, out IDXGIAdapter1 adapter).Success; a++)
            {
                using (adapter)
                {
                    for (uint o = 0; adapter.EnumOutputs(o, out IDXGIOutput output).Success; o++)
                    {
                        using (output)
                        {
                            var d = output.Description;
                            if (!d.AttachedToDesktop) continue;
                            list.Add(new MonitorInfo(d.DeviceName, d.DesktopCoordinates.Right - d.DesktopCoordinates.Left,
                                d.DesktopCoordinates.Bottom - d.DesktopCoordinates.Top, (int)a, (int)o, adapter.Description1.Description));
                        }
                    }
                }
            }
        }
        return list;
    }

    private void Loop()
    {
        _windowStart = Stopwatch.GetTimestamp();
        long nextTick = 0;
        double ticksPerFrame = 0;
        int tickFps = 0;

        while (!_stop)
        {
            if (_duplication is null || _reinit)
            {
                _reinit = false;
                ReleaseDuplication();
                if (!TryInitialize())
                {
                    Thread.Sleep(250); // secure desktop (UAC), mode switch or lock screen: keep retrying
                    continue;
                }
            }

            bool wantFrames = _sinks.Length > 0 || _stillRequest is not null;
            if (wantFrames && tickFps != _fps)
            {
                tickFps = _fps;
                ticksPerFrame = Stopwatch.Frequency / (double)tickFps;
                nextTick = 0;
            }

            uint timeoutMs = 100;
            if (wantFrames)
            {
                if (nextTick == 0) nextTick = Stopwatch.GetTimestamp();
                long wait = nextTick - Stopwatch.GetTimestamp();
                timeoutMs = wait <= 0 ? 0u : (uint)Math.Min(100, Math.Ceiling(wait * 1000.0 / Stopwatch.Frequency));
            }

            var result = _duplication!.AcquireNextFrame(timeoutMs, out var info, out IDXGIResource? resource);
            if (result.Success)
            {
                using (resource) OnDesktopFrame(info, resource!, wantFrames);
                _duplication.ReleaseFrame();
            }
            else if (result.Code != Vortice.DXGI.ResultCode.WaitTimeout.Code)
            {
                // AccessLost and friends: the duplication is dead, rebuild it.
                _duplication?.Dispose();
                _duplication = null;
                continue;
            }

            UpdateFpsWindow();

            if (wantFrames && _hasImageReady())
            {
                long now = Stopwatch.GetTimestamp();
                while (now >= nextTick)
                {
                    EmitTick();
                    nextTick += (long)ticksPerFrame;
                }
            }
            else if (!wantFrames)
            {
                nextTick = 0;
            }
        }

        ReleaseDuplication();
        _published?.Release();
        _published = null;
    }

    private bool _hasImageReady() => _hasImage || _gpuDirty;

    private bool TryInitialize()
    {
        try
        {
            DXGI.CreateDXGIFactory1(out IDXGIFactory1? factory).CheckError();
            using (factory)
            {
                IDXGIOutput? chosen = null;
                IDXGIAdapter1? chosenAdapter = null;
                string want;
                lock (_gate) want = _monitorDevice;

                for (uint a = 0; chosen is null && factory!.EnumAdapters1(a, out IDXGIAdapter1 adapter).Success; a++)
                {
                    for (uint o = 0; adapter.EnumOutputs(o, out IDXGIOutput output).Success; o++)
                    {
                        var d = output.Description;
                        if (d.AttachedToDesktop && (want.Length == 0 || d.DeviceName == want))
                        {
                            chosen = output;
                            chosenAdapter = adapter;
                            break;
                        }
                        output.Dispose();
                    }
                    if (chosen is null) adapter.Dispose();
                }

                if (chosen is null || chosenAdapter is null)
                    return false;

                using (chosenAdapter)
                using (chosen)
                {
                    D3D11.D3D11CreateDevice(chosenAdapter, DriverType.Unknown, DeviceCreationFlags.BgraSupport,
                        [FeatureLevel.Level_11_0], out _device, out _context).CheckError();

                    using var output1 = chosen.QueryInterface<IDXGIOutput1>();
                    _duplication = output1.DuplicateOutput(_device);

                    var desc = _duplication.Description;
                    int w = (int)desc.ModeDescription.Width, h = (int)desc.ModeDescription.Height;
                    bool sizeChanged = Width != 0 && (w != Width || h != Height);
                    if (_pool is null || w != Width || h != Height)
                    {
                        Width = w;
                        Height = h;
                        _pool = new FramePool(w, h);
                        _desktop = GC.AllocateUninitializedArray<byte>(w * h * 4, pinned: true);
                        _published?.Release();
                        _published = null;
                        _hasImage = false;
                    }

                    var texture = new Texture2DDescription
                    {
                        Width = (uint)w,
                        Height = (uint)h,
                        MipLevels = 1,
                        ArraySize = 1,
                        Format = Format.B8G8R8A8_UNorm,
                        SampleDescription = new SampleDescription(1, 0),
                        Usage = ResourceUsage.Default,
                        BindFlags = BindFlags.None,
                    };
                    _gpuLatest = _device.CreateTexture2D(texture);
                    texture.Usage = ResourceUsage.Staging;
                    texture.CPUAccessFlags = CpuAccessFlags.Read;
                    _staging = _device.CreateTexture2D(texture);

                    if (sizeChanged) SizeChanged?.Invoke();
                    return true;
                }
            }
        }
        catch (SharpGenException e)
        {
            Log.Write($"Skärmfångsten väntar: {e.Message}");
            ReleaseDuplication();
            return false;
        }
    }

    private void ReleaseDuplication()
    {
        _duplication?.Dispose();
        _gpuLatest?.Dispose();
        _staging?.Dispose();
        _context?.Dispose();
        _device?.Dispose();
        _duplication = null;
        _gpuLatest = null;
        _staging = null;
        _context = null;
        _device = null;
        _gpuDirty = false;
    }

    private void OnDesktopFrame(in OutduplFrameInfo info, IDXGIResource resource, bool wantFrames)
    {
        if (info.LastPresentTime != 0)
        {
            uint presents = Math.Max(1u, info.AccumulatedFrames);
            _windowPresents += presents;

            if (_lastPresentQpc != 0)
            {
                double seconds = (info.LastPresentTime - _lastPresentQpc) / (double)Stopwatch.Frequency / presents;
                if (seconds > 0)
                    for (uint i = 0; i < presents; i++) FrameTime?.Invoke(seconds);
            }
            _lastPresentQpc = info.LastPresentTime;
        }

        if (info.LastMouseUpdateTime != 0)
        {
            _pointerVisible = info.PointerPosition.Visible;
            if (_pointerVisible)
            {
                _pointerX = info.PointerPosition.Position.X;
                _pointerY = info.PointerPosition.Position.Y;
            }
            if (_drawCursor) _desktopDirty = true;
        }

        if (info.PointerShapeBufferSize > 0)
        {
            if (_pointerShape.Length < info.PointerShapeBufferSize)
                _pointerShape = new byte[info.PointerShapeBufferSize];
            fixed (byte* p = _pointerShape)
                _duplication!.GetFramePointerShape(info.PointerShapeBufferSize, (IntPtr)p, out _, out _pointerInfo).CheckError();
        }

        // Pointer-only updates have LastPresentTime == 0, but a first image must be taken from whatever comes.
        if (wantFrames && (info.LastPresentTime != 0 || !_hasImage))
        {
            using var texture = resource.QueryInterface<ID3D11Texture2D>();
            _context!.CopyResource(_gpuLatest!, texture);
            _gpuDirty = true;
            _desktopDirty = true;
        }
    }

    private void UpdateFpsWindow()
    {
        long now = Stopwatch.GetTimestamp();
        long elapsed = now - _windowStart;
        if (elapsed < Stopwatch.Frequency / 2) return;
        _currentFps = (int)Math.Round(_windowPresents * (double)Stopwatch.Frequency / elapsed);
        _windowPresents = 0;
        _windowStart = now;
    }

    /// <summary>Reads the desktop back only on ticks that need it, so a 240 Hz screen does not cost 240 maps.</summary>
    private void ReadBackDesktop()
    {
        if (!_gpuDirty) return;
        _context!.CopyResource(_staging!, _gpuLatest!);
        var map = _context.Map(_staging!, 0, MapMode.Read);
        try
        {
            int stride = Width * 4;
            fixed (byte* dst = _desktop)
            {
                byte* src = (byte*)map.DataPointer;
                for (int y = 0; y < Height; y++)
                    Buffer.MemoryCopy(src + y * map.RowPitch, dst + y * stride, stride, stride);
            }
        }
        finally
        {
            _context.Unmap(_staging!, 0);
        }
        _gpuDirty = false;
        _hasImage = true;
    }

    private void EmitTick()
    {
        if (_desktopDirty || _published is null)
        {
            ReadBackDesktop();
            var frame = _pool!.Rent();
            Buffer.BlockCopy(_desktop, 0, frame.Data, 0, _desktop.Length);
            if (_drawCursor && _pointerVisible && _pointerShape.Length > 0)
                DrawPointer(frame);
            _published?.Release();
            _published = frame;
            _desktopDirty = false;
        }

        foreach (var sink in _sinks)
            sink.Push(_published);
        PacedFrames++;

        var still = _stillRequest;
        if (still is not null)
        {
            _stillRequest = null;
            still(_published.AddRef());
        }
    }

    private void DrawPointer(Frame frame)
    {
        int shapeWidth = (int)_pointerInfo.Width;
        int shapeHeight = (int)_pointerInfo.Height;
        int pitch = (int)_pointerInfo.Pitch;
        uint type = (uint)_pointerInfo.Type;
        if (type == ShapeMonochrome) shapeHeight /= 2;

        int fromX = Math.Max(0, -_pointerX), toX = Math.Min(shapeWidth, frame.Width - _pointerX);
        int fromY = Math.Max(0, -_pointerY), toY = Math.Min(shapeHeight, frame.Height - _pointerY);

        fixed (byte* dstBase = frame.Data)
        fixed (byte* shape = _pointerShape)
        {
            for (int y = fromY; y < toY; y++)
            {
                uint* dst = (uint*)(dstBase + (_pointerY + y) * frame.Stride) + _pointerX;
                for (int x = fromX; x < toX; x++)
                {
                    switch (type)
                    {
                        case ShapeColor:
                        {
                            uint s = ((uint*)(shape + y * pitch))[x];
                            uint a = s >> 24;
                            if (a == 255) dst[x] = s;
                            else if (a > 0) dst[x] = Blend(s, dst[x], a);
                            break;
                        }
                        case ShapeMaskedColor:
                        {
                            uint s = ((uint*)(shape + y * pitch))[x];
                            dst[x] = (s >> 24) == 0 ? s | 0xFF000000 : (dst[x] ^ s) | 0xFF000000;
                            break;
                        }
                        default: // monochrome: AND plane followed by XOR plane, one bit per pixel
                        {
                            byte bit = (byte)(0x80 >> (x % 8));
                            bool and = (shape[y * pitch + x / 8] & bit) != 0;
                            bool xor = (shape[(y + shapeHeight) * pitch + x / 8] & bit) != 0;
                            uint d = and ? dst[x] : 0xFF000000;
                            dst[x] = (xor ? d ^ 0x00FFFFFF : d) | 0xFF000000;
                            break;
                        }
                    }
                }
            }
        }
    }

    private static uint Blend(uint src, uint dst, uint a)
    {
        uint inv = 255 - a;
        uint rb = (((src & 0xFF00FF) * a + (dst & 0xFF00FF) * inv) >> 8) & 0xFF00FF;
        uint g = (((src & 0x00FF00) * a + (dst & 0x00FF00) * inv) >> 8) & 0x00FF00;
        return 0xFF000000 | rb | g;
    }

    public void Dispose()
    {
        _stop = true;
        if (_thread.IsAlive) _thread.Join(2000);
    }
}
