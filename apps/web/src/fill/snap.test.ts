import { describe, expect, it } from 'vitest';
import { MemorySecretStore } from '@inkstone/ai';
import type { InkStroke } from '@inkstone/core';
import { detectHorizontalLines, findBoxAround, grayFromRGBA, placeMark, placeText, type GrayImage } from './snap.ts';
import { SignatureLibrary, inkForPlacement, normalizeInk, removeBackground, tintInk } from './signatures.ts';

/** A white page (page units, scale 1 px per unit) with things drawn on it. */
function page(w = 400, h = 300): GrayImage & { line(x1: number, x2: number, y: number, t?: number): void; rect(x0: number, y0: number, x1: number, y1: number): void; text(x: number, y: number, n: number): void } {
  const g = { data: new Uint8Array(w * h).fill(255), width: w, height: h, scale: 1 };
  const set = (x: number, y: number) => { if (x >= 0 && y >= 0 && x < w && y < h) g.data[y * w + x] = 20; };
  return Object.assign(g, {
    line(x1: number, x2: number, y: number, t = 1) { for (let k = 0; k < t; k++) for (let x = x1; x <= x2; x++) set(x, y + k); },
    rect(x0: number, y0: number, x1: number, y1: number) {
      for (let x = x0; x <= x1; x++) { set(x, y0); set(x, y1); }
      for (let y = y0; y <= y1; y++) { set(x0, y); set(x1, y); }
    },
    // Glyph-like blobs: short runs that must not count as lines.
    text(x: number, y: number, n: number) { for (let i = 0; i < n; i++) for (let dy = 0; dy < 9; dy++) for (let dx = 0; dx < 5; dx++) set(x + i * 7 + dx, y + dy); },
  });
}

describe('line and box detection', () => {
  it('finds underlines, not text', () => {
    const g = page();
    g.text(20, 40, 20);
    g.line(150, 360, 80);
    g.line(20, 120, 150, 2);
    const lines = detectHorizontalLines(g);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ x1: 150, x2: 361 });
    expect(lines[0]!.y).toBeCloseTo(80.5);
    expect(lines[1]!.y).toBeCloseTo(151);
  });

  it('finds the box around a point and rejects open shapes', () => {
    const g = page();
    g.rect(100, 100, 120, 120);
    g.line(200, 300, 100);
    expect(findBoxAround(g, 110, 110)).toEqual({ minX: 101, minY: 101, maxX: 120, maxY: 120 });
    expect(findBoxAround(g, 250, 90)).toBeNull();
    expect(findBoxAround(g, 5, 5)).toBeNull();
  });

  it('places typed text inside a box, on an underline, or at the tap', () => {
    const g = page();
    g.rect(20, 20, 220, 50);
    g.line(40, 300, 140);
    const inBox = placeText(g, 60, 35, 400);
    expect(inBox.snapped).toBe('box');
    expect(inBox.x).toBeCloseTo(24);
    expect(inBox.y).toBeGreaterThan(21);
    expect(inBox.y + inBox.fontSize * 1.25).toBeLessThan(50);
    const onLine = placeText(g, 50, 125, 400, 14);
    expect(onLine.snapped).toBe('line');
    expect(onLine.x).toBeCloseTo(42); // snapped to the start of the line
    expect(onLine.y + 14 * 1.02).toBeLessThan(140.5);
    expect(onLine.y + 14 * 1.02).toBeGreaterThan(134);
    expect(onLine.width).toBeCloseTo(259);
    expect(placeText(g, 300, 250, 400).snapped).toBeNull();
    expect(placeText(null, 300, 250, 400).snapped).toBeNull();
  });

  it('fits a checkmark inside a checkbox', () => {
    const g = page();
    g.rect(100, 100, 118, 118);
    const m = placeMark(g, 108, 112);
    expect(m.snapped).toBe(true);
    expect(m.minX).toBeGreaterThan(101);
    expect(m.maxX).toBeLessThan(118);
    expect(placeMark(g, 300, 200).snapped).toBe(false);
  });

  it('converts RGBA to luminance, transparent as paper', () => {
    const g = grayFromRGBA(new Uint8ClampedArray([0, 0, 0, 255, 0, 0, 0, 0]), 2, 1, 1);
    expect([...g.data]).toEqual([0, 255]);
  });
});

describe('signature library', () => {
  const stroke = (pts: [number, number][]): InkStroke => ({ id: 's', pen: 'fountain', color: '#FF000000', size: 2, createdAt: 0, points: pts.map(([x, y], i) => ({ x, y, t: i * 8, p: 0.5, tilt: -1, orient: -1 })) });

  it('normalizes drawn ink and places it at any size', () => {
    const n = normalizeInk([stroke([[100, 50], [300, 90]])])!;
    expect(n.aspect).toBeCloseTo((200 + 4) / (40 + 4), 1);
    const ys = n.ink[0]!.points.map((p) => p[1]);
    expect(Math.min(...ys)).toBeGreaterThan(0);
    expect(Math.max(...ys)).toBeLessThan(100);
    const placed = inkForPlacement({ id: 'x', kind: 'signature', source: 'drawn', createdAt: 0, aspect: n.aspect, ink: n.ink }, 10, 20, 50, '#FF1B3A8C', 5, () => 'id');
    expect(placed).toHaveLength(1);
    expect(placed[0]!.color).toBe('#FF1B3A8C');
    expect(placed[0]!.points[0]!.x).toBeCloseTo(10 + (2 * 50) / 44, 0);
    expect(placed[0]!.points[1]!.y).toBeLessThan(70);
    expect(normalizeInk([])).toBeNull();
  });

  it('removes the paper from a photographed signature and recolours it', () => {
    // 4×1: paper, paper, ink, light-grey paper shadow.
    const px = new Uint8ClampedArray([245, 245, 240, 255, 250, 250, 250, 255, 30, 30, 60, 255, 230, 230, 230, 255]);
    const big = new Uint8ClampedArray(4 * 4 * 50);
    for (let i = 0; i < 50; i++) big.set(px, i * 16);
    const b = removeBackground(big, 4, 50)!;
    expect(b).toEqual({ minX: 2, minY: 0, maxX: 2, maxY: 49 });
    expect(big[3]).toBe(0);
    expect(big[11]).toBe(255);
    expect(big[15]).toBe(0);
    tintInk(big, '#FF1B3A8C');
    expect([big[8], big[9], big[10]]).toEqual([0x1b, 0x3a, 0x8c]);
    expect(removeBackground(new Uint8ClampedArray(16).fill(255), 2, 2)).toBeNull();
  });

  it('keeps signatures in the encrypted store across instances', async () => {
    const store = new MemorySecretStore();
    const lib = new SignatureLibrary(store);
    const a = await lib.add({ kind: 'signature', source: 'typed', aspect: 3, png: 'AAAA', text: 'Ada', style: 'script' });
    await lib.add({ kind: 'initials', source: 'drawn', aspect: 1, ink: [] });
    const again = new SignatureLibrary(store);
    expect((await again.list()).map((s) => s.kind)).toEqual(['initials', 'signature']);
    await again.remove(a.id);
    expect((await new SignatureLibrary(store).list()).map((s) => s.kind)).toEqual(['initials']);
    expect(await store.get('inkstone.signatures.v1')).toContain('initials');
  });

  it('ignores a damaged store', async () => {
    const store = new MemorySecretStore();
    await store.set('inkstone.signatures.v1', '{not json');
    expect(await new SignatureLibrary(store).list()).toEqual([]);
  });
});
