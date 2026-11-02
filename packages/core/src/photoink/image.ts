/**
 * Photo to ink, part one: small, dependency-free image operations on grey and colour bitmaps.
 * Grey values are 0..1 with 1 = white paper, which keeps the thresholds readable.
 */

export interface Gray {
  width: number;
  height: number;
  data: Float32Array;
}

export interface Rgba {
  width: number;
  height: number;
  /** 4 bytes per pixel, like ImageData. */
  data: Uint8ClampedArray;
}

export type Quad = [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }, { x: number; y: number }];

export function grayFromRgba(img: Rgba): Gray {
  const out = new Float32Array(img.width * img.height);
  const d = img.data;
  for (let i = 0, j = 0; i < out.length; i++, j += 4) out[i] = (0.2126 * d[j]! + 0.7152 * d[j + 1]! + 0.0722 * d[j + 2]!) / 255;
  return { width: img.width, height: img.height, data: out };
}

/** Box-filter downscale of a colour image so its longer side is at most `max` pixels. */
export function downscaleRgba(img: Rgba, max: number): Rgba {
  const k = Math.max(img.width, img.height) / max;
  if (k <= 1) return img;
  const w = Math.max(1, Math.round(img.width / k)), h = Math.max(1, Math.round(img.height / k));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * k), y1 = Math.min(img.height, Math.max(y0 + 1, Math.floor((y + 1) * k)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * k), x1 = Math.min(img.width, Math.max(x0 + 1, Math.floor((x + 1) * k)));
      let r = 0, g = 0, b = 0, a = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) {
        const j = (yy * img.width + xx) * 4;
        r += img.data[j]!; g += img.data[j + 1]!; b += img.data[j + 2]!; a += img.data[j + 3]!; n++;
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = a / n;
    }
  }
  return { width: w, height: h, data: out };
}

/** Separable box blur (repeated, it approximates a Gaussian). */
export function boxBlur(g: Gray, radius: number, passes = 2): Gray {
  if (radius < 1) return g;
  let src = g.data;
  const { width: w, height: h } = g;
  const tmp = new Float32Array(src.length);
  const r = Math.round(radius);
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(src.length);
    for (let y = 0; y < h; y++) {
      let acc = 0;
      const row = y * w;
      for (let x = -r; x <= r; x++) acc += src[row + Math.min(w - 1, Math.max(0, x))]!;
      for (let x = 0; x < w; x++) {
        tmp[row + x] = acc / (2 * r + 1);
        acc += src[row + Math.min(w - 1, x + r + 1)]! - src[row + Math.max(0, x - r)]!;
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += tmp[Math.min(h - 1, Math.max(0, y)) * w + x]!;
      for (let y = 0; y < h; y++) {
        out[y * w + x] = acc / (2 * r + 1);
        acc += tmp[Math.min(h - 1, y + r + 1) * w + x]! - tmp[Math.max(0, y - r) * w + x]!;
      }
    }
    src = out;
  }
  return { width: w, height: h, data: src };
}

/** Otsu's threshold on a 0..1 image (256 bins). */
export function otsu(g: Gray): number {
  const hist = new Float64Array(256);
  for (const v of g.data) hist[Math.min(255, Math.max(0, Math.round(v * 255)))]!++;
  const total = g.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i]!;
  let sumB = 0, wB = 0, best = 0, bestT = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t]!;
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t]!;
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) { best = between; bestT = t; }
  }
  return bestT / 255;
}

/**
 * Finds the sheet of paper in a photo: the largest bright region (Otsu on a blurred copy), then its
 * four extreme corners (min/max of x+y and x−y over the region's pixels) — a contour pass that
 * holds up for perspective and rotations up to about 35°. When the paper fills the frame (or
 * nothing bright stands out) the whole image is returned.
 */
