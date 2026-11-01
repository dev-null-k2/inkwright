import { boundsOf, distanceToSegment, pathLength, principalAxisAngle, rectDiagonal, simplify } from './geometry.ts';
import type { InkPoint, InkStroke, ShapeKind } from './model.ts';

export interface ShapeResult {
  kind: ShapeKind;
  /** Snapped geometry as a polyline (closed shapes repeat the first point at the end). */
  points: { x: number; y: number }[];
  /** 0..1, how well the ink matched the shape. */
  confidence: number;
}

const SNAP_DEG = 6;

/**
 * Recognizes a hand-drawn line, arrow-less polygon, triangle, rectangle or ellipse — the
 * "draw and hold to perfect it" gesture. Returns null when nothing fits well enough, so ordinary
 * handwriting is never mangled.
 */
export function recognizeShape(pointsIn: ReadonlyArray<{ x: number; y: number }>): ShapeResult | null {
  const pts = pointsIn.filter((p, i) => i === 0 || p.x !== pointsIn[i - 1]!.x || p.y !== pointsIn[i - 1]!.y);
  if (pts.length < 4) return null;
  const diag = rectDiagonal(boundsOf(pts));
  // Length of the de-jittered path: sensor noise must not make a straight line look curly.
  const len = pathLength(simplify(pts as { x: number; y: number }[], Math.max(1.5, diag * 0.01)));
  if (len < 24 || diag < 16) return null;
  const first = pts[0]!, last = pts[pts.length - 1]!;
  const gap = Math.hypot(last.x - first.x, last.y - first.y);
  const closed = gap < Math.max(14, len * 0.16);

  if (!closed) {
    // Line: every point close to the chord.
    let maxDev = 0;
    for (const p of pts) maxDev = Math.max(maxDev, distanceToSegment(p.x, p.y, first.x, first.y, last.x, last.y));
    const straightness = gap / len;
    if (maxDev < Math.max(3, gap * 0.06) && straightness > 0.9) {
      const [a, b] = snapLine(first, last);
      return { kind: 'line', points: [a, b], confidence: Math.min(1, straightness) };
    }
    return null;
  }

  // Closed: polygon via simplification, else ellipse.
  const eps = diag * 0.075;
  const closedPts = [...pts, first];
  let corners = simplify(closedPts, eps);
  // Drop the duplicated closing point and merge corners that are too close.
  corners = corners.slice(0, -1);
  corners = mergeClose(corners, diag * 0.12);
  const ellipse = fitEllipse(pts);
  const polyErr = polygonError(pts, corners);

  if (corners.length >= 3 && corners.length <= 6 && polyErr < diag * 0.045 && (!ellipse || polyErr * 1.4 < ellipse.err * diag)) {
    if (corners.length === 4) {
      const rectPts = snapRectangle(corners);
      return { kind: 'rectangle', points: [...rectPts, rectPts[0]!], confidence: 1 - polyErr / (diag * 0.045) };
    }
    const kind: ShapeKind = corners.length === 3 ? 'triangle' : 'polygon';
    return { kind, points: [...corners, corners[0]!], confidence: 1 - polyErr / (diag * 0.045) };
  }
  if (ellipse && ellipse.err < 0.11) {
    return { kind: 'ellipse', points: ellipse.points, confidence: 1 - ellipse.err / 0.11 };
  }
  return null;
}

function snapLine(a: { x: number; y: number }, b: { x: number; y: number }) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const deg = (ang * 180) / Math.PI;
  const snapped = Math.round(deg / 45) * 45;
  if (Math.abs(deg - snapped) <= SNAP_DEG) {
    const r = Math.hypot(b.x - a.x, b.y - a.y);
    const s = (snapped * Math.PI) / 180;
    return [a, { x: a.x + r * Math.cos(s), y: a.y + r * Math.sin(s) }] as const;
  }
  return [a, b] as const;
}

function mergeClose(c: { x: number; y: number }[], minDist: number) {
  const out: { x: number; y: number }[] = [];
  for (const p of c) {
    const prev = out[out.length - 1];
    if (prev && Math.hypot(p.x - prev.x, p.y - prev.y) < minDist) continue;
    out.push(p);
  }
  if (out.length > 2) {
    const a = out[0]!, z = out[out.length - 1]!;
    if (Math.hypot(a.x - z.x, a.y - z.y) < minDist) out.pop();
  }
  return out;
}

function polygonError(pts: ReadonlyArray<{ x: number; y: number }>, corners: { x: number; y: number }[]): number {
  if (corners.length < 3) return Infinity;
  let sum = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i]!, b = corners[(i + 1) % corners.length]!;
      best = Math.min(best, distanceToSegment(p.x, p.y, a.x, a.y, b.x, b.y));
    }
    sum += best;
  }
  return sum / pts.length;
}

