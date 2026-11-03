import type { Rect } from '../geometry.ts';
import type { InkStroke } from '../model.ts';

/**
 * Geometry of single strokes, for grouping strokes into symbols and for the shapes a recognizer
 * trained on text handles badly (a lone bar, a dot, a radical sign). Everything is relative to the
 * writing's own scale (`ref`, the typical symbol height), so it works at any zoom and pen size.
 */

export interface StrokeInfo {
  s: InkStroke;
  /** Index in writing order (createdAt, then input order). */
  order: number;
  b: Rect;
  w: number;
  h: number;
  len: number;
  /** Chord angle in degrees, 0 = rightwards, 90 = downwards (page y grows down), folded to [0, 180). */
  angle: number;
  /** chord / path length: 1 for a straight line. */
  straightness: number;
  /** Largest distance of a point from the chord, relative to the chord length. */
  bulge: number;
  cx: number;
  cy: number;
}

export function strokeInfo(s: InkStroke, order: number): StrokeInfo {
  const pts = s.points;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, len = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (i) len += Math.hypot(p.x - pts[i - 1]!.x, p.y - pts[i - 1]!.y);
  }
  const a = pts[0]!, z = pts[pts.length - 1]!;
  const chord = Math.hypot(z.x - a.x, z.y - a.y);
  let bulge = 0;
  if (chord > 1e-6) {
    const nx = -(z.y - a.y) / chord, ny = (z.x - a.x) / chord;
    for (const p of pts) bulge = Math.max(bulge, Math.abs((p.x - a.x) * nx + (p.y - a.y) * ny));
    bulge /= chord;
  } else bulge = Infinity;
  let angle = (Math.atan2(z.y - a.y, z.x - a.x) * 180) / Math.PI;
  if (angle < 0) angle += 180;
  if (angle >= 180) angle -= 180;
  return {
    s, order, b: { minX, minY, maxX, maxY }, w: maxX - minX, h: maxY - minY, len,
    angle, straightness: len > 1e-6 ? chord / len : 0, bulge, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
  };
}

/** Strokes in writing order with their geometry. */
export function strokeInfos(strokes: readonly InkStroke[]): StrokeInfo[] {
  return strokes
    .filter((s) => s.points.length > 0)
    .map((s, i) => ({ s, i }))
    .sort((p, q) => p.s.createdAt - q.s.createdAt || p.i - q.i)
    .map(({ s }, order) => strokeInfo(s, order));
}

const quantile = (xs: number[], q: number) => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(q * (s.length - 1) + 0.5)))]!;
};

/**
 * The typical height of a written symbol (a digit), from the strokes that are not flat: bars and
 * dots say nothing about letter height. Falls back to the overall extent for all-flat input.
 */
export function referenceHeight(infos: readonly StrokeInfo[]): number {
  const upright = infos.filter((i) => i.h > 0.35 * i.w && i.h > 0).map((i) => i.h);
  const big = Math.max(0, ...infos.map((i) => Math.max(i.w, i.h)));
  // Ignore tiny marks when there is real writing; fractions' tall brackets don't dominate a 60th percentile.
  const tall = upright.filter((h) => h > big * 0.12);
  const q = quantile(tall.length ? tall : infos.map((i) => Math.max(i.w, i.h)), 0.6);
  return Math.max(q, 1e-3);
}

export type Primitive = 'dot' | 'hline' | 'vline' | 'slash' | 'backslash';

/** A single stroke that is a plain geometric mark, or null for anything with shape. */
export function primitiveOf(i: StrokeInfo, ref: number): Primitive | null {
  const diag = Math.hypot(i.w, i.h);
  if (diag < ref * 0.25 && i.len < ref * 0.8) return 'dot';
  const straight = i.straightness > 0.86 && i.bulge < 0.14;
  if (!straight) return null;
  const a = i.angle;
  if ((a < 20 || a > 160) && i.w > ref * 0.2) return 'hline';
  if (a > 62 && a < 118 && i.h > ref * 0.35) return 'vline';
  // y grows down: a stroke from bottom-left to top-right has its chord angle in (90, 180).
  if (a >= 118 && a <= 160) return 'slash';
  if (a >= 20 && a <= 62) return 'backslash';
  return null;
}

/**
 * A radical sign (√) drawn in one stroke: a small tick, down to a low point in the left half,
 * up to the top, then a long overline to the right.
 */
