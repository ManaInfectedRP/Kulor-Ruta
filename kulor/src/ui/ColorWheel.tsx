import { useEffect, useRef } from 'react';
import type { Rgbm } from '../core/types';
import { channelsToWheel, wheelToChannels } from '../core/grade';

const SIZE = 150;

function paintRing(ctx: CanvasRenderingContext2D): void {
  const c = SIZE / 2;
  const image = ctx.createImageData(SIZE, SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const dx = x - c;
      const dy = c - y;
      const d = Math.hypot(dx, dy) / c;
      if (d > 1) continue;
      const i = (y * SIZE + x) * 4;
      if (d > 0.9) {
        const { r, g, b } = wheelToChannels(dx / c, dy / c);
        const scale = 1.2;
        image.data[i] = 128 + r * 127 * scale;
        image.data[i + 1] = 128 + g * 127 * scale;
        image.data[i + 2] = 128 + b * 127 * scale;
        image.data[i + 3] = 255;
      } else {
        image.data[i] = 34;
        image.data[i + 1] = 36;
        image.data[i + 2] = 40;
        image.data[i + 3] = 255;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  ctx.strokeStyle = 'rgba(255,255,255,0.13)';
  ctx.beginPath();
  ctx.moveTo(c - 10, c);
  ctx.lineTo(c + 10, c);
  ctx.moveTo(c, c - 10);
  ctx.lineTo(c, c + 10);
  ctx.stroke();
}

interface Props {
  label: string;
  value: Rgbm;
  /** Channel offset at the edge of the wheel. */
  range: number;
  masterRange: number;
  onChange(value: Rgbm): void;
}

export function ColorWheel({ label, value, range, masterRange, onChange }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);
  const base = useRef<ImageData | null>(null);

  useEffect(() => {
    const ctx = ref.current?.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    if (!base.current) {
      paintRing(ctx);
      base.current = ctx.getImageData(0, 0, SIZE, SIZE);
    }
    ctx.putImageData(base.current, 0, 0);
    const puck = channelsToWheel(value.r / range, value.g / range, value.b / range);
    const c = SIZE / 2;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(c + puck.x * c * 0.85, c - puck.y * c * 0.85, 5, 0, Math.PI * 2);
    ctx.stroke();
  }, [value, range]);

  const pointer = (e: React.PointerEvent) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    const scale = bounds.width / SIZE;
    const c = (SIZE / 2) * scale;
    let x = (e.clientX - bounds.left - c) / (c * 0.85);
    let y = (c - (e.clientY - bounds.top)) / (c * 0.85);
    const d = Math.hypot(x, y);
    if (d > 1) {
      x /= d;
      y /= d;
    }
    const channels = wheelToChannels(x, y);
    onChange({ r: channels.r * range, g: channels.g * range, b: channels.b * range, m: value.m });
  };

  return (
    <div className="wheel">
      <div className="wheel-title">
        {label}
        <button className="tiny" onClick={() => onChange({ r: 0, g: 0, b: 0, m: 0 })} title="Återställ">↺</button>
      </div>
      <canvas
        ref={ref}
        width={SIZE}
        height={SIZE}
        onPointerDown={(e) => {
          e.currentTarget.setPointerCapture(e.pointerId);
          pointer(e);
        }}
        onPointerMove={(e) => {
          if (e.currentTarget.hasPointerCapture(e.pointerId)) pointer(e);
        }}
      />
      <input
        type="range"
        min={-masterRange}
        max={masterRange}
        step={masterRange / 200}
        value={value.m}
        onChange={(e) => onChange({ ...value, m: Number(e.target.value) })}
        onDoubleClick={() => onChange({ ...value, m: 0 })}
        title="Mästarvärde"
      />
      <div className="wheel-values">
        <span className="r">{(value.r + value.m).toFixed(2)}</span>
        <span className="g">{(value.g + value.m).toFixed(2)}</span>
        <span className="b">{(value.b + value.m).toFixed(2)}</span>
      </div>
    </div>
  );
}
