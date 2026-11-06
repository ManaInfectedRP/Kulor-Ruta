// Titles as data: defaults, presets and block layout. Drawing lives in engine/titles.ts.

import type { Clip, Title } from './types';

export const TITLE_FONTS = [
  'Segoe UI', 'Arial', 'Verdana', 'Trebuchet MS', 'Georgia', 'Times New Roman', 'Impact', 'Consolas', 'Courier New',
];

export function defaultTitle(): Title {
  return {
    text: 'Din titel',
    font: 'Segoe UI',
    size: 0.09,
    bold: true,
    italic: false,
    color: '#ffffff',
    align: 'center',
    posX: 0.5,
    posY: 0.5,
    lineHeight: 1.2,
    tracking: 0,
    outlineColor: '#000000',
    outlineWidth: 0,
    shadowEnabled: true,
    shadowColor: '#000000',
    shadowBlur: 0.012,
    shadowOffset: 0.004,
    backgroundEnabled: false,
    backgroundColor: '#000000',
    backgroundOpacity: 0.6,
  };
}

export interface TitlePreset {
  id: string;
  label: string;
  title: Title;
}

export const TITLE_PRESETS: TitlePreset[] = [
  { id: 'title', label: 'Titel', title: defaultTitle() },
  {
    id: 'lower-third',
    label: 'Nedre tredjedel',
    title: {
      ...defaultTitle(),
      text: 'Namn Namnsson\nTitel eller plats',
      size: 0.045,
      align: 'left',
      posX: 0.24,
      posY: 0.84,
      shadowEnabled: false,
      backgroundEnabled: true,
      backgroundOpacity: 0.65,
    },
  },
  {
    id: 'subtitle',
    label: 'Undertext',
    title: {
      ...defaultTitle(),
      text: 'Undertext på en rad',
      size: 0.05,
      bold: false,
      posY: 0.9,
      outlineWidth: 0.003,
      shadowEnabled: false,
    },
  },
  {
    id: 'poster',
    label: 'Affisch',
    title: {
      ...defaultTitle(),
      text: 'RUBRIK',
      font: 'Impact',
      size: 0.2,
      bold: false,
      color: '#f4b740',
      tracking: 0.04,
      outlineWidth: 0.004,
      shadowBlur: 0.02,
    },
  },
];

export const titleName = (title: Title): string => title.text.split('\n').find((l) => l.trim())?.trim() || 'Tom titel';

export interface TitleMetrics {
  /** Width of a line in pixels, for the title's font. */
  measure(line: string): number;
  ascent: number;
  descent: number;
}

export interface TitleLayout {
  /** Baseline start of each non-empty line, in pixels. */
  lines: { text: string; x: number; y: number }[];
  box: { x: number; y: number; width: number; height: number };
}

/** Places the text block so that its centre sits at posX, posY. Alignment acts within the block. */
export function layoutTitle(t: Title, width: number, height: number, metrics: TitleMetrics): TitleLayout {
  const rows = t.text.split('\n');
  const step = t.size * height * t.lineHeight;
  const widths = rows.map(metrics.measure);
  const blockWidth = Math.max(0, ...widths);
  const blockHeight = (rows.length - 1) * step + metrics.ascent + metrics.descent;
  const left = t.posX * width - blockWidth / 2;
  const top = t.posY * height - blockHeight / 2;

  const lines = rows.flatMap((text, i) => {
    if (!text) return [];
    const free = blockWidth - widths[i];
    const offset = t.align === 'left' ? 0 : t.align === 'right' ? free : free / 2;
    return [{ text, x: left + offset, y: top + metrics.ascent + i * step }];
  });
  return { lines, box: { x: left, y: top, width: blockWidth, height: blockHeight } };
}

export type TitleAnimation = 'none' | 'fade' | 'rise' | 'zoom';

export const TITLE_ANIMATIONS: { id: TitleAnimation; label: string }[] = [
  { id: 'none', label: 'Ingen' },
  { id: 'fade', label: 'Tona' },
  { id: 'rise', label: 'Glid upp' },
  { id: 'zoom', label: 'Zooma' },
];

/** Replaces the clip's fades and keyframes with a ready-made entrance. Ends keep their fade-out. */
export function applyTitleAnimation(clip: Clip, kind: TitleAnimation, fps: number): Clip {
  if (kind === 'none') return { ...clip, fadeIn: 0, fadeOut: 0, keyframes: {} };

  const half = Math.floor(clip.duration / 2);
  const fade = Math.min(half, Math.round(fps * 0.5));
  const move = Math.max(1, Math.min(half, Math.round(fps * 0.7)));
  const base = { ...clip, fadeIn: fade, fadeOut: fade, keyframes: {} };
  if (kind === 'rise') {
    return { ...base, keyframes: { y: [{ frame: 0, value: clip.transform.y + 0.06 }, { frame: move, value: clip.transform.y }] } };
  }
  if (kind === 'zoom') {
    return { ...base, keyframes: { scale: [{ frame: 0, value: clip.transform.scale * 0.85 }, { frame: move, value: clip.transform.scale }] } };
  }
  return base;
}
