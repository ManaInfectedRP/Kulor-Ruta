// Draws titles with the browser's text engine. Preview and export share this code, and the export
// draws at its own resolution, so text stays sharp and in the same place at any output size.

import type { Id, Title } from '../core/types';
import { layoutTitle } from '../core/title';
import type { Compositor } from './compositor';

type Context = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

export function drawTitle(ctx: Context, t: Title, width: number, height: number): void {
  const px = t.size * height;
  ctx.font = `${t.italic ? 'italic ' : ''}${t.bold ? '700' : '400'} ${px}px "${t.font}", sans-serif`;
  ctx.letterSpacing = `${t.tracking * px}px`;
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  ctx.lineJoin = 'round';

  const sample = ctx.measureText('Hg');
  const layout = layoutTitle(t, width, height, {
    measure: (line) => ctx.measureText(line).width,
    ascent: sample.fontBoundingBoxAscent,
    descent: sample.fontBoundingBoxDescent,
  });

  if (t.backgroundEnabled && layout.lines.length > 0) {
    const pad = px * 0.45;
    const { x, y, width: w, height: h } = layout.box;
    ctx.globalAlpha = t.backgroundOpacity;
    ctx.fillStyle = t.backgroundColor;
    ctx.beginPath();
    ctx.roundRect(x - pad, y - pad / 2, w + pad * 2, h + pad, px * 0.12);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  const outline = t.outlineWidth * height;
  ctx.strokeStyle = t.outlineColor;
  ctx.lineWidth = outline * 2;
  ctx.fillStyle = t.color;

  const shadow = (on: boolean) => {
    ctx.shadowColor = on ? t.shadowColor : 'transparent';
    ctx.shadowBlur = on ? t.shadowBlur * height : 0;
    ctx.shadowOffsetX = on ? t.shadowOffset * height : 0;
    ctx.shadowOffsetY = on ? t.shadowOffset * height : 0;
  };

  for (const line of layout.lines) {
    // The shadow goes on whatever is drawn first. Giving it to both would double it.
    if (outline > 0) {
      shadow(t.shadowEnabled);
      ctx.strokeText(line.text, line.x, line.y);
      shadow(false);
      ctx.fillText(line.text, line.x, line.y);
    } else {
      shadow(t.shadowEnabled);
      ctx.fillText(line.text, line.x, line.y);
    }
  }
  shadow(false);
}

/** What is on each compositor's title textures, so that an unchanged title is not drawn again. */
const uploaded = new WeakMap<Compositor, Map<Id, string>>();

export function uploadTitle(compositor: Compositor, key: Id, title: Title): void {
  let known = uploaded.get(compositor);
  if (!known) {
    known = new Map();
    uploaded.set(compositor, known);
  }
  const signature = `${compositor.width}x${compositor.height}|${JSON.stringify(title)}`;
  if (known.get(key) === signature && compositor.hasImage(key)) return;

  const canvas = new OffscreenCanvas(compositor.width, compositor.height);
  drawTitle(canvas.getContext('2d')!, title, canvas.width, canvas.height);
  compositor.uploadElement(key, canvas, true);
  known.set(key, signature);
}

/** Frees textures of titles that are gone from the project. */
export function pruneTitles(compositor: Compositor, live: ReadonlySet<Id>): void {
  const known = uploaded.get(compositor);
  if (!known) return;
  for (const key of known.keys()) {
    if (live.has(key)) continue;
    compositor.releaseImage(key);
    known.delete(key);
  }
}
