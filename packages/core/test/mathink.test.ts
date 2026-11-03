import { describe, expect, it } from 'vitest';
import {
  aliasesOf, builtInRecognizer, decode, fromRanked, handwrite, linearize, parseLayout, readMathInk, segmentSymbols, toLatex, toPlain,
  type InkPoint, type InkStroke, type MathSymbol, type RawCandidate, type SymbolRecognizer,
} from '../src/index.ts';

/** A stroke through these points (page units, y down), densified like real pen input. */
let clock = 1000;
function stroke(id: string, pts: [number, number][]): InkStroke {
  const out: InkPoint[] = [];
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i]!;
    if (i) {
      const [ax, ay] = pts[i - 1]!;
      const n = Math.max(1, Math.ceil(Math.hypot(x - ax, y - ay) / 1.5));
      for (let k = 1; k < n; k++) out.push({ x: ax + ((x - ax) * k) / n, y: ay + ((y - ay) * k) / n, t: out.length * 8, p: 0.5, tilt: -1, orient: -1 });
    }
    out.push({ x, y, t: out.length * 8, p: 0.5, tilt: -1, orient: -1 });
  }
  clock += 300;
  return { id, pen: 'ballpoint', color: '#FF000000', size: 1, points: out, createdAt: clock };
}

/** A digit-ish squiggle filling a box (for grouping and layout, the shape doesn't matter). */
const glyph = (id: string, x: number, y: number, w = 12, h = 20): InkStroke => stroke(id, [[x, y + h * 0.2], [x + w * 0.5, y], [x + w, y + h * 0.3], [x, y + h], [x + w, y + h]]);
const bar = (id: string, x0: number, x1: number, y: number) => stroke(id, [[x0, y], [x1, y + 0.3]]);

const sym = (id: string, labels: string | [string, number][], b: [number, number, number, number], shape?: string): MathSymbol => ({
  id, strokeIds: [id], bounds: { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] }, shape,
  cands: typeof labels === 'string' ? [{ label: labels, p: 0.9 }] : labels.map(([label, p]) => ({ label, p })),
});

/** A recognizer that answers from a table keyed by the group's first stroke id. */
function scripted(answers: Record<string, RawCandidate[]>): SymbolRecognizer {
  return { name: 'scripted', async recognize(groups) { return groups.map((g) => answers[g.strokes[0]!.id] ?? []); } };
}

describe('grouping strokes into symbols', () => {
  it('joins crossing strokes ("+"), stacked bars ("=") and a bar with its dots ("÷")', () => {
    const strokes = [
      glyph('two', 0, 0),
      bar('plus-h', 18, 32, 10), stroke('plus-v', [[25, 3], [25, 17]]),
      glyph('two2', 38, 0),
      bar('eq-top', 56, 70, 7), bar('eq-bottom', 56, 70, 13),
      bar('div', 80, 94, 10), stroke('dot-up', [[87, 4], [87.6, 4.4]]), stroke('dot-down', [[87, 16], [87.6, 16.4]]),
    ];
    const { groups } = segmentSymbols(strokes);
    const ids = groups.map((g) => g.strokes.map((s) => s.id).sort().join('+'));
    expect(ids).toEqual(['two', 'plus-h+plus-v', 'two2', 'eq-bottom+eq-top', 'div+dot-down+dot-up']);
    expect(groups.map((g) => g.shape)).toEqual([undefined, 'plus', undefined, 'equals', 'divide']);
  });

  it('never joins a fraction bar to the numerator it touches', () => {
    const strokes = [glyph('num', 4, 0, 12, 18), bar('bar', 0, 22, 18.5), glyph('den', 4, 22, 12, 18)];
    const { groups } = segmentSymbols(strokes);
    expect(groups.map((g) => g.strokes.map((s) => s.id).join('+')).sort()).toEqual(['bar', 'den', 'num']);
  });

  it('joins the foot of a "1" to its stem, but not a minus sign to its neighbour', () => {
    const one = [stroke('stem', [[5, 0], [5, 20]]), bar('foot', 0, 10, 20)];
    expect(segmentSymbols(one).groups).toHaveLength(1);
    const minus = [glyph('a', 0, 0), bar('minus', 13, 22, 10), glyph('b', 23, 0)];
    expect(segmentSymbols(minus).groups).toHaveLength(3);
  });

  it('keeps a radical sign apart from what is under it', () => {
    const strokes = [stroke('rad', [[0, 14], [3, 12], [7, 24], [12, -2], [40, -2]]), glyph('a', 16, 2, 9, 18), glyph('b', 27, 2, 9, 18)];
    const { groups } = segmentSymbols(strokes);
    expect(groups).toHaveLength(3);
    expect(groups.find((g) => g.strokes[0]!.id === 'rad')?.shape).toBe('radical');
  });
});

