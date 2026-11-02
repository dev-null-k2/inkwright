import { boundsOf, convexHull, distanceToSegment, pathLength, polygonArea, rectCenter, rectContains, rectHeight, rectWidth, type Rect, type Vec2 } from '../geometry.ts';
import type { InkStroke, RecognizedLine, TextBox } from '../model.ts';

/**
 * Executable canvas, step one: a hand-drawn diagram → a typed directed graph.
 *
 * Boxes are strokes the shape snapper already turned into rectangles/ellipses/polygons, raw
 * closed loops (drawn in one go, no snapping needed), or 2–4 open strokes whose ends meet in a
 * loop (a box drawn side by side). A box inside another box makes the outer one a frame, not a
 * node. Labels are typed text boxes and recognized handwriting lines whose centre is inside a box;
 * ink inside a box that has not been recognized yet is reported per node so the app can read it.
 *
 * Every other stroke long enough to be a line is a connector candidate. Each end attaches to the
 * nearest box within a tolerance that grows with the box. Direction comes from evidence, in
 * order of strength:
 *   1. an arrowhead stroke (a small "V" or a single barb) whose tip sits at one end;
 *   2. a hook — the stroke itself turns back sharply at one end (line + barb in one stroke);
 *   3. drawing order — people draw arrows from source to target, so the start is the tail.
 * Edges record which rule decided (`by`) so the overlay can show the weaker guesses for a check.
 *
 * Cycles are found with Tarjan's strongly connected components; acyclic graphs get a
 * deterministic topological order (Kahn's algorithm, ties broken top-to-bottom, left-to-right).
 */

export interface DagNode {
  id: string;
  rect: Rect;
  /** Label text (typed, recognized, or empty until read). */
  label: string;
  labelFrom: 'typed' | 'recognized' | 'none';
  boxStrokeIds: string[];
  /** Ink inside the box that is part of its label (recognized or still to read). */
  labelStrokeIds: string[];
  /** Label ink not covered by any recognized line yet. */
  unreadStrokeIds: string[];
}

export interface DagEdge {
  id: string;
  from: string;
  to: string;
  strokeIds: string[];
  /** Which evidence fixed the direction. */
  by: 'arrowhead' | 'hook' | 'order';
}

export interface DagGraph {
  nodes: DagNode[];
  edges: DagEdge[];
  /** Strongly connected groups of node ids that form cycles (self-loops included). */
  cycles: string[][];
  /** Topological order when acyclic, else null. */
  order: string[] | null;
  /** Connector strokes that could not be attached at both ends. */
  loose: string[];
}

export interface GraphExtractOptions {
  /** Smallest box side, page units. */
  minBox?: number;
  /** Shortest connector, page units. */
  minLine?: number;
}

interface Item {
  s: InkStroke;
  pts: Vec2[];
  b: Rect;
  len: number;
}

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

function distToRect(p: Vec2, r: Rect): number {
  const dx = Math.max(r.minX - p.x, 0, p.x - r.maxX);
  const dy = Math.max(r.minY - p.y, 0, p.y - r.maxY);
  if (dx === 0 && dy === 0) return 0;
  return Math.hypot(dx, dy);
}

/** Distance from a point inside a rect to its nearest side (0 outside). */
function insideDepth(p: Vec2, r: Rect): number {
  if (!rectContains(r, p.x, p.y)) return 0;
  return Math.min(p.x - r.minX, r.maxX - p.x, p.y - r.minY, r.maxY - p.y);
}

/** A closed loop drawn in one stroke that encloses a real area. */
function isClosedLoop(it: Item, minBox: number): boolean {
  const { pts, b, len } = it;
  if (pts.length < 8 || rectWidth(b) < minBox || rectHeight(b) < minBox * 0.6) return false;
  const gap = dist(pts[0]!, pts[pts.length - 1]!);
  const perim = 2 * (rectWidth(b) + rectHeight(b));
  if (gap > Math.max(14, len * 0.15)) return false;
  if (len < perim * 0.6 || len > perim * 2.2) return false;
  const hull = convexHull(pts);
  return polygonArea(hull) >= rectWidth(b) * rectHeight(b) * 0.55;
}

/** How straight a stroke is: chord / path length (1 = a ruler line). */
function straightness(it: Item): number {
  return it.len > 0 ? dist(it.pts[0]!, it.pts[it.pts.length - 1]!) / it.len : 0;
}

