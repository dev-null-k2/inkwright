import { singleLineGlyph, type HandwritingStyle } from '../handwrite.ts';
import type { InkGroup, RawCandidate, SymbolRecognizer } from './types.ts';

/**
 * The built-in symbol classifier: a $P point-cloud recognizer (Vatavu, Anthony & Wobbrock,
 * "Gestures as Point Clouds", ICMI 2012) over templates of the maths alphabet.
 *
 * It is the reader's last on-device engine, used when there is neither ML Kit (Android) nor the
 * browser's handwriting recognizer, so maths can still be read without sending anything anywhere.
 * $P ignores stroke order and direction, which is what handwriting needs ("+" drawn either way),
 * and uniform scaling keeps aspect ratio, so "(" and "c" stay apart. Templates are the glyphs of
 * the two single-line fonts in handwrite.ts at three slants, plus hand-made π and √; the eval in
 * apps/web/evals/mathink.eval.ts measures it on a third hand that is not among the templates.
 */

type Pt = { x: number; y: number; id: number };

const N = 32;

/** Symbols the built-in classifier knows, beyond what the fonts give. Font units, y up. */
const EXTRA: Record<string, number[][][]> = {
  π: [
    [[30, 300, 200, 318, 420, 312], [150, 310, 140, 160, 120, 0], [300, 312, 300, 120, 320, 20, 360, 10]],
    [[40, 290, 400, 300], [140, 296, 132, 0], [300, 298, 300, 0]],
  ],
  '√': [
    [[0, 230, 60, 260, 150, 0, 260, 620, 700, 620]],
    [[0, 260, 80, 300, 170, 0, 230, 560, 640, 560]],
  ],
};

/** Labels taken from the fonts: digits, operators and the letters people use as variables. */
const FONT_LABELS = [...'0123456789', ...'+-=()×÷/^%!<>[]', ...'abcdefghknpqrstuvwxyz'];

function resample(strokes: { x: number; y: number }[][], n = N): Pt[] {
  const pts: Pt[] = [];
  strokes.forEach((s, id) => s.forEach((p) => pts.push({ x: p.x, y: p.y, id })));
  if (pts.length === 1) return Array.from({ length: n }, () => ({ ...pts[0]! }));
  let total = 0;
  for (let i = 1; i < pts.length; i++) if (pts[i]!.id === pts[i - 1]!.id) total += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  if (total <= 1e-9) return Array.from({ length: n }, (_, i) => ({ ...pts[i % pts.length]! }));
  const I = total / (n - 1);
  const out: Pt[] = [{ ...pts[0]! }];
  let D = 0;
  const src = pts.map((p) => ({ ...p }));
  for (let i = 1; i < src.length; i++) {
    const a = src[i - 1]!, b = src[i]!;
    if (a.id !== b.id) continue;
    const d = Math.hypot(b.x - a.x, b.y - a.y);
    if (D + d >= I && d > 0) {
      const f = (I - D) / d;
      const q = { x: a.x + f * (b.x - a.x), y: a.y + f * (b.y - a.y), id: a.id };
      out.push(q);
      src.splice(i, 0, q);
      D = 0;
    } else D += d;
  }
  while (out.length < n) out.push({ ...src[src.length - 1]! });
  return out.slice(0, n);
}

function normalize(pts: Pt[]): Pt[] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  const size = Math.max(maxX - minX, maxY - minY) || 1;
  const sc = pts.map((p) => ({ x: (p.x - minX) / size, y: (p.y - minY) / size, id: p.id }));
  const cx = sc.reduce((a, p) => a + p.x, 0) / sc.length, cy = sc.reduce((a, p) => a + p.y, 0) / sc.length;
  return sc.map((p) => ({ x: p.x - cx, y: p.y - cy, id: p.id }));
}

function cloudDistance(a: Pt[], b: Pt[], start: number, cutoff: number): number {
  const n = a.length;
  const matched = new Uint8Array(n);
  let sum = 0;
  let i = start;
  do {
    let min = Infinity, idx = -1;
    for (let j = 0; j < n; j++) {
      if (matched[j]) continue;
      const dx = a[i]!.x - b[j]!.x, dy = a[i]!.y - b[j]!.y;
      const d = dx * dx + dy * dy;
      if (d < min) { min = d; idx = j; }
    }
    matched[idx] = 1;
    const weight = 1 - ((i - start + n) % n) / n;
    sum += weight * Math.sqrt(min);
    if (sum >= cutoff) return sum;
    i = (i + 1) % n;
  } while (i !== start);
  return sum;
}

