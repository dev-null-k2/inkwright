import { describe, expect, it } from 'vitest';
import {
  asFunctionOfX, autoView, cellAt, cellOfStroke, compileFunctionOfX, detectChecklist, detectEnclosure, detectTable,
  detectTrailingEquals, findRoots, fitTableToInk, graphGeometry, insertCol, insertRow, niceTicks, parseMath, compileNode,
  recognizeShape, relayoutStrokes, removeCol, removeRow, sampleFunction, shapeToStroke, tableFromCandidate,
  tableToCsv, tableToMarkdown, exportPageSvg, newNote, objectsText, type InkStroke, type TableObject, type GraphObject,
} from '../src/index.ts';
import { jitter, polyline, stroke, wobblyEllipse, word } from './helpers.ts';

type P = [number, number];
let seq = 0;
/** A stroke written at time `at` (createdAt matters to detectors that look at the newest ink). */
const s = (pts: P[], at = ++seq * 1000, id = `s${seq}`): InkStroke => ({ ...stroke(id, pts), createdAt: at });
const box = (x0: number, y0: number, x1: number, y1: number, j = 1.2) => s(jitter(polyline([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + 2]]), j, seq + 3));
const snappedBox = (x0: number, y0: number, x1: number, y1: number) => {
  const raw = s(polyline([[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0 + 2]]));
  return shapeToStroke(raw, recognizeShape(raw.points)!);
};
const hline = (x0: number, x1: number, y: number) => s(jitter(polyline([[x0, y], [x1, y + 1]]), 0.8, seq + 7));
const vline = (x: number, y0: number, y1: number) => s(jitter(polyline([[x, y0], [x + 1, y1]]), 0.8, seq + 11));

describe('draw a table', () => {
  it('turns a snapped box with rules across it into a 3×3 grid', () => {
    const strokes = [snappedBox(100, 100, 400, 250), hline(102, 398, 150), hline(100, 400, 200), vline(200, 101, 249), vline(300, 100, 250)];
    const c = detectTable(strokes);
    expect(c).not.toBeNull();
    expect(c!.xs).toHaveLength(2);
    expect(c!.ys).toHaveLength(2);
    expect(c!.strokeIds).toHaveLength(5);
    const t = tableFromCandidate(c!, 't1', 0);
    expect(t.rows).toHaveLength(3);
    expect(t.cols).toHaveLength(3);
    expect(t.cells.length).toBe(3);
    expect(t.cols.reduce((a, b) => a + b, 0)).toBeCloseTo(300, -1);
  });

  it('works with a freehand (unsnapped) box and two vertical rules (1×3)', () => {
    const c = detectTable([box(50, 50, 350, 120), vline(150, 52, 118), vline(250, 50, 121)]);
    expect(c?.xs).toHaveLength(2);
    expect(c?.ys).toHaveLength(0);
  });

  it('accepts rules that stop a little short of the edges', () => {
    const c = detectTable([snappedBox(0, 0, 300, 200), hline(12, 290, 100), vline(150, 10, 192)]);
    expect(c).not.toBeNull();
  });

  it('near miss: a box with a single line is not a table', () => {
    expect(detectTable([snappedBox(0, 0, 300, 200), hline(2, 298, 100)])).toBeNull();
  });

  it('near miss: a box with writing inside (a framed note with an underline) is not a table', () => {
    const strokes = [snappedBox(0, 0, 300, 200), s(word(30, 50, 200)), hline(2, 298, 100), vline(150, 2, 198)];
    expect(detectTable(strokes)).toBeNull();
  });

  it('near miss: lines that do not span the box are not rules', () => {
    expect(detectTable([snappedBox(0, 0, 300, 200), hline(2, 120, 70), hline(2, 140, 130)])).toBeNull();
  });

  it('near miss: diagonal lines (a crossed-out box) are not rules', () => {
    expect(detectTable([snappedBox(0, 0, 300, 200), s(polyline([[0, 0], [300, 200]])), s(polyline([[300, 0], [0, 200]]))])).toBeNull();
  });

  it('near miss: a circle with lines through it is not a table', () => {
    expect(detectTable([s(wobblyEllipse(150, 100, 140, 90)), hline(10, 290, 100), vline(150, 10, 190)])).toBeNull();
  });

  it('near miss: rules too close together for a cell', () => {
    expect(detectTable([snappedBox(0, 0, 300, 200), hline(2, 298, 100), hline(2, 298, 105)])).toBeNull();
  });

  it('only uses recent strokes as rules; older ink inside the box blocks it', () => {
    const old = hline(2, 298, 60);
    const recent = [snappedBox(0, 0, 300, 200), hline(2, 298, 120), vline(150, 2, 198)];
    expect(detectTable(recent, [old, ...recent])).toBeNull();
    expect(detectTable(recent, recent)).not.toBeNull();
  });
});

