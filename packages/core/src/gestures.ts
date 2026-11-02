import {
  boundsOf,
  convexHull,
  countReversals,
  densify,
  distanceToPolyline,
  pathLength,
  pointInPolygon,
  principalAxisAngle,
  projectOnAxis,
  rect,
  rectCenter,
  rectContains,
  rectDiagonal,
  rectExpand,
  rectHeight,
  rectIntersects,
  rectWidth,
  rectUnion,
  segmentDistance,
  simplify,
  EMPTY_RECT,
  type Rect,
  type Vec2,
} from './geometry.ts';
import { PEN_INFO, type InkPoint, type InkStroke } from './model.ts';

// ---- Scratch-out -----------------------------------------------------------------------------

export interface ScratchOutOptions {
  minPoints: number;
  minDiagonal: number;
  /** Path length ÷ longest side: a scribble goes over the same area again and again. */
  minLengthToSide: number;
  /** Direction changes along the scribble's main or cross axis. */
  minReversals: number;
  reversalHysteresisFraction: number;
  /** Fraction of the scribble that must lie on existing ink. */
  minScratchOverInk: number;
  /** A quick back-forth-back (only two reversals) counts when this much of it lies on ink. */
  minOverInkForShortScribble: number;
  /** Fraction of a target stroke that must lie inside the scribble's area. */
  minTargetCoverage: number;
  /** How far from the pen line still counts as "on" ink, in page units at 100% zoom. */
  overInkTolerance: number;
}

export const DEFAULT_SCRATCH: ScratchOutOptions = {
  minPoints: 8,
  minDiagonal: 8,
  minLengthToSide: 1.6,
  minReversals: 3,
  reversalHysteresisFraction: 0.2,
  minScratchOverInk: 0.5,
  minOverInkForShortScribble: 0.6,
  minTargetCoverage: 0.4,
  overInkTolerance: 5,
};

export interface ScratchResult {
  isScratch: boolean;
  targetIds: Set<string>;
  reason: string;
  /** Fraction of the scribble lying on ink and its zig-zag count, for tuning. */
  onInk?: number;
  reversals?: number;
}

/**
 * Recognizes the gesture of scribbling back and forth over ink to delete it, like crossing
 * something out on paper. A candidate is a scratch-out when it (1) is a dense zig-zag along either
 * axis, (2) mostly lies on existing ink and (3) mostly covers at least one stroke. Rules 2 and 3
 * keep normal writing ("m", "w", shading a box, brackets next to text) from erasing anything.
 * Measured by packages/core/evals/scratch.eval.ts.
 */
