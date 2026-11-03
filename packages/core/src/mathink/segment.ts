import { rectUnion, type Rect } from '../geometry.ts';
import type { InkStroke } from '../model.ts';
import {
  looksLikeRadical, looksLikeRadicalTick, primitiveOf, referenceHeight, strokeContact, strokeInfos, xOverlap,
  type Primitive, type StrokeInfo,
} from './features.ts';

/**
 * Stroke → symbol grouping.
 *
 * Handwritten maths is mostly one to three strokes per symbol, and the strokes of one symbol touch
 * or cross (+, ×, 4, t, π, 5), stack tightly (=, ÷, i) or follow each other in time. Strokes of
 * different symbols rarely do — with three exceptions this module is careful about:
 *  - a fraction bar touches its numerator or denominator when written quickly: bars with writing
 *    both above and below never join anything;
 *  - a radical sign (√) encloses its radicand: nothing inside it joins it;
 *  - neighbours that touch side by side ("12" written fast) only join when they overlap
 *    horizontally by a lot; otherwise the recognizer's multi-character answer splits them again
 *    (see `splitGroup`).
 */

export interface SymbolGroup {
  id: string;
  strokes: InkStroke[];
  infos: StrokeInfo[];
  bounds: Rect;
  /** Set when the group is a plain mark recognised from geometry alone. */
  shape?: GroupShape;
}

export type GroupShape = Primitive | 'equals' | 'divide' | 'plus' | 'cross' | 'radical';

export interface Segmentation {
  groups: SymbolGroup[];
  /** Typical symbol height (page units). */
  ref: number;
}

class UnionFind {
  private p: number[];
  constructor(n: number) { this.p = Array.from({ length: n }, (_, i) => i); }
  find(i: number): number { while (this.p[i] !== i) { this.p[i] = this.p[this.p[i]!]!; i = this.p[i]!; } return i; }
  union(a: number, b: number) { this.p[this.find(a)] = this.find(b); }
}

