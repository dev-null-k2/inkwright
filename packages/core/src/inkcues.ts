import { boundsOf, pathLength, pointInPolygon, rectUnion, type Rect } from './geometry.ts';
import { boundsOfStrokes, strokeBounds } from './gestures.ts';
import type { InkStroke } from './model.ts';
import { recognizeShape } from './shapes.ts';
import { strokeAsBox } from './tables.ts';

/**
 * Geometric cues in fresh ink that suggest something the app could do — before any handwriting
 * recognition runs, so suggestions are instant, private and free:
 *  - an equals sign written at the end of a line ("2x + 3 =") → solve it;
 *  - a loop drawn around existing writing → look at what it circles (dates, numbers, links);
 *  - small boxes at the start of lines → a checklist.
 * Every detector is conservative: a missed suggestion costs nothing, a wrong one is noise.
 */

type P = { x: number; y: number };

const centre = (r: Rect): P => ({ x: (r.minX + r.maxX) / 2, y: (r.minY + r.maxY) / 2 });

/** A short, nearly horizontal straight stroke (one bar of "="), else null. */
function bar(s: InkStroke): { x0: number; x1: number; y: number; len: number } | null {
  if (s.points.length < 2) return null;
  const b = strokeBounds(s);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  if (w < 5 || w > 90 || h > Math.max(5, w * 0.3)) return null;
  // Straight enough: the path is not much longer than its extent (rules out "~" and "z").
  if (pathLength(s.points) > w * 1.35 + 4) return null;
  return { x0: b.minX, x1: b.maxX, y: (b.minY + b.maxY) / 2, len: w };
}

export interface EqualsCue {
  /** The two bars of "=". */
  equalsIds: [string, string];
  equalsRect: Rect;
  /** Handwriting on the same line to the left of "=": the problem to solve. */
  problemIds: string[];
  problemRect: Rect;
}

/**
 * "Write it followed by = and pause": the last two strokes form an equals sign and there is
 * writing to its left on the same line.
 */
export function detectTrailingEquals(strokes: readonly InkStroke[]): EqualsCue | null {
  const list = strokes.filter((s) => s.points.length && !s.origin);
  if (list.length < 3) return null;
  const byTime = [...list].sort((a, b) => a.createdAt - b.createdAt);
  const s1 = byTime[byTime.length - 2]!, s2 = byTime[byTime.length - 1]!;
  const a = bar(s1), b = bar(s2);
  if (!a || !b) return null;
  const ratio = Math.min(a.len, b.len) / Math.max(a.len, b.len);
  const overlap = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
  const gap = Math.abs(a.y - b.y);
  if (ratio < 0.45 || overlap < Math.min(a.len, b.len) * 0.5 || gap < 2.5 || gap > Math.max(26, Math.max(a.len, b.len) * 0.9)) return null;
  const eq = rectUnion(strokeBounds(s1), strokeBounds(s2));
  const cy = (eq.minY + eq.maxY) / 2;
  const unit = Math.max(eq.maxX - eq.minX, gap * 2, 14);
  // Writing on this line, right-to-left from "=", stopping at a wide gap.
  const cands = list
    .filter((s) => s !== s1 && s !== s2)
    .map((s) => ({ s, b: strokeBounds(s) }))
    .filter(({ b }) => b.maxX <= eq.minX + unit * 0.4 && Math.abs((b.minY + b.maxY) / 2 - cy) < unit * 2.2 && b.maxY - b.minY < unit * 6)
    .sort((x, y) => y.b.maxX - x.b.maxX);
  const picked: InkStroke[] = [];
  let left = eq.minX;
  for (const c of cands) {
    if (c.b.maxX < left - unit * 3.2) break;
    picked.push(c.s);
    left = Math.min(left, c.b.minX);
  }
  if (!picked.length) return null;
  return { equalsIds: [s1.id, s2.id], equalsRect: eq, problemIds: picked.map((s) => s.id), problemRect: boundsOfStrokes(picked) };
}

export interface EnclosureCue {
  loopId: string;
  /** Strokes inside the loop (written before it). */
  enclosedIds: string[];
  rect: Rect;
}

/**
 * "Circle it": the newest stroke is a closed loop (not a neat rectangle — that may be a table)
 * drawn around existing writing.
 */
