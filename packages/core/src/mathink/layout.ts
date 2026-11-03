import { rectUnion, type Rect } from '../geometry.ts';
import type { LayoutNode, LayoutRow, MathSymbol } from './types.ts';

/**
 * The layout parser: where symbols sit relative to each other is half of handwritten maths.
 *
 * In order, within any region of the page:
 *  1. fraction bars, widest first: a flat bar with writing just above and just below it, the
 *     writing roughly centred on it. What is above is the numerator, what is below the
 *     denominator, each parsed again as its own region (so fractions nest);
 *  2. radical signs: everything inside the sign's box is the radicand;
 *  3. lines: what is left is split into lines of writing (a system of equations);
 *  4. scripts, line by line, left to right: a smaller symbol whose centre is raised to the top of
 *     the symbol before it starts an exponent (which continues while symbols stay up there), one
 *     hanging below the baseline starts a subscript.
 * Thresholds are fractions of `ref`, the typical symbol height, so any writing size works.
 */

const top = (s: MathSymbol) => s.cands[0]?.label ?? '';
const has = (s: MathSymbol, label: string, min = 0.15) => s.cands.some((c) => c.label === label && c.p >= min);
const w = (r: Rect) => r.maxX - r.minX;
const h = (r: Rect) => r.maxY - r.minY;
const cx = (r: Rect) => (r.minX + r.maxX) / 2;
const cy = (r: Rect) => (r.minY + r.maxY) / 2;

export const isBarSymbol = (s: MathSymbol) => s.shape === 'hline' || (top(s) === '-' && h(s.bounds) < w(s.bounds) * 0.3);
export const isRadicalSymbol = (s: MathSymbol) => s.shape === 'radical' || has(s, '√', 0.2);
const isOperatorLabel = (l: string) => '+-×÷·=/'.includes(l) && l.length === 1;
const isAlnum = (s: MathSymbol) => /^[0-9a-zA-Zπ()]/.test(top(s));

function boundsOfNode(n: LayoutNode): Rect {
  return n.k === 'sym' ? n.sym.bounds : n.bounds;
}

/** Parses symbols into lines of structure. */
export function parseLayout(symbols: readonly MathSymbol[], ref: number): LayoutRow[] {
  const nodes = structures([...symbols], ref);
  return splitLines(nodes, ref).map((line) => parseRow(line, ref));
}

/** Steps 1 and 2: fractions and radicals become composite nodes; the rest stay symbols. */
function structures(syms: MathSymbol[], ref: number): LayoutNode[] {
  const consumed = new Set<MathSymbol>();
  const out: LayoutNode[] = [];
  const bars = syms.filter(isBarSymbol).sort((a, b) => w(b.bounds) - w(a.bounds));
  for (const bar of bars) {
    if (consumed.has(bar)) continue;
    const B = bar.bounds, by = cy(B), bw = w(B);
    const inSpan = (s: MathSymbol) => !consumed.has(s) && s !== bar && cx(s.bounds) >= B.minX - bw * 0.12 && cx(s.bounds) <= B.maxX + bw * 0.12;
    const collect = (above: boolean): MathSymbol[] => {
      const pool = syms.filter((s) => inSpan(s) && (above ? cy(s.bounds) < by : cy(s.bounds) > by));
      const near = pool.filter((s) => (above ? by - s.bounds.maxY : s.bounds.minY - by) < ref * 0.8 && (above ? s.bounds.maxY < by + ref * 0.15 : s.bounds.minY > by - ref * 0.15));
      // A numerator or denominator has real writing next to the bar, not just another bar.
      if (!near.some((s) => !isBarSymbol(s))) return [];
      const got = new Set(near);
      let edge = above ? Math.min(...near.map((s) => s.bounds.minY)) : Math.max(...near.map((s) => s.bounds.maxY));
      for (let grew = true; grew;) {
        grew = false;
        for (const s of pool) {
          if (got.has(s)) continue;
          const close = above ? s.bounds.maxY > edge - ref * 0.55 : s.bounds.minY < edge + ref * 0.55;
          if (!close) continue;
          got.add(s);
          edge = above ? Math.min(edge, s.bounds.minY) : Math.max(edge, s.bounds.maxY);
          grew = true;
        }
      }
      return [...got];
    };
    const num = collect(true), den = collect(false);
    if (!num.length || !den.length) continue;
    const span = (list: MathSymbol[]) => list.reduce((r, s) => rectUnion(r, s.bounds), list[0]!.bounds);
    const N = span(num), D = span(den);
    // The bar spans what it divides, and both parts sit roughly over its middle.
    if (w(N) > bw * 1.45 || w(D) > bw * 1.45) continue;
    if (Math.abs(cx(N) - cx(B)) > bw * 0.45 + ref * 0.2 || Math.abs(cx(D) - cx(B)) > bw * 0.45 + ref * 0.2) continue;
    [bar, ...num, ...den].forEach((s) => consumed.add(s));
    const numRow = parseRow(structures(num, ref), ref);
    const denRow = parseRow(structures(den, ref), ref);
    out.push({ k: 'frac', bar, num: numRow, den: denRow, bounds: rectUnion(B, rectUnion(N, D)) });
  }
  const rest = syms.filter((s) => !consumed.has(s));
  // Radicals: everything whose centre is inside the sign's box (right of its hook) is under it.
  const rads = rest.filter(isRadicalSymbol).sort((a, b) => w(b.bounds) * h(b.bounds) - w(a.bounds) * h(a.bounds));
  const radConsumed = new Set<MathSymbol>();
  const radNodes: LayoutNode[] = [];
  const composite = out.slice();
  for (const r of rads) {
    if (radConsumed.has(r)) continue;
    const R = r.bounds;
    const inside = (b: Rect) => cx(b) > R.minX + w(R) * 0.28 && cx(b) < R.maxX + ref * 0.25 && cy(b) > R.minY - ref * 0.05 && cy(b) < R.maxY + ref * 0.1 && b.maxY < R.maxY + ref * 0.35;
    const bodySyms = rest.filter((s) => s !== r && !radConsumed.has(s) && inside(s.bounds));
    const bodyFracs = composite.filter((n) => inside(boundsOfNode(n)));
    if (!bodySyms.length && !bodyFracs.length) continue;
    [r, ...bodySyms].forEach((s) => radConsumed.add(s));
    for (const f of bodyFracs) composite.splice(composite.indexOf(f), 1);
    const bodyNodes = [...structures(bodySyms, ref), ...bodyFracs];
    const body = parseRow(bodyNodes, ref);
    radNodes.push({ k: 'sqrt', sign: r, body, bounds: rectUnion(R, body.bounds) });
  }
  return [...composite, ...radNodes, ...rest.filter((s) => !radConsumed.has(s)).map((sym): LayoutNode => ({ k: 'sym', sym }))];
}

