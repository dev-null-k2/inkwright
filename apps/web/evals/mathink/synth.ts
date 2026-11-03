import { singleLineGlyph, type InkPoint, type InkStroke } from '@inkwright/core';

/**
 * Synthetic handwritten maths for the eval: problems written as strokes, with the truth attached
 * to every stroke. Three hands:
 *  - A: EMS Felix (the print single-line font in handwrite.ts),
 *  - B: EMS Allure (the script font),
 *  - C: a hand drawn here for the eval only — open 4s, crossed 7s, flagged 1s, two-stroke 5s,
 *    curly x — whose shapes are NOT among the built-in classifier's templates, so the built-in
 *    numbers on hand C say how it does on writing it has never seen.
 * On top of each glyph: per-symbol size, slant and rotation wobble, per-stroke jitter and drift
 * (so a "+" crosses off-centre and an "=" has uneven bars), uneven spacing, a wandering
 * baseline, random stroke order and direction within a symbol, and plausible timing.
 * Structure is laid out the way people write it: stacked fractions with a bar a little wider
 * than the wider part, exponents smaller and raised, radicals with an overline over the radicand,
 * systems as lines one under the other.
 */

export type Hand = 'A' | 'B' | 'C';

/** A row of writing: characters and structures. */
export type Item = string | { frac: [Item[], Item[]] } | { sup: Item[] } | { sqrt: Item[] };

export interface Case {
  id: string;
  category: 'arithmetic' | 'fractions' | 'powers' | 'equations' | 'systems';
  /** One row per line. */
  rows: Item[][];
  /** The problem as the solver should get it (one equation per line). */
  truth: string;
  hand: Hand;
  seed: number;
}

export interface Written {
  strokes: InkStroke[];
  /** Stroke id → which symbol (index into `symbols`) it belongs to. */
  owner: Map<string, number>;
  symbols: { label: string; strokeIds: string[] }[];
}

