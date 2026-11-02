import { describe, expect, it } from 'vitest';
import { extrapolate } from './engine.ts';

const pt = (x: number, y: number, t: number) => ({ x, y, t, p: 0.5, tilt: -1, orient: -1 });

describe('extrapolate (prediction fallback)', () => {
  it('continues a steady stroke along its velocity', () => {
    const r = extrapolate([pt(0, 0, 0), pt(4, 0, 4), pt(8, 0, 8)], 10, 50);
    expect(r).toHaveLength(1);
    expect(r[0]!.x).toBeCloseTo(18, 5);
    expect(r[0]!.y).toBeCloseTo(0, 5);
  });
  it('is capped so a sudden stop never draws a long hook', () => {
    const r = extrapolate([pt(0, 0, 0), pt(40, 0, 4), pt(80, 0, 8)], 10, 6);
    expect(Math.hypot(r[0]!.x - 80, r[0]!.y)).toBeCloseTo(6, 5);
  });
  it('predicts nothing when resting, after a pause, or with too few samples', () => {
    expect(extrapolate([pt(0, 0, 0), pt(0, 0, 4), pt(0.05, 0, 8)], 10, 6)).toEqual([]);
    expect(extrapolate([pt(0, 0, 0), pt(4, 0, 4), pt(8, 0, 200)], 10, 6)).toEqual([]);
    expect(extrapolate([pt(0, 0, 0), pt(4, 0, 4)], 10, 6)).toEqual([]);
  });
});
