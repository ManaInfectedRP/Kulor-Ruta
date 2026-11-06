import { useEffect, useRef } from 'react';
import type { Track } from '../core/types';
import { updateTrack } from '../core/timeline';
import { player } from '../engine/player';
import { useStore } from '../store';
import { Timeline } from './Timeline';

const DB_MIN = -60;

/** Falling peak meter. Green to yellow to red, on a decibel scale. */
function Meter({ trackId }: { trackId?: string }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    let raf = 0;
    let shown = 0;
    const gradient = ctx.createLinearGradient(0, canvas.height, 0, 0);
    gradient.addColorStop(0, '#39d17a');
    gradient.addColorStop(0.72, '#39d17a');
    gradient.addColorStop(0.88, '#f2c744');
    gradient.addColorStop(1, '#f25a4a');
    const draw = () => {
      const peak = player().level(trackId);
      const db = peak > 0 ? 20 * Math.log10(peak) : DB_MIN;
      const level = Math.min(1, Math.max(0, (db - DB_MIN) / -DB_MIN));
      shown = Math.max(level, shown - 0.018);
      ctx.fillStyle = '#101114';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = gradient;
      const h = shown * canvas.height;
      ctx.fillRect(0, canvas.height - h, canvas.width, h);
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [trackId]);

  return <canvas ref={ref} className="meter" width={14} height={190} />;
}

function Strip({ track }: { track: Track }) {
  const commit = useStore((s) => s.commit);
  const set = (change: Partial<Track>, key?: string) => commit((p) => updateTrack(p, track.id, change), key);
  return (
    <div className="strip">
      <div className="strip-name">{track.name}</div>
      <label className="strip-pan">
        Panorering
        <input
          type="range" min={-1} max={1} step={0.01} value={track.pan}
          onChange={(e) => set({ pan: Number(e.target.value) }, `pan-${track.id}`)}
          onDoubleClick={() => set({ pan: 0 })}
        />
      </label>
      <div className="strip-fader">
        <input
          className="fader" type="range" min={-60} max={12} step={0.1} value={track.gainDb}
          onChange={(e) => set({ gainDb: Number(e.target.value) }, `gain-${track.id}`)}
          onDoubleClick={() => set({ gainDb: 0 })}
        />
        <Meter trackId={track.id} />
      </div>
      <div className="strip-db">{track.gainDb <= -60 ? '−∞' : `${track.gainDb.toFixed(1)} dB`}</div>
      <div className="strip-buttons">
        <button className={track.muted ? 'toggle on' : 'toggle'} onClick={() => set({ muted: !track.muted })}>M</button>
        <button className={track.solo ? 'toggle on' : 'toggle'} onClick={() => set({ solo: !track.solo })}>S</button>
      </div>
    </div>
  );
}

export function AudioPage() {
  const tracks = useStore((s) => s.project.tracks);
  return (
    <div className="audio-page">
      <section className="panel mixer">
        <div className="panel-title">Mixer</div>
        <div className="strips">
          {tracks.filter((t) => t.kind === 'audio').map((t) => <Strip key={t.id} track={t} />)}
          <div className="strip master">
            <div className="strip-name">Master</div>
            <div className="strip-fader tall"><Meter /></div>
          </div>
        </div>
      </section>
      <section className="panel edit-timeline"><Timeline /></section>
    </div>
  );
}
