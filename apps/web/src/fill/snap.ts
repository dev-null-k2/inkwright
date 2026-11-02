/**
 * Where to put things on a flat (field-less) form: finds the printed underline or box under a tap
 * from the page's pixels, so typed answers sit on the line and checkmarks land inside the box.
 * Works on a grayscale render of the page (any PDF or scan); pure functions, unit-tested.
 */

export interface GrayImage {
  /** Luminance 0 (black) … 255 (white), row-major. */
  data: Uint8Array;
  width: number;
  height: number;
  /** Pixels per page unit. */
  scale: number;
}

export interface Box { minX: number; minY: number; maxX: number; maxY: number }
export interface HLine { y: number; x1: number; x2: number }

const DARK = 150;

export function grayFromRGBA(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, scale: number): GrayImage {
  const data = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    const a = rgba[j + 3]! / 255;
    // Transparent pixels count as white paper.
    const lum = 0.299 * rgba[j]! + 0.587 * rgba[j + 1]! + 0.114 * rgba[j + 2]!;
    data[i] = Math.round(lum * a + 255 * (1 - a));
  }
  return { data, width, height, scale };
}

const dark = (g: GrayImage, x: number, y: number) => x >= 0 && y >= 0 && x < g.width && y < g.height && g.data[y * g.width + x]! < DARK;

/**
 * Horizontal rules: runs of dark pixels at least `minLength` page units long and at most
 * `maxThickness` thick (underlines, table and box edges). Text never makes runs that long.
 */
export function detectHorizontalLines(g: GrayImage, opts: { minLength?: number; maxThickness?: number } = {}): HLine[] {
  const minPx = Math.max(4, Math.round((opts.minLength ?? 36) * g.scale));
  const maxThick = Math.max(1, Math.round((opts.maxThickness ?? 4) * g.scale));
  type Run = { y0: number; y1: number; x1: number; x2: number };
  const open: Run[] = [];
  const done: Run[] = [];
  for (let y = 0; y < g.height; y++) {
    const runs: { x1: number; x2: number }[] = [];
    let start = -1;
    for (let x = 0; x <= g.width; x++) {
      const d = x < g.width && g.data[y * g.width + x]! < DARK;
      if (d && start < 0) start = x;
      if (!d && start >= 0) {
        if (x - start >= minPx) runs.push({ x1: start, x2: x - 1 });
        start = -1;
      }
    }
    // Continue runs from the row above that overlap mostly; close the rest.
    for (let i = open.length - 1; i >= 0; i--) {
      const r = open[i]!;
      const k = runs.findIndex((n) => Math.min(n.x2, r.x2) - Math.max(n.x1, r.x1) > 0.8 * Math.min(n.x2 - n.x1, r.x2 - r.x1));
      if (k >= 0 && r.y1 === y - 1) {
        const n = runs.splice(k, 1)[0]!;
        r.y1 = y;
        r.x1 = Math.min(r.x1, n.x1);
        r.x2 = Math.max(r.x2, n.x2);
      } else {
        done.push(r);
        open.splice(i, 1);
      }
    }
    for (const n of runs) open.push({ y0: y, y1: y, x1: n.x1, x2: n.x2 });
  }
  done.push(...open);
  return done
    .filter((r) => r.y1 - r.y0 + 1 <= maxThick)
    .map((r) => ({ y: (r.y0 + r.y1 + 1) / 2 / g.scale, x1: r.x1 / g.scale, x2: (r.x2 + 1) / g.scale }))
    .sort((a, b) => a.y - b.y || a.x1 - b.x1);
}

/**
 * The box drawn around a point (a checkbox, a form cell): walks out from the point to the first
 * dark pixel in each direction and checks the four edges are mostly solid lines.
 */
