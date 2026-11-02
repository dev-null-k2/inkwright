import { boundsOf, type Rect } from './geometry.ts';
import { strokeBounds } from './gestures.ts';
import type { InkStroke } from './model.ts';
import { emptyCells, type TableObject } from './objects.ts';
import { recognizeShape } from './shapes.ts';

/**
 * "Draw a table": recognizes a hand-drawn grid — a rectangle (snapped with hold-to-shape or
 * not) with straight lines drawn across it — so it can become a real table object. Strict on
 * purpose: lines must run (nearly) edge to edge and nothing else may be written inside the box,
 * so a boxed note with an underline, a framed heading or a sketch never turns into a table.
 */

export interface TableCandidate {
  /** Outer box in page units. */
  rect: Rect;
  /** x of each interior vertical rule, ascending. */
  xs: number[];
  /** y of each interior horizontal rule, ascending. */
  ys: number[];
  /** The strokes that make up the grid (box + rules). */
  strokeIds: string[];
  color: string;
  lineWidth: number;
}

export interface TableDetectOptions {
  /** Smallest box side (page units). */
  minSide: number;
  /** Smallest cell side. */
  minCell: number;
  /** Rules needed across the box (2 → at least a 2×2, 3×1 or 1×3 grid). */
  minRules: number;
  /** How far a rule may stop short of, or overshoot, the box edge (fraction of the side). */
  edgeSlack: number;
  /** Max tilt of a rule from horizontal/vertical, degrees. */
  maxTiltDeg: number;
}

export const DEFAULT_TABLE_DETECT: TableDetectOptions = { minSide: 40, minCell: 12, minRules: 2, edgeSlack: 0.14, maxTiltDeg: 12 };

type P = { x: number; y: number };

/** The axis-aligned box of a stroke if it is a rectangle (snapped or freehand), else null. */
export function strokeAsBox(s: InkStroke): Rect | null {
  if (s.points.length < 4) return null;
  let corners: P[] | null = null;
  if (s.shape === 'rectangle') corners = s.points;
  else {
    const r = recognizeShape(s.points);
    if (r?.kind === 'rectangle') corners = r.points;
  }
  if (!corners) return null;
  const b = boundsOf(corners);
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  // Axis-aligned: every corner of the fitted shape near a corner of its bounds.
  const tol = Math.hypot(w, h) * 0.07;
  const bc = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]] as const;
  const fit = s.shape === 'rectangle' ? s.points : corners;
  const pts = fit.length > 8 ? sampleCorners(fit) : fit;
  for (const [cx, cy] of bc) if (!pts.some((p) => Math.hypot(p.x - cx, p.y - cy) < tol)) return null;
  return b;
}

function sampleCorners(pts: readonly P[]): P[] {
  const b = boundsOf(pts);
  const bc = [[b.minX, b.minY], [b.maxX, b.minY], [b.maxX, b.maxY], [b.minX, b.maxY]] as const;
  return bc.map(([cx, cy]) => pts.reduce((best, p) => (Math.hypot(p.x - cx, p.y - cy) < Math.hypot(best.x - cx, best.y - cy) ? p : best), pts[0]!));
}

/** A straight stroke as a segment (snapped line or one recognized as straight), else null. */
export function strokeAsSegment(s: InkStroke): { a: P; b: P } | null {
  if (s.points.length < 2) return null;
  if (s.shape === 'line') return { a: s.points[0]!, b: s.points[s.points.length - 1]! };
  if (s.shape) return null;
  const r = recognizeShape(s.points);
  if (r?.kind === 'line') return { a: r.points[0]!, b: r.points[1]! };
  return null;
}

/**
 * Finds a table among `recent` strokes (the box and its rules must be among them); `all` is every
 * stroke on the page, used to make sure nothing else is written inside the box.
 */
export function detectTable(recent: readonly InkStroke[], all: readonly InkStroke[] = recent, options: Partial<TableDetectOptions> = {}): TableCandidate | null {
  const o = { ...DEFAULT_TABLE_DETECT, ...options };
  const boxes = recent.map((s) => ({ s, box: strokeAsBox(s) })).filter((x) => x.box && x.box.maxX - x.box.minX >= o.minSide && x.box.maxY - x.box.minY >= o.minSide * 0.6);
  // Newest box first: the grid the user just drew.
  boxes.sort((a, b) => b.s.createdAt - a.s.createdAt);
  for (const { s: boxStroke, box } of boxes) {
    const c = gridIn(box!, boxStroke, recent, all, o);
    if (c) return c;
  }
  return null;
}