export function rng(seed: number) {
  let a = seed | 0 || 0x9e3779b9;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Path = [number, number][];

/** Hand C, in digit-height units (y up, baseline 0). Several variants per symbol. */
const HAND_C: Record<string, Path[][]> = {
  '0': [[[[0.32, 1], [0.08, 0.85], [0.02, 0.5], [0.1, 0.12], [0.32, 0], [0.52, 0.15], [0.58, 0.5], [0.5, 0.88], [0.3, 1.0], [0.24, 0.95]]]],
  '1': [[[[0.1, 0.75], [0.35, 1], [0.33, 0]]], [[[0.3, 1], [0.28, 0]]], [[[0.08, 0.78], [0.32, 1], [0.32, 0]], [[0.08, 0], [0.55, 0.01]]]],
  '2': [
    [[[0.05, 0.72], [0.15, 0.92], [0.32, 1], [0.5, 0.9], [0.55, 0.68], [0.42, 0.45], [0.02, 0.0], [0.62, 0.02]]],
    [[[0.05, 0.78], [0.3, 1], [0.55, 0.8], [0.45, 0.5], [0.1, 0.1], [0.05, 0.02], [0.2, 0.08], [0.35, 0.03], [0.62, 0.05]]],
  ],
  '3': [[[[0.05, 0.9], [0.3, 1], [0.52, 0.88], [0.5, 0.65], [0.25, 0.55], [0.5, 0.45], [0.58, 0.22], [0.4, 0.02], [0.15, 0.0], [0.02, 0.1]]]],
  '4': [
    [[[0.42, 1], [0.0, 0.33], [0.62, 0.33]], [[0.44, 0.72], [0.44, 0]]],
    [[[0.08, 1], [0.05, 0.4], [0.55, 0.42]], [[0.45, 0.95], [0.46, 0]]],
  ],
  '5': [
    [[[0.12, 1], [0.08, 0.56], [0.32, 0.62], [0.52, 0.5], [0.56, 0.22], [0.38, 0.02], [0.05, 0.06]], [[0.12, 1], [0.58, 1.02]]],
    [[[0.55, 1], [0.12, 1], [0.08, 0.55], [0.35, 0.62], [0.55, 0.42], [0.5, 0.12], [0.3, 0], [0.04, 0.08]]],
  ],
  '6': [[[[0.48, 1], [0.2, 0.7], [0.05, 0.3], [0.15, 0.03], [0.38, 0], [0.55, 0.2], [0.48, 0.45], [0.25, 0.5], [0.07, 0.32]]]],
  '7': [
    [[[0.0, 1], [0.6, 1], [0.18, 0]]],
    [[[0.0, 0.95], [0.08, 1], [0.6, 1], [0.2, 0]], [[0.15, 0.5], [0.52, 0.5]]],
  ],
  '8': [[[[0.5, 0.88], [0.3, 1], [0.08, 0.85], [0.15, 0.62], [0.45, 0.4], [0.55, 0.15], [0.32, 0], [0.08, 0.12], [0.15, 0.4], [0.42, 0.6], [0.52, 0.82], [0.4, 0.98]]]],
  '9': [[[[0.52, 0.8], [0.32, 1], [0.08, 0.85], [0.08, 0.6], [0.3, 0.5], [0.52, 0.62], [0.55, 0.95], [0.5, 0.4], [0.42, 0]]]],
  '+': [[[[0.0, 0.45], [0.62, 0.45]], [[0.3, 0.78], [0.31, 0.12]]], [[[0.3, 0.78], [0.31, 0.12]], [[0.0, 0.47], [0.62, 0.44]]]],
  '-': [[[[0.0, 0.45], [0.5, 0.46]]]],
  '×': [[[[0.05, 0.68], [0.45, 0.22]], [[0.45, 0.68], [0.05, 0.22]]]],
  '÷': [[[[0.0, 0.45], [0.6, 0.45]], [[0.3, 0.78], [0.31, 0.74]], [[0.3, 0.15], [0.31, 0.11]]]],
  '=': [[[[0.0, 0.62], [0.58, 0.62]], [[0.0, 0.3], [0.58, 0.3]]]],
  '(': [[[[0.32, 1.1], [0.12, 0.85], [0.04, 0.45], [0.12, 0.08], [0.32, -0.15]]]],
  ')': [[[[0.02, 1.1], [0.22, 0.85], [0.3, 0.45], [0.22, 0.08], [0.02, -0.15]]]],
  '.': [[[[0.05, 0.03], [0.08, 0.0]]]],
  x: [
    [[[0.0, 0.55], [0.12, 0.62], [0.24, 0.5], [0.34, 0.1], [0.44, 0.0], [0.56, 0.06]], [[0.5, 0.6], [0.06, 0.0]]],
    [[[0.02, 0.62], [0.5, 0.0]], [[0.5, 0.62], [0.02, 0.0]]],
  ],
  y: [[[[0.0, 0.62], [0.08, 0.25], [0.28, 0.12], [0.5, 0.62]], [[0.5, 0.62], [0.42, 0.0], [0.3, -0.35], [0.08, -0.4]]]],
  π: [[[[0.0, 0.6], [0.62, 0.64]], [[0.18, 0.62], [0.15, 0]], [[0.44, 0.62], [0.46, 0.06], [0.58, 0.0]]]],
};

/** Font glyphs (hands A, B) in digit-height units. */
function fontGlyph(ch: string, hand: 'A' | 'B'): Path[] | null {
  const style = hand === 'A' ? 'print' : 'script';
  const name = ch === 'π' ? null : ch;
  if (!name) return null;
  const g = singleLineGlyph(name, style);
  const zero = singleLineGlyph('0', style)!;
  if (!g) return null;
  let z0 = Infinity, z1 = -Infinity;
  for (const p of zero.paths) for (let i = 1; i < p.length; i += 2) { z0 = Math.min(z0, p[i]!); z1 = Math.max(z1, p[i]!); }
  const unit = z1 - z0;
  let x0 = Infinity;
  for (const p of g.paths) for (let i = 0; i < p.length; i += 2) x0 = Math.min(x0, p[i]!);
  return g.paths.filter((p) => p.length >= 2).map((p) => {
    const out: Path = [];
    for (let i = 0; i + 1 < p.length; i += 2) out.push([(p[i]! - x0) / unit, (p[i + 1]! - z0) / unit]);
    if (out.length === 1) out.push([out[0]![0] + 0.03, out[0]![1] - 0.03]);
    return out;
  });
}

function glyph(ch: string, hand: Hand, r: () => number): Path[] {
  // The fonts have no π; and the eval wants a two-diagonal "×" distinct from the letter x.
  if (hand !== 'C' && ch !== 'π' && ch !== '×') {
    const g = fontGlyph(ch, hand);
    if (g) return g;
  }
  const variants = HAND_C[ch];
  if (!variants) throw new Error(`No glyph for ${ch}`);
  const v = variants[Math.floor(r() * variants.length)]!;
  const x0 = Math.min(...v.flatMap((p) => p.map(([x]) => x)));
  return v.map((p) => p.map(([x, y]) => [x - x0, y] as [number, number]));
}

interface Pen {
  strokes: InkStroke[];
  owner: Map<string, number>;
  symbols: { label: string; strokeIds: string[] }[];
  r: () => number;
  hand: Hand;
  slant: number;
  mess: number;
  clock: number;
  nextId: number;
  prefix: string;
}

function width(paths: Path[]): number {
  let a = Infinity, b = -Infinity;
  for (const p of paths) for (const [x] of p) { a = Math.min(a, x); b = Math.max(b, x); }
  return b > a ? b - a : 0.1;
}

/** Writes one symbol with its baseline at y (page units, y down), height s. Returns its width. */
function writeSymbol(pen: Pen, ch: string, x: number, y: number, s: number): number {
  const { r, mess } = pen;
  let paths = glyph(ch, pen.hand, r);
  const scale = s * (1 + (r() - 0.5) * 0.16 * mess);
  const rot = (r() - 0.5) * 0.09 * mess;
  const slant = Math.tan(((pen.slant + (r() - 0.5) * 6 * mess) * Math.PI) / 180);
  const lift = (r() - 0.5) * s * 0.08 * mess;
  // Stroke order and direction vary between people.
  if (paths.length > 1 && r() < 0.35) paths = [...paths].reverse();
  paths = paths.map((p) => (r() < 0.3 ? [...p].reverse() : p));
  const sym = pen.symbols.length;
  pen.symbols.push({ label: ch, strokeIds: [] });
  const cos = Math.cos(rot), sin = Math.sin(rot);
  for (const p of paths) {
    // Each stroke of a symbol lands a little off where the glyph puts it (sloppy "+", uneven "=").
    const dx = (r() - 0.5) * 0.07 * mess, dy = (r() - 0.5) * 0.06 * mess, stretch = 1 + (r() - 0.5) * 0.18 * mess;
    const cxp = p.reduce((a, q) => a + q[0], 0) / p.length;
    const dense: { x: number; y: number }[] = [];
    for (let i = 0; i < p.length; i++) {
      const [gx0, gy0] = p[i]!;
      const gx = cxp + (gx0 - cxp) * stretch + dx, gy = gy0 + dy;
      const ux = (gx + gy * slant) * scale, uy = -gy * scale;
      const pt = { x: x + ux * cos - uy * sin, y: y + lift + ux * sin + uy * cos };
      if (dense.length) {
        const a = dense[dense.length - 1]!;
        const d = Math.hypot(pt.x - a.x, pt.y - a.y);
        const n = Math.max(1, Math.ceil(d / (s * 0.06)));
        for (let k = 1; k < n; k++) dense.push({ x: a.x + ((pt.x - a.x) * k) / n, y: a.y + ((pt.y - a.y) * k) / n });
      }
      dense.push(pt);
    }
    const pts: InkPoint[] = dense.map((q, i) => ({ x: q.x + (r() - 0.5) * s * 0.012 * mess, y: q.y + (r() - 0.5) * s * 0.012 * mess, t: i * 9, p: 0.5, tilt: -1, orient: -1 }));
    const id = `${pen.prefix}-${pen.nextId++}`;
    pen.strokes.push({ id, pen: 'ballpoint', color: '#FF1F2433', size: Math.max(0.8, s * 0.06), points: pts, createdAt: Math.round(pen.clock), input: 'pen' });
    pen.clock += pts.length * 9 + 60 + r() * 120;
    pen.owner.set(id, sym);
    pen.symbols[sym]!.strokeIds.push(id);
  }
  return width(paths) * scale;
}

/** Lays out a row; returns its width and vertical extent above/below the baseline. */
function measure(row: Item[], s: number): { w: number; up: number; down: number } {
  let w = 0, up = s, down = 0;
  for (const it of row) {
    if (typeof it === 'string') { w += s * (it === '.' ? 0.3 : 0.75); continue; }
    if ('frac' in it) {
      const a = measure(it.frac[0], s * 0.9), b = measure(it.frac[1], s * 0.9);
      w += Math.max(a.w, b.w) + s * 0.5;
      up = Math.max(up, s * 0.4 + s * 0.25 + a.up + a.down);
      down = Math.max(down, -s * 0.4 + s * 0.25 + b.up + b.down);
    } else if ('sup' in it) {
      const a = measure(it.sup, s * 0.6);
      w += a.w;
      up = Math.max(up, s * 0.55 + a.up);
    } else {
      const a = measure(it.sqrt, s * 0.92);
      w += a.w + s * 0.75;
      up = Math.max(up, a.up + s * 0.2);
    }
  }
  return { w, up, down };
}

function writeRow(pen: Pen, row: Item[], x: number, y: number, s: number): number {
  const { r, mess } = pen;
  const start = x;
  let prevTop = y - s;
  for (const it of row) {
    const gap = s * (0.12 + r() * 0.3 * (0.5 + mess));
    if (typeof it === 'string') {
      const yy = y + (r() - 0.5) * s * 0.06 * mess;
      const w = writeSymbol(pen, it, x, yy, it === '×' ? s * 0.85 : s);
      prevTop = yy - (/[a-z×+=\-÷]/.test(it) ? s * 0.62 : s);
      x += w + gap;
      continue;
    }
    if ('frac' in it) {
      const fs = s * 0.88;
      const a = measure(it.frac[0], fs), b = measure(it.frac[1], fs);
      const barW = Math.max(a.w, b.w) + s * (0.25 + r() * 0.35);
      const barY = y - s * (0.42 + (r() - 0.5) * 0.1);
      const gapV = s * (0.18 + r() * 0.15);
      const order = r() < 0.5 ? ['num', 'bar', 'den'] : r() < 0.5 ? ['bar', 'num', 'den'] : ['num', 'den', 'bar'];
      for (const part of order) {
        if (part === 'num') writeRow(pen, it.frac[0], x + (barW - a.w) / 2 + (r() - 0.5) * s * 0.15, barY - gapV - a.down, fs);
        else if (part === 'den') writeRow(pen, it.frac[1], x + (barW - b.w) / 2 + (r() - 0.5) * s * 0.15, barY + gapV + b.up, fs);
        else drawLine(pen, '-', x, barY, x + barW, barY + (r() - 0.5) * s * 0.06, s);
      }
      x += barW + gap;
      prevTop = barY - gapV - a.up - a.down;
      continue;
    }
    if ('sup' in it) {
      const es = s * (0.55 + r() * 0.12);
      const ey = prevTop + es * (0.3 + r() * 0.3);
      x -= gap * 0.6;
      x += writeRow(pen, it.sup, x, ey, es) + gap;
      continue;
    }
    // Radical: tick, down, up to the top, overline over the radicand; then the radicand.
    const rs = s * 0.92;
    const m = measure(it.sqrt, rs);
    const topY = y - m.up - s * 0.12;
    const hookW = s * 0.45;
    const lineEnd = x + hookW + m.w + s * (0.15 + r() * 0.2);
    const pts: [number, number][] = [[x, y - s * 0.45], [x + hookW * 0.25, y - s * 0.55], [x + hookW * 0.55, y + s * 0.05], [x + hookW, topY], [lineEnd, topY + (r() - 0.5) * s * 0.05]];
    drawPolyline(pen, '√', pts, s);
    writeRow(pen, it.sqrt, x + hookW + s * 0.12, y, rs);
    x = lineEnd + gap;
    prevTop = topY;
  }
  return x - start;
}

function drawLine(pen: Pen, label: string, x0: number, y0: number, x1: number, y1: number, s: number) {
  drawPolyline(pen, label, [[x0, y0], [x1, y1]], s);
}

function drawPolyline(pen: Pen, label: string, pts: [number, number][], s: number) {
  const { r, mess } = pen;
  const sym = pen.symbols.length;
  pen.symbols.push({ label, strokeIds: [] });
  const dense: InkPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i]!;
    if (i) {
      const [ax, ay] = pts[i - 1]!;
      const n = Math.max(1, Math.ceil(Math.hypot(x - ax, y - ay) / (s * 0.06)));
      for (let k = 1; k < n; k++) dense.push({ x: ax + ((x - ax) * k) / n + (r() - 0.5) * s * 0.012 * mess, y: ay + ((y - ay) * k) / n + (r() - 0.5) * s * 0.012 * mess, t: 0, p: 0.5, tilt: -1, orient: -1 });
    }
    dense.push({ x, y, t: 0, p: 0.5, tilt: -1, orient: -1 });
  }
  dense.forEach((p, i) => { p.t = i * 9; });
  const id = `${pen.prefix}-${pen.nextId++}`;
  pen.strokes.push({ id, pen: 'ballpoint', color: '#FF1F2433', size: Math.max(0.8, s * 0.06), points: dense, createdAt: Math.round(pen.clock), input: 'pen' });
  pen.clock += dense.length * 9 + 80;
  pen.owner.set(id, sym);
  pen.symbols[sym]!.strokeIds.push(id);
}

