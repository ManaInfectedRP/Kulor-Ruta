import type { Clip, Title } from '../core/types';
import { applyTitleAnimation, TITLE_ANIMATIONS, TITLE_FONTS, titleName } from '../core/title';
import { updateClip } from '../core/timeline';
import { useStore } from '../store';
import { Field } from './Field';

function ColorField({ label, value, onChange }: { label: string; value: string; onChange(v: string): void }) {
  return (
    <label className="inline color-field">
      {label}
      <input type="color" value={value} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function TitleInspector({ clip, title }: { clip: Clip; title: Title }) {
  const commit = useStore((s) => s.commit);
  const fps = useStore((s) => s.project.fps);

  const set = (change: Partial<Title>, key: string) =>
    commit(
      (p) =>
        updateClip(p, clip.id, (c) => {
          const next = { ...c.title!, ...change };
          return { ...c, title: next, name: titleName(next) };
        }),
      `title-${key}-${clip.id}`,
    );

  return (
    <div className="title-inspector">
      <h4>Text</h4>
      <textarea
        className="title-text"
        rows={3}
        value={title.text}
        onChange={(e) => set({ text: e.target.value }, 'text')}
        spellCheck={false}
      />
      <label className="inline">
        Typsnitt
        <select value={title.font} onChange={(e) => set({ font: e.target.value }, 'font')}>
          {TITLE_FONTS.map((f) => <option key={f} style={{ fontFamily: f }}>{f}</option>)}
        </select>
      </label>
      <div className="title-style">
        <button className={title.bold ? 'toggle on' : 'toggle'} onClick={() => set({ bold: !title.bold }, 'bold')} title="Fet"><b>F</b></button>
        <button className={title.italic ? 'toggle on' : 'toggle'} onClick={() => set({ italic: !title.italic }, 'italic')} title="Kursiv"><i>K</i></button>
        <span className="divider" />
        {([['left', 'Vänster'], ['center', 'Mitten'], ['right', 'Höger']] as const).map(([align, label]) => (
          <button key={align} className={title.align === align ? 'toggle on' : 'toggle'} onClick={() => set({ align }, 'align')}>{label}</button>
        ))}
      </div>
      <ColorField label="Färg" value={title.color} onChange={(color) => set({ color }, 'color')} />
      <Field label="Storlek" value={title.size} min={0.01} max={0.6} step={0.001} display={100} unit="%" onChange={(size) => set({ size }, 'size')} />
      <Field label="Radavstånd" value={title.lineHeight} min={0.6} max={3} step={0.01} defaultValue={1.2} onChange={(lineHeight) => set({ lineHeight }, 'line')} />
      <Field label="Spärrning" value={title.tracking} min={-0.1} max={1} step={0.002} defaultValue={0} onChange={(tracking) => set({ tracking }, 'tracking')} />
      <Field label="Placering X" value={title.posX} min={-0.5} max={1.5} step={0.002} display={100} unit="%" defaultValue={0.5} onChange={(posX) => set({ posX }, 'pos')} />
      <Field label="Placering Y" value={title.posY} min={-0.5} max={1.5} step={0.002} display={100} unit="%" defaultValue={0.5} onChange={(posY) => set({ posY }, 'pos')} />

      <h4>Kontur</h4>
      <ColorField label="Färg" value={title.outlineColor} onChange={(outlineColor) => set({ outlineColor }, 'outline-color')} />
      <Field label="Bredd" value={title.outlineWidth} min={0} max={0.05} step={0.0005} display={100} unit="%" defaultValue={0} onChange={(outlineWidth) => set({ outlineWidth }, 'outline')} />

      <h4>Skugga</h4>
      <label className="check">
        <input type="checkbox" checked={title.shadowEnabled} onChange={(e) => set({ shadowEnabled: e.target.checked }, 'shadow-on')} /> Visa skugga
      </label>
      <ColorField label="Färg" value={title.shadowColor} onChange={(shadowColor) => set({ shadowColor }, 'shadow-color')} />
      <Field label="Oskärpa" value={title.shadowBlur} min={0} max={0.1} step={0.0005} display={100} unit="%" onChange={(shadowBlur) => set({ shadowBlur }, 'shadow-blur')} />
      <Field label="Avstånd" value={title.shadowOffset} min={0} max={0.05} step={0.0005} display={100} unit="%" onChange={(shadowOffset) => set({ shadowOffset }, 'shadow-offset')} />

      <h4>Bakgrund</h4>
      <label className="check">
        <input type="checkbox" checked={title.backgroundEnabled} onChange={(e) => set({ backgroundEnabled: e.target.checked }, 'bg-on')} /> Visa bakgrund
      </label>
      <ColorField label="Färg" value={title.backgroundColor} onChange={(backgroundColor) => set({ backgroundColor }, 'bg-color')} />
      <Field label="Täckning" value={title.backgroundOpacity} min={0} max={1} step={0.005} display={100} unit="%" onChange={(backgroundOpacity) => set({ backgroundOpacity }, 'bg-opacity')} />

      <h4>Animation</h4>
      <div className="title-style">
        {TITLE_ANIMATIONS.map((a) => (
          <button key={a.id} onClick={() => commit((p) => updateClip(p, clip.id, (c) => applyTitleAnimation(c, a.id, fps)))}>{a.label}</button>
        ))}
      </div>
    </div>
  );
}
