import { useState } from 'react';
import type { Clip, Grade, GradeNode } from '../core/types';
import { MAX_GRADE_NODES } from '../core/types';
import { defaultGrade, defaultNode, isIdentityNode } from '../core/grade';
import { updateClip } from '../core/timeline';
import { currentVideoClip, fileUrl, trackKind, useStore } from '../store';
import { player } from '../engine/player';
import { ColorWheel } from './ColorWheel';
import { CurveEditor } from './CurveEditor';
import { Field } from './Field';
import { Scopes } from './Scopes';
import { Viewer } from './Viewer';

type Tool = 'wheels' | 'curves' | 'secondary';

let gradeClipboard: Grade | null = null;

function NodeStrip({ clip, grade, active, setGrade }: {
  clip: Clip;
  grade: Grade;
  active: GradeNode;
  setGrade(g: Grade): void;
}) {
  const setActive = useStore((s) => s.setActiveNode);
  return (
    <div className="nodes">
      <div className="panel-title">
        Noder
        <span>
          <button className="small" disabled={grade.nodes.length >= MAX_GRADE_NODES} onClick={() => {
            const node = defaultNode(`Nod ${grade.nodes.length + 1}`);
            setGrade({ ...grade, nodes: [...grade.nodes, node] });
            setActive(node.id);
          }}>+ Nod</button>
          <button className="small" disabled={grade.nodes.length < 2} onClick={() => {
            setGrade({ ...grade, nodes: grade.nodes.filter((n) => n.id !== active.id) });
            setActive(null);
          }}>Ta bort</button>
          <button className={grade.bypass ? 'small toggle on' : 'small toggle'} onClick={() => setGrade({ ...grade, bypass: !grade.bypass })} title="Visa utan färgkorrigering">Förbikoppla</button>
          <button className="small" onClick={() => { gradeClipboard = structuredClone(clip.grade); }}>Kopiera</button>
          <button className="small" onClick={() => gradeClipboard && setGrade(structuredClone(gradeClipboard))}>Klistra in</button>
          <button className="small" onClick={() => { setGrade(defaultGrade()); setActive(null); }}>Nollställ</button>
        </span>
      </div>
      <div className="node-chain">
        <span className="node-port">In</span>
        {grade.nodes.map((n, i) => (
          <div key={n.id} className="node-link">
            <span className="node-wire" />
            <button
              className={`node ${n.id === active.id ? 'active' : ''} ${n.enabled ? '' : 'off'}`}
              onClick={() => setActive(n.id)}
              onDoubleClick={() => setGrade({ ...grade, nodes: grade.nodes.map((x) => (x.id === n.id ? { ...x, enabled: !x.enabled } : x)) })}
              title="Dubbelklicka för att slå av/på noden"
            >
              <b>{i + 1}</b>
              <span>{n.name}</span>
              {!isIdentityNode(n) && <i />}
            </button>
          </div>
        ))}
        <span className="node-wire" />
        <span className="node-port">Ut</span>
      </div>
    </div>
  );
}

function Wheels({ node, set }: { node: GradeNode; set(c: Partial<GradeNode>): void }) {
  return (
    <div className="wheels-layout">
      <div className="wheels">
        <ColorWheel label="Lift" value={node.lift} range={0.25} masterRange={0.5} onChange={(lift) => set({ lift })} />
        <ColorWheel label="Gamma" value={node.gamma} range={0.5} masterRange={1} onChange={(gamma) => set({ gamma })} />
        <ColorWheel label="Gain" value={node.gain} range={0.5} masterRange={1} onChange={(gain) => set({ gain })} />
        <ColorWheel label="Offset" value={node.offset} range={0.25} masterRange={0.5} onChange={(offset) => set({ offset })} />
      </div>
      <div className="tone-fields">
        <Field label="Kontrast" value={node.contrast} min={0} max={3} step={0.005} defaultValue={1} onChange={(contrast) => set({ contrast })} />
        <Field label="Pivot" value={node.pivot} min={0} max={1} step={0.005} defaultValue={0.435} onChange={(pivot) => set({ pivot })} />
        <Field label="Mättnad" value={node.saturation} min={0} max={3} step={0.005} defaultValue={1} onChange={(saturation) => set({ saturation })} />
        <Field label="Nyans" value={node.hue} min={-0.5} max={0.5} step={0.002} display={360} unit="°" defaultValue={0} onChange={(hue) => set({ hue })} />
        <Field label="Temperatur" value={node.temperature} min={-1} max={1} step={0.005} defaultValue={0} onChange={(temperature) => set({ temperature })} />
        <Field label="Tint" value={node.tint} min={-1} max={1} step={0.005} defaultValue={0} onChange={(tint) => set({ tint })} />
      </div>
    </div>
  );
}