/** Writes a case as strokes at a random size and position. */
export function writeCase(c: Case): Written {
  const r = rng(c.seed * 7919 + 17);
  const s = 14 + r() * 26;
  const pen: Pen = {
    strokes: [], owner: new Map(), symbols: [], r, hand: c.hand,
    slant: -4 + r() * 18, mess: 0.4 + r() * 0.6, clock: 1_700_000_000_000 + c.seed * 1000, nextId: 0, prefix: c.id,
  };
  let y = 100 + r() * 200;
  const x0 = 40 + r() * 200;
  for (const row of c.rows) {
    const m = measure(row, s);
    y += m.up;
    writeRow(pen, row, x0 + (r() - 0.5) * s * 0.4, y, s);
    y += m.down + s * (0.7 + r() * 0.6);
  }
  return { strokes: pen.strokes, owner: pen.owner, symbols: pen.symbols };
}

// ---- Problems --------------------------------------------------------------------------------------

const int = (r: () => number, a: number, b: number) => a + Math.floor(r() * (b - a + 1));
const chars = (s: string): Item[] => [...s];

function arithmetic(r: () => number): { rows: Item[][]; truth: string } {
  const a = int(r, 2, 99), b = int(r, 2, 99), c = int(r, 2, 12);
  switch (int(r, 0, 7)) {
    case 0: return { rows: [chars(`${a}+${b}=`)], truth: `${a}+${b}` };
    case 1: return { rows: [chars(`${a + b}-${b}=`)], truth: `${a + b}-${b}` };
    case 2: return { rows: [chars(`${a}×${c}=`)], truth: `${a}*${c}` };
    case 3: return { rows: [chars(`${a * c}÷${c}=`)], truth: `${a * c}/${c}` };
    case 4: return { rows: [chars(`${a}+${b}×${c}=`)], truth: `${a}+${b}*${c}` };
    case 5: return { rows: [chars(`(${a}+${b})×${c}=`)], truth: `(${a}+${b})*${c}` };
    case 6: { const d = `${int(r, 1, 9)}.${int(r, 1, 9)}`, e = `${int(r, 1, 9)}.${int(r, 10, 99)}`; return { rows: [chars(`${d}+${e}=`)], truth: `${d}+${e}` }; }
    default: return { rows: [chars(`${a}-${b}-${c}=`)], truth: `${a}-${b}-${c}` };
  }
}

