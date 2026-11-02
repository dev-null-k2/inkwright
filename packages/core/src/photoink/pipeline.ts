import { densify } from '../geometry.ts';
import type { InkPoint, InkStroke } from '../model.ts';
import { boxBlur, despeckle, detectPageQuad, downscaleRgba, grayFromRgba, quadSize, sauvola, warpQuad, type Quad, type Rgba } from './image.ts';
import { distanceTransform, simplifyPath, smoothPath, traceSkeleton, zhangSuen, type TracedPath } from './skeleton.ts';

/**
 * Photo to ink, the whole pipeline: a photo of handwriting or a diagram on paper → real,
 * editable strokes. Page quad (detected, or the four corners the user dragged) → perspective
 * warp to an upright page → Sauvola threshold → despeckle → Zhang–Suen skeleton → traced centre
 * lines with the ink's measured width → strokes in page units, marked `origin: 'import'` (they
 * are the user's handwriting from paper, but were not written in the app, so authorship never
 * counts them as written here). Ink colour is the average of each stroke's pixels when it is
 * clearly coloured (blue, red, green pens), else the default ink.
 *
 * Pure and synchronous: the app runs it in a worker.
 */

export interface PhotoToInkOptions {
  /** Page corners as fractions of the image (0..1), clockwise from top-left; detected when absent. */
  quad?: Quad;
  /** Width of the resulting page, page units (A4 portrait by default). */
  pageWidth?: number;
  /** Longer side the photo is reduced to before tracing (speed vs detail). */
  maxSide?: number;
  newId?: () => string;
  now?: number;
}

export interface PhotoToInkResult {
  strokes: InkStroke[];
  page: { width: number; height: number };
  /** The upright, cropped page (for the hidden underlay). */
  rectified: Rgba;
  /** The quad used, as fractions of the image. */
  quad: Quad;
  /** Whether the paper's edges were found (false: the whole photo was used). */
  found: boolean;
}

/** The detected page corners of a photo, as fractions of its size. */
export function findPageCorners(img: Rgba, maxSide = 900): { quad: Quad; found: boolean } {
  const small = downscaleRgba(img, maxSide);
  const { quad, found } = detectPageQuad(grayFromRgba(small));
  return { quad: quad.map((p) => ({ x: p.x / (small.width - 1), y: p.y / (small.height - 1) })) as Quad, found };
}

const DEFAULT_INK = '#FF1B1F24';

function hex2(n: number) { return Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0').toUpperCase(); }

/** Runs the pipeline (see the module comment). */
export function photoToInk(src: Rgba, o: PhotoToInkOptions = {}): PhotoToInkResult {
  const maxSide = o.maxSide ?? 1400;
  const img = downscaleRgba(src, Math.max(maxSide, 400));
  const detected = o.quad ? { quad: o.quad, found: true } : findPageCorners(img);
  const qpx = detected.quad.map((p) => ({ x: p.x * (img.width - 1), y: p.y * (img.height - 1) })) as Quad;
  let size = quadSize(qpx);
  const k = Math.min(1, maxSide / Math.max(size.width, size.height));
  size = { width: Math.max(2, Math.round(size.width * k)), height: Math.max(2, Math.round(size.height * k)) };
  const page = warpQuad(img, qpx, size);
  const { width: w, height: h } = page;
  const gray = boxBlur(grayFromRgba(page), Math.max(1, Math.round(Math.min(w, h) / 900)), 1);
  let ink = sauvola(gray);
  // The paper's own edge (and a sliver of desk where the corners are slightly off) is not ink.
  const margin = Math.max(3, Math.round(Math.min(w, h) * 0.015));
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x < margin || y < margin || x >= w - margin || y >= h - margin) ink[y * w + x] = 0;
  ink = despeckle(ink, w, h, Math.max(6, Math.round((Math.min(w, h) / 500) ** 2 * 6)));
  const dist = distanceTransform(ink, w, h);
  const skel = zhangSuen(ink, w, h);
  const radii: number[] = [];
  for (let i = 0; i < skel.length; i++) if (skel[i]) radii.push(dist[i]!);
  radii.sort((a, b) => a - b);
  const rMed = radii[Math.floor(radii.length / 2)] ?? 1;
  const paths: TracedPath[] = traceSkeleton(skel, w, h, dist, { spur: Math.max(3, rMed * 3) })
    .map((p) => simplifyPath(smoothPath(p, 2), 0.6))
    // Drop dust that survived: tiny paths with no length.
    .filter((p) => p.points.length > 1 || p.radius[0]! >= rMed);

  const pageWidth = o.pageWidth ?? 793.7;
  const scale = pageWidth / w;
  let n = 0;
  const newId = o.newId ?? (() => `photo-${(n++).toString(36)}`);
  let clock = o.now ?? Date.now();
  // Reading order: top to bottom in rough lines, then left to right.
  const lineH = Math.max(8, rMed * 12);
  paths.sort((a, b) => {
    const ya = Math.min(...a.points.map((p) => p.y)), yb = Math.min(...b.points.map((p) => p.y));
    return Math.floor(ya / lineH) - Math.floor(yb / lineH) || Math.min(...a.points.map((p) => p.x)) - Math.min(...b.points.map((p) => p.x));
  });
  const strokes: InkStroke[] = paths.map((p) => {
    const r = p.radius.slice().sort((a, b) => a - b)[Math.floor(p.radius.length / 2)]!;
    const size = Math.max(0.8, 2 * r * scale);
    const color = strokeColor(page, p);
    const pts: InkPoint[] = (p.points.length === 1 ? [p.points[0]!, { x: p.points[0]!.x + 0.6, y: p.points[0]!.y + 0.4 }] : p.points).map((q, i) => {
      const ratio = (p.radius[Math.min(i, p.radius.length - 1)] ?? r) / r;
      // Ballpoint radius = size·(0.5 − 0.18·(0.5 − pressure)): pressure that reproduces the measured width.
      const pr = Math.max(0.05, Math.min(1, 0.5 + (ratio - 1) * (0.5 / 0.18)));
      return { x: q.x * scale, y: q.y * scale, t: i * 8, p: pr, tilt: -1, orient: -1 };
    });
    const dense = densify(pts, 2.5).map((q, i) => ({ ...q, t: i * 6 }));
    const s: InkStroke = { id: newId(), pen: 'ballpoint', color, size: +size.toFixed(2), points: dense, createdAt: clock, origin: 'import' };
    clock += (dense[dense.length - 1]?.t ?? 0) + 60;
    return s;
  });
  return { strokes, page: { width: pageWidth, height: +(h * scale).toFixed(1) }, rectified: page, quad: detected.quad, found: detected.found };
}

