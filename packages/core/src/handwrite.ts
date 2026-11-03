import type { ContentOrigin, InkPoint, InkStroke, PenType } from './model.ts';
import script from './fonts/script.json' with { type: 'json' };
import print from './fonts/print.json' with { type: 'json' };

/**
 * Handwriting synthesis: turns text into pen strokes that look written, not typeset.
 *
 * Glyphs come from single-line (engraving) fonts — each letter is the path a pen would follow, not
 * an outline — so the result is real ink: it renders with every pen, erases, lassoes and exports
 * like anything written by hand. Human variation is layered on top, deterministically from a seed:
 * a drifting baseline, per-letter size and slant wobble, slightly uneven spacing, pressure that
 * swells mid-stroke and lifts at the ends, and plausible timing (so audio sync and replay work).
 *
 * Uses: sample notebooks and screenshots; "write it in ink" for AI answers (marked origin 'ai', so
 * authorship never counts them as the user's handwriting); placeholder ink in tests.
 *
 * Fonts: EMS Allure (script) and EMS Felix (print), SIL Open Font License — see fonts/OFL.txt.
 */

interface SingleLineFont {
  name: string;
  unitsPerEm: number;
  ascent: number;
  xHeight: number;
  capHeight: number;
  glyphs: Record<string, { a: number; p: number[][] }>;
}

export type HandwritingStyle = 'script' | 'print';

const FONTS: Record<HandwritingStyle, SingleLineFont> = { script: script as SingleLineFont, print: print as SingleLineFont };

export interface HandwriteOptions {
  /** Top-left of the first line's x-height band, page units. */
  x: number;
  y: number;
  /** Wrap width in page units (Infinity = no wrapping). */
  width?: number;
  /** Height of lowercase letters (x-height), page units. Default 9 (≈ college-ruled writing). */
  xHeight?: number;
  /** Distance between baselines, page units. Default 3.6 × xHeight. */
  lineHeight?: number;
  style?: HandwritingStyle;
  pen?: PenType;
  color?: string;
  /** Pen tip size, page units. */
  size?: number;
  /** 0 = machine-neat, 1 = hurried. Default 0.45. */
  messiness?: number;
  /** Extra forward slant in degrees. */
  slant?: number;
  seed?: number;
  /** Wall-clock time of the first stroke (ms); later strokes follow at a writing pace. */
  startTime?: number;
  origin?: ContentOrigin;
  /** Stroke id factory (defaults to deterministic ids derived from the seed). */
  newId?: () => string;
}

export interface HandwriteResult {
  strokes: InkStroke[];
  /** Bottom of the last line (baseline + descender), page units — where the next block can start. */
  bottom: number;
  /** Baseline y of each written line. */
  baselines: number[];
}