export function detectPageQuad(g: Gray): { quad: Quad; found: boolean } {
  const { width: w, height: h } = g;
  const whole: Quad = [{ x: 0, y: 0 }, { x: w - 1, y: 0 }, { x: w - 1, y: h - 1 }, { x: 0, y: h - 1 }];
  const blurred = boxBlur(g, Math.max(2, Math.round(Math.min(w, h) / 120)));
  const t = otsu(blurred);
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < bright.length; i++) bright[i] = blurred.data[i]! > t ? 1 : 0;
  // Largest 4-connected bright component.
  const label = new Int32Array(w * h).fill(-1);
  let bestLabel = -1, bestSize = 0, next = 0;
  const stack: number[] = [];
  for (let i = 0; i < bright.length; i++) {
    if (!bright[i] || label[i] !== -1) continue;
    let size = 0;
    label[i] = next;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w, y = (p - x) / w;
      if (x > 0 && bright[p - 1] && label[p - 1] === -1) { label[p - 1] = next; stack.push(p - 1); }
      if (x < w - 1 && bright[p + 1] && label[p + 1] === -1) { label[p + 1] = next; stack.push(p + 1); }
      if (y > 0 && bright[p - w] && label[p - w] === -1) { label[p - w] = next; stack.push(p - w); }
      if (y < h - 1 && bright[p + w] && label[p + w] === -1) { label[p + w] = next; stack.push(p + w); }
    }
    if (size > bestSize) { bestSize = size; bestLabel = next; }
    next++;
  }
  const frac = bestSize / (w * h);
  if (bestLabel < 0 || frac < 0.15 || frac > 0.97) return { quad: whole, found: false };
  let tl = { x: 0, y: 0, v: Infinity }, br = { x: 0, y: 0, v: -Infinity }, tr = { x: 0, y: 0, v: -Infinity }, bl = { x: 0, y: 0, v: Infinity };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (label[y * w + x] !== bestLabel) continue;
    const s = x + y, d = x - y;
    if (s < tl.v) tl = { x, y, v: s };
    if (s > br.v) br = { x, y, v: s };
    if (d > tr.v) tr = { x, y, v: d };
    if (d < bl.v) bl = { x, y, v: d };
  }
  const rough: Quad = [{ x: tl.x, y: tl.y }, { x: tr.x, y: tr.y }, { x: br.x, y: br.y }, { x: bl.x, y: bl.y }];
  const quad = refineCorners(rough, label, bestLabel, w, h);
  // A degenerate quad (a corner repeated) means the region was not page-like.
  const area = Math.abs(quad.reduce((a, p, i) => { const q = quad[(i + 1) % 4]!; return a + p.x * q.y - q.x * p.y; }, 0)) / 2;
  if (area < w * h * 0.12) return { quad: whole, found: false };
  return { quad, found: true };
}

/**
 * Sharpens rough corners: blurring rounds a page's corners, so the extreme pixels sit a little
 * inside them. Each side's boundary pixels (away from the corners) get a least-squares line, and
 * neighbouring lines meet at the true corner.
 */
function refineCorners(q: Quad, label: Int32Array, id: number, w: number, h: number): Quad {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && label[y * w + x] === id;
  const lines: { px: number; py: number; dx: number; dy: number }[] = [];
  for (let s = 0; s < 4; s++) {
    const a = q[s]!, b = q[(s + 1) % 4]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 8) return q;
    const ux = (b.x - a.x) / len, uy = (b.y - a.y) / len;
    const pts: { x: number; y: number }[] = [];
    // Walk along the side; at each step search across it for the boundary.
    for (let t = len * 0.15; t <= len * 0.85; t += Math.max(1, len / 200)) {
      const cx = a.x + ux * t, cy = a.y + uy * t;
      // The outward normal of a clockwise quad (in image coordinates) is (uy, -ux).
      let last: { x: number; y: number } | null = null;
      for (let d = -12; d <= 12; d++) {
        const x = Math.round(cx + uy * d), y = Math.round(cy - ux * d);
        if (inside(x, y)) last = { x, y };
      }
      if (last) pts.push(last);
    }
    if (pts.length < 6) return q;
    const mx = pts.reduce((v, p) => v + p.x, 0) / pts.length, my = pts.reduce((v, p) => v + p.y, 0) / pts.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
    const ang = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    lines.push({ px: mx + uy * 0.5, py: my - ux * 0.5, dx: Math.cos(ang), dy: Math.sin(ang) });
  }
  const meet = (l1: (typeof lines)[number], l2: (typeof lines)[number]) => {
    const den = l1.dx * l2.dy - l1.dy * l2.dx;
    if (Math.abs(den) < 1e-6) return null;
    const t = ((l2.px - l1.px) * l2.dy - (l2.py - l1.py) * l2.dx) / den;
    return { x: l1.px + l1.dx * t, y: l1.py + l1.dy * t };
  };
  const out: { x: number; y: number }[] = [];
  for (let c = 0; c < 4; c++) {
    const p = meet(lines[(c + 3) % 4]!, lines[c]!);
    // Keep the rough corner when the fit disagrees wildly (a torn or folded corner).
    if (!p || Math.hypot(p.x - q[c]!.x, p.y - q[c]!.y) > Math.min(w, h) * 0.05) out.push(q[c]!);
    else out.push({ x: Math.max(0, Math.min(w - 1, p.x)), y: Math.max(0, Math.min(h - 1, p.y)) });
  }
  return out as Quad;
}

/** Solves the 3×3 homography (h33 = 1) mapping four source points onto four destination points. */
export function homography(src: Quad, dst: Quad): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i]!, { x: u, y: v } = dst[i]!;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]); b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]); b.push(v);
  }
  // Gaussian elimination with partial pivoting.
  const n = 8;
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r]![c]!) > Math.abs(A[p]![c]!)) p = r;
    [A[c], A[p]] = [A[p]!, A[c]!];
    [b[c], b[p]] = [b[p]!, b[c]!];
    const piv = A[c]![c]!;
    if (Math.abs(piv) < 1e-12) throw new Error('Corners are degenerate');
    for (let r = c + 1; r < n; r++) {
      const f = A[r]![c]! / piv;
      for (let k = c; k < n; k++) A[r]![k]! -= f * A[c]![k]!;
      b[r]! -= f * b[c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let k = r + 1; k < n; k++) s -= A[r]![k]! * x[k]!;
    x[r] = s / A[r]![r]!;
  }
  return [...x, 1];
}