export function looksLikeRadical(i: StrokeInfo, ref: number): boolean {
  const pts = i.s.points;
  if (pts.length < 4 || i.h < ref * 0.55 || i.w < ref * 0.55) return false;
  let iBottom = 0;
  for (let k = 1; k < pts.length; k++) if (pts[k]!.y > pts[iBottom]!.y) iBottom = k;
  const bx = (pts[iBottom]!.x - i.b.minX) / i.w;
  if (bx > 0.5 || iBottom === 0 || iBottom === pts.length - 1) return false;
  if (pts[0]!.x > pts[iBottom]!.x) return false;
  // The tick starts well above the low point (a "5" starts at its bottom and curls)…
  if (pts[0]!.y > i.b.minY + i.h * 0.85) return false;
  let iTop = -1;
  for (let k = iBottom + 1; k < pts.length; k++) if (pts[k]!.y < i.b.minY + i.h * 0.22) { iTop = k; break; }
  if (iTop < 0) return false;
  // …and the rise from the low point to the top is one straight stroke.
  let rise = 0;
  for (let k = iBottom + 1; k <= iTop; k++) rise += Math.hypot(pts[k]!.x - pts[k - 1]!.x, pts[k]!.y - pts[k - 1]!.y);
  if (Math.hypot(pts[iTop]!.x - pts[iBottom]!.x, pts[iTop]!.y - pts[iBottom]!.y) < rise * 0.85) return false;
  const tail = pts.slice(iTop);
  const travel = tail[tail.length - 1]!.x - tail[0]!.x;
  const low = Math.max(...tail.map((p) => p.y));
  return travel > i.w * 0.35 && low < i.b.minY + i.h * 0.3;
}

/** The tick-and-rise part of a radical drawn as two strokes (the overline separately). */
export function looksLikeRadicalTick(i: StrokeInfo, ref: number): boolean {
  const pts = i.s.points;
  if (pts.length < 3 || i.h < ref * 0.55) return false;
  let iBottom = 0;
  for (let k = 1; k < pts.length; k++) if (pts[k]!.y > pts[iBottom]!.y) iBottom = k;
  if (iBottom === 0 || iBottom === pts.length - 1) return false;
  const end = pts[pts.length - 1]!;
  // Ends high and to the right of the low point; the low point sits in the lower part.
  return end.y < i.b.minY + i.h * 0.2 && end.x > pts[iBottom]!.x && pts[0]!.x < pts[iBottom]!.x && pts[iBottom]!.y > i.b.minY + i.h * 0.8;
}

/** Closest distance between two strokes' centrelines, and whether their segments cross. */
export function strokeContact(a: StrokeInfo, b: StrokeInfo): { dist: number; cross: boolean } {
  const pa = a.s.points, pb = b.s.points;
  let dist = Infinity, cross = false;
  if (pa.length === 1 || pb.length === 1) {
    for (const p of pa) for (const q of pb) dist = Math.min(dist, Math.hypot(p.x - q.x, p.y - q.y));
    if (pa.length > 1) for (let i = 1; i < pa.length; i++) dist = Math.min(dist, segPoint(pa[i - 1]!, pa[i]!, pb[0]!));
    if (pb.length > 1) for (let i = 1; i < pb.length; i++) dist = Math.min(dist, segPoint(pb[i - 1]!, pb[i]!, pa[0]!));
    return { dist, cross };
  }
  for (let i = 1; i < pa.length; i++) {
    const p0 = pa[i - 1]!, p1 = pa[i]!;
    for (let j = 1; j < pb.length; j++) {
      const q0 = pb[j - 1]!, q1 = pb[j]!;
      // Strictly crossing, or meeting exactly at a point inside both strokes (not at a stroke's end).
      if (segmentsCross(p0, p1, q0, q1) || (i > 1 && i < pa.length - 1 && j > 1 && j < pb.length - 1 && segmentsTouch(p0, p1, q0, q1))) { cross = true; dist = 0; continue; }
      if (dist === 0) continue;
      dist = Math.min(dist, segPoint(p0, p1, q0), segPoint(p0, p1, q1), segPoint(q0, q1, p0), segPoint(q0, q1, p1));
    }
  }
  return { dist, cross };
}

type P = { x: number; y: number };
function segPoint(a: P, b: P, p: P): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}
function segmentsCross(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function segmentsTouch(a: P, b: P, c: P, d: P): boolean {
  const o = (p: P, q: P, r: P) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
  if (d1 === 0 && d2 === 0) return false; // collinear: overlapping, not crossing
  return d1 * d2 <= 0 && d3 * d4 <= 0;
}

/** Horizontal overlap of two boxes as a fraction of the narrower one (0..1). */
export function xOverlap(a: Rect, b: Rect): number {
  const o = Math.min(a.maxX, b.maxX) - Math.max(a.minX, b.minX);
  const n = Math.max(1e-6, Math.min(a.maxX - a.minX, b.maxX - b.minX));
  return Math.max(0, Math.min(1, o / n));
}