/** Step 3: lines of writing. Big things claim bands first; small marks join the band they overlap most. */
function splitLines(nodes: LayoutNode[], ref: number): LayoutNode[][] {
  const bands: { minY: number; maxY: number; nodes: LayoutNode[] }[] = [];
  const order = [...nodes].sort((a, b) => h(boundsOfNode(b)) - h(boundsOfNode(a)));
  for (const n of order) {
    const b = boundsOfNode(n);
    const nh = Math.max(h(b), ref * 0.15);
    let best = -1, bestOv = 0;
    bands.forEach((band, i) => {
      const ov = (Math.min(band.maxY, b.maxY + ref * 0.05) - Math.max(band.minY, b.minY - ref * 0.05)) / nh;
      const near = Math.abs(cy(b) - (band.minY + band.maxY) / 2) < ref * 0.75;
      const score = Math.max(ov, near ? 0.3 : 0);
      if (score > bestOv) { bestOv = score; best = i; }
    });
    if (best >= 0 && bestOv > 0.2) {
      const band = bands[best]!;
      band.nodes.push(n);
      // Only full-size writing widens a band, so an exponent can't pull the next line in.
      if (h(b) > ref * 0.7 && n.k === 'sym' && isAlnum(n.sym)) { band.minY = Math.min(band.minY, b.minY); band.maxY = Math.max(band.maxY, b.maxY); }
    } else bands.push({ minY: b.minY, maxY: b.maxY, nodes: [n] });
  }
  return bands.sort((a, b) => a.minY - b.minY).map((b) => b.nodes);
}

