import { getStroke, type StrokeOptions } from 'perfect-freehand';
import { DEFAULT_NIB_ANGLE, type InkPoint, type InkStroke, type PenType } from './model.ts';

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
  // Low streamline: the ink keeps up with the nib (smoothing still evens the outline).
  const base: StrokeOptions = { size, last, simulatePressure: !hasPressure, smoothing: 0.55, streamline: 0.12 };
  switch (pen) {
    case 'fountain':
      return { ...base, thinning: 0.62, easing: easeOutSine, start: { taper: size * 1.5, cap: true }, end: { taper: size * 2.5, cap: true } };
    case 'ballpoint':
      return { ...base, thinning: 0.18, smoothing: 0.5, streamline: 0.1, start: { cap: true }, end: { cap: true } };
    case 'pencil':
      return { ...base, thinning: 0.4, smoothing: 0.5, easing: easeOutSine, start: { taper: size, cap: true }, end: { taper: size * 1.5, cap: true } };
    case 'brush':
      return { ...base, thinning: 0.88, smoothing: 0.62, easing: easeInQuad, start: { taper: size * 4, cap: true }, end: { taper: size * 6, cap: true } };
    case 'marker':
      return { ...base, thinning: 0, simulatePressure: false, start: { cap: true }, end: { cap: true } };
    case 'highlighter':
      return { ...base, thinning: 0, simulatePressure: false, smoothing: 0.7, streamline: 0.2, start: { cap: false }, end: { cap: false } };
    case 'dashed':
      return { ...base, thinning: 0, simulatePressure: false };
    case 'calligraphy':
      // Not drawn by perfect-freehand (see `calligraphyOutline`); these options only size things
      // that need a nominal width (the hover cursor, nominalWidth).
      return { ...base, thinning: 0, simulatePressure: false };
  }
}

/**
 * Width (page units) a pen actually draws at a given pressure, mirroring perfect-freehand's
 * radius: size × easing(0.5 − thinning × (0.5 − pressure)) when the pen thins, size / 2 otherwise.
 * Used to size anything drawn to match live ink (the native instant ink tip).
 */
export function nominalWidth(pen: PenType, size: number, pressure = 0.5): number {
  const o = outlineOptions(pen, size, pressure >= 0, false);
  const p = pressure >= 0 ? Math.min(1, Math.max(0, pressure)) : 0.5;
  const thinning = o.thinning ?? 0.5;
  const easing = o.easing ?? ((t: number) => t);
  const r = thinning ? size * easing(0.5 - thinning * (0.5 - p)) : size / 2;
  return 2 * Math.max(0.01, r);
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

/**
 * Outline of a broad-nib (calligraphy) stroke: the area a flat nib of width `size` held at
 * `nibDeg` sweeps along the path — the Minkowski sum of the path with the nib. Moving across the
 * nib gives a full-width stroke, moving along it a hairline, exactly like an italic or chisel pen.
 *
 * The nib is a thin rectangle (width × hairline). At every sample the boundary point on each side
 * is the nib corner furthest out along that side's normal, so the left and right edges never cross
 * and the polygon fills cleanly with the nonzero rule in canvas, SVG and PDF. Pressure (when the
 * device reports it) opens the nib a little, like pressing a dip pen. Pure and deterministic, so
 * every renderer and export draws identical strokes.
 */
export function calligraphyOutline(points: ReadonlyArray<InkPoint>, size: number, nibDeg = DEFAULT_NIB_ANGLE): number[][] {
  // Drop repeats so directions are defined.
  const pts: InkPoint[] = [];
  for (const p of points) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 0.05) pts.push(p);
  }
  if (!pts.length) return [];
  const a = (nibDeg * Math.PI) / 180;
  const ux = Math.cos(a), uy = Math.sin(a);
  const half = size / 2;
  const hair = Math.max(0.3, size * 0.07);
  const mx = -uy * hair, my = ux * hair;
  const hasPressure = pts.some((p) => p.p >= 0);
  const k = (p: InkPoint) => (hasPressure ? 0.72 + 0.56 * Math.min(1, Math.max(0, p.p >= 0 ? p.p : 0.5)) : 1);
  if (pts.length === 1) {
    const p = pts[0]!, s = k(p);
    const nx = ux * half * s, ny = uy * half * s;
    return [[p.x + nx + mx, p.y + ny + my], [p.x + nx - mx, p.y + ny - my], [p.x - nx - mx, p.y - ny - my], [p.x - nx + mx, p.y - ny + my]];
  }
  // Light smoothing of positions (endpoints fixed) steadies the direction on noisy input.
  const sm = pts.map((p, i) => {
    if (i === 0 || i === pts.length - 1) return { x: p.x, y: p.y };
    const a0 = pts[i - 1]!, a1 = pts[i + 1]!;
    return { x: (a0.x + 2 * p.x + a1.x) / 4, y: (a0.y + 2 * p.y + a1.y) / 4 };
  });
  const left: number[][] = [];
  const right: number[][] = [];
  let lastNx = 0, lastNy = 1;
  for (let i = 0; i < sm.length; i++) {
    const p0 = sm[Math.max(0, i - 1)]!, p1 = sm[Math.min(sm.length - 1, i + 1)]!;
    let dx = p1.x - p0.x, dy = p1.y - p0.y;
    const len = Math.hypot(dx, dy);
    // Normal to the direction of travel (kept from the previous sample when the pen pauses).
    let nx = lastNx, ny = lastNy;
    if (len > 1e-6) { dx /= len; dy /= len; nx = -dy; ny = dx; lastNx = nx; lastNy = ny; }
    const s = k(pts[i]!);
    const hx = ux * half * s, hy = uy * half * s;
    // The nib corner furthest along the normal: ±half-width along the nib, ±hairline across it.
    const sa = hx * nx + hy * ny >= 0 ? 1 : -1;
    const sb = mx * nx + my * ny >= 0 ? 1 : -1;
    const cx = sa * hx + sb * mx, cy = sa * hy + sb * my;
    const p = sm[i]!;
    left.push([p.x + cx, p.y + cy]);
    right.push([p.x - cx, p.y - cy]);
  }
  return left.concat(right.reverse());
}

/** Filled outline polygon of a stroke, as [x, y] pairs. */
export function strokeOutline(stroke: Pick<InkStroke, 'pen' | 'size' | 'points'> & { shape?: InkStroke['shape']; nib?: number }, last = true): number[][] {
  const pts = stroke.points;
  if (pts.length === 0) return [];
  if (stroke.pen === 'calligraphy') return calligraphyOutline(pts, stroke.size, stroke.nib ?? DEFAULT_NIB_ANGLE);
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