describe('table objects', () => {
  const t: TableObject = { type: 'table', id: 't', x: 0, y: 0, cols: [100, 100], rows: [40, 40], cells: [[{ text: 'Name' }, { text: 'Qty' }], [{ recognized: 'Milk' }, { text: '2' }]], color: '#FF000000', lineWidth: 1.5, createdAt: 0 };

  it('finds cells by point and strokes by their centre', () => {
    expect(cellAt(t, 150, 60)).toEqual({ r: 1, c: 1 });
    expect(cellAt(t, 250, 60)).toBeNull();
    expect(cellOfStroke(t, s(word(10, 60, 60)))).toEqual({ r: 1, c: 0 });
  });

  it('exports Markdown and CSV (typed text first, else recognized)', () => {
    expect(tableToMarkdown(t)).toBe('| Name | Qty |\n| --- | --- |\n| Milk | 2 |');
    expect(tableToCsv({ ...t, cells: [[{ text: 'a,b' }, { text: 'say "hi"' }], [{}, { text: 'x' }]] })).toBe('"a,b","say ""hi"""\r\n,x\r\n');
    expect(objectsText([t])).toContain('| Milk | 2 |');
  });

  it('moves cell ink with its cell when a row or column is inserted', () => {
    const ink = s(word(110, 60, 60)); // cell (1,1)
    const outside = s(word(300, 300, 40));
    const e = insertRow(t, 1, 30);
    expect(e.table.rows).toEqual([40, 30, 40]);
    expect(e.table.cells[1]).toEqual([{}, {}]);
    const r = relayoutStrokes(t, e, [ink, outside]);
    expect(r.moved.get(ink.id)!.points[0]!.y).toBeCloseTo(ink.points[0]!.y + 30);
    expect(r.moved.has(outside.id)).toBe(false);
    const e2 = insertCol(t, 0, 50);
    expect(relayoutStrokes(t, e2, [ink]).moved.get(ink.id)!.points[0]!.x).toBeCloseTo(ink.points[0]!.x + 50);
  });

  it('removes the ink of a removed row and shifts the rest up', () => {
    const top = s(word(10, 20, 60));
    const bottom = s(word(10, 60, 60));
    const e = removeRow(t, 0)!;
    const r = relayoutStrokes(t, e, [top, bottom]);
    expect(r.removed.has(top.id)).toBe(true);
    expect(r.moved.get(bottom.id)!.points[0]!.y).toBeCloseTo(bottom.points[0]!.y - 40);
    expect(removeCol(removeCol(t, 0)!.table, 0)).toBeNull();
  });

  it('grows a row so the ink written in it stays inside', () => {
    const tall = s(polyline([[20, 45], [20, 100]]));
    const e = fitTableToInk(t, [tall])!;
    expect(e.table.rows[1]).toBeGreaterThanOrEqual(100 - 40 + 6 - 0.01);
    expect(fitTableToInk(t, [s(word(10, 60, 40))])).toBeNull();
  });

  it('renders into the page SVG', () => {
    const note = newNote({ id: 'n', title: 'T', pageId: 'p', now: 0 });
    const svg = exportPageSvg(note, { id: 'p', strokes: [], objects: [t], formatVersion: 2 });
    expect(svg).toContain('class="table"');
    expect(svg).toContain('>Name<');
  });
});