function greedyMatch(a: Pt[], b: Pt[], cutoff = Infinity): number {
  const step = Math.floor(Math.sqrt(a.length));
  let min = cutoff;
  for (let i = 0; i < a.length; i += step) {
    min = Math.min(min, cloudDistance(a, b, i, min), cloudDistance(b, a, i, min));
  }
  return min;
}

interface Template { label: string; pts: Pt[]; aspect: number }

/** Font units (y up) → points (y down), slanted by `slant` degrees. */
function fromPaths(paths: number[][], slant: number): { x: number; y: number }[][] {
  const k = Math.tan((slant * Math.PI) / 180);
  return paths.filter((p) => p.length >= 2).map((p) => {
    const out: { x: number; y: number }[] = [];
    for (let i = 0; i + 1 < p.length; i += 2) out.push({ x: p[i]! + p[i + 1]! * k, y: -p[i + 1]! });
    if (out.length === 1) out.push({ x: out[0]!.x + 10, y: out[0]!.y - 8 });
    return out;
  });
}

function aspectOf(strokes: { x: number; y: number }[][]): number {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) for (const p of s) { minX = Math.min(minX, p.x); minY = Math.min(minY, p.y); maxX = Math.max(maxX, p.x); maxY = Math.max(maxY, p.y); }
  return Math.log((maxX - minX + 1e-3 * (maxY - minY + 1)) / (maxY - minY + 1e-3 * (maxX - minX + 1)));
}

let templates: Template[] | null = null;

function buildTemplates(): Template[] {
  const out: Template[] = [];
  const add = (label: string, strokes: { x: number; y: number }[][]) => out.push({ label, pts: normalize(resample(strokes)), aspect: aspectOf(strokes) });
  for (const style of ['print', 'script'] as HandwritingStyle[]) {
    for (const label of FONT_LABELS) {
      const g = singleLineGlyph(label, style);
      if (!g) continue;
      for (const slant of [-6, 6, 18]) add(label, fromPaths(g.paths, slant));
    }
  }
  for (const [label, variants] of Object.entries(EXTRA)) for (const v of variants) for (const slant of [-6, 8]) add(label, fromPaths(v, slant));
  return out;
}

/**
 * Ranks labels for one ink. Distances become weights with a softmax over each label's best
 * template, and an absolute penalty when even the best match is poor (a scribble is nothing).
 */
export function classifySymbol(strokes: { x: number; y: number }[][], max = 6): { label: string; p: number }[] {
  templates ??= buildTemplates();
  const pts = normalize(resample(strokes.filter((s) => s.length)));
  const aspect = aspectOf(strokes);
  const best = new Map<string, number>();
  for (const t of templates) {
    // Aspect ratio is cheap and separates "-" from "1" and "(" from "o" before the cloud match.
    const da = Math.abs(t.aspect - aspect);
    const d = greedyMatch(pts, t.pts, best.get(t.label) ?? Infinity) + Math.max(0, da - 0.5) * 0.6;
    if (d < (best.get(t.label) ?? Infinity)) best.set(t.label, d);
  }
  const ranked = [...best.entries()].sort((a, b) => a[1] - b[1]).slice(0, max);
  if (!ranked.length) return [];
  const d0 = ranked[0]![1];
  const tau = 0.35 + d0 * 0.15;
  const ws = ranked.map(([, d]) => Math.exp(-(d - d0) / tau));
  const total = ws.reduce((a, b) => a + b, 0);
  const quality = Math.exp(-Math.max(0, d0 - 2.2) * 0.8);
  return ranked.map(([label], i) => ({ label, p: (ws[i]! / total) * quality }));
}

/** The built-in classifier as a SymbolRecognizer (scores are -log weights, lower = better, like ML Kit). */
export const builtInRecognizer: SymbolRecognizer = {
  name: 'built-in',
  async recognize(groups: readonly InkGroup[]): Promise<RawCandidate[][]> {
    return groups.map((g) => classifySymbol(g.strokes.map((s) => s.points.map((p) => ({ x: p.x, y: p.y })))).map((c) => ({ text: c.label, score: -Math.log(Math.max(1e-6, c.p)) })));
  },
};
