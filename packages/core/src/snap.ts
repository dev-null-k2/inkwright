import type { Rect } from './geometry.ts';
import { effectiveSpacing, type PaperSpec } from './model.ts';
import { paperElements } from './paper.ts';

/**
 * Snapping and alignment guides for moving and resizing things on a page (selections, images,
 * text boxes, page objects): the dragged box's edges and centre line up with other items' edges
 * and centres, the page's margins and centre, and the paper's lines or grid. Pure geometry; the
 * app draws the returned guides as thin jade lines.
 */

/** Where a snap line comes from: another item, the page edge/centre, a margin, or the paper. */
export type SnapSource = 'item' | 'page' | 'margin' | 'paper';

/** A candidate line: x = value (vertical line) or y = value (horizontal), spanning [from, to] on the other axis. */
export interface SnapLine {
  v: number;
  source: SnapSource;
  from: number;
  to: number;
  /** Which part of a target it is (edges and paper lines only snap to edges, centres to centres). */
  part: 'edge' | 'center';
}

export interface SnapTargets {
  x: SnapLine[];
  y: SnapLine[];
}

/** A guide to draw: a vertical (x) or horizontal (y) line in page units. */
export interface SnapGuide {
  axis: 'x' | 'y';
  v: number;
  from: number;
  to: number;
  source: SnapSource;
}

/** Page margin used for margin guides: half an inch (48 page units). */
export const PAGE_MARGIN = 48;

/**
 * Snap lines for a page: other items' edges and centres, the page edges, centre and margins, and
 * (when not too dense to be useful) the paper's lines/grid. `minPaperGap` is the closest two paper
 * lines may be to be offered (in page units; pass a screen distance ÷ zoom).
 */
export function snapTargets(args: { items: readonly Rect[]; page?: { width: number; height: number } | null; paper?: PaperSpec | null; minPaperGap?: number; margin?: number }): SnapTargets {
  const x: SnapLine[] = [], y: SnapLine[] = [];
  for (const r of args.items) {
    if (!Number.isFinite(r.minX) || r.maxX < r.minX) continue;
    const cx = (r.minX + r.maxX) / 2, cy = (r.minY + r.maxY) / 2;
    x.push({ v: r.minX, source: 'item', from: r.minY, to: r.maxY, part: 'edge' }, { v: r.maxX, source: 'item', from: r.minY, to: r.maxY, part: 'edge' }, { v: cx, source: 'item', from: r.minY, to: r.maxY, part: 'center' });
    y.push({ v: r.minY, source: 'item', from: r.minX, to: r.maxX, part: 'edge' }, { v: r.maxY, source: 'item', from: r.minX, to: r.maxX, part: 'edge' }, { v: cy, source: 'item', from: r.minX, to: r.maxX, part: 'center' });
  }
  const pg = args.page;
  if (pg && pg.width > 0 && pg.height > 0) {
    const m = args.margin ?? PAGE_MARGIN;
    x.push({ v: 0, source: 'page', from: 0, to: pg.height, part: 'edge' }, { v: pg.width, source: 'page', from: 0, to: pg.height, part: 'edge' }, { v: pg.width / 2, source: 'page', from: 0, to: pg.height, part: 'center' });
    y.push({ v: 0, source: 'page', from: 0, to: pg.width, part: 'edge' }, { v: pg.height, source: 'page', from: 0, to: pg.width, part: 'edge' }, { v: pg.height / 2, source: 'page', from: 0, to: pg.width, part: 'center' });
    x.push({ v: m, source: 'margin', from: 0, to: pg.height, part: 'edge' }, { v: pg.width - m, source: 'margin', from: 0, to: pg.height, part: 'edge' });
    y.push({ v: m, source: 'margin', from: 0, to: pg.width, part: 'edge' }, { v: pg.height - m, source: 'margin', from: 0, to: pg.width, part: 'edge' });
    if (args.paper) {
      const lines = paperSnapLines(args.paper, { width: pg.width, height: pg.height }, args.minPaperGap ?? 0);
      for (const v of lines.xs) x.push({ v, source: 'paper', from: 0, to: pg.height, part: 'edge' });
      for (const v of lines.ys) y.push({ v, source: 'paper', from: 0, to: pg.width, part: 'edge' });
    }
  }
  return { x, y };
}