function snapRectangle(c: { x: number; y: number }[]): { x: number; y: number }[] {
  // Fit an oriented rectangle: principal axis of the corners, snapped to axis-aligned if close.
  let angle = principalAxisAngle(c);
  const deg = ((angle * 180) / Math.PI) % 90;
  if (Math.abs(deg) <= SNAP_DEG || Math.abs(Math.abs(deg) - 90) <= SNAP_DEG) angle = 0;
  const cos = Math.cos(angle), sin = Math.sin(angle);
  const cx = c.reduce((s, p) => s + p.x, 0) / c.length;
  const cy = c.reduce((s, p) => s + p.y, 0) / c.length;
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of c) {
    const u = (p.x - cx) * cos + (p.y - cy) * sin;
    const v = -(p.x - cx) * sin + (p.y - cy) * cos;
    minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const back = (u: number, v: number) => ({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos });
  return [back(minU, minV), back(maxU, minV), back(maxU, maxV), back(minU, maxV)];
}

function fitEllipse(pts: ReadonlyArray<{ x: number; y: number }>) {
  let angle = principalAxisAngle(pts);
  let cos = Math.cos(angle), sin = Math.sin(angle);
  const mx = pts.reduce((s, p) => s + p.x, 0) / pts.length;
  const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
  // Extents in the principal frame; the ellipse centre is the middle of those extents.
  let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
  for (const p of pts) {
    const u = (p.x - mx) * cos + (p.y - my) * sin;
    const v = -(p.x - mx) * sin + (p.y - my) * cos;
    minU = Math.min(minU, u); maxU = Math.max(maxU, u); minV = Math.min(minV, v); maxV = Math.max(maxV, v);
  }
  const cu = (minU + maxU) / 2, cv = (minV + maxV) / 2;
  const cx = mx + cu * cos - cv * sin, cy = my + cu * sin + cv * cos;
  const a = (maxU - minU) / 2, b = (maxV - minV) / 2;
  if (a < 4 || b < 4) return null;
  let err = 0;
  for (const p of pts) {
    const u = (p.x - cx) * cos + (p.y - cy) * sin;
    const v = -(p.x - cx) * sin + (p.y - cy) * cos;
    err += Math.abs(Math.sqrt((u / a) ** 2 + (v / b) ** 2) - 1);
  }
  err /= pts.length;
  // A closed shape must actually go around its centre (rules out a "C" or a squiggle).
  let swept = 0;
  for (let i = 1; i < pts.length; i++) {
    const a0 = Math.atan2(pts[i - 1]!.y - cy, pts[i - 1]!.x - cx);
    const a1 = Math.atan2(pts[i]!.y - cy, pts[i]!.x - cx);
    let d = a1 - a0;
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    swept += d;
  }
  if (Math.abs(swept) < Math.PI * 1.7) return null;
  // Nearly round → perfect circle; nearly axis-aligned → snap.
  let A = a, B = b;
  if (Math.min(a, b) / Math.max(a, b) > 0.88) { A = B = (a + b) / 2; angle = 0; cos = 1; sin = 0; }
  else {
    const deg = ((angle * 180) / Math.PI) % 90;
    if (Math.abs(deg) <= SNAP_DEG || Math.abs(Math.abs(deg) - 90) <= SNAP_DEG) {
      // Snap to the nearest axis keeping which radius is horizontal.
      const horizontal = Math.abs(Math.cos(angle)) > 0.5;
      if (!horizontal) { const t = A; A = B; B = t; }
      angle = 0; cos = 1; sin = 0;
    }
  }
  const N = Math.max(48, Math.min(160, Math.round((A + B) / 2)));
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * Math.PI * 2;
    const u = A * Math.cos(t), v = B * Math.sin(t);
    out.push({ x: cx + u * cos - v * sin, y: cy + u * sin + v * cos });
  }
  return { points: out, err };
}

/** Builds a stroke from snapped shape geometry, keeping pen, color, size and timing. */
export function shapeToStroke(src: InkStroke, shape: ShapeResult): InkStroke {
  const pts = densifyPlain(shape.points, Math.max(2, src.size));
  const pressure = averagePressure(src.points);
  const duration = src.points.length ? src.points[src.points.length - 1]!.t : 0;
  const out: InkPoint[] = pts.map((p, i) => ({ x: p.x, y: p.y, t: Math.round((duration * i) / Math.max(1, pts.length - 1)), p: pressure, tilt: -1, orient: -1 }));
  return { ...src, points: out, shape: shape.kind };
}

function averagePressure(points: InkPoint[]): number {
  const ps = points.filter((p) => p.p >= 0).map((p) => p.p);
  return ps.length ? ps.reduce((a, b) => a + b, 0) / ps.length : -1;
}

function densifyPlain(pts: { x: number; y: number }[], gap: number) {
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    if (i > 0) {
      const a = pts[i - 1]!;
      const d = Math.hypot(p.x - a.x, p.y - a.y);
      const n = Math.ceil(d / gap);
      for (let k = 1; k < n; k++) out.push({ x: a.x + ((p.x - a.x) * k) / n, y: a.y + ((p.y - a.y) * k) / n });
    }
    out.push(p);
  }
  return out;
}
