import { describe, expect, it } from 'vitest';
import { detectScratchOut, erasePrecisely, hitStrokes, lassoSelect, scaleStroke, segmentLines, translateStroke, rotateStroke, point } from '../src/index.ts';
import { horizontalScribble, polyline, stroke, verticalScribble, word } from './helpers.ts';

const hello = stroke('hello', word(100, 200));
const world = stroke('world', word(300, 200));
const page = [hello, world];

describe('scratch-out', () => {
  it('side-to-side scribble over a word erases it', () => {
    const r = detectScratchOut(stroke('s', horizontalScribble(95, 205, 190, 210, 8)), page);
    expect(r.isScratch).toBe(true);
    expect([...r.targetIds]).toEqual(['hello']);
  });
  it('up-and-down scribble over a word erases it', () => {
    const r = detectScratchOut(stroke('s', verticalScribble(98, 204, 188, 212, 14)), page);
    expect(r.isScratch).toBe(true);
    expect([...r.targetIds]).toEqual(['hello']);
  });
  it('scribble on empty paper is just ink', () => {
    expect(detectScratchOut(stroke('s', horizontalScribble(95, 205, 590, 610, 8)), page).isScratch).toBe(false);
  });
  it('an underline is not a scratch', () => {
    expect(detectScratchOut(stroke('u', polyline([[95, 212], [205, 212]])), page).isScratch).toBe(false);
  });
  it('writing an "m" next to a word is not a scratch', () => {
    const m = stroke('m', polyline([[420, 210], [425, 195], [430, 210], [435, 195], [440, 210], [445, 195], [450, 210]]));
    expect(detectScratchOut(m, page).isScratch).toBe(false);
  });
  it('a short tick over a word is not a scratch', () => {
    expect(detectScratchOut(stroke('t', polyline([[140, 200], [145, 206], [155, 190]])), page).isScratch).toBe(false);
  });
  it('shading inside a box you drew keeps the box', () => {
    const box = stroke('box', polyline([[500, 100], [580, 100], [580, 150], [500, 150], [500, 100]]));
    const shade = stroke('s', horizontalScribble(503, 577, 103, 147, 12));
    expect(detectScratchOut(shade, [...page, box]).targetIds.has('box')).toBe(false);
  });
  it('a quick back-forth-back over a word still erases it', () => {
    const r = detectScratchOut(stroke('s', horizontalScribble(95, 205, 192, 208, 3)), page);
    expect(r.isScratch).toBe(true);
    expect(r.targetIds.has('hello')).toBe(true);
  });
  it('zoomed in, small handwriting is scratched without touching the line below', () => {
    const small = stroke('small', word(100, 200).map(([x, y]) => [100 + (x - 100) * 0.3, 200 + (y - 200) * 0.3] as [number, number]));
    const below = stroke('below', word(100, 210).map(([x, y]) => [100 + (x - 100) * 0.3, 210 + (y - 210) * 0.3] as [number, number]));
    const r = detectScratchOut(stroke('s', horizontalScribble(99, 133, 197, 203, 6)), [small, below], { overInkTolerance: 5 / 3 });
    expect([...r.targetIds]).toEqual(['small']);
  });
  it('a scribble covering two words erases both', () => {
    const r = detectScratchOut(stroke('s', horizontalScribble(95, 405, 188, 212, 10)), page);
    expect(r.isScratch).toBe(true);
    expect([...r.targetIds].sort()).toEqual(['hello', 'world']);
  });
  it('grazing the edge of a word leaves it alone', () => {
    const r = detectScratchOut(stroke('s', horizontalScribble(185, 230, 190, 210, 10)), page);
    expect(r.targetIds.has('hello')).toBe(false);
  });
  it('highlighter scribbles never erase', () => {
    const r = detectScratchOut(stroke('s', horizontalScribble(95, 205, 190, 210, 8), 16, 'highlighter'), page);
    expect(r.isScratch).toBe(false);
  });
});

