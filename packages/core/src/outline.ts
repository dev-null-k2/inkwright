import { getStroke, type StrokeOptions } from 'perfect-freehand';
import type { InkPoint, InkStroke, PenType } from './model.ts';

/**
 * How each pen looks. One geometry function feeds the screen renderer, thumbnails, SVG, PDF and
 * PNG export, so ink looks identical everywhere.
 */
export interface PenLook {
  /** Multiplier on the stroke color's alpha. */
  opacity: number;
  /** Draw with multiply blending (highlighters sit "in" the paper, under the ink). */
  multiply: boolean;
  /** Rendered as a dashed centerline instead of a filled outline. */
  dashed: boolean;
  /** Graphite grain texture inside the outline. */
  grain: boolean;
  /** Highlighters render beneath ink regardless of z-order. */
  underlay: boolean;
}

export function penLook(pen: PenType): PenLook {
  switch (pen) {
    case 'highlighter':
      return { opacity: 0.38, multiply: true, dashed: false, grain: false, underlay: true };
    case 'pencil':
      return { opacity: 0.82, multiply: false, dashed: false, grain: true, underlay: false };
    case 'marker':
      return { opacity: 0.95, multiply: false, dashed: false, grain: false, underlay: false };
    case 'dashed':
      return { opacity: 1, multiply: false, dashed: true, grain: false, underlay: false };
    default:
      return { opacity: 1, multiply: false, dashed: false, grain: false, underlay: false };
  }
}

const easeOutSine = (t: number) => Math.sin((t * Math.PI) / 2);
const easeInQuad = (t: number) => t * t;

/** perfect-freehand options per pen. `size` is the nominal tip diameter in page units. */
export function outlineOptions(pen: PenType, size: number, hasPressure: boolean, last: boolean): StrokeOptions {
  const base: StrokeOptions = { size, last, simulatePressure: !hasPressure, smoothing: 0.55, streamline: 0.32 };
  switch (pen) {
    case 'fountain':
      return { ...base, thinning: 0.62, easing: easeOutSine, start: { taper: size * 1.5, cap: true }, end: { taper: size * 2.5, cap: true } };
    case 'ballpoint':
      return { ...base, thinning: 0.18, smoothing: 0.5, streamline: 0.28, start: { cap: true }, end: { cap: true } };
    case 'pencil':
      return { ...base, thinning: 0.4, smoothing: 0.5, easing: easeOutSine, start: { taper: size, cap: true }, end: { taper: size * 1.5, cap: true } };
    case 'brush':
      return { ...base, thinning: 0.88, smoothing: 0.62, easing: easeInQuad, start: { taper: size * 4, cap: true }, end: { taper: size * 6, cap: true } };
    case 'marker':
      return { ...base, thinning: 0, simulatePressure: false, start: { cap: true }, end: { cap: true } };
    case 'highlighter':
      return { ...base, thinning: 0, simulatePressure: false, smoothing: 0.7, streamline: 0.4, start: { cap: false }, end: { cap: false } };
    case 'dashed':
      return { ...base, thinning: 0, simulatePressure: false };
  }
}

function toFreehand(points: ReadonlyArray<InkPoint>, pen?: PenType): number[][] {
  // Pencils shade wider when tilted, like the side of real graphite.
  const tiltGain = pen === 'pencil' ? 0.9 : pen === 'brush' ? 0.4 : 0;
  return points.map((p) => {
    let pr = p.p >= 0 ? Math.max(0.05, p.p) : 0.5;
    if (tiltGain && p.tilt > 0) pr = Math.min(1, pr * (1 + tiltGain * Math.min(1, p.tilt / (Math.PI / 2.4))));
    return [p.x, p.y, pr];
  });
}

/** Filled outline polygon of a stroke, as [x, y] pairs. */
export function strokeOutline(stroke: Pick<InkStroke, 'pen' | 'size' | 'points'> & { shape?: InkStroke['shape'] }, last = true): number[][] {
  const pts = stroke.points;
  if (pts.length === 0) return [];
  const hasPressure = pts.some((p) => p.p >= 0);
  const opts = outlineOptions(stroke.pen, stroke.size, hasPressure, last);
  if (stroke.shape) {
    // Snapped shapes are drawn with an even line and no tapered ends (closed shapes would notch).
    return getStroke(toFreehand(pts, stroke.pen), { ...opts, thinning: Math.min(opts.thinning ?? 0, 0.15), simulatePressure: false, start: { cap: true, taper: 0 }, end: { cap: true, taper: 0 } });
  }
  return getStroke(toFreehand(pts, stroke.pen), opts);
}

const fmt = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};
export const formatNumber = fmt;

/** Smooth closed SVG path through outline points (quadratic midpoints). */
export function outlineToSvgPath(outline: number[][]): string {
  const n = outline.length;
  if (n === 0) return '';
  if (n < 3) {
    const [x, y] = outline[0]!;
    return `M${fmt(x!)} ${fmt(y!)}Z`;
  }
  let d = `M${fmt(outline[0]![0]!)} ${fmt(outline[0]![1]!)}Q`;
  for (let i = 0; i < n; i++) {
    const [x0, y0] = outline[i]!;
    const [x1, y1] = outline[(i + 1) % n]!;
    d += `${fmt(x0!)} ${fmt(y0!)} ${fmt((x0! + x1!) / 2)} ${fmt((y0! + y1!) / 2)} `;
  }
  return d.trimEnd() + 'Z';
}

/** Centerline path (for dashed strokes and simple exports). */
export function centerlineSvgPath(points: ReadonlyArray<InkPoint>): string {
  if (points.length === 0) return '';
  let d = `M${fmt(points[0]!.x)} ${fmt(points[0]!.y)}`;
  if (points.length === 1) return d + `l0.01 0`;
  for (let i = 1; i < points.length; i++) d += `L${fmt(points[i]!.x)} ${fmt(points[i]!.y)}`;
  return d;
}

export function strokeSvgPath(stroke: InkStroke): string {
  return penLook(stroke.pen).dashed ? centerlineSvgPath(stroke.points) : outlineToSvgPath(strokeOutline(stroke));
}
