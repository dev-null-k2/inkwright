import type { InkPoint } from './model.ts';

export interface Vec2 {
  x: number;
  y: number;
}

export interface Rect {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export const EMPTY_RECT: Rect = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };

export const rect = (minX: number, minY: number, maxX: number, maxY: number): Rect => ({ minX, minY, maxX, maxY });
export const rectWidth = (r: Rect) => Math.max(0, r.maxX - r.minX);
export const rectHeight = (r: Rect) => Math.max(0, r.maxY - r.minY);
export const rectIsEmpty = (r: Rect) => r.minX > r.maxX || r.minY > r.maxY;
export const rectDiagonal = (r: Rect) => (rectIsEmpty(r) ? 0 : Math.hypot(rectWidth(r), rectHeight(r)));
export const rectCenter = (r: Rect): Vec2 => ({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });
export const rectExpand = (r: Rect, by: number): Rect => rect(r.minX - by, r.minY - by, r.maxX + by, r.maxY + by);
export function rectUnion(a: Rect, b: Rect): Rect {
  if (rectIsEmpty(a)) return b;
  if (rectIsEmpty(b)) return a;
  return rect(Math.min(a.minX, b.minX), Math.min(a.minY, b.minY), Math.max(a.maxX, b.maxX), Math.max(a.maxY, b.maxY));
}
export const rectContains = (r: Rect, x: number, y: number) => x >= r.minX && x <= r.maxX && y >= r.minY && y <= r.maxY;
export const rectIntersects = (a: Rect, b: Rect) =>
  !rectIsEmpty(a) && !rectIsEmpty(b) && a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY;
export function rectIntersection(a: Rect, b: Rect): Rect {
  const r = rect(Math.max(a.minX, b.minX), Math.max(a.minY, b.minY), Math.min(a.maxX, b.maxX), Math.min(a.maxY, b.maxY));
  return rectIsEmpty(r) ? EMPTY_RECT : r;
}
export const rectArea = (r: Rect) => rectWidth(r) * rectHeight(r);

export function boundsOf(points: ReadonlyArray<{ x: number; y: number }>): Rect {
  if (points.length === 0) return EMPTY_RECT;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function pathLength(points: ReadonlyArray<{ x: number; y: number }>): number {
  let d = 0;
  for (let i = 1; i < points.length; i++) d += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return d;
}

export function distanceToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export function distanceToPolyline(px: number, py: number, line: ReadonlyArray<{ x: number; y: number }>): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return Math.hypot(px - line[0]!.x, py - line[0]!.y);
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!;
    const b = line[i]!;
    const d = distanceToSegment(px, py, a.x, a.y, b.x, b.y);
    if (d < best) best = d;
  }
  return best;
}

export function segmentsIntersect(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
  const d1 = cross3(cx, cy, dx, dy, ax, ay);
  const d2 = cross3(cx, cy, dx, dy, bx, by);
  const d3 = cross3(ax, ay, bx, by, cx, cy);
  const d4 = cross3(ax, ay, bx, by, dx, dy);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  return false;
}

function cross3(ax: number, ay: number, bx: number, by: number, px: number, py: number) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax);
}

/** Minimum distance between two segments (0 if they cross). */
export function segmentDistance(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): number {
  if (segmentsIntersect(ax, ay, bx, by, cx, cy, dx, dy)) return 0;
  return Math.min(
    distanceToSegment(ax, ay, cx, cy, dx, dy),
    distanceToSegment(bx, by, cx, cy, dx, dy),
    distanceToSegment(cx, cy, ax, ay, bx, by),
    distanceToSegment(dx, dy, ax, ay, bx, by),
  );
}

export function pointInPolygon(x: number, y: number, poly: ReadonlyArray<Vec2>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i]!;
    const b = poly[j]!;
    if (a.y > y !== b.y > y && x < ((b.x - a.x) * (y - a.y)) / (b.y - a.y) + a.x) inside = !inside;
  }
  return inside;
}

/** Andrew's monotone chain; returns hull counter-clockwise without repeating the first point. */
export function convexHull(points: ReadonlyArray<Vec2>): Vec2[] {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  if (pts.length <= 2) return pts;
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const lower: Vec2[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: Vec2[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, p) <= 0) upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

export function polygonArea(poly: ReadonlyArray<Vec2>): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j]!.x + poly[i]!.x) * (poly[j]!.y - poly[i]!.y);
  return Math.abs(a / 2);
}

