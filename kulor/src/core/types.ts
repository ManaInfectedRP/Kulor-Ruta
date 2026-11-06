// The project model. Plain JSON: this is exactly what a .kulor file contains.
// All timeline positions are whole frames at the project frame rate, never seconds, so that
// repeated edits cannot accumulate floating point drift.

export type Id = string;
export type MediaKind = 'video' | 'audio' | 'image';
export type ProxyState = 'none' | 'working' | 'ready' | 'failed';

export interface MediaItem {
  id: Id;
  path: string;
  name: string;
  kind: MediaKind;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
  videoCodec: string;
  audioCodec: string;
  container: string;
  sizeBytes: number;
  /** ffmpeg's colour matrix name for the source, used so export decodes the same way as preview. */
  colorMatrix: string;
  thumb?: string;
  /** True when the browser engine cannot play the original file and a proxy is required. */
  needsProxy: boolean;
  proxyPath?: string;
  proxyState: ProxyState;
  offline?: boolean;
}

export interface Rgbm {
  r: number;
  g: number;
  b: number;
  /** Master, applied equally to all channels. */
  m: number;
}

export interface CurvePoint {
  x: number;
  y: number;
}

export interface Curves {
  m: CurvePoint[];
  r: CurvePoint[];
  g: CurvePoint[];
  b: CurvePoint[];
}

export interface Qualifier {
  enabled: boolean;
  hueCenter: number; // 0..1
  hueWidth: number; // 0..1, full width of the selected hue range
  satLow: number;
  satHigh: number;
  lumLow: number;
  lumHigh: number;
  softness: number;
  invert: boolean;
}

export interface PowerWindow {
  enabled: boolean;
  shape: 'ellipse' | 'rectangle';
  cx: number; // source UV
  cy: number;
  rx: number;
  ry: number;
  softness: number;
  invert: boolean;
}

export interface GradeNode {
  id: Id;
  name: string;
  enabled: boolean;
  lift: Rgbm;
  gamma: Rgbm;
  gain: Rgbm;
  offset: Rgbm;
  contrast: number;
  pivot: number;
  saturation: number;
  hue: number; // -0.5..0.5 turns
  temperature: number; // -1..1
  tint: number; // -1..1
  curves: Curves;
  qualifier: Qualifier;
  window: PowerWindow;
}

/** Serial node chain: each node feeds the next. */
export interface Grade {
  bypass: boolean;
  nodes: GradeNode[];
}

/** Sizes are fractions of the frame height, so a title looks the same at any output resolution. */
export interface Title {
  text: string;
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
  color: string;
  align: 'left' | 'center' | 'right';
  /** Centre of the text block, as a fraction of the frame. */
  posX: number;
  posY: number;
  lineHeight: number;
  /** Extra letter spacing as a fraction of the font size. */
  tracking: number;
  outlineColor: string;
  outlineWidth: number;
  shadowEnabled: boolean;
  shadowColor: string;
  shadowBlur: number;
  shadowOffset: number;
  backgroundEnabled: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
}

export interface Transform {
  x: number; // fraction of project width, 0 is centred
  y: number; // fraction of project height, 0 is centred
  scale: number; // 1 fits the frame
  rotation: number; // degrees
  opacity: number; // 0..1
}

export type AnimatedProperty = keyof Transform;

export interface Keyframe {
  /** Frame relative to the clip's first frame. */
  frame: number;
  value: number;
}

export type Keyframes = Partial<Record<AnimatedProperty, Keyframe[]>>;

export interface Clip {
  id: Id;
  /** Empty for titles, which have no source file. */
  mediaId: Id;
  trackId: Id;
  name: string;
  /** First frame on the timeline. */
  start: number;
  /** Length in frames. */
  duration: number;
  /** First used frame in the source, counted at the project frame rate. */
  sourceIn: number;
  /** Clips of one linked A/V pair share this. */
  linkId?: Id;
  transform: Transform;
  keyframes: Keyframes;
  fadeIn: number; // frames
  fadeOut: number; // frames
  /** Frames this clip dissolves in over the clip that ends where it starts, on the same track. */
  dissolveIn: number;
  gainDb: number;
  grade: Grade;
  /** Set on title clips. */
  title?: Title;
}

export type TrackKind = 'video' | 'audio';

export interface Track {
  id: Id;
  kind: TrackKind;
  name: string;
  hidden: boolean;
  locked: boolean;
  muted: boolean;
  solo: boolean;
  gainDb: number;
  pan: number; // -1..1
}

export interface Project {
  version: 1;
  name: string;
  width: number;
  height: number;
  fps: number;
  media: MediaItem[];
  /** Video tracks are drawn bottom to top in list order, audio tracks follow them. */
  tracks: Track[];
  clips: Clip[];
  markIn: number | null;
  markOut: number | null;
}

export const SAMPLE_RATE = 48000;
export const MAX_GRADE_NODES = 8;
