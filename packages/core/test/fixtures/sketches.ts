import { handwrite, type InkPoint, type InkStroke, type RecognizedLine, type ShapeKind, type TextBox } from '../../src/index.ts';

/**
 * Synthetic hand-drawn diagrams with known answers, for the executable-canvas tests and the
 * graph-extraction eval. Everything is seeded and deterministic. What varies, like real sketches:
 *
 * - boxes: snapped rectangles, one-stroke loops that wobble and overshoot or leave a gap, boxes
 *   drawn as four separate sides that cross or miss at the corners, and rough ellipses;
 * - labels: handwritten with `handwrite()` (script or print) and reported as recognized lines,
 *   typed text boxes, or handwriting not recognized yet;
 * - arrows: slightly curved shafts that start and end short of or past the box edge, with a
 *   separate "V" head, a single barb, a barb drawn in the same stroke (a hook), or no head at
 *   all (drawn from source to target); "V"-headed arrows are sometimes drawn backwards, from the
 *   target to the source, so only the head can tell the direction;
 * - layout: rows and columns with jitter, two to six boxes, a random DAG of edges, sometimes a
 *   back edge that makes a cycle.
 */

export type BoxStyle = 'snapped' | 'loop' | 'sides' | 'ellipse';
export type HeadStyle = 'v' | 'barb' | 'hook' | 'none';
type P = [number, number];

export interface Sketch {
  strokes: InkStroke[];
  texts: TextBox[];
  lines: RecognizedLine[];
  truth: { nodes: { label: string; rect: { minX: number; minY: number; maxX: number; maxY: number } }[]; edges: [number, number][]; cyclic: boolean };
  meta: { boxStyles: BoxStyle[]; heads: HeadStyle[] };
}