/**
 * The paper's straight lines as snap positions: ruled lines (y), grid lines and dot rows/columns
 * (x and y). Empty for blank paper, or when the lines are closer than `minGap` (a 1 mm grid at
 * low zoom would make everything snap).
 */
export function paperSnapLines(paper: PaperSpec, page: { width: number; height: number }, minGap = 0): { xs: number[]; ys: number[] } {
  if (paper.style === 'blank' || effectiveSpacing(paper) < minGap) return { xs: [], ys: [] };
  const r = { minX: 0, minY: 0, maxX: page.width, maxY: page.height };
  const xs = new Set<number>(), ys = new Set<number>();
  const q = (v: number) => Math.round(v * 100) / 100;
  for (const e of paperElements(paper, r, r)) {
    if (e.kind === 'line') {
      if (Math.abs(e.y1 - e.y2) < 0.01 && Math.abs(e.x2 - e.x1) > page.width * 0.25) ys.add(q(e.y1));
      else if (Math.abs(e.x1 - e.x2) < 0.01 && Math.abs(e.y2 - e.y1) > page.height * 0.25) xs.add(q(e.x1));
    } else if (e.kind === 'dot') { xs.add(q(e.x)); ys.add(q(e.y)); }
  }
  const thin = (set: Set<number>) => {
    const sorted = [...set].sort((a, b) => a - b);
    const out: number[] = [];
    for (const v of sorted) if (!out.length || v - out[out.length - 1]! >= minGap) out.push(v);
    return out;
  };
  return { xs: thin(xs), ys: thin(ys) };
}

interface AxisHit { delta: number; line: SnapLine; at: number }

/** Best line for any of the moving values (edge values match edges, centres match anything). */
function bestOnAxis(values: { v: number; part: 'edge' | 'center' }[], lines: readonly SnapLine[], tol: number): AxisHit | null {
  let best: AxisHit | null = null;
  for (const m of values) {
    for (const l of lines) {
      if (m.part === 'center' && l.source === 'paper') continue;
      if (m.part === 'edge' && l.part === 'center' && l.source === 'item') continue;
      const d = l.v - m.v;
      if (Math.abs(d) > tol) continue;
      // Prefer the closest; on ties, other items over the page, the page over paper lines.
      const rank = (x: SnapLine) => (x.source === 'item' ? 0 : x.source === 'page' || x.source === 'margin' ? 1 : 2);
      if (!best || Math.abs(d) < Math.abs(best.delta) - 1e-6 || (Math.abs(Math.abs(d) - Math.abs(best.delta)) <= 1e-6 && rank(l) < rank(best.line))) best = { delta: d, line: l, at: m.v };
    }
  }
  return best;
}

function guideFor(axis: 'x' | 'y', hit: AxisHit, moved: Rect): SnapGuide {
  const lo = axis === 'x' ? moved.minY : moved.minX;
  const hi = axis === 'x' ? moved.maxY : moved.maxX;
  const full = hit.line.source !== 'item';
  return { axis, v: hit.line.v, from: full ? hit.line.from : Math.min(lo, hit.line.from), to: full ? hit.line.to : Math.max(hi, hit.line.to), source: hit.line.source };
}

/**
 * Snaps a box being moved by (dx, dy): returns the adjusted offset and the guides to show.
 * `tol` is the snap distance in page units (a few screen pixels ÷ zoom).
 */