/**
 * Finds a sharp turn near one end (an arrowhead drawn in the same stroke). Returns the index of
 * the tip and which end it belongs to.
 */
export function findHook(pts: readonly Vec2[]): { end: 'start' | 'end'; tip: number } | null {
  if (pts.length < 6) return null;
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + dist(pts[i - 1]!, pts[i]!));
  const total = cum[cum.length - 1]!;
  if (total <= 0) return null;
  const step = Math.max(2, total * 0.05);
  const at = (d: number) => { let i = 0; while (i < cum.length - 1 && cum[i]! < d) i++; return i; };
  let best: { end: 'start' | 'end'; tip: number; turn: number } | null = null;
  for (let i = 1; i < pts.length - 1; i++) {
    const frac = cum[i]! / total;
    const nearEnd = frac > 0.6 ? 'end' : frac < 0.4 ? 'start' : null;
    if (!nearEnd) continue;
    const a = pts[at(cum[i]! - step)]!, b = pts[i]!, c = pts[at(cum[i]! + step)]!;
    const v1 = { x: b.x - a.x, y: b.y - a.y }, v2 = { x: c.x - b.x, y: c.y - b.y };
    const n1 = Math.hypot(v1.x, v1.y), n2 = Math.hypot(v2.x, v2.y);
    if (n1 < 1e-6 || n2 < 1e-6) continue;
    const turn = Math.acos(Math.max(-1, Math.min(1, (v1.x * v2.x + v1.y * v2.y) / (n1 * n2))));
    // The barb is short compared with the shaft and doubles back (> ~110°).
    const tail = nearEnd === 'end' ? total - cum[i]! : cum[i]!;
    if (turn > (110 * Math.PI) / 180 && tail < total * 0.4 && tail > total * 0.03 && (!best || turn > best.turn)) best = { end: nearEnd, tip: i, turn };
  }
  return best ? { end: best.end, tip: best.tip } : null;
}

/** The apex of a small "V" (the point farthest from its chord), or an endpoint of a lone barb. */
function headTips(it: Item): Vec2[] {
  const { pts } = it;
  const a = pts[0]!, z = pts[pts.length - 1]!;
  let far = 0, fi = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const d = distanceToSegment(pts[i]!.x, pts[i]!.y, a.x, a.y, z.x, z.y);
    if (d > far) { far = d; fi = i; }
  }
  const chord = dist(a, z);
  if (far > chord * 0.25 && fi > 0) return [pts[fi]!];
  return [a, z]; // a single barb: either end may touch the shaft's tip
}

/**
 * Finds 2–4 open strokes that chain end to end into a closed loop: a box drawn side by side. Each
 * piece must use *both* its ends — one to meet the previous piece, the other the next — so a fan
 * of arrows leaving the same point never reads as a box.
 */
function multiStrokeBoxes(items: Item[], minBox: number): Item[][] {
  const out: Item[][] = [];
  const used = new Set<Item>();
  const ends = (x: Item): [Vec2, Vec2] => [x.pts[0]!, x.pts[x.pts.length - 1]!];
  const meets = (x: Item, ex: 0 | 1, y: Item, ey: 0 | 1) => dist(ends(x)[ex], ends(y)[ey]) <= Math.max(14, Math.max(x.len, y.len) * 0.1);
  const cands = items.filter((x) => x.len >= minBox * 0.6);
  for (const a of cands) {
    if (used.has(a)) continue;
    // Walk from a's end 1; each next piece enters at one end and leaves by the other; the loop
    // closes when the last piece's free end meets a's end 0.
    const search = (path: Item[], freeEnd: 0 | 1): Item[] | null => {
      const last = path[path.length - 1]!;
      for (const b of cands) {
        if (used.has(b) || path.includes(b)) continue;
        for (const eb of [0, 1] as const) {
          if (!meets(last, freeEnd, b, eb)) continue;
          const bFree = (1 - eb) as 0 | 1;
          const next = [...path, b];
          if (meets(b, bFree, a, 0)) {
            const pts = next.flatMap((x) => x.pts);
            const bb = boundsOf(pts);
            if (rectWidth(bb) >= minBox && rectHeight(bb) >= minBox * 0.6 && polygonArea(convexHull(pts)) >= rectWidth(bb) * rectHeight(bb) * 0.55) return next;
          }
          if (next.length < 4) { const r = search(next, bFree); if (r) return r; }
        }
      }
      return null;
    };
    const loop = search([a], 1);
    if (loop) { loop.forEach((x) => used.add(x)); out.push(loop); }
  }
  return out;
}