/** The ink's colour along a path when it is clearly a coloured pen; otherwise the default ink. */
function strokeColor(img: Rgba, p: TracedPath): string {
  let r = 0, g = 0, b = 0, n = 0;
  for (const q of p.points) {
    const j = (Math.round(q.y) * img.width + Math.round(q.x)) * 4;
    r += img.data[j]!; g += img.data[j + 1]!; b += img.data[j + 2]!; n++;
  }
  if (!n) return DEFAULT_INK;
  r /= n; g /= n; b /= n;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const chroma = (max - min) / 255;
  if (chroma < 0.18) return DEFAULT_INK;
  // Deepen photographed ink a little (it reads lighter than the pen on screen).
  const k = 0.8;
  return `#FF${hex2(r * k)}${hex2(g * k)}${hex2(b * k)}`;
}

/**
 * Symmetric Chamfer distance between two point sets: the mean distance from each point to the
 * nearest point of the other set, averaged both ways (page units). The quality measure of tracing.
 */
export function chamferDistance(a: readonly { x: number; y: number }[], b: readonly { x: number; y: number }[]): number {
  if (!a.length || !b.length) return Infinity;
  const one = (from: readonly { x: number; y: number }[], to: readonly { x: number; y: number }[]) => {
    const cell = 8;
    const grid = new Map<string, { x: number; y: number }[]>();
    for (const p of to) { const k = `${Math.floor(p.x / cell)},${Math.floor(p.y / cell)}`; const l = grid.get(k); if (l) l.push(p); else grid.set(k, [p]); }
    let sum = 0;
    for (const p of from) {
      const cx = Math.floor(p.x / cell), cy = Math.floor(p.y / cell);
      let best = Infinity;
      for (let ring = 0; ring < 64 && (best === Infinity || best > (ring - 1) * cell); ring++) {
        for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
          for (const q of grid.get(`${cx + dx},${cy + dy}`) ?? []) best = Math.min(best, Math.hypot(p.x - q.x, p.y - q.y));
        }
      }
      sum += best;
    }
    return sum / from.length;
  };
  return (one(a, b) + one(b, a)) / 2;
}

/** Points along strokes every `step` units (for Chamfer comparisons). */
export function samplePoints(strokes: readonly InkStroke[], step = 1.5): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  for (const s of strokes) {
    const pts = s.points;
    out.push({ x: pts[0]!.x, y: pts[0]!.y });
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1]!, b = pts[i]!;
      const d = Math.hypot(b.x - a.x, b.y - a.y);
      const n = Math.max(1, Math.ceil(d / step));
      for (let k = 1; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n });
    }
  }
  return out;
}