export function detectScratchOut(candidate: InkStroke, existing: InkStroke[], options: Partial<ScratchOutOptions> = {}): ScratchResult {
  const o = { ...DEFAULT_SCRATCH, ...options };
  const no = (reason: string): ScratchResult => ({ isScratch: false, targetIds: new Set(), reason });
  const pts = candidate.points;
  if (PEN_INFO[candidate.pen]?.isHighlighter) return no('highlighter');
  if (pts.length < o.minPoints) return no('too few points');
  const bounds = boundsOf(pts);
  const diag = rectDiagonal(bounds);
  if (diag < o.minDiagonal) return no('too small');
  const side = Math.max(rectWidth(bounds), rectHeight(bounds));
  if (pathLength(pts) / side < o.minLengthToSide) return no('not dense enough');
  const reversals = zigZagReversals(pts, o);
  if (reversals < Math.min(2, o.minReversals)) return no('not a zig-zag');

  const pad = candidate.size / 2 + o.overInkTolerance;
  const region = rectExpand(bounds, pad);
  const nearby = existing.filter((s) => s.id !== candidate.id && s.points.length > 0 && rectIntersects(rectExpand(boundsOf(s.points), s.size / 2), region));
  if (nearby.length === 0) return no('no ink underneath');

  // How big the writing under the scribble is, across its own line (people write uphill on
  // phones, and large): letter height sets how far a crossing-out reaches beyond the ink.
  const line = writingFrame(nearby, region);
  // Only a clear back-and-forth earns the wider reach: one loop around a word (circling it) is not
  // crossing it out.
  const strong = reversals >= 4;
  const reach = strong ? pad + 0.3 * line.letterHeight : pad;
  const step = Math.max(1, Math.floor(pts.length / 96));
  let overInk = 0, sampled = 0;
  for (let i = 0; i < pts.length; i += step) {
    sampled++;
    const p = pts[i]!;
    if (nearby.some((s) => distanceToPolyline(p.x, p.y, s.points) <= s.size / 2 + reach)) overInk++;
  }
  const onInk = overInk / sampled;
  if (onInk < o.minScratchOverInk) return { ...no('scribble mostly off ink'), onInk, reversals };
  if (reversals < o.minReversals && onInk < o.minOverInkForShortScribble) return { ...no('not a zig-zag'), onInk, reversals };

  const hull = inflate(convexHull(pts), candidate.size / 2 + Math.min(o.overInkTolerance, 3));
  const box = rectExpand(bounds, pad);
  // A strike through the middle of a word crosses out the whole word, ascenders and descenders
  // included: the covered band reaches across the writing line by most of a letter's height (but
  // not along it, so the next word is safe).
  // Three or more passes, or a quick back-and-forth that stays on the ink (striking a word out).
  const band = reversals >= 3 || (reversals >= 2 && onInk >= 0.75) ? crossLineBand(pts, line, candidate.size / 2) : null;
  const targets = new Set(nearby.filter((s) => Math.max(coverage(s, hull, box), band ? bandCoverage(s, band) : 0) >= o.minTargetCoverage && !encloses(s, pts)).map((s) => s.id));
  if (targets.size === 0) return { ...no('nothing mostly covered'), onInk, reversals };
  return { isScratch: true, targetIds: targets, reason: 'scratch-out', onInk, reversals };
}

/** The writing line's direction and typical letter height, from the ink near a scribble. */
interface WritingFrame { angle: number; letterHeight: number }
function writingFrame(nearby: InkStroke[], region: Rect): WritingFrame {
  const sample: Vec2[] = [];
  for (const s of nearby) {
    const st = Math.max(1, Math.floor(s.points.length / 16));
    for (let i = 0; i < s.points.length; i += st) { const p = s.points[i]!; if (rectContains(region, p.x, p.y)) sample.push(p); }
  }
  // A line of writing is longer than it is tall; one letter alone gives no reliable direction.
  let angle = sample.length >= 8 ? principalAxisAngle(sample) : 0;
  const box = boundsOf(sample.length ? sample : nearby.flatMap((s) => s.points));
  if (rectWidth(box) < rectHeight(box) * 1.3 && Math.abs(Math.sin(angle)) > 0.71) angle = 0;
  const heights = nearby.map((s) => {
    const v = projectOnAxis(s.points, angle + Math.PI / 2);
    let lo = Infinity, hi = -Infinity;
    for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
    return hi - lo;
  }).filter((h) => h > 0).sort((a, b) => a - b);
  const median = heights.length ? heights[Math.floor(heights.length / 2)]! : 0;
  return { angle, letterHeight: Math.min(median, 60) };
}