function fractions(r: () => number): { rows: Item[][]; truth: string } {
  const p = int(r, 1, 9), q = int(r, 2, 9), u = int(r, 1, 9), v = int(r, 2, 9);
  const f = (n: string | number, d: string | number): Item => ({ frac: [chars(String(n)), chars(String(d))] });
  switch (int(r, 0, 5)) {
    case 0: return { rows: [[f(p, q), '+', f(u, v), '=']], truth: `${p}/${q}+${u}/${v}` };
    case 1: return { rows: [[f(p, q), '-', f(u, v), '=']], truth: `${p}/${q}-${u}/${v}` };
    case 2: return { rows: [[f(p, q), '×', f(u, v), '=']], truth: `${p}/${q}*${u}/${v}` };
    case 3: { const k = int(r, 2, 6); return { rows: [[f(p * k, q * k), '=']], truth: `${p * k}/${q * k}` }; }
    case 4: { const a = int(r, 1, 20), b = int(r, 1, 20); return { rows: [[f(`${a}+${b}`, q), '=']], truth: `(${a}+${b})/${q}` }; }
    default: { const b = int(r, 2, 9); return { rows: [[f('x', q), '=', ...chars(String(b))]], truth: `x/${q}=${b}` }; }
  }
}

function powers(r: () => number): { rows: Item[][]; truth: string } {
  const a = int(r, 2, 9), b = int(r, 2, 4), c = int(r, 2, 9);
  switch (int(r, 0, 5)) {
    case 0: return { rows: [[...chars(String(a)), { sup: chars(String(b)) }, '=']], truth: `${a}^${b}` };
    case 1: return { rows: [[...chars(String(a)), { sup: ['2'] }, '+', ...chars(String(c)), { sup: ['2'] }, '=']], truth: `${a}^2+${c}^2` };
    case 2: { const n = a * a; return { rows: [[{ sqrt: chars(String(n)) }, '=']], truth: `sqrt(${n})` }; }
    case 3: { const n = a * a; return { rows: [[{ sqrt: chars(String(n)) }, '+', ...chars(String(c)), '=']], truth: `sqrt(${n})+${c}` }; }
    case 4: return { rows: [['x', { sup: ['2'] }, '=', ...chars(String(a * a))]], truth: `x^2=${a * a}` };
    default: return { rows: [['(', ...chars(`${a}+${c}`), ')', { sup: ['2'] }, '=']], truth: `(${a}+${c})^2` };
  }
}

