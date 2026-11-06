// Video scopes computed on the CPU from a small copy of the composite.

export type ScopeKind = 'waveform' | 'parade' | 'vectorscope' | 'histogram';

const BG = '#0d0e10';
const GRID = 'rgba(255,255,255,0.13)';

function plot(ctx: CanvasRenderingContext2D, buffer: Uint32Array<ArrayBuffer>, width: number, height: number): void {
  const image = new ImageData(new Uint8ClampedArray(buffer.buffer), width, height);
  ctx.putImageData(image, 0, 0);
}

/** Additive point plotting: traces get brighter where many pixels land on them. */
function bump(buffer: Uint32Array<ArrayBuffer>, i: number, r: number, g: number, b: number): void {
  const v = buffer[i];
  const nr = Math.min(255, (v & 255) + r);
  const ng = Math.min(255, ((v >> 8) & 255) + g);
  const nb = Math.min(255, ((v >> 16) & 255) + b);
  buffer[i] = 0xff000000 | (nb << 16) | (ng << 8) | nr;
}

function clearBuffer(width: number, height: number): Uint32Array<ArrayBuffer> {
  return new Uint32Array(width * height).fill(0xff100e0d);
}

function drawWaveform(ctx: CanvasRenderingContext2D, px: Uint8Array, sw: number, sh: number): void {
  const { width, height } = ctx.canvas;
  const buffer = clearBuffer(width, height);
  const strength = 28;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const luma = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
      const py = height - 1 - Math.round((luma / 255) * (height - 1));
      const col = Math.floor((x / sw) * width);
      bump(buffer, py * width + col, strength >> 2, strength, strength >> 1);
    }
  }
  plot(ctx, buffer, width, height);
}

function drawParade(ctx: CanvasRenderingContext2D, px: Uint8Array, sw: number, sh: number): void {
  const { width, height } = ctx.canvas;
  const buffer = clearBuffer(width, height);
  const third = Math.floor(width / 3);
  const strength = 30;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const i = (y * sw + x) * 4;
      const col = Math.floor((x / sw) * (third - 4));
      for (let c = 0; c < 3; c++) {
        const py = height - 1 - Math.round((px[i + c] / 255) * (height - 1));
        bump(buffer, py * width + c * third + col + 2, c === 0 ? strength : 3, c === 1 ? strength : 3, c === 2 ? strength : 3);
      }
    }
  }
  plot(ctx, buffer, width, height);
}

function drawVectorscope(ctx: CanvasRenderingContext2D, px: Uint8Array, sw: number, sh: number): void {
  const { width, height } = ctx.canvas;
  const buffer = clearBuffer(width, height);
  const size = Math.min(width, height);
  const cx = width / 2;
  const cy = height / 2;
  for (let i = 0; i < sw * sh * 4; i += 4) {
    const r = px[i] / 255;
    const g = px[i + 1] / 255;
    const b = px[i + 2] / 255;
    const cb = -0.1146 * r - 0.3854 * g + 0.5 * b;
    const cr = 0.5 * r - 0.4542 * g - 0.0458 * b;
    const x = Math.round(cx + cb * size * 0.92);
    const y = Math.round(cy - cr * size * 0.92);
    if (x >= 0 && x < width && y >= 0 && y < height) bump(buffer, y * width + x, 40, 55, 30);
  }
  plot(ctx, buffer, width, height);

  ctx.strokeStyle = GRID;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.46, 0, Math.PI * 2);
  ctx.moveTo(cx - size * 0.46, cy);
  ctx.lineTo(cx + size * 0.46, cy);
  ctx.moveTo(cx, cy - size * 0.46);
  ctx.lineTo(cx, cy + size * 0.46);
  ctx.stroke();

  // Targets for the six primary and secondary colours.
  const targets: [string, number, number, number][] = [
    ['R', 1, 0, 0], ['G', 0, 1, 0], ['B', 0, 0, 1], ['C', 0, 1, 1], ['M', 1, 0, 1], ['Y', 1, 1, 0],
  ];
  ctx.fillStyle = 'rgba(255,255,255,0.45)';
  ctx.font = '10px system-ui';
  for (const [label, r, g, b] of targets) {
    const cb = -0.1146 * r - 0.3854 * g + 0.5 * b;
    const cr = 0.5 * r - 0.4542 * g - 0.0458 * b;
    ctx.fillText(label, cx + cb * size * 0.92 - 3, cy - cr * size * 0.92 + 3);
  }
}

function drawHistogram(ctx: CanvasRenderingContext2D, px: Uint8Array, sw: number, sh: number): void {
  const { width, height } = ctx.canvas;
  const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)];
  for (let i = 0; i < sw * sh * 4; i += 4) {
    bins[0][px[i]]++;
    bins[1][px[i + 1]]++;
    bins[2][px[i + 2]]++;
  }
  // The very ends often hold a clipped spike that would flatten everything else.
  let max = 1;
  for (const channel of bins) for (let v = 1; v < 255; v++) max = Math.max(max, channel[v]);

  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, width, height);
  ctx.globalCompositeOperation = 'lighter';
  const colors = ['rgba(255,70,70,0.75)', 'rgba(70,235,110,0.75)', 'rgba(80,120,255,0.75)'];
  bins.forEach((channel, c) => {
    ctx.fillStyle = colors[c];
    ctx.beginPath();
    ctx.moveTo(0, height);
    for (let v = 0; v < 256; v++) {
      ctx.lineTo((v / 255) * width, height - Math.min(1, channel[v] / max) * height * 0.95);
    }
    ctx.lineTo(width, height);
    ctx.closePath();
    ctx.fill();
  });
  ctx.globalCompositeOperation = 'source-over';
}

function drawGraticule(ctx: CanvasRenderingContext2D): void {
  const { width, height } = ctx.canvas;
  ctx.strokeStyle = GRID;
  ctx.fillStyle = 'rgba(255,255,255,0.4)';
  ctx.font = '9px system-ui';
  ctx.beginPath();
  for (const v of [0, 25, 50, 75, 100]) {
    const y = Math.round(height - 1 - (v / 100) * (height - 1)) + 0.5;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
  }
  ctx.stroke();
  for (const v of [25, 50, 75]) ctx.fillText(String(v), 3, height - (v / 100) * height - 2);
}

export function drawScope(kind: ScopeKind, ctx: CanvasRenderingContext2D, pixels: Uint8Array, sw: number, sh: number): void {
  switch (kind) {
    case 'waveform':
      drawWaveform(ctx, pixels, sw, sh);
      drawGraticule(ctx);
      break;
    case 'parade':
      drawParade(ctx, pixels, sw, sh);
      drawGraticule(ctx);
      break;
    case 'vectorscope':
      drawVectorscope(ctx, pixels, sw, sh);
      break;
    case 'histogram':
      drawHistogram(ctx, pixels, sw, sh);
      break;
  }
}
