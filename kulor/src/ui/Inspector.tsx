import type { AnimatedProperty, Clip } from '../core/types';
import { evalProperty, hasKeyframeAt, removeKeyframe, setKeyframe, updateClip } from '../core/timeline';
import { currentVideoClip, trackKind, useStore } from '../store';
import { player } from '../engine/player';
import { Field } from './Field';
import { TitleInspector } from './TitleInspector';

interface Row {
  prop: AnimatedProperty;
  label: string;
  min?: number;
  max?: number;
  step: number;
  display: number;
  unit: string;
  reset: number;
}

const ROWS: Row[] = [
  { prop: 'x', label: 'Position X', step: 0.002, display: 100, unit: '%', reset: 0 },
  { prop: 'y', label: 'Position Y', step: 0.002, display: 100, unit: '%', reset: 0 },
  { prop: 'scale', label: 'Skala', min: 0.01, max: 10, step: 0.005, display: 100, unit: '%', reset: 1 },
  { prop: 'rotation', label: 'Rotation', step: 0.25, display: 1, unit: '°', reset: 0 },
  { prop: 'opacity', label: 'Opacitet', min: 0, max: 1, step: 0.005, display: 100, unit: '%', reset: 1 },
];

function KeyframeRow({ clip, row, local }: { clip: Clip; row: Row; local: number }) {
  const commit = useStore((s) => s.commit);
  const list = clip.keyframes[row.prop] ?? [];
  const animated = list.length > 0;
  const onKey = hasKeyframeAt(clip, row.prop, local);
  const value = evalProperty(clip, row.prop, local);
  const inside = local >= 0 && local < clip.duration;

  const change = (v: number) => {
    commit(
      (p) =>
        updateClip(p, clip.id, (c) =>
          animated && inside ? setKeyframe(c, row.prop, local, v) : { ...c, transform: { ...c.transform, [row.prop]: v } },
        ),
      `transform-${clip.id}-${row.prop}`,
    );
  };

  const toggle = () =>
    commit((p) =>
      updateClip(p, clip.id, (c) => (onKey ? removeKeyframe(c, row.prop, local) : setKeyframe(c, row.prop, local, value))),
    );

  const jump = (direction: 1 | -1) => {
    const options = list.map((k) => k.frame).filter((f) => (direction > 0 ? f > local : f < local));
    if (options.length === 0) return;
    const target = direction > 0 ? Math.min(...options) : Math.max(...options);
    player().seek(clip.start + target);
  };

  return (
    <div className="keyframe-row">
      <Field
        label={row.label}
        value={value}
        min={row.min}
        max={row.max}
        step={row.step}
        display={row.display}
        unit={row.unit}
        defaultValue={row.reset}
        onChange={change}
      />
      <button className="key-nav" disabled={!animated} onClick={() => jump(-1)} title="Föregående nyckelbild">‹</button>
      <button className={`key-toggle ${onKey ? 'on' : animated ? 'animated' : ''}`} disabled={!inside} onClick={toggle} title="Nyckelbild vid spelhuvudet">◆</button>
      <button className="key-nav" disabled={!animated} onClick={() => jump(1)} title="Nästa nyckelbild">›</button>
    </div>
  );
}

export function Inspector() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const playhead = useStore((s) => s.playhead);
  const commit = useStore((s) => s.commit);

  const selected = project.clips.find((c) => selection.includes(c.id));
  const clip = selected ?? currentVideoClip(project, selection, playhead);
  if (!clip) {
    return (
      <div className="inspector">
        <div className="panel-title">Inspektör</div>
        <div className="empty">Inget klipp valt</div>
      </div>
    );
  }

  const isVideo = trackKind(project, clip) === 'video';
  const local = playhead - clip.start;
  const set = (change: Partial<Clip>, key: string) =>
    commit((p) => updateClip(p, clip.id, (c) => ({ ...c, ...change })), `${key}-${clip.id}`);

  return (
    <div className="inspector">
      <div className="panel-title">Inspektör</div>
      <div className="inspector-clip" title={clip.name}>{clip.name}</div>

      {clip.title && <TitleInspector clip={clip} title={clip.title} />}

      {isVideo && (
        <>
          <h4>Transform</h4>
          {ROWS.map((row) => (
            <KeyframeRow key={row.prop} clip={clip} row={row} local={local} />
          ))}
          <h4>Övergångar</h4>
          <Field label="Tona in" value={clip.fadeIn} min={0} max={clip.duration} step={1} unit="bilder" defaultValue={0}
            onChange={(v) => set({ fadeIn: Math.round(v) }, 'fade-in')} />
          <Field label="Tona ut" value={clip.fadeOut} min={0} max={clip.duration} step={1} unit="bilder" defaultValue={0}
            onChange={(v) => set({ fadeOut: Math.round(v) }, 'fade-out')} />
          <Field label="Korstoning in" value={clip.dissolveIn} min={0} max={clip.duration} step={1} unit="bilder" defaultValue={0}
            onChange={(v) => set({ dissolveIn: Math.round(v) }, 'dissolve')} />
        </>
      )}

      {!isVideo && (
        <>
          <h4>Ljud</h4>
          <Field label="Volym" value={clip.gainDb} min={-60} max={12} step={0.1} unit="dB" defaultValue={0}
            onChange={(v) => set({ gainDb: v }, 'gain')} />
          <Field label="Tona in" value={clip.fadeIn} min={0} max={clip.duration} step={1} unit="bilder" defaultValue={0}
            onChange={(v) => set({ fadeIn: Math.round(v) }, 'fade-in')} />
          <Field label="Tona ut" value={clip.fadeOut} min={0} max={clip.duration} step={1} unit="bilder" defaultValue={0}
            onChange={(v) => set({ fadeOut: Math.round(v) }, 'fade-out')} />
        </>
      )}
    </div>
  );
}