function textRect(t: TextBox): Rect {
  const lines = Math.max(1, t.text.split('\n').length);
  return { minX: t.x, minY: t.y, maxX: t.x + t.width, maxY: t.y + t.fontSize * 1.35 * lines };
}

/** Builds the graph (see the module comment). */
export function extractGraph(input: { strokes: readonly InkStroke[]; texts?: readonly TextBox[]; lines?: readonly RecognizedLine[] }, o: GraphExtractOptions = {}): DagGraph {
  const minBox = o.minBox ?? 28;
  const minLine = o.minLine ?? 24;
  const items: Item[] = input.strokes.filter((s) => s.points.length > 0 && s.pen !== 'highlighter').map((s) => {
    const pts = s.points.map((p) => ({ x: p.x, y: p.y }));
    return { s, pts, b: boundsOf(pts), len: pathLength(pts) };
  });

  // 1. Boxes.
  type Box = { rect: Rect; strokes: Item[] };
  const boxes: Box[] = [];
  const rest: Item[] = [];
  for (const it of items) {
    const snapped = it.s.shape === 'rectangle' || it.s.shape === 'ellipse' || it.s.shape === 'polygon' || it.s.shape === 'triangle';
    if ((snapped && rectWidth(it.b) >= minBox * 0.8 && rectHeight(it.b) >= minBox * 0.5) || isClosedLoop(it, minBox)) boxes.push({ rect: it.b, strokes: [it] });
    else rest.push(it);
  }
  // Side-by-side boxes come only from fairly straight or L-shaped pieces that are not inside another box.
  // (Inside another box — a frame — only ruler-straight sides count, never handwriting.)
  const pieces = rest.filter((it) => {
    const st = straightness(it);
    if (st <= 0.55) return false;
    const inBox = boxes.some((b) => rectContains(b.rect, rectCenter(it.b).x, rectCenter(it.b).y));
    return !inBox || (st > 0.92 && it.len >= minBox * 0.8);
  });
  for (const loop of multiStrokeBoxes(pieces, minBox)) {
    boxes.push({ rect: boundsOf(loop.flatMap((x) => x.pts)), strokes: loop });
    for (const x of loop) rest.splice(rest.indexOf(x), 1);
  }
  // A box around two or more other boxes is a frame, not a step.
  const inside = (inner: Rect, outer: Rect) => inner !== outer && inner.minX >= outer.minX - 2 && inner.maxX <= outer.maxX + 2 && inner.minY >= outer.minY - 2 && inner.maxY <= outer.maxY + 2;
  const frames = new Set(boxes.filter((b) => boxes.filter((c) => inside(c.rect, b.rect)).length >= 2));
  // A box inside exactly one other box (a double outline) merges into the outer one.
  const kept = boxes.filter((b) => !frames.has(b) && !boxes.some((c) => !frames.has(c) && c !== b && inside(b.rect, c.rect)));
  for (const b of boxes) if (!kept.includes(b) && !frames.has(b)) { const outer = kept.find((c) => inside(b.rect, c.rect)); outer?.strokes.push(...b.strokes); }
  // Reading order: top to bottom, then left to right (rows within half a box height).
  kept.sort((a, b) => (Math.abs(a.rect.minY - b.rect.minY) < Math.min(rectHeight(a.rect), rectHeight(b.rect)) / 2 ? a.rect.minX - b.rect.minX : a.rect.minY - b.rect.minY));

  const nodes: DagNode[] = kept.map((b, i) => ({ id: `n${i + 1}`, rect: b.rect, label: '', labelFrom: 'none', boxStrokeIds: b.strokes.map((x) => x.s.id), labelStrokeIds: [], unreadStrokeIds: [] }));
  const boxOf = (p: Vec2): DagNode | undefined => {
    let best: DagNode | undefined;
    for (const n of nodes) if (rectContains(n.rect, p.x, p.y) && (!best || rectWidth(n.rect) * rectHeight(n.rect) < rectWidth(best.rect) * rectHeight(best.rect))) best = n;
    return best;
  };

  // 2. Labels: ink whose centre is well inside a box belongs to it.
  const connectors: Item[] = [];
  for (const it of rest) {
    const c = rectCenter(it.b);
    const n = boxOf(c);
    const fitsInside = n && it.b.minX >= n.rect.minX - 4 && it.b.maxX <= n.rect.maxX + 4 && it.b.minY >= n.rect.minY - 4 && it.b.maxY <= n.rect.maxY + 4;
    if (n && fitsInside && insideDepth(c, n.rect) > 3) n.labelStrokeIds.push(it.s.id);
    else connectors.push(it);
  }
  for (const n of nodes) {
    const parts: { y: number; x: number; text: string; from: 'typed' | 'recognized' }[] = [];
    for (const t of input.texts ?? []) {
      const c = rectCenter(textRect(t));
      if (boxOf(c) === n && t.text.trim()) parts.push({ y: t.y, x: t.x, text: t.text.trim(), from: 'typed' });
    }
    const covered = new Set<string>();
    for (const l of input.lines ?? []) {
      const ids = l.strokeIds.filter((id) => n.labelStrokeIds.includes(id));
      const c = rectCenter(l.bounds);
      if (!ids.length && boxOf(c) !== n) continue;
      if (!l.text.trim()) continue;
      ids.forEach((id) => covered.add(id));
      parts.push({ y: l.bounds.minY, x: l.bounds.minX, text: l.text.trim(), from: 'recognized' });
    }
    parts.sort((a, b) => a.y - b.y || a.x - b.x);
    n.label = parts.map((p) => p.text).join(' ').replace(/\s+/g, ' ').trim();
    n.labelFrom = parts.some((p) => p.from === 'typed') ? 'typed' : parts.length ? 'recognized' : 'none';
    n.unreadStrokeIds = n.labelStrokeIds.filter((id) => !covered.has(id));
  }

  // 3. Connectors and arrowheads.
  const attach = (p: Vec2): DagNode | undefined => {
    let best: DagNode | undefined;
    let bd = Infinity;
    for (const n of nodes) {
      const tolN = Math.max(26, 0.35 * Math.min(rectWidth(n.rect), rectHeight(n.rect)));
      const d = distToRect(p, n.rect);
      if (d <= tolN && d < bd) { bd = d; best = n; }
    }
    return best;
  };
  // Arrowheads are small in absolute terms; a short stroke whose ends land on two different boxes
  // is a connector between close boxes, not a head.
  const joinsTwoBoxes = (it: Item) => { const a = attach(it.pts[0]!), z = attach(it.pts[it.pts.length - 1]!); return !!a && !!z && a !== z; };
  const isHeadCand = (it: Item) => Math.hypot(rectWidth(it.b), rectHeight(it.b)) < 40 && !joinsTwoBoxes(it);
  const heads = connectors.filter(isHeadCand);
  const shafts = connectors.filter((it) => it.len >= minLine && !heads.includes(it));

  // Each shaft's own ends (a hook's barb cut off at the tip).
  type Shaft = { it: Item; a: Vec2; z: Vec2; hook: 'start' | 'end' | null; heads: { h: Item; end: 'start' | 'end'; d: number }[] };
  const prepared: Shaft[] = shafts.map((it) => {
    let pts = it.pts;
    const hook = findHook(pts);
    if (hook) pts = hook.end === 'end' ? pts.slice(0, hook.tip + 1) : pts.slice(hook.tip);
    return { it, a: pts[0]!, z: pts[pts.length - 1]!, hook: hook?.end ?? null, heads: [] };
  });
  // Every head goes to the single nearest shaft end within reach (so two arrows arriving at the
  // same box never trade heads).
  const usedHeads = new Set<Item>();
  for (const h of heads) {
    const tips = headTips(h);
    let best: { sh: Shaft; end: 'start' | 'end'; d: number } | null = null;
    for (const sh of prepared) {
      const tol = Math.max(12, Math.min(26, sh.it.len * 0.12));
      for (const [end, p] of [['start', sh.a], ['end', sh.z]] as const) {
        const d = Math.min(...tips.map((t) => dist(t, p)));
        if (d <= tol && (!best || d < best.d)) best = { sh, end, d };
      }
    }
    if (best) { best.sh.heads.push({ h, end: best.end, d: best.d }); usedHeads.add(h); }
  }

  const edges: DagEdge[] = [];
  const loose: string[] = [];
  const connect = (sh: Shaft): boolean => {
    let by: DagEdge['by'] = 'order';
    let headEnd: 'start' | 'end' | null = null;
    if (sh.heads.length) {
      const atEnd = sh.heads.filter((x) => x.end === 'end').length, atStart = sh.heads.length - atEnd;
      headEnd = atEnd >= atStart ? 'end' : 'start';
      by = 'arrowhead';
    } else if (sh.hook) {
      headEnd = sh.hook;
      by = 'hook';
    }
    const { a, z } = sh;
    const from = attach(headEnd === 'start' ? z : a);
    const to = attach(headEnd === 'start' ? a : z);
    if (!from || !to || (from === to && rectContains(from.rect, a.x, a.y) && rectContains(from.rect, z.x, z.y))) return false;
    edges.push({ id: `e${edges.length + 1}`, from: from.id, to: to.id, strokeIds: [sh.it.s.id, ...sh.heads.map((x) => x.h.s.id)], by });
    return true;
  };
  for (const sh of prepared) if (!connect(sh)) loose.push(sh.it.s.id, ...sh.heads.map((x) => x.h.s.id));
  // Small strokes no shaft claimed and long enough to be lines: try them as connectors.
  for (const h of heads) {
    if (usedHeads.has(h) || h.len < minLine) continue;
    const hook = findHook(h.pts);
    const pts = hook ? (hook.end === 'end' ? h.pts.slice(0, hook.tip + 1) : h.pts.slice(hook.tip)) : h.pts;
    if (!connect({ it: h, a: pts[0]!, z: pts[pts.length - 1]!, hook: hook?.end ?? null, heads: [] })) loose.push(h.s.id);
  }

  const cycles = findGraphCycles(nodes.map((n) => n.id), edges);
  return { nodes, edges, cycles, order: cycles.length ? null : topoOrder(nodes, edges), loose };
}