export function findBoxAround(g: GrayImage, x: number, y: number, opts: { maxWidth?: number; maxHeight?: number; minSize?: number } = {}): Box | null {
  const px = Math.round(x * g.scale), py = Math.round(y * g.scale);
  if (dark(g, px, py)) return null;
  const maxW = Math.round((opts.maxWidth ?? 400) * g.scale), maxH = Math.round((opts.maxHeight ?? 80) * g.scale);
  const min = (opts.minSize ?? 6) * g.scale;
  const walk = (dx: number, dy: number, limit: number) => {
    for (let i = 1; i <= limit; i++) if (dark(g, px + dx * i, py + dy * i)) return i;
    return -1;
  };
  const l = walk(-1, 0, maxW), r = walk(1, 0, maxW), u = walk(0, -1, maxH), d = walk(0, 1, maxH);
  if (l < 0 || r < 0 || u < 0 || d < 0) return null;
  const x0 = px - l, x1 = px + r, y0 = py - u, y1 = py + d;
  if (x1 - x0 < min || y1 - y0 < min || x1 - x0 > maxW || y1 - y0 > maxH) return null;
  // Each edge must be a line (≥ 75% dark within ±1 px), not a stray glyph.
  const solidH = (yy: number) => {
    let n = 0;
    for (let xx = x0; xx <= x1; xx++) if (dark(g, xx, yy) || dark(g, xx, yy - 1) || dark(g, xx, yy + 1)) n++;
    return n / (x1 - x0 + 1) >= 0.75;
  };
  const solidV = (xx: number) => {
    let n = 0;
    for (let yy = y0; yy <= y1; yy++) if (dark(g, xx, yy) || dark(g, xx - 1, yy) || dark(g, xx + 1, yy)) n++;
    return n / (y1 - y0 + 1) >= 0.75;
  };
  if (!solidH(y0) || !solidH(y1) || !solidV(x0) || !solidV(x1)) return null;
  // Inner edge of the lines.
  return { minX: (x0 + 1) / g.scale, minY: (y0 + 1) / g.scale, maxX: x1 / g.scale, maxY: y1 / g.scale };
}

export interface TextPlacement { x: number; y: number; width: number; fontSize: number; snapped: 'box' | 'line' | null }

/**
 * Where a typed answer goes for a tap at (x, y): inside the box around it, else on the nearest
 * underline just below, else right where the user tapped. `y` of the result is the text box's
 * top (Inkwright text boxes put the first baseline ~1.02 × font size below the top).
 */
export function placeText(g: GrayImage | null, x: number, y: number, pageWidth: number, defaultSize = 14): TextPlacement {
  if (g) {
    const box = findBoxAround(g, x, y, { maxWidth: pageWidth * 0.9, maxHeight: 70, minSize: 12 });
    if (box && box.maxY - box.minY >= 12) {
      const h = box.maxY - box.minY;
      const fontSize = Math.max(8, Math.min(defaultSize + 4, h * 0.62));
      return { x: box.minX + 3, y: box.minY + (h - fontSize * 1.25) / 2, width: Math.max(40, box.maxX - box.minX - 6), fontSize, snapped: 'box' };
    }
    const lines = detectHorizontalLines(g);
    const near = lines
      .filter((l) => l.y >= y - 10 && l.y <= y + 34 && x >= l.x1 - 16 && x <= l.x2 + 8)
      .sort((a, b) => Math.abs(a.y - y - 8) - Math.abs(b.y - y - 8))[0];
    if (near) {
      const fontSize = defaultSize;
      const startX = x - near.x1 < 28 ? near.x1 + 2 : x;
      return { x: startX, y: near.y - 3 - fontSize * 1.02, width: Math.max(40, near.x2 - startX), fontSize, snapped: 'line' };
    }
  }
  return { x, y: y - defaultSize * 0.7, width: Math.max(120, Math.min(360, pageWidth - x - 24)), fontSize: defaultSize, snapped: null };
}

/** Where a check or cross goes: fitted inside the box around the tap, else centred on it. */
export function placeMark(g: GrayImage | null, x: number, y: number, defaultSize = 16): Box & { snapped: boolean } {
  const box = g ? findBoxAround(g, x, y, { maxWidth: 44, maxHeight: 44, minSize: 6 }) : null;
  if (box) {
    const inset = Math.min(box.maxX - box.minX, box.maxY - box.minY) * 0.16;
    return { minX: box.minX + inset, minY: box.minY + inset, maxX: box.maxX - inset, maxY: box.maxY - inset, snapped: true };
  }
  const h = defaultSize / 2;
  return { minX: x - h, minY: y - h, maxX: x + h, maxY: y + h, snapped: false };
}