export function applyHomography(H: readonly number[], x: number, y: number): { x: number; y: number } {
  const d = H[6]! * x + H[7]! * y + H[8]!;
  return { x: (H[0]! * x + H[1]! * y + H[2]!) / d, y: (H[3]! * x + H[4]! * y + H[5]!) / d };
}

/** Output size for a quad: the longer of each pair of opposite sides. */
export function quadSize(q: Quad): { width: number; height: number } {
  const d = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);
  return { width: Math.max(2, Math.round(Math.max(d(q[0], q[1]), d(q[3], q[2])))), height: Math.max(2, Math.round(Math.max(d(q[0], q[3]), d(q[1], q[2])))) };
}

/** Warps the quad of a colour image onto an upright rectangle (bilinear sampling). */
export function warpQuad(img: Rgba, q: Quad, size = quadSize(q)): Rgba {
  const { width: W, height: H } = size;
  const dst: Quad = [{ x: 0, y: 0 }, { x: W - 1, y: 0 }, { x: W - 1, y: H - 1 }, { x: 0, y: H - 1 }];
  const Hm = homography(dst, q); // output pixel → source pixel
  const out = new Uint8ClampedArray(W * H * 4);
  const sw = img.width, sh = img.height, s = img.data;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const p = applyHomography(Hm, x, y);
    const x0 = Math.floor(p.x), y0 = Math.floor(p.y);
    const fx = p.x - x0, fy = p.y - y0;
    const o = (y * W + x) * 4;
    if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) { out[o] = out[o + 1] = out[o + 2] = 255; out[o + 3] = 255; continue; }
    for (let c = 0; c < 4; c++) {
      const a = s[(y0 * sw + x0) * 4 + c]!, b = s[(y0 * sw + x0 + 1) * 4 + c]!;
      const cc = s[((y0 + 1) * sw + x0) * 4 + c]!, d = s[((y0 + 1) * sw + x0 + 1) * 4 + c]!;
      out[o + c] = (a * (1 - fx) + b * fx) * (1 - fy) + (cc * (1 - fx) + d * fx) * fy;
    }
  }
  return { width: W, height: H, data: out };
}

/**
 * Sauvola adaptive threshold: a pixel is ink when darker than T = m·(1 + k·(s/R − 1)) for the
 * mean m and deviation s of its window — robust to shadows and uneven light across a photo.
 * Pixels must also be clearly darker than their surroundings (`minContrast`), so flat paper
 * noise never becomes ink.
 */
export function sauvola(g: Gray, opts: { window?: number; k?: number; minContrast?: number } = {}): Uint8Array {
  const { width: w, height: h, data } = g;
  const win = opts.window ?? Math.max(15, Math.round(Math.min(w, h) / 24) | 1);
  const k = opts.k ?? 0.3;
  const R = 0.5;
  const minC = opts.minContrast ?? 0.1;
  const I = new Float64Array((w + 1) * (h + 1)), I2 = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let rs = 0, rs2 = 0;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x]!;
      rs += v; rs2 += v * v;
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1]! + rs;
      I2[(y + 1) * (w + 1) + x + 1] = I2[y * (w + 1) + x + 1]! + rs2;
    }
  }
  const half = win >> 1;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - half), y1 = Math.min(h, y + half + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - half), x1 = Math.min(w, x + half + 1);
      const n = (x1 - x0) * (y1 - y0);
      const sum = I[y1 * (w + 1) + x1]! - I[y0 * (w + 1) + x1]! - I[y1 * (w + 1) + x0]! + I[y0 * (w + 1) + x0]!;
      const sum2 = I2[y1 * (w + 1) + x1]! - I2[y0 * (w + 1) + x1]! - I2[y1 * (w + 1) + x0]! + I2[y0 * (w + 1) + x0]!;
      const m = sum / n;
      const sd = Math.sqrt(Math.max(0, sum2 / n - m * m));
      const v = data[y * w + x]!;
      out[y * w + x] = v < m * (1 + k * (sd / R - 1)) && m - v > minC ? 1 : 0;
    }
  }
  return out;
}

/** Removes 8-connected specks smaller than `minArea` pixels (dust, paper grain, JPEG noise). */
export function despeckle(bin: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  const out = new Uint8Array(bin);
  const seen = new Uint8Array(bin.length);
  const stack: number[] = [];
  const comp: number[] = [];
  for (let i = 0; i < bin.length; i++) {
    if (!bin[i] || seen[i]) continue;
    comp.length = 0;
    stack.push(i);
    seen[i] = 1;
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const x = p % w, y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if ((dx || dy) && nx >= 0 && ny >= 0 && nx < w && ny < h) { const q = ny * w + nx; if (bin[q] && !seen[q]) { seen[q] = 1; stack.push(q); } }
      }
    }
    if (comp.length < minArea) for (const p of comp) out[p] = 0;
  }
  return out;
}
