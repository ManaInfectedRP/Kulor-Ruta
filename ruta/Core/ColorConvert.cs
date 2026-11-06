namespace Ruta.Core;

/// <summary>BGRA to BT.709 limited range NV12. Scalar and split over all cores, which is ample here.</summary>
public static unsafe class ColorConvert
{
    // BT.709 scaled to limited range, 8.8 fixed point.
    private const int YR = 47, YG = 157, YB = 16;
    private const int UR = -26, UG = -87, UB = 112;
    private const int VR = 112, VG = -102, VB = -10;

    public static int Nv12Size(int width, int height)
    {
        int w = width & ~1, h = height & ~1;
        return w * h + w * h / 2;
    }

    public static void BgraToNv12(byte[] bgra, int width, int height, byte[] nv12)
    {
        int w = width & ~1, h = height & ~1;
        int rowPairs = h / 2;
        int bands = Math.Min(Environment.ProcessorCount, Math.Max(1, rowPairs));

        fixed (byte* src = bgra)
        fixed (byte* dst = nv12)
        {
            byte* srcBase = src, dstBase = dst;
            int stride = width * 4;
            Parallel.For(0, bands, band =>
            {
                int from = rowPairs * band / bands, to = rowPairs * (band + 1) / bands;
                for (int pair = from; pair < to; pair++)
                {
                    int y = pair * 2;
                    ConvertRowPair(srcBase + y * stride, srcBase + (y + 1) * stride,
                        dstBase + y * w, dstBase + (y + 1) * w, dstBase + w * h + pair * w, w);
                }
            });
        }
    }

    private static void ConvertRowPair(byte* top, byte* bottom, byte* yTop, byte* yBottom, byte* uv, int width)
    {
        for (int x = 0; x < width; x += 2)
        {
            int b0 = top[0], g0 = top[1], r0 = top[2];
            int b1 = top[4], g1 = top[5], r1 = top[6];
            int b2 = bottom[0], g2 = bottom[1], r2 = bottom[2];
            int b3 = bottom[4], g3 = bottom[5], r3 = bottom[6];

            yTop[0] = (byte)(((YR * r0 + YG * g0 + YB * b0 + 128) >> 8) + 16);
            yTop[1] = (byte)(((YR * r1 + YG * g1 + YB * b1 + 128) >> 8) + 16);
            yBottom[0] = (byte)(((YR * r2 + YG * g2 + YB * b2 + 128) >> 8) + 16);
            yBottom[1] = (byte)(((YR * r3 + YG * g3 + YB * b3 + 128) >> 8) + 16);

            // 4:2:0: one chroma pair per 2x2 block, taken from the block average.
            int r = r0 + r1 + r2 + r3, g = g0 + g1 + g2 + g3, b = b0 + b1 + b2 + b3;
            uv[0] = (byte)(((UR * r + UG * g + UB * b + 512) >> 10) + 128);
            uv[1] = (byte)(((VR * r + VG * g + VB * b + 512) >> 10) + 128);

            top += 8;
            bottom += 8;
            yTop += 2;
            yBottom += 2;
            uv += 2;
        }
    }
}