function Secondary({ node, set }: { node: GradeNode; set(c: Partial<GradeNode>): void }) {
  const q = node.qualifier;
  const w = node.window;
  const setQ = (c: Partial<typeof q>) => set({ qualifier: { ...q, ...c } });
  const setW = (c: Partial<typeof w>) => set({ window: { ...w, ...c } });
  return (
    <div className="secondary">
      <div>
        <label className="check">
          <input type="checkbox" checked={q.enabled} onChange={(e) => setQ({ enabled: e.target.checked })} /> HSL-kvalificerare
        </label>
        <Field label="Nyans" value={q.hueCenter} min={0} max={1} step={0.002} display={360} unit="°" onChange={(hueCenter) => setQ({ hueCenter })} />
        <Field label="Bredd" value={q.hueWidth} min={0} max={1} step={0.002} display={360} unit="°" onChange={(hueWidth) => setQ({ hueWidth })} />
        <Field label="Mättnad låg" value={q.satLow} min={0} max={1} step={0.005} onChange={(satLow) => setQ({ satLow })} />
        <Field label="Mättnad hög" value={q.satHigh} min={0} max={1} step={0.005} onChange={(satHigh) => setQ({ satHigh })} />
        <Field label="Luma låg" value={q.lumLow} min={0} max={1} step={0.005} onChange={(lumLow) => setQ({ lumLow })} />
        <Field label="Luma hög" value={q.lumHigh} min={0} max={1} step={0.005} onChange={(lumHigh) => setQ({ lumHigh })} />
        <Field label="Mjukhet" value={q.softness} min={0} max={0.5} step={0.002} onChange={(softness) => setQ({ softness })} />
      </div>
      <div>
        <label className="check">
          <input type="checkbox" checked={w.enabled} onChange={(e) => setW({ enabled: e.target.checked })} /> Maskfönster
        </label>
        <label className="inline">
          Form
          <select value={w.shape} onChange={(e) => setW({ shape: e.target.value as typeof w.shape })}>
            <option value="ellipse">Ellips</option>
            <option value="rectangle">Rektangel</option>
          </select>
        </label>
        <Field label="Mitt X" value={w.cx} min={0} max={1} step={0.002} onChange={(cx) => setW({ cx })} />
        <Field label="Mitt Y" value={w.cy} min={0} max={1} step={0.002} onChange={(cy) => setW({ cy })} />
        <Field label="Bredd" value={w.rx} min={0.01} max={1} step={0.002} onChange={(rx) => setW({ rx })} />
        <Field label="Höjd" value={w.ry} min={0.01} max={1} step={0.002} onChange={(ry) => setW({ ry })} />
        <Field label="Mjukhet" value={w.softness} min={0} max={1} step={0.002} onChange={(softness) => setW({ softness })} />
        <label className="check">
          <input type="checkbox" checked={w.invert} onChange={(e) => setW({ invert: e.target.checked })} /> Invertera masken
        </label>
      </div>
    </div>
  );
}

function ClipStrip() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const playhead = useStore((s) => s.playhead);
  const setSelection = useStore((s) => s.setSelection);
  const current = currentVideoClip(project, selection, playhead);
  const clips = project.clips
    .filter((c) => trackKind(project, c) === 'video')
    .sort((a, b) => a.start - b.start);

  return (
    <div className="clip-strip">
      {clips.map((c, i) => {
        const media = project.media.find((m) => m.id === c.mediaId);
        const graded = c.grade.nodes.some((n) => !isIdentityNode(n));
        return (
          <button
            key={c.id}
            className={`strip-clip ${current?.id === c.id ? 'active' : ''}`}
            onClick={() => {
              setSelection([c.id]);
              player().seek(c.start);
            }}
          >
            <span className="strip-thumb" style={media?.thumb ? { backgroundImage: `url("${fileUrl(media.thumb)}")` } : undefined} />
            <span className="strip-label">{i + 1}{graded ? ' ●' : ''}</span>
          </button>
        );
      })}
      {clips.length === 0 && <div className="empty">Lägg klipp på tidslinjen för att färgkorrigera</div>}
    </div>
  );
}

export function ColorPage() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const playhead = useStore((s) => s.playhead);
  const activeId = useStore((s) => s.activeNodeId);
  const commit = useStore((s) => s.commit);
  const [tool, setTool] = useState<Tool>('wheels');

  const clip = currentVideoClip(project, selection, playhead);
  const node = clip ? (clip.grade.nodes.find((n) => n.id === activeId) ?? clip.grade.nodes[0]) : null;

  const setGrade = (grade: Grade, key?: string) => {
    if (clip) commit((p) => updateClip(p, clip.id, (c) => ({ ...c, grade })), key);
  };
  const setNode = (change: Partial<GradeNode>) => {
    if (!clip || !node) return;
    setGrade(
      { ...clip.grade, nodes: clip.grade.nodes.map((n) => (n.id === node.id ? { ...n, ...change } : n)) },
      `grade-${node.id}-${Object.keys(change).join()}`,
    );
  };

  return (
    <div className="color-page">
      <section className="panel color-viewer"><Viewer compact /></section>
      <section className="panel color-scopes"><Scopes /></section>
      <section className="panel color-strip"><ClipStrip /></section>
      <section className="panel color-tools">
        {clip && node ? (
          <>
            <NodeStrip clip={clip} grade={clip.grade} active={node} setGrade={setGrade} />
            <div className="tool-tabs">
              <button className={tool === 'wheels' ? 'toggle on' : 'toggle'} onClick={() => setTool('wheels')}>Färghjul</button>
              <button className={tool === 'curves' ? 'toggle on' : 'toggle'} onClick={() => setTool('curves')}>Kurvor</button>
              <button className={tool === 'secondary' ? 'toggle on' : 'toggle'} onClick={() => setTool('secondary')}>Sekundär</button>
            </div>
            <div className="tool-body">
              {tool === 'wheels' && <Wheels node={node} set={setNode} />}
              {tool === 'curves' && <CurveEditor curves={node.curves} onChange={(curves) => setNode({ curves })} />}
              {tool === 'secondary' && <Secondary node={node} set={setNode} />}
            </div>
          </>
        ) : (
          <div className="empty">Inget klipp under spelhuvudet</div>
        )}
      </section>
    </div>
  );
}
