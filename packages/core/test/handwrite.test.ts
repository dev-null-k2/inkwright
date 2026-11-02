import { describe, expect, it } from 'vitest';
import { handwrite, layoutHandwriting } from '../src/index.ts';

describe('handwriting synthesis', () => {
  it('is deterministic for a seed and varies between seeds', () => {
    const a = handwrite('Fourier series', { x: 0, y: 0, seed: 3 });
    const b = handwrite('Fourier series', { x: 0, y: 0, seed: 3 });
    const c = handwrite('Fourier series', { x: 0, y: 0, seed: 4 });
    expect(a.strokes).toEqual(b.strokes);
    expect(a.strokes[0]!.points[3]).not.toEqual(c.strokes[0]!.points[3]);
  });
  it('wraps to the width and keeps strokes inside it (with a little human slack)', () => {
    const r = handwrite('the quick brown fox jumps over the lazy dog '.repeat(4), { x: 10, y: 10, width: 300, xHeight: 8, style: 'print' });
    expect(r.baselines.length).toBeGreaterThan(2);
    for (const s of r.strokes) for (const p of s.points) expect(p.x).toBeLessThan(10 + 300 + 12);
    expect(layoutHandwriting('a\nb', 1000, 8)).toEqual(['a', 'b']);
  });
  it('draws dots and punctuation, and pressure lifts at stroke ends', () => {
    const plain = handwrite('ii', { x: 0, y: 0, seed: 1 }).strokes.length;
    expect(plain).toBe(4); // two stems + two dots
    const s = handwrite('l', { x: 0, y: 0, seed: 1 }).strokes[0]!;
    const mid = s.points[Math.floor(s.points.length / 2)]!.p;
    expect(mid).toBeGreaterThan(s.points[0]!.p);
  });
  it('timestamps advance like real writing and AI ink is marked', () => {
    const r = handwrite('note', { x: 0, y: 0, startTime: 1000, origin: 'ai' });
    const times = r.strokes.map((s) => s.createdAt);
    expect([...times].sort((x, y) => x - y)).toEqual(times);
    expect(r.strokes.every((s) => s.origin === 'ai' && !s.input)).toBe(true);
  });
});