describe('erasers', () => {
  const line = stroke('line', polyline([[0, 100], [200, 100]]));
  const far = stroke('far', polyline([[0, 300], [200, 300]]));
  const path = (...c: [number, number][]) => polyline(c).map(([x, y]) => point(x, y, 0));

  it('stroke eraser hits only touched strokes', () => {
    expect([...hitStrokes([line, far], path([100, 80], [100, 120]), 4)]).toEqual(['line']);
  });
  it('tap eraser hits the stroke under the tip', () => {
    expect([...hitStrokes([line, far], [point(50, 101, 0)], 3)]).toEqual(['line']);
  });
  it('precise eraser splits a stroke in two', () => {
    let n = 0;
    const out = erasePrecisely([line, far], path([100, 80], [100, 120]), 6, () => `frag${n++}`);
    expect(out.removed.map((s) => s.id)).toEqual(['line']);
    expect(out.added).toHaveLength(2);
    const [left, right] = [...out.added].sort((a, b) => a.points[0]!.x - b.points[0]!.x);
    expect(Math.max(...left!.points.map((p) => p.x))).toBeLessThan(94);
    expect(Math.min(...right!.points.map((p) => p.x))).toBeGreaterThan(106);
    expect(left!.pen).toBe(line.pen);
    expect(right!.points[0]!.t).toBe(0);
    expect(out.replacements.get('line')).toHaveLength(2);
  });
  it('precise eraser over a whole small stroke removes it without fragments', () => {
    const small = stroke('small', polyline([[10, 10], [14, 10]]));
    const out = erasePrecisely([small], path([0, 10], [30, 10]), 6, () => 'x');
    expect(out.removed).toHaveLength(1);
    expect(out.added).toHaveLength(0);
  });
  it('precise eraser leaves untouched strokes alone', () => {
    expect(erasePrecisely([far], path([100, 80], [100, 120]), 6, () => 'x').removed).toHaveLength(0);
  });
});

describe('lasso & transforms', () => {
  it('selects enclosed strokes only', () => {
    const a = stroke('a', polyline([[10, 10], [40, 40]]));
    const b = stroke('b', polyline([[60, 60], [90, 90]]));
    const c = stroke('c', polyline([[200, 200], [260, 260]]));
    const lasso = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }];
    expect([...lassoSelect([a, b, c], lasso)].sort()).toEqual(['a', 'b']);
  });
  it('needs most of a stroke inside', () => {
    const half = stroke('half', polyline([[50, 50], [150, 50]]));
    expect(lassoSelect([half], [{ x: 0, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 100 }, { x: 0, y: 100 }]).size).toBe(0);
  });
  it('moves, scales and rotates', () => {
    const line = stroke('line', polyline([[0, 100], [200, 100]]));
    const moved = translateStroke(line, 10, -5);
    expect(moved.points[0]).toMatchObject({ x: 10, y: 95 });
    const scaled = scaleStroke(line, 2, 0, 100);
    expect(scaled.points[scaled.points.length - 1]!.x).toBe(400);
    expect(scaled.size).toBe(line.size * 2);
    const rotated = rotateStroke(line, Math.PI / 2, 0, 100);
    expect(rotated.points[rotated.points.length - 1]!.x).toBeCloseTo(0, 5);
    expect(rotated.points[rotated.points.length - 1]!.y).toBeCloseTo(300, 5);
  });
});

describe('line segmentation', () => {
  it('groups words into lines top to bottom, left to right', () => {
    const l1a = stroke('l1a', word(300, 100, 80));
    const l1b = stroke('l1b', word(100, 102, 80));
    const l2 = stroke('l2', word(100, 160, 80));
    const lines = segmentLines([l2, l1a, l1b]);
    expect(lines).toHaveLength(2);
    expect(lines[0]!.strokes.map((s) => s.id)).toEqual(['l1b', 'l1a']);
    expect(lines[1]!.strokes.map((s) => s.id)).toEqual(['l2']);
  });
  it('excludes highlighters', () => {
    expect(segmentLines([stroke('h', word(0, 0), 16, 'highlighter')])).toHaveLength(0);
  });
});
