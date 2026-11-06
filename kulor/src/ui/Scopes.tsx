import { useEffect, useRef, useState } from 'react';
import { Compositor } from '../engine/compositor';
import { player } from '../engine/player';
import { drawScope, type ScopeKind } from '../engine/scopes';

const KINDS: { id: ScopeKind; label: string }[] = [
  { id: 'waveform', label: 'Vågform' },
  { id: 'parade', label: 'RGB-parad' },
  { id: 'vectorscope', label: 'Vektorskop' },
  { id: 'histogram', label: 'Histogram' },
];

export function Scopes() {
  const ref = useRef<HTMLCanvasElement>(null);
  const [kind, setKind] = useState<ScopeKind>('waveform');

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;
    const p = player();
    const pixels = new Uint8Array(Compositor.SCOPE_WIDTH * Compositor.SCOPE_HEIGHT * 4);
    const draw = () => {
      p.compositor.readScope(pixels);
      drawScope(kind, ctx, pixels, Compositor.SCOPE_WIDTH, Compositor.SCOPE_HEIGHT);
    };
    p.onFrame = draw;
    p.invalidate();
    return () => {
      p.onFrame = null;
    };
  }, [kind]);

  return (
    <div className="scopes">
      <div className="panel-title">
        Mätinstrument
        <span className="scope-tabs">
          {KINDS.map((k) => (
            <button key={k.id} className={k.id === kind ? 'toggle on' : 'toggle'} onClick={() => setKind(k.id)}>{k.label}</button>
          ))}
        </span>
      </div>
      <canvas ref={ref} width={520} height={260} />
    </div>
  );
}
