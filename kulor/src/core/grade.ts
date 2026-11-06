import type { CurvePoint, Grade, GradeNode, Rgbm } from './types';
import { MAX_GRADE_NODES } from './types';
import { newId } from './id';

const flat = (): Rgbm => ({ r: 0, g: 0, b: 0, m: 0 });
const identityCurve = (): CurvePoint[] => [
  { x: 0, y: 0 },
  { x: 1, y: 1 },
];

export function defaultNode(name: string): GradeNode {
  return {
    id: newId(),
    name,
    enabled: true,
    lift: flat(),
    gamma: flat(),
    gain: flat(),
    offset: flat(),
    contrast: 1,
    pivot: 0.435,
    saturation: 1,
    hue: 0,
    temperature: 0,
    tint: 0,
    curves: { m: identityCurve(), r: identityCurve(), g: identityCurve(), b: identityCurve() },
    qualifier: {
      enabled: false,
      hueCenter: 0.33,
      hueWidth: 0.2,
      satLow: 0.1,
      satHigh: 1,
      lumLow: 0,
      lumHigh: 1,
      softness: 0.1,
      invert: false,
    },
    window: { enabled: false, shape: 'ellipse', cx: 0.5, cy: 0.5, rx: 0.3, ry: 0.3, softness: 0.1, invert: false },
  };
}

export const defaultGrade = (): Grade => ({ bypass: false, nodes: [defaultNode('Nod 1')] });

function isFlat(c: Rgbm): boolean {
  return c.r === 0 && c.g === 0 && c.b === 0 && c.m === 0;
}

function isIdentityCurve(points: CurvePoint[]): boolean {
  return points.every((p) => Math.abs(p.x - p.y) < 1e-6);
}

export function isIdentityNode(n: GradeNode): boolean {
  return (
    isFlat(n.lift) && isFlat(n.gamma) && isFlat(n.gain) && isFlat(n.offset) &&
    n.contrast === 1 && n.saturation === 1 && n.hue === 0 && n.temperature === 0 && n.tint === 0 &&
    isIdentityCurve(n.curves.m) && isIdentityCurve(n.curves.r) &&
    isIdentityCurve(n.curves.g) && isIdentityCurve(n.curves.b)
  );
}

/**
 * Evaluates a monotone cubic spline (Fritsch-Carlson) through the points. Monotone so that a curve
 * dragged close to its neighbours cannot overshoot and solarise the image.
 */
export function sampleCurve(input: CurvePoint[], size: number): Float32Array {
  const points = [...input].sort((a, b) => a.x - b.x);
  const out = new Float32Array(size);
  const n = points.length;
  if (n === 0) {
    for (let i = 0; i < size; i++) out[i] = i / (size - 1);
    return out;
  }
  if (n === 1) return out.fill(points[0].y);

  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = Math.max(1e-6, points[i + 1].x - points[i].x);
    slope[i] = (points[i + 1].y - points[i].y) / dx[i];
  }

  const tangent: number[] = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const h = Math.hypot(a, b);
    if (h > 3) {
      const t = 3 / h;
      tangent[i] = t * a * slope[i];
      tangent[i + 1] = t * b * slope[i];
    }
  }

  let segment = 0;
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    if (x <= points[0].x) {
      out[i] = points[0].y;
      continue;
    }
    if (x >= points[n - 1].x) {
      out[i] = points[n - 1].y;
      continue;
    }
    while (segment < n - 2 && x > points[segment + 1].x) segment++;
    const h = dx[segment];
    const t = (x - points[segment].x) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    out[i] =
      (2 * t3 - 3 * t2 + 1) * points[segment].y +
      (t3 - 2 * t2 + t) * h * tangent[segment] +
      (-2 * t3 + 3 * t2) * points[segment + 1].y +
      (t3 - t2) * h * tangent[segment + 1];
  }
  return out;
}

export const CURVE_SIZE = 256;