/** Angle (radians) of the principal axis of a point cloud (PCA of the covariance matrix). */
export function principalAxisAngle(points: ReadonlyArray<{ x: number; y: number }>): number {
  if (points.length < 2) return 0;
  let mx = 0, my = 0;
  for (const p of points) { mx += p.x; my += p.y; }
  mx /= points.length; my /= points.length;
  let sxx = 0, syy = 0, sxy = 0;
  for (const p of points) {
    const dx = p.x - mx, dy = p.y - my;
    sxx += dx * dx; syy += dy * dy; sxy += dx * dy;
  }
  return 0.5 * Math.atan2(2 * sxy, sxx - syy);
}

export function projectOnAxis(points: ReadonlyArray<{ x: number; y: number }>, angle: number): number[] {
  const c = Math.cos(angle), s = Math.sin(angle);
  return points.map((p) => p.x * c + p.y * s);
}

/** Counts direction reversals in a 1-D signal, ignoring wiggles smaller than [hysteresis]. */
export function countReversals(signal: ReadonlyArray<number>, hysteresis: number): number {
  if (signal.length < 3) return 0;
  let reversals = 0;
  let direction = 0; // +1 rising, -1 falling, 0 unknown
  let extreme = signal[0]!;
  for (let i = 1; i < signal.length; i++) {
    const v = signal[i]!;
    if (direction === 0) {
      if (v - extreme >= hysteresis) { direction = 1; extreme = v; }
      else if (extreme - v >= hysteresis) { direction = -1; extreme = v; }
    } else if (direction === 1) {
      if (v > extreme) extreme = v;
      else if (extreme - v >= hysteresis) { direction = -1; extreme = v; reversals++; }
    } else {
      if (v < extreme) extreme = v;
      else if (v - extreme >= hysteresis) { direction = 1; extreme = v; reversals++; }
    }
  }
  return reversals;
}

export function lerpPoint(a: InkPoint, b: InkPoint, f: number): InkPoint {
  const l = (u: number, v: number) => (u < 0 || v < 0 ? (f < 0.5 ? u : v) : u + (v - u) * f);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, t: Math.round(a.t + (b.t - a.t) * f), p: l(a.p, b.p), tilt: l(a.tilt, b.tilt), orient: l(a.orient, b.orient) };
}

/** Inserts interpolated points so no gap exceeds [maxGap]. */
export function densify(points: InkPoint[], maxGap: number): InkPoint[] {
  if (points.length < 2) return points.slice();
  const out: InkPoint[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    const n = Math.ceil(d / maxGap);
    for (let k = 1; k < n; k++) out.push(lerpPoint(a, b, k / n));
    out.push(b);
  }
  return out;
}

/** Ramer–Douglas–Peucker simplification. */
export function simplify<T extends { x: number; y: number }>(points: T[], epsilon: number): T[] {
  if (points.length < 3) return points.slice();
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let maxD = -1, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = distanceToSegment(points[i]!.x, points[i]!.y, points[s]!.x, points[s]!.y, points[e]!.x, points[e]!.y);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsilon && idx > 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

export const clamp01 = (v: number) => Math.max(0, Math.min(1, v));
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
export function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

// ---- 2D affine transforms (a c e / b d f), same convention as Canvas/DOMMatrix ---------------

export interface Affine {
  a: number; b: number; c: number; d: number; e: number; f: number;
}

export const IDENTITY: Affine = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function multiply(m: Affine, n: Affine): Affine {
  return {
    a: m.a * n.a + m.c * n.b,
    b: m.b * n.a + m.d * n.b,
    c: m.a * n.c + m.c * n.d,
    d: m.b * n.c + m.d * n.d,
    e: m.a * n.e + m.c * n.f + m.e,
    f: m.b * n.e + m.d * n.f + m.f,
  };
}

export function invert(m: Affine): Affine {
  const det = m.a * m.d - m.b * m.c;
  if (det === 0) throw new Error('Singular transform');
  return {
    a: m.d / det,
    b: -m.b / det,
    c: -m.c / det,
    d: m.a / det,
    e: (m.c * m.f - m.d * m.e) / det,
    f: (m.b * m.e - m.a * m.f) / det,
  };
}

export const applyAffine = (m: Affine, x: number, y: number): Vec2 => ({ x: m.a * x + m.c * y + m.e, y: m.b * x + m.d * y + m.f });
export const translation = (dx: number, dy: number): Affine => ({ a: 1, b: 0, c: 0, d: 1, e: dx, f: dy });
export const scaling = (s: number, cx = 0, cy = 0): Affine => ({ a: s, b: 0, c: 0, d: s, e: cx - s * cx, f: cy - s * cy });
export function rotation(rad: number, cx = 0, cy = 0): Affine {
  const c = Math.cos(rad), s = Math.sin(rad);
  return { a: c, b: s, c: -s, d: c, e: cx - c * cx + s * cy, f: cy - s * cx - c * cy };
}