export function rng(seed: number) {
  let a = seed | 0 || 1;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const LABELS = ['fetch data', 'filter price > 10', 'sum price', 'chart', 'summarize', 'count', 'sort by date', 'top 5', 'translate', 'average score', 'clean up', 'draft email', 'plan', 'review'];

function interp(c: P[], step = 2): P[] {
  const out: P[] = [];
  for (let i = 1; i < c.length; i++) {
    const [ax, ay] = c[i - 1]!, [bx, by] = c[i]!;
    const n = Math.max(1, Math.floor(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(c[c.length - 1]!);
  return out;
}

export function makeStroke(id: string, pts: P[], opts: { shape?: ShapeKind; t0?: number } = {}): InkStroke {
  const s: InkStroke = { id, pen: 'ballpoint', color: '#FF1B1F24', size: 1.8, createdAt: opts.t0 ?? 0, points: pts.map(([x, y], i): InkPoint => ({ x, y, t: i * 6, p: 0.5, tilt: -1, orient: -1 })) };
  if (opts.shape) s.shape = opts.shape;
  return s;
}

/** Generates one sketch from a seed. */
export function generateSketch(seed: number): Sketch {
  const r = rng(seed);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(r() * xs.length)]!;
  const jit = (a: number) => (r() - 0.5) * 2 * a;
  const n = 2 + Math.floor(r() * 5);
  const cols = n <= 3 ? n : Math.ceil(n / 2);
  const strokes: InkStroke[] = [];
  const texts: TextBox[] = [];
  const lines: RecognizedLine[] = [];
  const nodes: Sketch['truth']['nodes'] = [];
  const boxStyles: BoxStyle[] = [];
  const heads: HeadStyle[] = [];
  let sid = 0;
  const id = () => `s${seed}-${sid++}`;
  const usedLabels = new Set<string>();

  for (let i = 0; i < n; i++) {
    const w = 120 + r() * 70, h = 56 + r() * 26;
    const x = 60 + (i % cols) * 280 + jit(16), y = 60 + Math.floor(i / cols) * 200 + jit(16);
    const rect = { minX: x, minY: y, maxX: x + w, maxY: y + h };
    const style: BoxStyle = pick(['snapped', 'loop', 'loop', 'sides', 'ellipse'] as const);
    boxStyles.push(style);
    if (style === 'snapped') {
      strokes.push(makeStroke(id(), interp([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], 3), { shape: 'rectangle' }));
    } else if (style === 'loop') {
      // One stroke around, starting near a corner, with wobble and a small overshoot or gap.
      const end = r() < 0.5 ? jit(6) + 8 : -(4 + r() * 6);
      const c: P[] = [[x + jit(3), y + jit(3)], [x + w + jit(4), y + jit(4)], [x + w + jit(4), y + h + jit(4)], [x + jit(4), y + h + jit(4)], [x + jit(3), y + end]];
      strokes.push(makeStroke(id(), interp(c, 2).map(([px, py]) => [px + jit(0.8), py + jit(0.8)])));
    } else if (style === 'ellipse') {
      const cx = x + w / 2, cy = y + h / 2;
      const pts: P[] = Array.from({ length: 80 }, (_, k) => { const a = (k / 76) * Math.PI * 2; return [cx + (w / 2) * Math.cos(a) * (1 + jit(0.03)), cy + (h / 2) * Math.sin(a) * (1 + jit(0.03))]; });
      strokes.push(makeStroke(id(), pts));
    } else {
      const o = () => jit(5);
      strokes.push(makeStroke(id(), interp([[x + o(), y + o()], [x + w + o(), y + o()]])));
      strokes.push(makeStroke(id(), interp([[x + w + o(), y + o()], [x + w + o(), y + h + o()]])));
      strokes.push(makeStroke(id(), interp([[x + w + o(), y + h + o()], [x + o(), y + h + o()]])));
      strokes.push(makeStroke(id(), interp([[x + o(), y + h + o()], [x + o(), y + o()]])));
    }
    let label = pick(LABELS);
    while (usedLabels.has(label)) label = `${pick(LABELS)} ${usedLabels.size}`;
    usedLabels.add(label);
    nodes.push({ label, rect });
    const how = r();
    if (how < 0.25) {
      texts.push({ id: id(), x: x + 12, y: y + h / 2 - 10, width: w - 24, text: label, fontSize: 14, color: '#FF1B1F24', font: 'sans', createdAt: 0 });
    } else {
      const xh = 6 + r() * 2;
      const hw = handwrite(label, { x: x + 10, y: y + h / 2 - xh * 1.2, width: w - 20, xHeight: xh, style: r() < 0.5 ? 'script' : 'print', seed: seed * 31 + i, newId: id });
      strokes.push(...hw.strokes);
      // Mostly recognized already; sometimes not yet (the app then reads it).
      if (how < 0.9) {
        const xs = hw.strokes.flatMap((s) => s.points.map((p) => p.x)), ys = hw.strokes.flatMap((s) => s.points.map((p) => p.y));
        lines.push({ text: label, strokeIds: hw.strokes.map((s) => s.id), bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } });
      }
    }
  }

  // A random DAG over a random order, plus sometimes one back edge (a cycle).
  const order = nodes.map((_, i) => i).sort(() => r() - 0.5);
  const edges: [number, number][] = [];
  for (let k = 1; k < order.length; k++) {
    const to = order[k]!;
    const from = order[Math.floor(r() * k)]!;
    edges.push([from, to]);
    if (k > 1 && r() < 0.25) { const f2 = order[Math.floor(r() * k)]!; if (f2 !== from) edges.push([f2, to]); }
  }
  let cyclic = false;
  if (order.length >= 3 && r() < 0.15) { edges.push([order[order.length - 1]!, order[0]!]); cyclic = true; }

  for (const [a, b] of edges) {
    const A = nodes[a]!.rect, B = nodes[b]!.rect;
    const ca: P = [(A.minX + A.maxX) / 2, (A.minY + A.maxY) / 2], cb: P = [(B.minX + B.maxX) / 2, (B.minY + B.maxY) / 2];
    // Leave each box through the side facing the other box, a little short of or past the edge.
    const gap = Math.max(20, Math.hypot(cb[0] - ca[0], cb[1] - ca[1]) - Math.hypot(A.maxX - A.minX, A.maxY - A.minY) / 2 - Math.hypot(B.maxX - B.minX, B.maxY - B.minY) / 2);
    const exit = (R: typeof A, from: P, to: P): P => {
      const dx = to[0] - from[0], dy = to[1] - from[1];
      const tx = dx ? ((dx > 0 ? R.maxX : R.minX) - from[0]) / dx : Infinity;
      const ty = dy ? ((dy > 0 ? R.maxY : R.minY) - from[1]) / dy : Infinity;
      const t = Math.min(tx, ty);
      const off = Math.min(4 + r() * 12, gap * 0.2);
      const len = Math.hypot(dx, dy) || 1;
      return [from[0] + dx * t + (dx / len) * off * (r() < 0.8 ? 1 : -0.4), from[1] + dy * t + (dy / len) * off * (r() < 0.8 ? 1 : -0.4)];
    };
    const p0 = exit(A, ca, cb), p1 = exit(B, cb, ca);
    const style: HeadStyle = pick(['v', 'v', 'barb', 'hook', 'none'] as const);
    heads.push(style);
    const bend = jit(10);
    const mid: P = [(p0[0] + p1[0]) / 2 + bend * 0.5, (p0[1] + p1[1]) / 2 + bend];
    const shaft = interp([p0, mid, p1], 2).map(([x, y]): P => [x + jit(0.6), y + jit(0.6)]);
    const dx = p1[0] - mid[0], dy = p1[1] - mid[1];
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len, uy = dy / len;
    const hs = 9 + r() * 5;
    const barbL: P = [p1[0] - ux * hs - uy * hs * 0.6, p1[1] - uy * hs + ux * hs * 0.6];
    const barbR: P = [p1[0] - ux * hs + uy * hs * 0.6, p1[1] - uy * hs - ux * hs * 0.6];
    if (style === 'hook') {
      strokes.push(makeStroke(id(), [...shaft, ...interp([p1, barbL], 1.5).slice(1)]));
    } else {
      const backwards = style === 'v' && r() < 0.35;
      strokes.push(makeStroke(id(), backwards ? [...shaft].reverse() : shaft));
      if (style === 'v') strokes.push(makeStroke(id(), interp([barbL, [p1[0] + jit(2), p1[1] + jit(2)], barbR], 1.5)));
      if (style === 'barb') strokes.push(makeStroke(id(), interp([[p1[0] + jit(2), p1[1] + jit(2)], barbR], 1.5)));
    }
  }
  return { strokes, texts, lines, truth: { nodes, edges, cyclic }, meta: { boxStyles, heads } };
}