function rng(seed: number) {
  let a = seed | 0 || 0x2545f491;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in [-1, 1] along one axis (for baseline drift). */
function drift(r: () => number) {
  const knots = Array.from({ length: 64 }, () => r() * 2 - 1);
  return (u: number) => {
    const i = Math.floor(u), f = u - i;
    const a = knots[((i % 64) + 64) % 64]!, b = knots[(((i + 1) % 64) + 64) % 64]!;
    const s = f * f * (3 - 2 * f);
    return a + (b - a) * s;
  };
}

/**
 * One glyph of a single-line font as pen paths in font units (y up, baseline 0), with the font's
 * metrics. The handwritten-maths reader builds its symbol templates from these, and its eval
 * writes test problems with them. Null when the font has no such glyph.
 */
export function singleLineGlyph(ch: string, style: HandwritingStyle = 'print'): { advance: number; paths: number[][]; xHeight: number; capHeight: number } | null {
  const font = FONTS[style];
  const g = font.glyphs[ch];
  if (!g) return null;
  return { advance: g.a, paths: g.p.map((p) => [...p]), xHeight: font.xHeight, capHeight: font.capHeight };
}

/** Advance width of a word in page units at the given scale (for wrapping). */
function wordWidth(font: SingleLineFont, word: string, scale: number) {
  let w = 0;
  for (const ch of word) w += (font.glyphs[ch] ?? font.glyphs['?'] ?? { a: font.unitsPerEm * 0.4 }).a * scale;
  return w;
}

/** Splits text into lines that fit `width` (explicit newlines always break). */
export function layoutHandwriting(text: string, width: number, xHeight: number, style: HandwritingStyle = 'script'): string[] {
  const font = FONTS[style];
  const scale = xHeight / font.xHeight;
  const space = (font.glyphs[' ']?.a ?? font.unitsPerEm * 0.35) * scale;
  const lines: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    let lineW = 0;
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const w = wordWidth(font, word, scale);
      if (line && lineW + space + w > width) {
        lines.push(line);
        line = word;
        lineW = w;
      } else {
        line = line ? `${line} ${word}` : word;
        lineW += (line === word ? 0 : space) + w;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** Writes `text` as strokes. Deterministic for a given seed. */
export function handwrite(text: string, o: HandwriteOptions): HandwriteResult {
  const style = o.style ?? 'script';
  const font = FONTS[style];
  const xh = o.xHeight ?? 9;
  const scale = xh / font.xHeight;
  const lineHeight = o.lineHeight ?? xh * 3.6;
  const mess = Math.max(0, Math.min(1, o.messiness ?? 0.45));
  const r = rng(o.seed ?? 7);
  const wobble = drift(r);
  const slant = ((o.slant ?? (style === 'print' ? 4 : 0)) * Math.PI) / 180;
  const pen = o.pen ?? 'fountain';
  const color = o.color ?? '#FF1F2433';
  const size = o.size ?? Math.max(1.2, xh * 0.2);
  let idn = 0;
  const seedTag = (o.seed ?? 7).toString(36);
  const newId = o.newId ?? (() => `hw-${seedTag}-${(idn++).toString(36)}`);
  let clock = o.startTime ?? 0;

  const strokes: InkStroke[] = [];
  const baselines: number[] = [];
  const lines = layoutHandwriting(text, o.width ?? Infinity, xh, style);
  const space = (font.glyphs[' ']?.a ?? font.unitsPerEm * 0.35) * scale;

  lines.forEach((line, li) => {
    const baseline = o.y + xh + li * lineHeight;
    baselines.push(baseline);
    let penX = o.x + (r() - 0.5) * xh * 0.3 * mess;
    let wordStart = true;
    for (const ch of line) {
      if (ch === ' ') {
        penX += space * (0.85 + r() * 0.35 * (0.5 + mess));
        clock += 120 + r() * 160;
        wordStart = true;
        continue;
      }
      const glyph = font.glyphs[ch] ?? font.glyphs['?'];
      if (!glyph) continue;
      // Per-letter human variation.
      const s = scale * (1 + (r() - 0.5) * 0.12 * (0.4 + mess));
      const rot = (r() - 0.5) * 0.06 * (0.4 + mess);
      const lift = wobble((penX - o.x) / (xh * 9) + li * 7.3) * xh * 0.18 * (0.4 + mess) + (r() - 0.5) * xh * 0.05 * mess;
      const cos = Math.cos(rot), sin = Math.sin(rot);
      for (const raw of glyph.p) {
        if (raw.length < 2) continue;
        // A dot (i, j, full stop, colon) is a point or a near-zero segment in the font: give it a
        // short tick so it reads as a pen dot rather than vanishing.
        let span = 0;
        for (let i = 2; i < raw.length; i += 2) span = Math.max(span, Math.hypot(raw[i]! - raw[0]!, raw[i + 1]! - raw[1]!));
        const dot = span < 30;
        const path = dot ? [raw[0]!, raw[1]!, raw[0]! + 22, raw[1]! - 16] : raw;
        const pts: InkPoint[] = [];
        const n = path.length / 2;
        // Arc length for pressure and timing.
        let total = 0;
        for (let i = 1; i < n; i++) total += Math.hypot(path[i * 2]! - path[i * 2 - 2]!, path[i * 2 + 1]! - path[i * 2 - 1]!);
        let acc = 0;
        const speed = (0.9 + r() * 0.5) * (1 + mess * 0.6); // font units per ms
        for (let i = 0; i < n; i++) {
          if (i > 0) acc += Math.hypot(path[i * 2]! - path[i * 2 - 2]!, path[i * 2 + 1]! - path[i * 2 - 1]!);
          const gx = path[i * 2]!, gy = path[i * 2 + 1]!;
          // Font units (y up) → page units (y down), slant, small rotation about the glyph origin.
          const ux = gx * s + gy * s * Math.tan(slant);
          const uy = -gy * s;
          const x = penX + ux * cos - uy * sin + (r() - 0.5) * 0.25 * mess;
          const y = baseline + lift + ux * sin + uy * cos + (r() - 0.5) * 0.25 * mess;
          const f = total > 0 ? acc / total : 0;
          const p = Math.min(1, Math.max(0.12, 0.38 + 0.32 * Math.sin(Math.PI * Math.min(1, f * 1.15)) + (r() - 0.5) * 0.08));
          pts.push({ x, y, t: Math.round(acc / speed), p, tilt: -1, orient: -1 });
        }
        // Densify long straight runs so outlines stay smooth with every pen.
        const dense: InkPoint[] = [pts[0]!];
        for (let i = 1; i < pts.length; i++) {
          const a = pts[i - 1]!, b = pts[i]!;
          const d = Math.hypot(b.x - a.x, b.y - a.y);
          const steps = Math.max(1, Math.ceil(d / Math.max(0.8, xh * 0.12)));
          for (let k = 1; k <= steps; k++) {
            const f = k / steps;
            dense.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, t: Math.round(a.t + (b.t - a.t) * f), p: a.p + (b.p - a.p) * f, tilt: -1, orient: -1 });
          }
        }
        const stroke: InkStroke = { id: newId(), pen, color, size, points: dense, createdAt: Math.round(clock) };
        if (o.origin) stroke.origin = o.origin;
        strokes.push(stroke);
        clock += (dense[dense.length - 1]?.t ?? 0) + 40 + r() * 90;
      }
      penX += glyph.a * s * (0.96 + r() * 0.08 * (0.5 + mess)) + (wordStart ? 0 : 0);
      wordStart = false;
    }
    clock += 400 + r() * 500;
  });
  const last = baselines[baselines.length - 1] ?? o.y + xh;
  return { strokes, bottom: last + xh * 1.4, baselines };
}