/** RGBA32F data for the curve texture. One row per node: red, green, blue, master. */
export function buildCurveTexture(nodes: GradeNode[]): Float32Array {
  const data = new Float32Array(CURVE_SIZE * MAX_GRADE_NODES * 4);
  for (let row = 0; row < MAX_GRADE_NODES; row++) {
    const node = nodes[row];
    const r = node ? sampleCurve(node.curves.r, CURVE_SIZE) : null;
    const g = node ? sampleCurve(node.curves.g, CURVE_SIZE) : null;
    const b = node ? sampleCurve(node.curves.b, CURVE_SIZE) : null;
    const m = node ? sampleCurve(node.curves.m, CURVE_SIZE) : null;
    for (let i = 0; i < CURVE_SIZE; i++) {
      const at = (row * CURVE_SIZE + i) * 4;
      const identity = i / (CURVE_SIZE - 1);
      data[at] = r ? r[i] : identity;
      data[at + 1] = g ? g[i] : identity;
      data[at + 2] = b ? b[i] : identity;
      data[at + 3] = m ? m[i] : identity;
    }
  }
  return data;
}

export interface NodeUniforms {
  lift: [number, number, number];
  gamma: [number, number, number];
  gain: [number, number, number];
  offset: [number, number, number];
  /** contrast, pivot, saturation, hue in radians */
  tone: [number, number, number, number];
  /** temperature, tint, enabled, unused */
  balance: [number, number, number, number];
  /** hue centre, hue half width, softness, enabled */
  qualifierA: [number, number, number, number];
  /** saturation low/high, luma low/high */
  qualifierB: [number, number, number, number];
  /** centre x/y, radius x/y */
  windowA: [number, number, number, number];
  /** softness, shape (0 ellipse, 1 rectangle), enabled, invert mask */
  windowB: [number, number, number, number];
}

const channels = (c: Rgbm, base: number, min = -Infinity): [number, number, number] => [
  Math.max(min, base + c.r + c.m),
  Math.max(min, base + c.g + c.m),
  Math.max(min, base + c.b + c.m),
];

export function nodeUniforms(n: GradeNode): NodeUniforms {
  return {
    lift: channels(n.lift, 0),
    gamma: channels(n.gamma, 1, 0.05),
    gain: channels(n.gain, 1, 0),
    offset: channels(n.offset, 0),
    tone: [n.contrast, n.pivot, n.saturation, n.hue * Math.PI * 2],
    balance: [n.temperature, n.tint, n.enabled ? 1 : 0, 0],
    qualifierA: [n.qualifier.hueCenter, n.qualifier.hueWidth / 2, n.qualifier.softness, n.qualifier.enabled ? 1 : 0],
    qualifierB: [n.qualifier.satLow, n.qualifier.satHigh, n.qualifier.lumLow, n.qualifier.lumHigh],
    windowA: [n.window.cx, n.window.cy, n.window.rx, n.window.ry],
    windowB: [
      n.window.softness,
      n.window.shape === 'rectangle' ? 1 : 0,
      n.window.enabled ? 1 : 0,
      n.window.invert !== n.qualifier.invert ? 1 : 0,
    ],
  };
}

// Colour wheel axes in degrees. Red sits upper left, as most colourists expect.
const AXES = { r: 103.5, g: 240.5, b: 347 };

/** Each row maps (x, y) to one channel, with the mean removed so brightness stays put. */
const WHEEL_MATRIX: [number, number][] = (() => {
  const rows = [AXES.r, AXES.g, AXES.b].map((deg): [number, number] => {
    const a = (deg * Math.PI) / 180;
    return [Math.cos(a), Math.sin(a)];
  });
  const meanX = (rows[0][0] + rows[1][0] + rows[2][0]) / 3;
  const meanY = (rows[0][1] + rows[1][1] + rows[2][1]) / 3;
  return rows.map(([x, y]) => [x - meanX, y - meanY]);
})();

/** Converts a puck position (unit disc, y up) into channel offsets that leave brightness alone. */
export function wheelToChannels(x: number, y: number): { r: number; g: number; b: number } {
  const [r, g, b] = WHEEL_MATRIX.map(([mx, my]) => mx * x + my * y);
  return { r, g, b };
}

/** Least squares inverse of wheelToChannels; the axes are not 120 degrees apart, so no simple one exists. */
export function channelsToWheel(r: number, g: number, b: number): { x: number; y: number } {
  const v = [r, g, b];
  let xx = 0, xy = 0, yy = 0, xv = 0, yv = 0;
  WHEEL_MATRIX.forEach(([mx, my], i) => {
    xx += mx * mx;
    xy += mx * my;
    yy += my * my;
    xv += mx * v[i];
    yv += my * v[i];
  });
  const det = xx * yy - xy * xy;
  return { x: (yy * xv - xy * yv) / det, y: (xx * yv - xy * xv) / det };
}
