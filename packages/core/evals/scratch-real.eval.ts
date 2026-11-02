import { describe, expect, it } from 'vitest';
import { detectScratchOut, handwrite, type InkPoint, type InkStroke } from '../src/index.ts';

/**
 * Scratch-out on realistic handwriting: real letter shapes (the handwriting synthesizer's
 * single-line fonts, joined script and print), written large or small, on a slant (people writing
 * on a phone often write uphill), and crossed out the way people actually do it — a fast zig-zag
 * with big overshoot, a looping "cloud", or a few hard back-and-forth strokes along the word.
 *
 * This complements scratch.eval.ts (synthetic bumps) after real-device feedback that crossing out
 * was messy: big, slanted handwriting crossed out with overshoot was often left alone, or only
 * some letters went.
 */
type P = [number, number];
let seed = 4242;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const range = (a: number, b: number) => a + (b - a) * rnd();
const WORDS = ['budget', 'car', 'meeting', 'Tuesday', 'notes', 'idea', 'lecture', 'answer', 'review', 'plan', 'apple', 'invoice'];

function rotateStrokes(strokes: InkStroke[], cx: number, cy: number, a: number): InkStroke[] {
  const c = Math.cos(a), s = Math.sin(a);
  return strokes.map((st) => ({ ...st, points: st.points.map((p) => ({ ...p, x: cx + (p.x - cx) * c - (p.y - cy) * s, y: cy + (p.x - cx) * s + (p.y - cy) * c })) }));
}
function bounds(strokes: InkStroke[]) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const s of strokes) for (const p of s.points) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y); }
  return { minX, minY, maxX, maxY };
}
function stroke(id: string, pts: P[], size: number): InkStroke {
  return { id, pen: 'fountain', color: '#FF000000', size, createdAt: 0, points: pts.map(([x, y], i): InkPoint => ({ x, y, t: i * 4, p: 0.5, tilt: -1, orient: -1 })) };
}
function dense(c: P[], step: number): P[] {
  const out: P[] = [];
  for (let i = 1; i < c.length; i++) {
    const [ax, ay] = c[i - 1]!, [bx, by] = c[i]!;
    const n = Math.max(1, Math.floor(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(c[c.length - 1]!);
  return out.map(([x, y]) => [x + range(-0.6, 0.6), y + range(-0.6, 0.6)]);
}

/** A written line: words with their strokes, laid out along a slant. */
function writeLine(n: number, xh: number, angle: number, style: 'script' | 'print') {
  const words: { word: string; strokes: InkStroke[] }[] = [];
  let x = 40;
  const y = 200;
  for (let i = 0; i < n; i++) {
    const w = WORDS[Math.floor(rnd() * WORDS.length)]!;
    const r = handwrite(w, { x, y, xHeight: xh, style, seed: Math.floor(rnd() * 1e6), messiness: range(0.3, 0.7), newId: (() => { let k = 0; return () => `w${i}-${k++}`; })() });
    words.push({ word: w, strokes: r.strokes });
    x = bounds(r.strokes).maxX + xh * range(1.2, 2.2);
  }
  // Slant the whole line about its start.
  return words.map((wd) => ({ ...wd, strokes: rotateStrokes(wd.strokes, 40, y, angle) }));
}

/** A crossing-out gesture over a word's area in the word's own frame (rotated with the line). */
function crossOut(b: { minX: number; minY: number; maxX: number; maxY: number }, kind: 'zigzag' | 'loops' | 'strikes', angle: number, origin: P, xh: number): P[] {
  // Undo the slant to get the word's box in its own frame, build the gesture there, rotate back.
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  const over = xh * range(0.2, 0.9);
  const c: P[] = [];
  if (kind === 'zigzag') {
    const passes = Math.round(range(5, 12));
    for (let i = 0; i <= passes; i++) c.push([b.minX + (w * i) / passes + range(-2, 2), i % 2 ? b.maxY + over : b.minY - over]);
  } else if (kind === 'strikes') {
    const passes = Math.round(range(3, 6));
    for (let i = 0; i <= passes; i++) c.push([i % 2 ? b.maxX + over : b.minX - over, b.minY + h * (0.25 + 0.5 * (i / passes)) + range(-2, 2)]);
  } else {
    const turns = Math.round(range(3, 6)), n = turns * 32, r = xh * range(0.7, 1.1); // loops ride the letters' body
    for (let i = 0; i <= n; i++) { const a = (i / 32) * Math.PI * 2; c.push([b.minX + (w * i) / n + Math.cos(a) * r, (b.minY + b.maxY) / 2 + Math.sin(a) * r]); }
  }
  const [ox, oy] = origin, cs = Math.cos(angle), sn = Math.sin(angle);
  return dense(c, 1.4).map(([x, y]) => [ox + (x - ox) * cs - (y - oy) * sn, oy + (x - ox) * sn + (y - oy) * cs]);
}

interface Result { ok: boolean; erasedNeighbour: boolean; missed: number; total: number; tag: string }

function trial(): Result {
  const style = rnd() < 0.6 ? 'script' : 'print';
  const xh = range(8, 28);
  const angle = -range(0, 0.7); // up to ~40° uphill
  const unrotated = writeLine(Math.round(range(2, 4)), xh, 0, style);
  const target = Math.floor(rnd() * unrotated.length);
  const box = bounds(unrotated[target]!.strokes);
  const kind = (['zigzag', 'zigzag', 'loops', 'strikes'] as const)[Math.floor(rnd() * 4)]!;
  const gesture = crossOut(box, kind, angle, [40, 200], xh);
  const words = unrotated.map((wd) => ({ ...wd, strokes: rotateStrokes(wd.strokes, 40, 200, angle) }));
  const all = words.flatMap((w) => w.strokes);
  const size = Math.max(1.2, xh * 0.2);
  const r = detectScratchOut(stroke('scribble', gesture, size), all, { overInkTolerance: 5 });
  const want = new Set(words[target]!.strokes.map((s) => s.id));
  const missed = [...want].filter((id) => !r.targetIds.has(id)).length;
  const erasedNeighbour = [...r.targetIds].some((id) => !want.has(id));
  return { ok: r.isScratch && missed / want.size <= 0.15 && !erasedNeighbour, erasedNeighbour, missed, total: want.size, tag: `${kind}/${style}/xh${Math.round(xh)}/${r.reason}/onInk${(r.onInk ?? 0).toFixed(2)}/rev${r.reversals ?? 0}/miss${missed}of${want.size}` };
}

/** Normal writing next to existing words must never erase anything. */
function negative(): { ok: boolean; which: string } {
  const xh = range(8, 28);
  const angle = -range(0, 0.7);
  const flat = writeLine(Math.round(range(2, 4)), xh, 0, rnd() < 0.6 ? 'script' : 'print');
  const b = bounds(flat.flatMap((w) => w.strokes));
  // The next word, written after the line; and an underline under it (both in the line's frame).
  const extra = handwrite(WORDS[Math.floor(rnd() * WORDS.length)]!, { x: b.maxX + xh * 1.5, y: 200, xHeight: xh, style: 'script', seed: Math.floor(rnd() * 1e6), newId: (() => { let k = 0; return () => `x${k++}`; })() }).strokes;
  const underline = stroke('underline', dense([[b.minX, b.maxY + xh * 0.4], [b.maxX, b.maxY + xh * 0.5]], 1.4), Math.max(1.2, xh * 0.2));
  const all = rotateStrokes(flat.flatMap((w) => w.strokes), 40, 200, angle);
  const candidates = rotateStrokes([...extra, underline], 40, 200, angle);
  for (const c of candidates) if (detectScratchOut(c, all, { overInkTolerance: 5 }).isScratch) return { ok: false, which: c.id };
  return { ok: true, which: '' };
}

describe('scratch-out on realistic handwriting', () => {
  it('erases the crossed-out word, and only that word', () => {
    const N = 300;
    let ok = 0, neighbours = 0;
    const fails: string[] = [];
    for (let i = 0; i < N; i++) { const r = trial(); if (r.ok) ok++; else fails.push((r.erasedNeighbour ? 'NEIGHBOUR ' : '') + r.tag); if (r.erasedNeighbour) neighbours++; }
    if (process.env.SCRATCH_DEBUG) console.log(fails.join('\n'));
    const recall = ok / N, fp = neighbours / N;
    console.log(`realistic scratch-out: ${(recall * 100).toFixed(1)}% fully erased, ${(fp * 100).toFixed(1)}% touched a neighbour (n=${N})`);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(fp).toBeLessThanOrEqual(0.01);
  });
  it('never erases when writing the next word or underlining', () => {
    let bad = 0;
    const which: string[] = [];
    for (let i = 0; i < 200; i++) { const r = negative(); if (!r.ok) { bad++; which.push(r.which); } }
    console.log(`realistic negatives: ${bad} false erases of 200 ${which.slice(0, 12).join(' ')}`);
    expect(bad).toBeLessThanOrEqual(2);
  });
});