export function snapMove(box: Rect, dx: number, dy: number, targets: SnapTargets, tol: number): { dx: number; dy: number; guides: SnapGuide[] } {
  const r = { minX: box.minX + dx, minY: box.minY + dy, maxX: box.maxX + dx, maxY: box.maxY + dy };
  const hx = bestOnAxis([{ v: r.minX, part: 'edge' }, { v: r.maxX, part: 'edge' }, { v: (r.minX + r.maxX) / 2, part: 'center' }], targets.x, tol);
  const hy = bestOnAxis([{ v: r.minY, part: 'edge' }, { v: r.maxY, part: 'edge' }, { v: (r.minY + r.maxY) / 2, part: 'center' }], targets.y, tol);
  const ndx = dx + (hx?.delta ?? 0), ndy = dy + (hy?.delta ?? 0);
  const moved = { minX: box.minX + ndx, minY: box.minY + ndy, maxX: box.maxX + ndx, maxY: box.maxY + ndy };
  const guides: SnapGuide[] = [];
  if (hx) guides.push(guideFor('x', hx, moved));
  if (hy) guides.push(guideFor('y', hy, moved));
  return { dx: ndx, dy: ndy, guides };
}

/**
 * Snaps a uniform resize about `anchor` (the box's top-left): the far corner's x or y lands on a
 * line, whichever needs the smaller change. Returns the adjusted scale and guides.
 */
export function snapScale(box: Rect, anchor: { x: number; y: number }, scale: number, targets: SnapTargets, tol: number): { scale: number; guides: SnapGuide[] } {
  const fx = anchor.x + (box.maxX - anchor.x) * scale;
  const fy = anchor.y + (box.maxY - anchor.y) * scale;
  const hx = box.maxX - anchor.x > 1e-6 ? bestOnAxis([{ v: fx, part: 'edge' }], targets.x, tol) : null;
  const hy = box.maxY - anchor.y > 1e-6 ? bestOnAxis([{ v: fy, part: 'edge' }], targets.y, tol) : null;
  const sx = hx ? (hx.line.v - anchor.x) / (box.maxX - anchor.x) : null;
  const sy = hy ? (hy.line.v - anchor.y) / (box.maxY - anchor.y) : null;
  let s = scale;
  let use: 'x' | 'y' | null = null;
  if (sx != null && (sy == null || Math.abs(sx - scale) <= Math.abs(sy - scale))) { s = sx; use = 'x'; }
  else if (sy != null) { s = sy; use = 'y'; }
  if (!(s > 0.05)) return { scale, guides: [] };
  const moved = { minX: anchor.x + (box.minX - anchor.x) * s, minY: anchor.y + (box.minY - anchor.y) * s, maxX: anchor.x + (box.maxX - anchor.x) * s, maxY: anchor.y + (box.maxY - anchor.y) * s };
  const guides: SnapGuide[] = [];
  if (use === 'x' && hx) guides.push(guideFor('x', hx, moved));
  if (use === 'y' && hy) guides.push(guideFor('y', hy, moved));
  return { scale: s, guides };
}

/**
 * Snaps a free resize of a box's bottom-right corner (stickies, tables): width and height snap
 * independently. Returns the adjusted size and guides.
 */
export function snapSize(box: Rect, width: number, height: number, targets: SnapTargets, tol: number): { width: number; height: number; guides: SnapGuide[] } {
  const hx = bestOnAxis([{ v: box.minX + width, part: 'edge' }], targets.x, tol);
  const hy = bestOnAxis([{ v: box.minY + height, part: 'edge' }], targets.y, tol);
  const w = hx ? hx.line.v - box.minX : width, h = hy ? hy.line.v - box.minY : height;
  const moved = { minX: box.minX, minY: box.minY, maxX: box.minX + w, maxY: box.minY + h };
  const guides: SnapGuide[] = [];
  if (hx) guides.push(guideFor('x', hx, moved));
  if (hy) guides.push(guideFor('y', hy, moved));
  return { width: w, height: h, guides };
}
