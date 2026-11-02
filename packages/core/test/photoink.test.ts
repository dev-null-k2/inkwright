import { describe, expect, it } from 'vitest';
import {
  chamferDistance,
  despeckle,
  findPageCorners,
  handwrite,
  homography,
  applyHomography,
  photoToInk,
  samplePoints,
  sauvola,
  zhangSuen,
  type InkStroke,
  type Quad,
} from '../src/index.ts';
import { renderPhoto } from './fixtures/photo.ts';

const PAGE = { width: 420, height: 300 };
const text = (seed = 5): InkStroke[] => [
  ...handwrite('Photo to ink', { x: 30, y: 40, xHeight: 12, size: 2.6, seed, style: 'print' }).strokes,
  ...handwrite('real strokes', { x: 30, y: 120, xHeight: 12, size: 2.6, seed: seed + 1, style: 'script' }).strokes,
  { id: 'box', pen: 'ballpoint', color: '#FF000000', size: 2.6, createdAt: 0, points: [[260, 160], [390, 160], [390, 260], [260, 260], [260, 160]].flatMap(([x, y], i, a) => (i ? Array.from({ length: 20 }, (_, k) => ({ x: a[i - 1]![0]! + ((x! - a[i - 1]![0]!) * (k + 1)) / 20, y: a[i - 1]![1]! + ((y! - a[i - 1]![1]!) * (k + 1)) / 20, t: 0, p: 0.5, tilt: -1, orient: -1 })) : [{ x: x!, y: y!, t: 0, p: 0.5, tilt: -1, orient: -1 }])) },
];

describe('photo to ink', () => {
  it('thins a thick bar to a one-pixel line and removes specks', () => {
    const w = 40, h = 20;
    const bin = new Uint8Array(w * h);
    for (let y = 7; y < 13; y++) for (let x = 5; x < 35; x++) bin[y * w + x] = 1;
    bin[2 * w + 2] = 1;
    const clean = despeckle(bin, w, h, 4);
    expect(clean[2 * w + 2]).toBe(0);
    const sk = zhangSuen(clean, w, h);
    const rows = new Set<number>();
    let n = 0;
    for (let i = 0; i < sk.length; i++) if (sk[i]) { rows.add(Math.floor(i / w)); n++; }
    expect(rows.size).toBeLessThanOrEqual(2);
    expect(n).toBeGreaterThan(20);
  });

  it('thresholds ink under uneven light without turning shadows into ink', () => {
    const w = 120, h = 60;
    const g = { width: w, height: h, data: new Float32Array(w * h) };
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g.data[y * w + x] = 0.95 - 0.5 * (x / w) - (Math.abs(y - 30) < 2 && x > 10 && x < 110 ? 0.4 : 0);
    const bin = sauvola(g, { window: 15 });
    let ink = 0, wrong = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { if (bin[y * w + x]) { if (Math.abs(y - 30) < 3) ink++; else wrong++; } }
    expect(ink).toBeGreaterThan(200);
    expect(wrong).toBe(0);
  });

  it('solves a homography exactly', () => {
    const src: Quad = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }];
    const dst: Quad = [{ x: 3, y: 1 }, { x: 20, y: 4 }, { x: 18, y: 22 }, { x: 1, y: 17 }];
    const H = homography(src, dst);
    for (let i = 0; i < 4; i++) { const p = applyHomography(H, src[i]!.x, src[i]!.y); expect(p.x).toBeCloseTo(dst[i]!.x, 6); expect(p.y).toBeCloseTo(dst[i]!.y, 6); }
  });

  it('finds a tilted page on a desk', () => {
    const corners: Quad = [{ x: 120, y: 70 }, { x: 640, y: 110 }, { x: 610, y: 500 }, { x: 90, y: 470 }];
    const { image, quad } = renderPhoto(text(), { page: PAGE, photo: { width: 760, height: 580 }, corners });
    const found = findPageCorners(image);
    expect(found.found).toBe(true);
    for (let i = 0; i < 4; i++) {
      expect(Math.abs(found.quad[i]!.x - quad[i]!.x)).toBeLessThan(0.02);
      expect(Math.abs(found.quad[i]!.y - quad[i]!.y)).toBeLessThan(0.02);
    }
  });

  /**
   * The quality bar: handwriting rendered to a photo with perspective, blur, uneven light and noise
   * comes back as strokes whose Chamfer distance to the source is under a stroke's width (2.6 page
   * units), and nothing important is lost (coverage both ways).
   */
  it.each([
    ['flat scan', [{ x: 40, y: 30 }, { x: 670, y: 30 }, { x: 670, y: 480 }, { x: 40, y: 480 }], 1, 0.02, 0.05],
    ['phone photo, tilted with perspective', [{ x: 120, y: 70 }, { x: 640, y: 110 }, { x: 610, y: 500 }, { x: 90, y: 470 }], 1, 0.04, 0.2],
    ['soft focus and noise', [{ x: 60, y: 50 }, { x: 680, y: 40 }, { x: 700, y: 500 }, { x: 50, y: 520 }], 2, 0.06, 0.25],
  ] as const)('traces %s within the Chamfer bar', (_name, corners, blur, noise, shade) => {
    const src = text(9);
    const { image } = renderPhoto(src, { page: PAGE, photo: { width: 760, height: 580 }, corners: corners as unknown as Quad, blur, noise, shade });
    const out = photoToInk(image, { pageWidth: PAGE.width, maxSide: 1000, now: 0 });
    expect(out.found).toBe(true);
    expect(out.page.width).toBe(PAGE.width);
    // A perspective photo's true aspect ratio can't be known without the camera, so the page
    // height is estimated from the paper's side lengths: close, not exact. Compare shapes on the
    // page as found (heights normalised), which is what the user sees.
    expect(Math.abs(out.page.height - PAGE.height)).toBeLessThan(PAGE.height * 0.1);
    const ky = PAGE.height / out.page.height;
    expect(out.strokes.every((s) => s.origin === 'import' && s.pen === 'ballpoint')).toBe(true);
    const a = samplePoints(src), b = samplePoints(out.strokes).map((p) => ({ x: p.x, y: p.y * ky }));
    const d = chamferDistance(a, b);
    expect(d).toBeLessThan(2.6);
    expect(d).toBeLessThan(_name === 'flat scan' ? 1.2 : 2.6);
    // Stroke width is recovered (within 60 %).
    const sizes = out.strokes.map((s) => s.size).sort((x, y) => x - y);
    const med = sizes[Math.floor(sizes.length / 2)]!;
    expect(med).toBeGreaterThan(2.6 * 0.4);
    expect(med).toBeLessThan(2.6 * 1.6);
  });

  it('keeps coloured ink coloured', () => {
    const src = text(2);
    const { image } = renderPhoto(src, { page: PAGE, photo: { width: 700, height: 520 }, corners: [{ x: 40, y: 30 }, { x: 660, y: 30 }, { x: 660, y: 480 }, { x: 40, y: 480 }], ink: [30, 60, 170] });
    const out = photoToInk(image, { pageWidth: PAGE.width, now: 0 });
    const blue = out.strokes.filter((s) => { const r = parseInt(s.color.slice(3, 5), 16), b = parseInt(s.color.slice(7, 9), 16); return b > r + 40; });
    expect(blue.length / out.strokes.length).toBeGreaterThan(0.8);
  });
});