export function detectEnclosure(strokes: readonly InkStroke[]): EnclosureCue | null {
  const list = strokes.filter((s) => s.points.length && !s.origin);
  if (list.length < 2) return null;
  const loop = list.reduce((a, b) => (b.createdAt > a.createdAt ? b : a));
  const pts = loop.points;
  if (pts.length < 8) return null;
  const lb = boundsOf(pts);
  const w = lb.maxX - lb.minX, h = lb.maxY - lb.minY;
  if (w < 24 || h < 14) return null;
  const len = pathLength(pts);
  const first = pts[0]!, last = pts[pts.length - 1]!;
  // Closed: ends meet (or cross over) relative to the size.
  if (Math.hypot(last.x - first.x, last.y - first.y) > Math.max(22, Math.min(w, h) * 0.45)) return null;
  if (len < (w + h) * 1.5) return null;
  // Must turn about once around its centre (not a scribble).
  const c = centre(lb);
  let swept = 0;
  for (let i = 1; i < pts.length; i++) {
    let d = Math.atan2(pts[i]!.y - c.y, pts[i]!.x - c.x) - Math.atan2(pts[i - 1]!.y - c.y, pts[i - 1]!.x - c.x);
    if (d > Math.PI) d -= 2 * Math.PI;
    if (d < -Math.PI) d += 2 * Math.PI;
    swept += d;
  }
  if (Math.abs(swept) < Math.PI * 1.6 || Math.abs(swept) > Math.PI * 3.2) return null;
  if (loop.shape === 'rectangle' || strokeAsBox(loop)) return null;
  const poly = pts.map((p) => ({ x: p.x, y: p.y }));
  const inside = list.filter((s) => {
    if (s === loop || s.createdAt > loop.createdAt) return false;
    const n = s.points.filter((p) => pointInPolygon(p.x, p.y, poly)).length;
    return n >= s.points.length * 0.8;
  });
  if (!inside.length) return null;
  return { loopId: loop.id, enclosedIds: inside.map((s) => s.id), rect: lb };
}

export interface ChecklistItemCue {
  boxId: string;
  /** A tick or cross drawn in the box. */
  checked: boolean;
  /** Writing to the right of the box on its line. */
  textIds: string[];
  rect: Rect;
}

/** Small hand-drawn boxes at the start of lines, each followed by writing: a to-do list. */
export function detectChecklist(strokes: readonly InkStroke[]): ChecklistItemCue[] {
  const list = strokes.filter((s) => s.points.length && !s.origin);
  const boxes: { s: InkStroke; b: Rect }[] = [];
  for (const s of list) {
    const b = strokeBounds(s);
    const w = b.maxX - b.minX, h = b.maxY - b.minY;
    if (w < 7 || w > 44 || h < 7 || h > 44 || w / h > 1.7 || h / w > 1.7) continue;
    const box = s.shape === 'rectangle' ? b : recognizeShape(s.points)?.kind === 'rectangle' ? b : null;
    if (box) boxes.push({ s, b: box });
  }
  const used = new Set(boxes.map((x) => x.s.id));
  const out: ChecklistItemCue[] = [];
  for (const { s, b } of boxes) {
    const size = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    const cy = (b.minY + b.maxY) / 2;
    // A mark inside the box: tick or cross.
    const marks = list.filter((t) => !used.has(t.id) && (() => { const tb = strokeBounds(t); const c = centre(tb); return c.x > b.minX && c.x < b.maxX && c.y > b.minY - size * 0.3 && c.y < b.maxY && tb.maxX - tb.minX < size * 1.6; })());
    const markIds = new Set(marks.map((m) => m.id));
    const text = list
      .filter((t) => !used.has(t.id) && !markIds.has(t.id))
      .map((t) => ({ t, tb: strokeBounds(t) }))
      .filter(({ tb }) => tb.minX > b.maxX - size * 0.2 && Math.abs((tb.minY + tb.maxY) / 2 - cy) < size * 1.1)
      .sort((x, y) => x.tb.minX - y.tb.minX);
    const textIds: string[] = [];
    let right = b.maxX;
    for (const { t, tb } of text) {
      if (tb.minX > right + size * 2.5) break;
      textIds.push(t.id);
      right = Math.max(right, tb.maxX);
    }
    if (!textIds.length) continue;
    out.push({ boxId: s.id, checked: marks.length > 0, textIds, rect: { minX: b.minX, minY: Math.min(b.minY, ...text.filter((x) => textIds.includes(x.t.id)).map((x) => x.tb.minY)), maxX: right, maxY: Math.max(b.maxY, ...text.filter((x) => textIds.includes(x.t.id)).map((x) => x.tb.maxY)) } });
    for (const m of markIds) used.add(m);
  }
  // A checklist is at least two boxes stacked at the same left edge.
  if (out.length < 2) return [];
  return out.sort((a, b) => a.rect.minY - b.rect.minY);
}

