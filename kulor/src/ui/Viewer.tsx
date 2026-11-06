import { useEffect, useRef } from 'react';
import { updateClip } from '../core/timeline';
import { player } from '../engine/player';
import { useStore } from '../store';
import { timelineEnd } from '../core/timeline';
import { formatTimecode } from './actions';

/** One canvas lives for the whole session and moves between pages, keeping its GL context. */
export function Viewer({ compact = false }: { compact?: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const playhead = useStore((s) => s.playhead);
  const playing = useStore((s) => s.playing);
  const fps = useStore((s) => s.project.fps);
  const end = useStore((s) => timelineEnd(s.project));
  const width = useStore((s) => s.project.width);
  const height = useStore((s) => s.project.height);
  const titleDrag = useRef<{ id: string; x: number; y: number; posX: number; posY: number } | null>(null);

  /** A selected title under the playhead can be dragged straight in the picture. */
  const startTitleDrag = (e: React.PointerEvent) => {
    const s = useStore.getState();
    const clip = s.project.clips.find(
      (c) => c.title && s.selection.includes(c.id) && s.playhead >= c.start && s.playhead < c.start + c.duration,
    );
    if (!clip?.title) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    titleDrag.current = { id: clip.id, x: e.clientX, y: e.clientY, posX: clip.title.posX, posY: clip.title.posY };
  };

  const moveTitle = (e: React.PointerEvent) => {
    const drag = titleDrag.current;
    if (!drag) return;
    // The canvas letterboxes inside its box, so one project pixel is the smaller of the two scales.
    const box = e.currentTarget.getBoundingClientRect();
    const scale = Math.min(box.width / width, box.height / height);
    const posX = drag.posX + (e.clientX - drag.x) / (width * scale);
    const posY = drag.posY + (e.clientY - drag.y) / (height * scale);
    useStore.getState().commit(
      (p) => updateClip(p, drag.id, (c) => ({ ...c, title: { ...c.title!, posX, posY } })),
      `title-pos-${drag.id}`,
    );
  };

  useEffect(() => {
    const p = player();
    host.current?.appendChild(p.canvas);
    p.invalidate();
  }, []);

  return (
    <div className={`viewer ${compact ? 'compact' : ''}`}>
      <div
        className="viewer-stage"
        ref={host}
        style={{ aspectRatio: `${width} / ${height}` }}
        onPointerDown={startTitleDrag}
        onPointerMove={moveTitle}
        onPointerUp={() => {
          titleDrag.current = null;
        }}
      />
      <div className="transport">
        <button onClick={() => player().seek(0)} title="Till början (Home)">⏮</button>
        <button onClick={() => player().seek(playhead - 1)} title="En bildruta bakåt (←)">◀</button>
        <button className="play" onClick={() => player().togglePlay()} title="Spela/pausa (mellanslag)">
          {playing ? '❚❚' : '▶'}
        </button>
        <button onClick={() => player().seek(playhead + 1)} title="En bildruta framåt (→)">▶</button>
        <button onClick={() => player().seek(end)} title="Till slutet (End)">⏭</button>
        <span className="timecode">{formatTimecode(playhead, fps)}</span>
        <span className="timecode dim">{formatTimecode(end, fps)}</span>
      </div>
    </div>
  );
}