/** Step 4: one line left to right, with exponents and subscripts. */
export function parseRow(nodes: LayoutNode[], ref: number): LayoutRow {
  const items = [...nodes].sort((a, b) => boundsOfNode(a).minX - boundsOfNode(b).minX);
  const bounds = items.length ? items.map(boundsOfNode).reduce((r, b) => rectUnion(r, b)) : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  if (!items.length) return { items: [], bounds };
  // Full-size writing height: digits and letters (brackets are taller than what they hold).
  const normal = items.filter((n) => n.k === 'sym' && /^[0-9a-zA-Zπ]/.test(top(n.sym))).map((n) => h(boundsOfNode(n))).sort((a, b) => a - b);
  const rowH = Math.max(normal.length ? normal[Math.floor(normal.length * 0.7)]! : ref, ref * 0.5);

  for (const n of items) if (n.k === 'sym' && (n.sym.shape === 'dot' || /^[.·]$/.test(top(n.sym)))) reweightDot(n.sym, items, rowH);

  const out: LayoutNode[] = [];
  let i = 0;
  while (i < items.length) {
    const base = items[i]!;
    out.push(base);
    i++;
    if (!canTakeScripts(base)) continue;
    let B = boundsOfNode(base);
    // A bracket reaches above and below the writing it closes; measure from the writing's band.
    if (base.k === 'sym' && top(base.sym) === ')') B = { ...B, minY: B.minY + h(B) * 0.1, maxY: B.maxY - h(B) * 0.12 };
    const bh = Math.max(h(B), rowH * 0.45);
    const scriptRef = Math.max(bh, rowH);
    // A cross may be "×" as much as "x": as a script it has to be clearly up there, like an operator.
    const isOp = (n: LayoutNode) => n.k === 'sym' && (isOperatorLabel(top(n.sym)) || has(n.sym, '×', 0.3));
    // An exponent is smaller than full-size writing and its bottom is lifted well off the base's
    // bottom (measured in full-size heights, so a lowercase x works like a digit or a tall 8).
    const lift = (b: Rect) => (B.maxY - b.maxY) / scriptRef;
    const raised = (b: Rect, n: LayoutNode) => lift(b) >= 0.28 && h(b) <= scriptRef * 0.8 && cy(b) < cy(B) - bh * 0.05 && !(isOp(n) && cy(b) > B.minY);
    // Subscripts hang below the baseline, and only letters take them (x₁, a₂) in school maths.
    const lowered = (b: Rect, n: LayoutNode) => base.k === 'sym' && /^[a-zA-Z]$/.test(top(base.sym)) && b.minY > B.minY + bh * 0.55 && b.maxY > B.maxY + bh * 0.3 && h(b) < scriptRef * 0.7 && n.k === 'sym' && /^[0-9a-z]/.test(top(n.sym));
    const run = (test: (b: Rect, n: LayoutNode) => boolean, up: boolean): LayoutNode[] => {
      const got: LayoutNode[] = [];
      while (i < items.length) {
        const n = items[i]!, b = boundsOfNode(n);
        const prev = got[got.length - 1];
        const continues = prev && (() => {
          const P = boundsOfNode(prev);
          const level = Math.abs(cy(b) - cy(P)) < Math.max(h(P), ref * 0.3) * 0.55 && h(b) < Math.max(h(P), ref * 0.3) * 1.6 && b.minX - P.maxX < ref * 0.9;
          // Off the base's level: an exponent never comes back down to the middle of the line.
          const away = up ? lift(b) >= 0.2 && cy(b) < cy(B) : cy(b) > B.minY + bh * 0.6;
          return level && away && !(isOp(n) && !test(b, n) && !(up && cy(b) < B.minY + bh * 0.15));
        })();
        if (!(got.length ? continues || test(b, n) : test(b, n))) break;
        got.push(n);
        i++;
      }
      // A script can't end on an operator: give trailing operators back to the line.
      while (got.length && isOp(got[got.length - 1]!)) { got.pop(); i--; }
      return got;
    };
    const sup = run(raised, true);
    if (sup.length) { setScript(base, 'sup', parseRow(sup, ref)); continue; }
    const sub = run(lowered, false);
    if (sub.length) setScript(base, 'sub', parseRow(sub, ref));
  }
  return { items: out, bounds };
}

function canTakeScripts(n: LayoutNode): boolean {
  if (n.k !== 'sym') return true;
  const l = top(n.sym);
  return /^[0-9a-zA-Zπ)]/.test(l) || n.sym.cands.some((c) => /^[0-9a-zA-Z)]$/.test(c.label) && c.p > 0.3);
}

function setScript(n: LayoutNode, kind: 'sup' | 'sub', row: LayoutRow) {
  if (n.k === 'sym') n[kind] = row;
  else if (kind === 'sup') n.sup = row;
}

/** A dot on the baseline is a decimal point; one at mid-height is a multiplication dot. */
function reweightDot(s: MathSymbol, items: LayoutNode[], rowH: number) {
  const neighbours = items.filter((n) => n.k === 'sym' && n.sym !== s && isAlnum(n.sym) && Math.abs(cx(n.sym.bounds) - cx(s.bounds)) < rowH * 2.5);
  if (!neighbours.length) return;
  const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
  // Below the middle of the writing around it (old-style figures descend, so not "near the bottom").
  const mid = med(neighbours.map((n) => cy(boundsOfNode(n))));
  const low = cy(s.bounds) - mid > rowH * 0.15;
  s.cands = s.cands.map((c) => (c.label === '.' ? { ...c, p: c.p * (low ? 1 : 0.25) } : c.label === '·' ? { ...c, p: c.p * (low ? 0.25 : 1) } : c)).sort((a, b) => b.p - a.p);
}

/**
 * The same lines with every exponent and subscript put back on the line. The decoder falls back
 * to this when no reading of the scripts it found is valid maths (a misjudged script is likelier
 * than an impossible expression).
 */
export function flattenScripts(rows: readonly LayoutRow[]): LayoutRow[] {
  const flat = (r: LayoutRow): LayoutRow => ({
    bounds: r.bounds,
    items: r.items.flatMap((n): LayoutNode[] => {
      const scripts = [...(n.k === 'sym' && n.sub ? flat(n.sub).items : []), ...(n.sup ? flat(n.sup).items : [])];
      const self: LayoutNode = n.k === 'sym' ? { k: 'sym', sym: n.sym }
        : n.k === 'frac' ? { k: 'frac', bar: n.bar, num: flat(n.num), den: flat(n.den), bounds: n.bounds }
          : { k: 'sqrt', sign: n.sign, body: flat(n.body), bounds: n.bounds };
      return [self, ...scripts];
    }),
  });
  return rows.map(flat);
}