export function segmentSymbols(strokes: readonly InkStroke[]): Segmentation {
  const infos = strokeInfos(strokes);
  if (!infos.length) return { groups: [], ref: 1 };
  const ref = referenceHeight(infos);
  const prim = infos.map((i) => primitiveOf(i, ref));
  const radical = infos.map((i, k) => prim[k] == null && looksLikeRadical(i, ref));
  const n = infos.length;

  // Fraction bars: flat strokes with real writing (not dots) right above and right below.
  const isBar = infos.map((i, k) => {
    if (prim[k] !== 'hline') return false;
    const within = (o: StrokeInfo) => o.cx >= i.b.minX - i.w * 0.05 && o.cx <= i.b.maxX + i.w * 0.05;
    // Only real writing counts: an "=" or a minus above or below a bar does not make it a fraction.
    // Nor does a stroke the bar is part of (the flag of a "5" over its body).
    const writing = (o: StrokeInfo, j: number) => j !== k && prim[j] !== 'dot' && prim[j] !== 'hline' && !endBar(i, 'hline', o, ref, Math.max(i.s.size, o.s.size, ref * 0.05));
    const above = infos.some((o, j) => writing(o, j) && within(o) && o.cy < i.cy && i.cy - o.b.maxY < ref * 0.75 && o.b.maxY < i.cy + ref * 0.1);
    const below = infos.some((o, j) => writing(o, j) && within(o) && o.cy > i.cy && o.b.minY - i.cy < ref * 0.75 && o.b.minY > i.cy - ref * 0.1);
    return above && below && i.w > ref * 0.45;
  });
  const longBar = infos.map((i, k) => prim[k] === 'hline' && (isBar[k] || i.w > ref * 1.6));

  const uf = new UnionFind(n);
  const shape = new Map<number, GroupShape>();
  const inside = (outer: StrokeInfo, o: StrokeInfo) => o.cx > outer.b.minX + outer.w * 0.25 && o.cx < outer.b.maxX + ref * 0.2 && o.cy > outer.b.minY && o.cy < outer.b.maxY + ref * 0.1;

  // 1. "=": two flat bars of similar length, stacked closely, nothing between them.
  const used = new Set<number>();
  for (let a = 0; a < n; a++) {
    if (prim[a] !== 'hline' || isBar[a] || used.has(a)) continue;
    let best = -1, bestGap = Infinity;
    for (let b = 0; b < n; b++) {
      if (b === a || prim[b] !== 'hline' || isBar[b] || used.has(b)) continue;
      const A = infos[a]!, B = infos[b]!;
      const ratio = Math.min(A.w, B.w) / Math.max(A.w, B.w);
      const gap = Math.abs(A.cy - B.cy);
      if (ratio < 0.4 || xOverlap(A.b, B.b) < 0.5 || gap < ref * 0.06 || gap > Math.max(A.w, B.w) * 0.85 || gap > ref * 0.9) continue;
      const lo = Math.min(A.cy, B.cy), hi = Math.max(A.cy, B.cy);
      const between = infos.some((o, j) => j !== a && j !== b && o.cy > lo + gap * 0.15 && o.cy < hi - gap * 0.15 && o.cx > Math.min(A.b.minX, B.b.minX) && o.cx < Math.max(A.b.maxX, B.b.maxX));
      if (between) continue;
      if (gap < bestGap) { bestGap = gap; best = b; }
    }
    if (best >= 0) { uf.union(a, best); used.add(a); used.add(best); shape.set(a, 'equals'); }
  }

  // 2. "÷": a bar with a dot centred above and one below.
  for (let a = 0; a < n; a++) {
    if (prim[a] !== 'hline' || used.has(a) || isBar[a]) continue;
    const A = infos[a]!;
    const dots = infos.map((o, j) => ({ o, j })).filter(({ o, j }) => prim[j] === 'dot' && !used.has(j) && o.cx > A.b.minX - A.w * 0.1 && o.cx < A.b.maxX + A.w * 0.1 && Math.abs(o.cy - A.cy) < Math.max(A.w * 0.9, ref * 0.2) && Math.abs(o.cy - A.cy) < ref * 0.8);
    const up = dots.find(({ o }) => o.cy < A.cy), down = dots.find(({ o }) => o.cy > A.cy);
    if (up && down) { uf.union(a, up.j); uf.union(a, down.j); used.add(a); used.add(up.j); used.add(down.j); shape.set(a, 'divide'); }
  }

  // 3. Touching or crossing strokes of one symbol.
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      if (used.has(a) || used.has(b)) continue;
      const A = infos[a]!, B = infos[b]!;
      if (prim[a] === 'dot' || prim[b] === 'dot') continue;
      const pad = Math.max(A.s.size, B.s.size, ref * 0.05);
      if (A.b.maxX + pad < B.b.minX || B.b.maxX + pad < A.b.minX || A.b.maxY + pad < B.b.minY || B.b.maxY + pad < A.b.minY) continue;
      // A two-stroke radical: tick, then an overline starting at its top.
      const radTick = (t: number, bar: number) => prim[bar] === 'hline' && looksLikeRadicalTick(infos[t]!, ref) && Math.abs(infos[bar]!.b.minX - infos[t]!.b.maxX) < ref * 0.3 && Math.abs(infos[bar]!.cy - infos[t]!.b.minY) < ref * 0.3;
      if (radTick(a, b) || radTick(b, a)) { uf.union(a, b); shape.set(a, 'radical'); continue; }
      if (longBar[a] || longBar[b]) continue;
      if ((radical[a] && inside(A, B)) || (radical[b] && inside(B, A))) continue;
      const c = strokeContact(A, B);
      if (c.cross) { uf.union(a, b); continue; }
      if (c.dist > pad * 1.2) continue;
      const adjacent = Math.abs(A.order - B.order) === 1;
      // Touching is not enough: the smaller stroke must also sit within the bigger one's box (an
      // exponent touching the letter before it sits above it).
      const [small, big] = A.w * A.h < B.w * B.h ? [A, B] : [B, A];
      const m = ref * 0.12;
      const within = small.cx > big.b.minX - m && small.cx < big.b.maxX + m && small.cy > big.b.minY - m && small.cy < big.b.maxY + m;
      if (within && xOverlap(A.b, B.b) > (adjacent ? 0.35 : 0.6)) { uf.union(a, b); continue; }
      // A short bar touching the top or bottom end of a stroke: the foot of a "1", the flag of
      // a "5", the top of a "7" or "T". (A minus sits at mid-height, away from stroke ends.)
      if (endBar(A, prim[a]!, B, ref, pad) || endBar(B, prim[b]!, A, ref, pad)) uf.union(a, b);
    }
  }

  // 4. Strokes written one after the other that stack tightly within one symbol's box (a "5"
  //    whose flag doesn't touch, an "i" and its dot, π's legs under its bar).
  for (let a = 0; a + 1 < n; a++) {
    const b = a + 1;
    if (used.has(a) || used.has(b) || longBar[a] || longBar[b] || radical[a] || radical[b]) continue;
    const A = infos[a]!, B = infos[b]!;
    if (uf.find(a) === uf.find(b)) continue;
    const gap = Math.max(A.b.minY, B.b.minY) - Math.min(A.b.maxY, B.b.maxY);
    const unionH = Math.max(A.b.maxY, B.b.maxY) - Math.min(A.b.minY, B.b.minY);
    const dotOverStem = (prim[a] === 'dot' && prim[b] === 'vline') || (prim[b] === 'dot' && prim[a] === 'vline');
    // Two flat marks are "=" or two minus signs, never one symbol; don't stack them here.
    if (prim[a] === 'hline' && prim[b] === 'hline') continue;
    if (xOverlap(A.b, B.b) > 0.6 && gap < ref * (dotOverStem ? 0.45 : 0.18) && unionH < ref * 1.35 && (prim[a] !== 'dot' || dotOverStem) && (prim[b] !== 'dot' || dotOverStem)) uf.union(a, b);
  }

  const byRoot = new Map<number, number[]>();
  for (let k = 0; k < n; k++) {
    const r = uf.find(k);
    (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(k);
  }
  const groups: SymbolGroup[] = [];
  for (const members of byRoot.values()) {
    const ms = members.sort((p, q) => infos[p]!.order - infos[q]!.order);
    const gi = ms.map((k) => infos[k]!);
    let bounds = gi[0]!.b;
    for (const i of gi) bounds = rectUnion(bounds, i.b);
    let gShape: GroupShape | undefined = ms.map((k) => shape.get(k)).find(Boolean);
    if (!gShape && ms.length === 1) gShape = radical[ms[0]!] ? 'radical' : prim[ms[0]!] ?? undefined;
    if (!gShape && ms.length === 2) gShape = crossShape(gi[0]!, gi[1]!, prim[ms[0]!]!, prim[ms[1]!]!, ref);
    groups.push({ id: gi.map((i) => i.s.id).join('+'), strokes: gi.map((i) => i.s), infos: gi, bounds, shape: gShape });
  }
  groups.sort((p, q) => p.bounds.minX - q.bounds.minX || p.bounds.minY - q.bounds.minY);
  return { groups, ref };
}