describe('maths expressions', () => {
  const ev = (src: string, x = 0) => compileNode(parseMath(src))({ x });
  it('reads handwritten maths: implicit multiplication, powers, functions, symbols', () => {
    expect(ev('2x+3', 2)).toBe(7);
    expect(ev('3x^2', 2)).toBe(12);
    expect(ev('-x^2', 3)).toBe(-9);
    expect(ev('(x+1)(x-1)', 3)).toBe(8);
    expect(ev('2sin(x)', Math.PI / 2)).toBeCloseTo(2);
    expect(ev('sin x', Math.PI / 2)).toBeCloseTo(1);
    expect(ev('√(16)')).toBe(4);
    expect(ev('2π')).toBeCloseTo(Math.PI * 2);
    expect(ev('x²', 5)).toBe(25);
    expect(ev('6 ÷ 3 × 2')).toBe(4);
    expect(ev('|x-5|', 2)).toBe(3);
    expect(ev('5!')).toBe(120);
    expect(ev('log(1000)')).toBeCloseTo(3);
    expect(ev('ln(e)')).toBeCloseTo(1);
    expect(ev('(-8)^(1/3)')).toBeCloseTo(-2);
    expect(ev('2^3^2')).toBe(512);
    expect(ev('sin(x)^2+cos(x)^2', 0.7)).toBeCloseTo(1);
  });
  it('rejects malformed input', () => {
    expect(() => parseMath('2+')).toThrow();
    expect(() => parseMath('(2')).toThrow();
    expect(() => parseMath('2 $ 3')).toThrow();
  });
  it('recognises functions of x to plot', () => {
    expect(asFunctionOfX('y = x^2 - 4')).toEqual({ expr: 'x^2 - 4', label: 'y' });
    expect(asFunctionOfX('f(x) = 2x + 1')).toEqual({ expr: '2x + 1', label: 'f(x)' });
    expect(asFunctionOfX('sin(x)/x')).toEqual({ expr: 'sin(x)/x', label: 'y' });
    expect(asFunctionOfX('2 + 3')).toBeNull();
    expect(asFunctionOfX('x + y')).toBeNull();
    expect(asFunctionOfX('x = 3')).toBeNull();
  });
  it('finds roots and skips poles', () => {
    expect(findRoots(compileFunctionOfX('x^2-4')!, -10, 10).map((r) => Math.round(r * 1e6) / 1e6)).toEqual([-2, 2]);
    expect(findRoots(compileFunctionOfX('1/x')!, -10, 10)).toEqual([]);
    expect(findRoots(compileFunctionOfX('sin(x)')!, -1, 7).length).toBe(3);
  });
  it('samples curves and breaks them at asymptotes', () => {
    const lines = sampleFunction(compileFunctionOfX('1/x')!, -5, 5, 400, 20);
    expect(lines.length).toBe(2);
    expect(sampleFunction(compileFunctionOfX('sqrt(x)')!, -5, 5, 100, 10).length).toBe(1);
  });
  it('nice ticks and an automatic view', () => {
    expect(niceTicks(-10, 10, 4)).toEqual([-10, -5, 0, 5, 10]);
    const v = autoView(['x^2']);
    expect(v.yMin).toBeLessThan(0);
    expect(v.yMax).toBeGreaterThan(50);
  });
  it('graph geometry maps intercepts into the frame', () => {
    const g: GraphObject = { type: 'graph', id: 'g', x: 0, y: 0, width: 200, height: 200, functions: [{ expr: 'x - 2', color: '#FF2F6FB5' }], view: { xMin: -5, xMax: 5, yMin: -5, yMax: 5 }, origin: 'solver', createdAt: 0 };
    const geo = graphGeometry(g);
    expect(geo.curves[0]!.roots[0]).toBeCloseTo(2);
    expect(geo.curves[0]!.yIntercept).toBeCloseTo(-2);
    const p = geo.toPage(0, 0);
    expect(p.x).toBeCloseTo(100);
    expect(p.y).toBeCloseTo(100);
  });
});

describe('ink cues', () => {
  it('spots "=" written after an expression', () => {
    const a = s(word(100, 100, 30)), plus = s(polyline([[140, 100], [152, 100]])), b = s(word(160, 100, 20));
    const e1 = s(polyline([[190, 96], [206, 96]])), e2 = s(polyline([[190, 104], [207, 104]]));
    const cue = detectTrailingEquals([a, plus, b, e1, e2]);
    expect(cue).not.toBeNull();
    expect(cue!.equalsIds).toEqual([e1.id, e2.id]);
    expect(new Set(cue!.problemIds)).toEqual(new Set([a.id, plus.id, b.id]));
  });
  it('does not mistake two underlines or a lone dash for "="', () => {
    const w1 = s(word(100, 100, 120));
    expect(detectTrailingEquals([w1, s(polyline([[100, 112], [220, 112]])), s(polyline([[100, 160], [220, 160]]))])).toBeNull();
    expect(detectTrailingEquals([w1, s(polyline([[230, 100], [245, 100]]))])).toBeNull();
    // An "=" with nothing before it on the line.
    expect(detectTrailingEquals([s(word(100, 300, 50)), s(polyline([[400, 96], [416, 96]])), s(polyline([[400, 104], [416, 104]]))])).toBeNull();
  });
  it('spots a loop drawn around writing', () => {
    const w = s(word(110, 100, 80));
    const loop = s(wobblyEllipse(150, 100, 70, 30));
    const cue = detectEnclosure([w, loop]);
    expect(cue?.enclosedIds).toEqual([w.id]);
    expect(detectEnclosure([s(word(500, 500, 80)), s(wobblyEllipse(150, 100, 70, 30))])).toBeNull();
    // A box (could be a table) is not a circling gesture.
    expect(detectEnclosure([s(word(110, 100, 80)), snappedBox(60, 60, 240, 140)])).toBeNull();
  });
  it('spots a handwritten checklist', () => {
    const items = [0, 1, 2].map((i) => [s(polyline([[100, 100 + i * 40], [116, 100 + i * 40], [116, 116 + i * 40], [100, 116 + i * 40], [100, 101 + i * 40]])), s(word(130, 108 + i * 40, 90))]);
    const tick = s(polyline([[102, 148], [107, 154], [115, 142]]));
    const cues = detectChecklist([...items.flat(), tick]);
    expect(cues).toHaveLength(3);
    expect(cues.map((c) => c.checked)).toEqual([false, true, false]);
    expect(detectChecklist(items[0]!)).toEqual([]);
  });
});
