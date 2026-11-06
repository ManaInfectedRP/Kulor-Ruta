import { useEffect, useRef, useState } from 'react';
import type { CurvePoint, Curves } from '../core/types';
import { sampleCurve } from '../core/grade';

const WIDTH = 300;
const HEIGHT = 230;
const COLORS: Record<keyof Curves, string> = { m: '#e8e8e8', r: '#ff6a6a', g: '#6ae88a', b: '#6a9aff' };
const LABELS: Record<keyof Curves, string> = { m: 'Y', r: 'R', g: 'G', b: 'B' };
const GRAB_RADIUS = 0.04;

export function CurveEditor({ curves, onChange }: { curves: Curves; onChange(c: Curves): void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [channel, setChannel] = useState<keyof Curves>('m');
  const dragging = useRef<number | null>(null);
  const points = curves[channel];

  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, WIDTH, HEIGHT);
    ctx.fillStyle = '#111215';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    ctx.strokeStyle = 'rgba(255,255,255,0.09)';
    ctx.beginPath();
    for (let i = 1; i < 4; i++) {
      ctx.moveTo((i * WIDTH) / 4, 0);
      ctx.lineTo((i * WIDTH) / 4, HEIGHT);
      ctx.moveTo(0, (i * HEIGHT) / 4);
      ctx.lineTo(WIDTH, (i * HEIGHT) / 4);
    }
    ctx.stroke();

    const line = sampleCurve(points, WIDTH);
    ctx.strokeStyle = COLORS[channel];
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    for (let x = 0; x < WIDTH; x++) {
      const y = HEIGHT - line[x] * HEIGHT;
      if (x === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();

    ctx.fillStyle = COLORS[channel];
    for (const p of points) {
      ctx.beginPath();
      ctx.arc(p.x * WIDTH, HEIGHT - p.y * HEIGHT, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }, [points, channel]);

  const position = (e: React.PointerEvent): CurvePoint => {
    const b = e.currentTarget.getBoundingClientRect();
    return {
      x: Math.min(1, Math.max(0, (e.clientX - b.left) / b.width)),
      y: Math.min(1, Math.max(0, 1 - (e.clientY - b.top) / b.height)),
    };
  };

  const update = (next: CurvePoint[]) => onChange({ ...curves, [channel]: next });

  return (
    <div className="curves">
      <div className="curve-tabs">
        {(Object.keys(LABELS) as (keyof Curves)[]).map((k) => (
          <button key={k} className={k === channel ? 'toggle on' : 'toggle'} style={{ color: COLORS[k] }} onClick={() => setChannel(k)}>
            {LABELS[k]}
          </button>
        ))}
        <button className="tiny" onClick={() => update([{ x: 0, y: 0 }, { x: 1, y: 1 }])} title="Återställ kurvan">↺</button>
      </div>
      <canvas
        ref={ref}
        width={WIDTH}
        height={HEIGHT}
        title="Klicka för en ny punkt, dra för att flytta, högerklicka för att ta bort"
        onContextMenu={(e) => {
          e.preventDefault();
          const p = position(e as unknown as React.PointerEvent);
          const hit = points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < GRAB_RADIUS);
          if (hit > 0 && hit < points.length - 1) update(points.filter((_, i) => i !== hit));
        }}
        onPointerDown={(e) => {
          if (e.button !== 0) return;
          const p = position(e);
          e.currentTarget.setPointerCapture(e.pointerId);
          let hit = points.findIndex((q) => Math.hypot(q.x - p.x, q.y - p.y) < GRAB_RADIUS);
          if (hit < 0) {
            const next = [...points, p].sort((a, b) => a.x - b.x);
            hit = next.indexOf(p);
            update(next);
          }
          dragging.current = hit;
        }}
        onPointerMove={(e) => {
          const i = dragging.current;
          if (i === null) return;
          const p = position(e);
          // A point stays between its neighbours, and the two end points keep their x.
          const left = i > 0 ? points[i - 1].x + 0.01 : 0;
          const right = i < points.length - 1 ? points[i + 1].x - 0.01 : 1;
          const x = i === 0 || i === points.length - 1 ? points[i].x : Math.min(right, Math.max(left, p.x));
          update(points.map((q, n) => (n === i ? { x, y: p.y } : q)));
        }}
        onPointerUp={() => {
          dragging.current = null;
        }}
      />
    </div>
  );
}