/** The scribble's span along the writing line, and across it widened by `extend` each side. */
interface Band { angle: number; u0: number; u1: number; v0: number; v1: number }
function crossLineBand(pts: InkPoint[], f: WritingFrame, pad: number): Band {
  const u = projectOnAxis(pts, f.angle), v = projectOnAxis(pts, f.angle + Math.PI / 2);
  // Trim the ends of the sweep along the line (loops and overshoot past the last letter): the band
  // covers the middle 84 %; the scribble's own hull still covers the letters at its ends.
  const su = [...u].sort((a, b) => a - b), sv = [...v].sort((a, b) => a - b);
  const q = (arr: number[], t: number) => arr[Math.min(arr.length - 1, Math.max(0, Math.round(t * (arr.length - 1))))]!;
  const v0 = q(sv, 0), v1 = q(sv, 1);
  // A band thinner than the letters (a strike through the middle) widens to a full letter height;
  // a scribble that already spans the letters isn't widened, so lines above and below are safe.
  const extend = Math.max(0, (1.2 * f.letterHeight - (v1 - v0)) / 2) + pad;
  return { angle: f.angle, u0: q(su, 0.08), u1: q(su, 0.92), v0: v0 - extend, v1: v1 + extend };
}
function bandCoverage(stroke: InkStroke, b: Band): number {
  if (stroke.points.length === 0) return 0;
  const u = projectOnAxis(stroke.points, b.angle), v = projectOnAxis(stroke.points, b.angle + Math.PI / 2);
  let inside = 0;
  for (let i = 0; i < u.length; i++) if (u[i]! >= b.u0 && u[i]! <= b.u1 && v[i]! >= b.v0 && v[i]! <= b.v1) inside++;
  return inside / u.length;
}

/** Most direction changes along the principal axis or across it. */
function zigZagReversals(pts: InkPoint[], o: ScratchOutOptions): number {
  const s = simplify(pts, 0.8);
  const angle = principalAxisAngle(s);
  let best = 0;
  for (const axis of [angle, angle + Math.PI / 2]) {
    const proj = projectOnAxis(s, axis);
    let lo = Infinity, hi = -Infinity;
    for (const v of proj) { if (v < lo) lo = v; if (v > hi) hi = v; }
    const range = hi - lo;
    if (range <= 0) continue;
    best = Math.max(best, countReversals(proj, Math.max(range * o.reversalHysteresisFraction, 2)));
  }
  return best;
}

/**
 * Shading inside a shape you drew: the shape is closed and holds nearly all of the scribble.
 * Scratching a shape out overshoots it, so much of the scribble lands outside.
 */
function encloses(target: InkStroke, scribble: InkPoint[]): boolean {
  const t = target.points;
  if (t.length < 8) return false;
  const tb = boundsOf(t);
  const first = t[0]!, last = t[t.length - 1]!;
  if (Math.hypot(first.x - last.x, first.y - last.y) > Math.max(6, rectDiagonal(tb) * 0.15)) return false;
  const step = Math.max(1, Math.floor(scribble.length / 48));
  let inside = 0, n = 0;
  for (let i = 0; i < scribble.length; i += step) { n++; if (pointInPolygon(scribble[i]!.x, scribble[i]!.y, t)) inside++; }
  return inside / n >= 0.8;
}

function coverage(stroke: InkStroke, hull: Vec2[], box: Rect): number {
  if (stroke.points.length === 0) return 0;
  const sb = boundsOf(stroke.points);
  // Dots and tiny marks (i-dots, full stops, accents): judged by their centre.
  if (stroke.points.length <= 3 || rectDiagonal(sb) < stroke.size * 2 + 2) {
    const c = rectCenter(sb);
    return rectContains(box, c.x, c.y) && pointInPolygon(c.x, c.y, hull) ? 1 : 0;
  }
  let inside = 0;
  for (const p of stroke.points) if (rectContains(box, p.x, p.y) && pointInPolygon(p.x, p.y, hull)) inside++;
  return inside / stroke.points.length;
}

function inflate(hull: Vec2[], by: number): Vec2[] {
  if (hull.length === 0) return hull;
  let cx = 0, cy = 0;
  for (const v of hull) { cx += v.x; cy += v.y; }
  cx /= hull.length; cy /= hull.length;
  return hull.map((v) => {
    const dx = v.x - cx, dy = v.y - cy;
    const len = Math.hypot(dx, dy);
    return len < 1e-4 ? v : { x: v.x + (dx / len) * by, y: v.y + (dy / len) * by };
  });
}

// ---- Erasing ---------------------------------------------------------------------------------