describe('the layout parser', () => {
  it('finds a fraction: numerator above the bar, denominator below', () => {
    const lines = parseLayout([
      sym('1', '1', [4, 0, 10, 16]), sym('bar', '-', [0, 19, 16, 19.4], 'hline'), sym('2', '2', [3, 23, 13, 39]), sym('eq', '=', [22, 15, 32, 23], 'equals'),
    ], 16);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.items.map((n) => n.k)).toEqual(['frac', 'sym']);
  });

  it('finds exponents (smaller and raised) but not a lowercase letter after a digit', () => {
    const lines = parseLayout([
      sym('x', 'x', [0, 8, 10, 20]), sym('2', '2', [11, 0, 17, 9]), sym('plus', '+', [20, 8, 30, 18], 'plus'), sym('3', '3', [33, 0, 43, 20]), sym('y', 'y', [45, 8, 55, 24]),
    ], 20);
    const items = lines[0]!.items;
    expect(items).toHaveLength(4);
    expect(items[0]!.k === 'sym' && items[0].sup?.items.length).toBe(1);
    expect(items[2]!.k === 'sym' && items[2].sup).toBeUndefined();
  });

  it('splits a system into lines and puts a radicand under its root', () => {
    const lines = parseLayout([
      sym('x', 'x', [0, 6, 10, 18]), sym('eq', '=', [14, 9, 24, 15], 'equals'), sym('1', '1', [28, 0, 32, 18]),
      sym('y', 'y', [0, 36, 10, 52]), sym('eq2', '=', [14, 40, 24, 46], 'equals'), sym('rad', '√', [27, 26, 60, 52], 'radical'), sym('4', '4', [40, 32, 52, 50]),
    ], 18);
    expect(lines).toHaveLength(2);
    expect(lines[1]!.items.map((n) => n.k)).toEqual(['sym', 'sym', 'sqrt']);
  });
});

describe('the decoder', () => {
  const read = (syms: MathSymbol[], ref = 20) => {
    const d = decode(linearize(parseLayout(syms, ref)));
    return d ? toPlain(d.toks) : null;
  };
  it('lets the grammar pick: "t" between numbers is a plus, "l" is a one', () => {
    expect(read([sym('a', '2', [0, 0, 10, 20]), sym('b', [['t', 0.6], ['+', 0.5]], [13, 4, 23, 16]), sym('c', [['l', 0.7], ['1', 0.6]], [27, 0, 30, 20])])).toBe('2+1');
  });
  it('tells times from the letter x by what follows', () => {
    const cross = (id: string, x: number) => sym(id, [['×', 0.7], ['x', 0.65]], [x, 6, x + 9, 16]);
    expect(read([sym('a', '2', [0, 0, 10, 20]), cross('b', 13), sym('c', '3', [26, 0, 36, 20])])).toBe('2*3');
    expect(read([sym('a', '2', [0, 0, 10, 20]), cross('b', 13), sym('p', '+', [25, 5, 35, 15], 'plus'), sym('c', '1', [38, 0, 41, 20])])).toBe('2x+1');
  });
  it('prints fractions, powers and roots as plain maths and LaTeX', () => {
    const syms = [sym('1', '1', [4, 0, 10, 16]), sym('bar', '-', [0, 19, 16, 19.4], 'hline'), sym('2', '2', [3, 23, 13, 39]), sym('p', '+', [20, 14, 30, 24], 'plus'), sym('x', 'x', [33, 14, 43, 26]), sym('e', '2', [44, 6, 50, 15])];
    const d = decode(linearize(parseLayout(syms, 16)))!;
    expect(toPlain(d.toks)).toBe('1/2+x^2');
    expect(toLatex(d.toks)).toBe('\\frac{1}{2}+x^{2}');
  });
  it('gives up rather than invent maths', () => {
    expect(read([sym('a', '+', [0, 5, 10, 15], 'plus'), sym('b', '=', [12, 7, 22, 13], 'equals')])).toBeNull();
  });
});

describe('recognizer output', () => {
  it('maps text answers onto maths symbols with weights', () => {
    expect(aliasesOf('—')).toEqual([['-', 0.95]]);
    expect(aliasesOf('TT')[0]![0]).toBe('π');
    expect(aliasesOf('12')).toEqual([['12', 0.9]]);
    const c = fromRanked([{ text: 't', score: 1.1 }, { text: '+', score: 1.3 }]);
    expect(c.map((x) => x.label)).toContain('+');
    expect(c.find((x) => x.label === '+')!.p).toBeGreaterThan(c.find((x) => x.label === 't')!.p);
  });
});

describe('reading handwritten maths end to end', () => {
  it('reads "2+2=" written by the handwriting synthesizer with the built-in classifier', async () => {
    const hw = handwrite('2+2=', { x: 10, y: 10, xHeight: 10, style: 'print', seed: 3 });
    const r = await readMathInk(hw.strokes, builtInRecognizer);
    expect(r.plain).toBe('2+2=');
    expect(r.engine).toBe('built-in');
    expect(r.confidence).toBeGreaterThan(0.5);
  });

  it('reads a stacked fraction from ML Kit-style answers', async () => {
    const strokes = [glyph('three', 3, 0, 10, 18), bar('bar', 0, 16, 21), glyph('four', 3, 24, 10, 18), bar('e1', 22, 32, 18), bar('e2', 22, 32, 24)];
    const r = await readMathInk(strokes, scripted({ three: [{ text: '3', score: 0.2 }, { text: 'B', score: 2 }], four: [{ text: '4', score: 0.4 }, { text: 'y', score: 2.5 }] }));
    expect(r.plain).toBe('3/4=');
    expect(r.latex).toBe('\\frac{3}{4}=');
  });

  it('splits a group the recognizer read as two characters, and reads the parts again', async () => {
    // A "1" whose stem cuts through the "2" next to it: one group, which ML Kit reads "12".
    const strokes = [stroke('one', [[1, 0], [6, 22]]), stroke('two', [[4, 4], [9, 0], [14, 4], [4, 20], [16, 20]]), bar('e1', 22, 32, 8), bar('e2', 22, 32, 14)];
    const asked: number[] = [];
    const r = await readMathInk(strokes, {
      name: 'ml-kit',
      async recognize(groups) {
        asked.push(groups.length);
        return groups.map((g) => (g.strokes.length === 2 ? [{ text: '12', score: 1 }] : g.strokes[0]!.id === 'one' ? [{ text: '1', score: 0.3 }] : [{ text: '2', score: 0.3 }]));
      },
    });
    expect(asked).toEqual([1, 2]);
    expect(r.plain).toBe('12=');
  });
});