function endBar(bar: StrokeInfo, kind: Primitive | null, other: StrokeInfo, ref: number, pad: number): boolean {
  if (kind !== 'hline' || bar.w > ref * 1.1 || other.h < ref * 0.4) return false;
  const pts = other.s.points;
  for (const end of [pts[0]!, pts[pts.length - 1]!]) {
    const atExtreme = end.y < other.b.minY + other.h * 0.15 || end.y > other.b.maxY - other.h * 0.15;
    if (!atExtreme) continue;
    const near = bar.s.points.some((p) => Math.hypot(p.x - end.x, p.y - end.y) < pad * 1.5) || (end.x > bar.b.minX - pad && end.x < bar.b.maxX + pad && Math.abs(end.y - bar.cy) < pad * 1.5);
    if (near) return true;
  }
  return false;
}

/** Two straight strokes crossing near their middles: "+" (upright) or "×"/"x" (diagonal). */
function crossShape(a: StrokeInfo, b: StrokeInfo, pa: Primitive | null, pb: Primitive | null, ref: number): GroupShape | undefined {
  if (!pa || !pb || pa === 'dot' || pb === 'dot') return undefined;
  const c = strokeContact(a, b);
  if (!c.cross && c.dist > ref * 0.08) return undefined;
  const kinds = new Set([pa, pb]);
  if (kinds.has('hline') && kinds.has('vline')) return 'plus';
  if (kinds.has('slash') && kinds.has('backslash')) return 'cross';
  return undefined;
}

/**
 * Splits a group the recognizer read as several characters ("12" from two touching digits) into
 * `parts` groups at the widest horizontal gaps between its strokes. Null when it can't.
 */
export function splitGroup(g: SymbolGroup, parts: number): SymbolGroup[] | null {
  if (parts < 2 || g.infos.length < parts) return null;
  const sorted = [...g.infos].sort((p, q) => p.cx - q.cx);
  const gaps = sorted.slice(1).map((s, i) => ({ i, gap: s.b.minX - sorted[i]!.b.maxX + (s.cx - sorted[i]!.cx) * 0.25 }));
  const cuts = gaps.sort((p, q) => q.gap - p.gap).slice(0, parts - 1).map((x) => x.i).sort((p, q) => p - q);
  const out: SymbolGroup[] = [];
  let start = 0;
  for (const c of [...cuts, sorted.length - 1]) {
    const part = sorted.slice(start, c + 1).sort((p, q) => p.order - q.order);
    start = c + 1;
    let bounds = part[0]!.b;
    for (const i of part) bounds = rectUnion(bounds, i.b);
    out.push({ id: part.map((i) => i.s.id).join('+'), strokes: part.map((i) => i.s), infos: part, bounds });
  }
  return out;
}