/** Ids of strokes within [radius] (+ half their width) of the eraser path. One point = a tap. */
export function hitStrokes(strokes: InkStroke[], path: InkPoint[] | Vec2[], radius: number): Set<string> {
  const out = new Set<string>();
  if (path.length === 0) return out;
  const pathBounds = rectExpand(boundsOf(path), radius);
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    const reach = radius + s.size / 2;
    if (!rectIntersects(rectExpand(boundsOf(s.points), s.size / 2), pathBounds)) continue;
    if (touches(s.points, path, reach)) out.add(s.id);
  }
  return out;
}

function touches(a: ReadonlyArray<Vec2>, b: ReadonlyArray<Vec2>, reach: number): boolean {
  if (a.length === 0 || b.length === 0) return false;
  if (a.length === 1 || b.length === 1) {
    const [single, line] = a.length === 1 ? [a, b] : [b, a];
    return distanceToPolyline(single[0]!.x, single[0]!.y, line) <= reach;
  }
  for (let i = 1; i < a.length; i++) {
    const a1 = a[i - 1]!, a2 = a[i]!;
    for (let j = 1; j < b.length; j++) {
      const b1 = b[j - 1]!, b2 = b[j]!;
      if (segmentDistance(a1.x, a1.y, a2.x, a2.y, b1.x, b1.y, b2.x, b2.y) <= reach) return true;
    }
  }
  return false;
}

export interface EraseOutcome {
  removed: InkStroke[];
  added: InkStroke[];
  /** Maps each removed stroke id to its surviving fragments, for z-order-preserving replace. */
  replacements: Map<string, InkStroke[]>;
}

/** Partial eraser: removes only the parts under the eraser, splitting strokes into fragments. */
export function erasePrecisely(
  strokes: InkStroke[],
  path: InkPoint[] | Vec2[],
  radius: number,
  newId: () => string,
  minFragmentLength = 1.5,
): EraseOutcome {
  const removed: InkStroke[] = [];
  const added: InkStroke[] = [];
  const replacements = new Map<string, InkStroke[]>();
  if (path.length === 0) return { removed, added, replacements };
  const pathBounds = rectExpand(boundsOf(path), radius);
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    const reach = radius + s.size / 2;
    if (!rectIntersects(rectExpand(boundsOf(s.points), s.size / 2), pathBounds)) continue;
    const dense = densify(s.points, Math.max(radius / 2, 0.5));
    const keep = dense.map((p) => distanceToPolyline(p.x, p.y, path) > reach);
    if (keep.every(Boolean)) continue;
    removed.push(s);
    const frags: InkStroke[] = [];
    let run: InkPoint[] = [];
    const flush = () => {
      if (run.length >= 2 && pathLength(run) >= minFragmentLength) {
        const t0 = run[0]!.t;
        frags.push({ ...s, id: newId(), points: t0 === 0 ? run : run.map((p) => ({ ...p, t: p.t - t0 })) });
      }
      run = [];
    };
    for (let i = 0; i < dense.length; i++) {
      if (keep[i]) run.push(dense[i]!);
      else flush();
    }
    flush();
    added.push(...frags);
    replacements.set(s.id, frags);
  }
  return { removed, added, replacements };
}

// ---- Lasso & transforms ----------------------------------------------------------------------

/** Strokes with at least [threshold] of their points inside the lasso. Dots: center inside. */
export function lassoSelect(strokes: InkStroke[], polygon: Vec2[], threshold = 0.6): Set<string> {
  const out = new Set<string>();
  if (polygon.length < 3) return out;
  const bounds = boundsOf(polygon);
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    const sb = boundsOf(s.points);
    if (!rectIntersects(sb, bounds)) continue;
    if (s.points.length <= 2 || rectDiagonal(sb) < 2) {
      const c = rectCenter(sb);
      if (pointInPolygon(c.x, c.y, polygon)) out.add(s.id);
      continue;
    }
    let inside = 0;
    for (const p of s.points) if (rectContains(bounds, p.x, p.y) && pointInPolygon(p.x, p.y, polygon)) inside++;
    if (inside / s.points.length >= threshold) out.add(s.id);
  }
  return out;
}