function equations(r: () => number): { rows: Item[][]; truth: string } {
  const x = int(r, -6, 9), a = int(r, 2, 9), b = int(r, 1, 20), c = int(r, 2, 9);
  const sgn = (n: number) => (n < 0 ? `-${-n}` : `+${n}`);
  switch (int(r, 0, 4)) {
    case 0: return { rows: [chars(`${a}x${sgn(b)}=${a * x + b}`)], truth: `${a}x${sgn(b)}=${a * x + b}` };
    case 1: { const d = a + c; return { rows: [chars(`${d}x-${b}=${c}x${sgn(a * x - b)}`)], truth: `${d}x-${b}=${c}x${sgn(a * x - b)}` }; }
    case 2: return { rows: [chars(`${a}(x+${b})=${a * (x + b)}`)], truth: `${a}(x+${b})=${a * (x + b)}` };
    case 3: {
      const p = int(r, 1, 6), q = int(r, 1, 6);
      const s = p + q, m = p * q;
      return { rows: [['x', { sup: ['2'] }, ...chars(`-${s}x+${m}=0`)]], truth: `x^2-${s}x+${m}=0` };
    }
    default: return { rows: [chars(`${a}x=${a * x}`)], truth: `${a}x=${a * x}` };
  }
}

function systems(r: () => number): { rows: Item[][]; truth: string } {
  const x = int(r, -4, 8), y = int(r, -4, 8);
  const a = int(r, 1, 5), b = int(r, 1, 5), c = int(r, 1, 5), d = int(r, 1, 5);
  const sgn = (n: number) => (n < 0 ? `-${-n}` : `${n}`);
  const coef = (n: number) => (n === 1 ? '' : String(n));
  const minus = r() < 0.5;
  const l1 = `${coef(a)}x+${coef(b)}y=${sgn(a * x + b * y)}`;
  const l2 = minus ? `${coef(c)}x-${coef(d)}y=${sgn(c * x - d * y)}` : `${coef(c)}x+${coef(d)}y=${sgn(c * x + d * y)}`;
  if (!minus && a * d === b * c) return systems(r);
  return { rows: [chars(l1), chars(l2)], truth: `${l1}\n${l2}` };
}

const MAKERS = { arithmetic, fractions, powers, equations, systems };

/** The eval set: `perCategory` problems in each category, hands rotating A, B, C. */
export function makeCases(perCategory = 70, seed = 20261102): Case[] {
  const out: Case[] = [];
  const r = rng(seed);
  for (const category of Object.keys(MAKERS) as Case['category'][]) {
    for (let i = 0; i < perCategory; i++) {
      const p = MAKERS[category](r);
      const hand = (['A', 'B', 'C'] as const)[i % 3]!;
      out.push({ id: `${category}-${i}`, category, rows: p.rows, truth: p.truth, hand, seed: Math.floor(r() * 1e9) });
    }
  }
  return out;
}
