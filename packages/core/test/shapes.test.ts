import { describe, expect, it } from 'vitest';
import { recognizeShape, shapeToStroke } from '../src/index.ts';
import { jitter, polyline, stroke, wobblyEllipse, word } from './helpers.ts';

const xy = (pts: [number, number][]) => pts.map(([x, y]) => ({ x, y }));

describe('shape recognition', () => {
  it('straightens a wobbly line and snaps to horizontal', () => {
    const r = recognizeShape(xy(jitter(polyline([[0, 100], [200, 103]]), 1.2)));
    expect(r?.kind).toBe('line');
    expect(r!.points[1]!.y).toBeCloseTo(r!.points[0]!.y, 0);
  });
  it('keeps a deliberate diagonal', () => {
    const r = recognizeShape(xy(polyline([[0, 0], [200, 60]])));
    expect(r?.kind).toBe('line');
    expect(r!.points[1]!.y).toBeGreaterThan(50);
  });
  it('recognizes a circle', () => {
    expect(recognizeShape(xy(wobblyEllipse(200, 200, 80, 78)))?.kind).toBe('ellipse');
  });
  it('recognizes an ellipse', () => {
    const r = recognizeShape(xy(wobblyEllipse(200, 200, 140, 60)));
    expect(r?.kind).toBe('ellipse');
  });
  it('recognizes a rectangle and squares it up', () => {
    const r = recognizeShape(xy(jitter(polyline([[100, 100], [300, 104], [298, 220], [102, 218], [101, 102]]), 1.5)));
    expect(r?.kind).toBe('rectangle');
    const [a, b] = r!.points;
    expect(Math.abs(a!.y - b!.y)).toBeLessThan(0.5);
  });
  it('recognizes a triangle', () => {
    expect(recognizeShape(xy(jitter(polyline([[100, 300], [200, 120], [300, 300], [102, 298]]), 1)))?.kind).toBe('triangle');
  });
  it('leaves handwriting alone', () => {
    expect(recognizeShape(xy(word(0, 0, 120)))).toBeNull();
    expect(recognizeShape(xy(polyline([[0, 0], [20, 30], [40, 0], [60, 30], [80, 0]])))).toBeNull();
  });
  it('ignores tiny marks', () => {
    expect(recognizeShape(xy(polyline([[0, 0], [5, 3]])))).toBeNull();
  });
  it('produces a stroke keeping pen, color and size', () => {
    const src = stroke('s', wobblyEllipse(0, 0, 50, 50), 3, 'marker');
    const out = shapeToStroke(src, recognizeShape(src.points)!);
    expect(out.shape).toBe('ellipse');
    expect(out.pen).toBe('marker');
    expect(out.size).toBe(3);
    expect(out.points.length).toBeGreaterThan(20);
    for (let i = 1; i < out.points.length; i++) expect(out.points[i]!.t).toBeGreaterThanOrEqual(out.points[i - 1]!.t);
  });
});