/** Whether a rectangle (text box/image) is selected by a lasso: its center is inside. */
export function lassoContainsRect(polygon: Vec2[], r: Rect): boolean {
  const c = rectCenter(r);
  return polygon.length >= 3 && pointInPolygon(c.x, c.y, polygon);
}

export function translateStroke(s: InkStroke, dx: number, dy: number): InkStroke {
  return { ...s, points: s.points.map((p) => ({ ...p, x: p.x + dx, y: p.y + dy })) };
}

/** Uniform scale about (cx, cy); tip size scales too so the ink keeps its look. */
export function scaleStroke(s: InkStroke, factor: number, cx: number, cy: number): InkStroke {
  return {
    ...s,
    size: Math.max(0.1, s.size * factor),
    points: s.points.map((p) => ({ ...p, x: cx + (p.x - cx) * factor, y: cy + (p.y - cy) * factor })),
  };
}

export function rotateStroke(s: InkStroke, radians: number, cx: number, cy: number): InkStroke {
  const c = Math.cos(radians), sn = Math.sin(radians);
  return {
    ...s,
    points: s.points.map((p) => {
      const dx = p.x - cx, dy = p.y - cy;
      return { ...p, x: cx + dx * c - dy * sn, y: cy + dx * sn + dy * c };
    }),
  };
}

export function strokeBounds(s: InkStroke): Rect {
  // The drawn outline (tapers, pressure swell, round caps) reaches up to ~1x size from the centreline.
  return rectExpand(boundsOf(s.points), s.size);
}

export function boundsOfStrokes(strokes: Iterable<InkStroke>): Rect {
  let r: Rect = EMPTY_RECT;
  for (const s of strokes) if (s.points.length) r = rectUnion(r, strokeBounds(s));
  return r;
}

// ---- Lines of writing ------------------------------------------------------------------------

export interface WritingLine {
  strokes: InkStroke[];
  bounds: Rect;
}

/**
 * Groups strokes into lines of writing, top to bottom, each ordered left to right. Recognizers
 * work far better line by line. Tall strokes (drawings, brackets) form their own groups.
 */
export function segmentLines(strokes: InkStroke[], excludeHighlighters = true): WritingLine[] {
  const items = strokes
    .filter((s) => s.points.length > 0 && !(excludeHighlighters && PEN_INFO[s.pen]?.isHighlighter))
    .map((s) => ({ s, b: boundsOf(s.points) }))
    .sort((a, b) => rectCenter(a.b).y - rectCenter(b.b).y);
  if (items.length === 0) return [];
  const heights = items.map((i) => rectHeight(i.b)).sort((a, b) => a - b);
  const typical = Math.max(6, heights[Math.floor(heights.length / 2)]!);
  const groups: { s: InkStroke; b: Rect }[][] = [];
  const bands: Rect[] = [];
  for (const item of items) {
    const b = item.b;
    const tall = rectHeight(b) > typical * 3.5;
    let placed = false;
    if (!tall) {
      for (let g = 0; g < groups.length; g++) {
        const band = bands[g]!;
        const cy = rectCenter(band).y;
        const core = rect(band.minX, cy - typical * 0.6, band.maxX, cy + typical * 0.6);
        const bc = rectCenter(b).y;
        if ((bc >= core.minY && bc <= core.maxY) || overlapFraction(b, band) > 0.5) {
          groups[g]!.push(item);
          bands[g] = rectUnion(band, b);
          placed = true;
          break;
        }
      }
    }
    if (!placed) {
      groups.push([item]);
      bands.push(b);
    }
  }
  return groups
    .map((g, i) => ({ strokes: g.sort((a, b) => a.b.minX - b.b.minX).map((x) => x.s), bounds: bands[i]! }))
    .sort((a, b) => a.bounds.minY - b.bounds.minY);
}

function overlapFraction(a: Rect, band: Rect): number {
  const top = Math.max(a.minY, band.minY);
  const bottom = Math.min(a.maxY, band.maxY);
  const h = rectHeight(a);
  if (bottom <= top || h <= 0) return 0;
  return (bottom - top) / h;
}