/** Tarjan's SCC: groups of 2+ nodes, and single nodes with a self-loop. */
export function findGraphCycles(ids: readonly string[], edges: readonly Pick<DagEdge, 'from' | 'to'>[]): string[][] {
  const adj = new Map(ids.map((id) => [id, [] as string[]]));
  for (const e of edges) adj.get(e.from)?.push(e.to);
  let index = 0;
  const idx = new Map<string, number>(), low = new Map<string, number>(), on = new Set<string>();
  const stack: string[] = [];
  const out: string[][] = [];
  const visit = (v: string) => {
    idx.set(v, index); low.set(v, index); index++;
    stack.push(v); on.add(v);
    for (const w of adj.get(v) ?? []) {
      if (!idx.has(w)) { visit(w); low.set(v, Math.min(low.get(v)!, low.get(w)!)); }
      else if (on.has(w)) low.set(v, Math.min(low.get(v)!, idx.get(w)!));
    }
    if (low.get(v) === idx.get(v)) {
      const comp: string[] = [];
      let w: string;
      do { w = stack.pop()!; on.delete(w); comp.push(w); } while (w !== v);
      if (comp.length > 1 || edges.some((e) => e.from === v && e.to === v)) out.push(comp.reverse());
    }
  };
  for (const id of ids) if (!idx.has(id)) visit(id);
  return out;
}

/** Kahn's algorithm with ties broken by the nodes' reading order. */
export function topoOrder(nodes: readonly Pick<DagNode, 'id'>[], edges: readonly Pick<DagEdge, 'from' | 'to'>[]): string[] {
  const rank = new Map(nodes.map((n, i) => [n.id, i]));
  const indeg = new Map(nodes.map((n) => [n.id, 0]));
  for (const e of edges) indeg.set(e.to, (indeg.get(e.to) ?? 0) + 1);
  const ready = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const out: string[] = [];
  while (ready.length) {
    ready.sort((a, b) => rank.get(a)! - rank.get(b)!);
    const v = ready.shift()!;
    out.push(v);
    for (const e of edges) if (e.from === v) { indeg.set(e.to, indeg.get(e.to)! - 1); if (indeg.get(e.to) === 0) ready.push(e.to); }
  }
  return out;
}

/** Ids of the nodes upstream of `id` (direct inputs first, in edge order). */
export function upstreamOf(g: Pick<DagGraph, 'edges'>, id: string): string[] {
  return g.edges.filter((e) => e.to === id).map((e) => e.from);
}
