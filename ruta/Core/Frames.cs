using System.Collections.Concurrent;

namespace Ruta.Core;

/// <summary>A reference counted BGRA frame. The same frame can sit in several encoder queues.</summary>
public sealed class Frame
{
    private readonly FramePool _pool;
    private readonly Lock _convertGate = new();
    private byte[]? _nv12;
    private volatile bool _nv12Ready;
    private int _refs;

    public byte[] Data { get; }
    public int Width { get; }
    public int Height { get; }
    public int Stride => Width * 4;

    internal Frame(FramePool pool, int width, int height)
    {
        _pool = pool;
        Width = width;
        Height = height;
        // Pinned so that row copies can run on raw pointers without fixed-blocks in the capture loop.
        Data = GC.AllocateUninitializedArray<byte>(width * height * 4, pinned: true);
    }

    internal void Reset()
    {
        _refs = 1;
        _nv12Ready = false;
    }

    /// <summary>The frame as BT.709 limited range NV12. Converted once, whichever encoder asks first.</summary>
    public byte[] Nv12()
    {
        if (_nv12Ready) return _nv12!;
        lock (_convertGate)
        {
            if (!_nv12Ready)
            {
                _nv12 ??= GC.AllocateUninitializedArray<byte>(ColorConvert.Nv12Size(Width, Height), pinned: true);
                ColorConvert.BgraToNv12(Data, Width, Height, _nv12);
                _nv12Ready = true;
            }
        }
        return _nv12!;
    }

    public Frame AddRef()
    {
        Interlocked.Increment(ref _refs);
        return this;
    }

    public void Release()
    {
        if (Interlocked.Decrement(ref _refs) == 0)
            _pool.Return(this);
    }
}

public sealed class FramePool(int width, int height, int maxIdle = 16)
{
    private readonly ConcurrentBag<Frame> _idle = [];

    public int Width { get; } = width;
    public int Height { get; } = height;

    public Frame Rent()
    {
        if (!_idle.TryTake(out var frame))
            frame = new Frame(this, Width, Height);
        frame.Reset();
        return frame;
    }

    internal void Return(Frame frame)
    {
        // Frames above the idle cap are left to the GC so a burst does not pin RAM forever.
        if (_idle.Count < maxIdle)
            _idle.Add(frame);
    }
}

/// <summary>Anything that consumes the paced frame stream.</summary>
public interface IFrameSink
{
    /// <summary>Takes its own reference to the frame. Must never block the capture thread.</summary>
    void Push(Frame frame);
}
