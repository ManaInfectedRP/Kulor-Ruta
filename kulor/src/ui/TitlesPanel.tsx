import { useEffect, useRef } from 'react';
import { TITLE_PRESETS, type TitlePreset } from '../core/title';
import { drawTitle } from '../engine/titles';
import { addTitle } from './actions';

export const TITLE_DRAG_TYPE = 'application/x-kulor-title';

const WIDTH = 256;
const HEIGHT = 144;

function PresetCard({ preset }: { preset: TitlePreset }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#34373e';
    ctx.fillRect(0, 0, WIDTH, HEIGHT);
    drawTitle(ctx, preset.title, WIDTH, HEIGHT);
  }, [preset]);

  return (
    <div
      className="pool-item title-preset"
      draggable
      onDragStart={(e) => e.dataTransfer.setData(TITLE_DRAG_TYPE, preset.id)}
      onDoubleClick={() => addTitle(preset.id)}
      title="Dra till tidslinjen eller dubbelklicka för att lägga till vid spelhuvudet"
      data-preset={preset.id}
    >
      <canvas ref={ref} width={WIDTH} height={HEIGHT} />
      <div className="pool-name">{preset.label}</div>
    </div>
  );
}

export function TitlesPanel() {
  return (
    <div className="pool">
      <div className="pool-grid">
        {TITLE_PRESETS.map((p) => <PresetCard key={p.id} preset={p} />)}
      </div>
    </div>
  );
}