function gridIn(box: Rect, boxStroke: InkStroke, recent: readonly InkStroke[], all: readonly InkStroke[], o: TableDetectOptions): TableCandidate | null {
  const w = box.maxX - box.minX, h = box.maxY - box.minY;
  const tilt = Math.tan((o.maxTiltDeg * Math.PI) / 180);
  const xs: number[] = [], ys: number[] = [];
  const ids = [boxStroke.id];
  const recentIds = new Set(recent.map((s) => s.id));
  const margin = Math.min(w, h) * 0.04 + 2;
  for (const s of all) {
    if (s === boxStroke || !s.points.length) continue;
    const b = strokeBounds(s);
    // Ignore ink clearly outside the box.
    if (b.maxX < box.minX - margin || b.minX > box.maxX + margin || b.maxY < box.minY - margin || b.minY > box.maxY + margin) continue;
    const seg = recentIds.has(s.id) ? strokeAsSegment(s) : null;
    const rule = seg ? asRule(seg, box, w, h, tilt, o.edgeSlack) : null;
    if (rule) {
      (rule.kind === 'h' ? ys : xs).push(rule.at);
      ids.push(s.id);
      continue;
    }
    // Anything else overlapping the box's interior means this is not (just) a grid.
    const inner = { minX: box.minX + margin, minY: box.minY + margin, maxX: box.maxX - margin, maxY: box.maxY - margin };
    if (b.maxX > inner.minX && b.minX < inner.maxX && b.maxY > inner.minY && b.minY < inner.maxY) return null;
  }
  const cx = dedupe(xs, o.minCell), cy = dedupe(ys, o.minCell);
  if (cx.length + cy.length < o.minRules) return null;
  const edgesX = [box.minX, ...cx, box.maxX], edgesY = [box.minY, ...cy, box.maxY];
  for (let i = 1; i < edgesX.length; i++) if (edgesX[i]! - edgesX[i - 1]! < o.minCell) return null;
  for (let i = 1; i < edgesY.length; i++) if (edgesY[i]! - edgesY[i - 1]! < o.minCell) return null;
  return { rect: box, xs: cx, ys: cy, strokeIds: ids, color: boxStroke.color, lineWidth: Math.max(1, Math.min(3, boxStroke.size * 0.6)) };
}

function asRule(seg: { a: P; b: P }, box: Rect, w: number, h: number, tilt: number, slack: number): { kind: 'h' | 'v'; at: number } | null {
  const dx = Math.abs(seg.b.x - seg.a.x), dy = Math.abs(seg.b.y - seg.a.y);
  if (dy <= dx * tilt) {
    const y = (seg.a.y + seg.b.y) / 2;
    const x0 = Math.min(seg.a.x, seg.b.x), x1 = Math.max(seg.a.x, seg.b.x);
    const tol = w * slack;
    if (y <= box.minY + h * 0.06 || y >= box.maxY - h * 0.06) return null;
    if (Math.abs(x0 - box.minX) > tol || Math.abs(x1 - box.maxX) > tol) return null;
    return { kind: 'h', at: y };
  }
  if (dx <= dy * tilt) {
    const x = (seg.a.x + seg.b.x) / 2;
    const y0 = Math.min(seg.a.y, seg.b.y), y1 = Math.max(seg.a.y, seg.b.y);
    const tol = h * slack;
    if (x <= box.minX + w * 0.06 || x >= box.maxX - w * 0.06) return null;
    if (Math.abs(y0 - box.minY) > tol || Math.abs(y1 - box.maxY) > tol) return null;
    return { kind: 'v', at: x };
  }
  return null;
}

function dedupe(v: number[], minGap: number): number[] {
  const s = [...v].sort((a, b) => a - b);
  const out: number[] = [];
  for (const x of s) {
    const last = out[out.length - 1];
    if (last !== undefined && x - last < minGap) out[out.length - 1] = (last + x) / 2;
    else out.push(x);
  }
  return out;
}

/** The table object for a detected grid (empty cells, the grid's colour). */
export function tableFromCandidate(c: TableCandidate, id: string, now: number): TableObject {
  const xs = [c.rect.minX, ...c.xs, c.rect.maxX], ys = [c.rect.minY, ...c.ys, c.rect.maxY];
  const cols = xs.slice(1).map((x, i) => x - xs[i]!);
  const rows = ys.slice(1).map((y, i) => y - ys[i]!);
  return { type: 'table', id, x: c.rect.minX, y: c.rect.minY, cols, rows, cells: emptyCells(rows.length, cols.length), color: c.color, lineWidth: c.lineWidth, createdAt: now };
}
