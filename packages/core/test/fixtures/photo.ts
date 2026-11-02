import { applyHomography, homography, type InkStroke, type Quad, type Rgba } from '../../src/index.ts';
import { rng } from './sketches.ts';

/**
 * Renders strokes as a *photo* of paper: the page (page units → pixels) is placed on a darker desk
 * through a perspective (`corners`, the page's corners in the photo), ink is stamped as discs of
 * the stroke's width, then the photo is blurred, lit unevenly and given sensor noise. Returns the
 * image and the true page corners as fractions of the photo.
 */
export function renderPhoto(strokes: readonly InkStroke[], o: {
  page: { width: number; height: number };
  photo: { width: number; height: number };
  /** Page corners in photo pixels, clockwise from top-left. */
  corners: Quad;
  blur?: number;
  noise?: number;
  /** Brightness falloff across the photo (0 = even light). */
  shade?: number;
  ink?: [number, number, number];
  seed?: number;
}): { image: Rgba; quad: Quad } {
  const { width: W, height: H } = o.photo;
  const r = rng(o.seed ?? 3);
  // Photo pixel → page units.
  const pageQuad: Quad = [{ x: 0, y: 0 }, { x: o.page.width, y: 0 }, { x: o.page.width, y: o.page.height }, { x: 0, y: o.page.height }];
  const toPage = homography(o.corners, pageQuad);
  const toPhoto = homography(pageQuad, o.corners);
  const val = new Float32Array(W * H);
  const paper = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = applyHomography(toPage, x, y);
    const on = p.x >= 0 && p.y >= 0 && p.x <= o.page.width && p.y <= o.page.height;
    paper[y * W + x] = on ? 1 : 0;
    val[y * W + x] = on ? 0.93 : 0.32;
  }
  // Ink: stamp discs along each segment in photo space.
  const inkMask = new Float32Array(W * H);
  const pxPerUnit = Math.hypot(o.corners[1].x - o.corners[0].x, o.corners[1].y - o.corners[0].y) / o.page.width;
  for (const s of strokes) {
    const rad = Math.max(0.7, (s.size / 2) * pxPerUnit);
    const pts = s.points.map((p) => applyHomography(toPhoto, p.x, p.y));
    for (let i = 0; i < pts.length; i++) {
      const a = pts[Math.max(0, i - 1)]!, b = pts[i]!;
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 0.5));
      for (let k = 0; k <= n; k++) {
        const cx = a.x + ((b.x - a.x) * k) / n, cy = a.y + ((b.y - a.y) * k) / n;
        for (let y = Math.floor(cy - rad - 1); y <= Math.ceil(cy + rad + 1); y++) for (let x = Math.floor(cx - rad - 1); x <= Math.ceil(cx + rad + 1); x++) {
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          const d = Math.hypot(x - cx, y - cy);
          const cov = Math.max(0, Math.min(1, rad + 0.5 - d));
          if (cov > inkMask[y * W + x]!) inkMask[y * W + x] = cov;
        }
      }
    }
  }
  const ink = o.ink ?? [30, 32, 40];
  const out = new Uint8ClampedArray(W * H * 4);
  // Blur the luminance and ink with a small box (camera softness), then light and noise.
  const blur = (src: Float32Array, rad: number) => {
    if (rad < 1) return src;
    const tmp = new Float32Array(src.length), dst = new Float32Array(src.length);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, c = 0; for (let d = -rad; d <= rad; d++) { const xx = x + d; if (xx >= 0 && xx < W) { s += src[y * W + xx]!; c++; } } tmp[y * W + x] = s / c; }
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { let s = 0, c = 0; for (let d = -rad; d <= rad; d++) { const yy = y + d; if (yy >= 0 && yy < H) { s += tmp[yy * W + x]!; c++; } } dst[y * W + x] = s / c; }
    return dst;
  };
  const b = o.blur ?? 1;
  const bg = blur(val, b), im = blur(inkMask, b);
  const shade = o.shade ?? 0.15;
  const noise = o.noise ?? 0.03;
  for (let i = 0; i < W * H; i++) {
    const x = i % W, y = (i - x) / W;
    const light = 1 - shade * (x / W * 0.6 + y / H * 0.4);
    const base = bg[i]! * light;
    const n = (r() - 0.5) * 2 * noise;
    const m = im[i]!;
    for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.round(((base * (1 - m) + (ink[c]! / 255) * m * light) + n) * 255);
    out[i * 4 + 3] = 255;
  }
  void paper;
  return { image: { width: W, height: H, data: out }, quad: o.corners.map((p) => ({ x: p.x / (W - 1), y: p.y / (H - 1) })) as Quad };
}
