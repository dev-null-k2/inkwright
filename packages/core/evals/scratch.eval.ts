import { describe, expect, it } from 'vitest';
import { detectScratchOut, type InkPoint, type InkStroke } from '../src/index.ts';

/**
 * Scratch-out eval: hundreds of synthetic but realistic gestures, measured for recall (real
 * scribbles over ink erase what they cover) and false positives (normal writing never erases).
 * Seeded, so results are reproducible; thresholds below are the quality bar.
 */
type P = [number, number];
let seed = 12345;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const range = (a: number, b: number) => a + (b - a) * rnd();

function toStroke(id: string, pts: P[], size = 2.2, msPer = 6): InkStroke {
  return { id, pen: 'fountain', color: '#FF000000', size, createdAt: 0, points: pts.map(([x, y], i): InkPoint => ({ x, y, t: i * msPer, p: 0.5, tilt: -1, orient: -1 })) };
}
function interp(c: P[], step = 1.6): P[] {
  const out: P[] = [];
  for (let i = 1; i < c.length; i++) {
    const [ax, ay] = c[i - 1]!, [bx, by] = c[i]!;
    const n = Math.max(1, Math.floor(Math.hypot(bx - ax, by - ay) / step));
    for (let k = 0; k < n; k++) out.push([ax + ((bx - ax) * k) / n, ay + ((by - ay) * k) / n]);
  }
  out.push(c[c.length - 1]!);
  return out;
}
const jitter = (pts: P[], a: number): P[] => pts.map(([x, y]) => [x + range(-a, a), y + range(-a, a)]);
/** A handwritten word as several strokes (letters), with an i-dot sometimes. */
function word(id: string, x: number, y: number, w: number, h = 16): InkStroke[] {
  const out: InkStroke[] = [];
  const letters = Math.max(2, Math.round(w / 14));
  for (let l = 0; l < letters; l++) {
    const x0 = x + (l * w) / letters, x1 = x + ((l + 0.9) * w) / letters;
    const c: P[] = [];
    for (let i = 0; i <= 24; i++) {
      const f = i / 24;
      c.push([x0 + (x1 - x0) * f, y + Math.sin(f * Math.PI * range(2, 4)) * h * 0.45 + range(-1, 1)]);
    }
    out.push(toStroke(`${id}-${l}`, interp(c)));
  }
  if (rnd() < 0.5) out.push(toStroke(`${id}-dot`, [[x + w * 0.4, y - h], [x + w * 0.4 + 0.8, y - h + 0.5]]));
  return out;
}
/**
 * Zig-zag scribble over [x0,x1]×[y0,y1] at an angle, with drift, overshoot and jitter. Passes are
 * spaced like real hands do it: horizontal scribbles stack 3–9 passes over a line's height; vertical
 * ones sweep across the word every 6–14 units.
 */
function scribble(x0: number, x1: number, y0: number, y1: number, passes: number, vertical: boolean, angle = 0): P[] {
  const c: P[] = [];
  for (let i = 0; i <= passes; i++) {
    const f = i / passes;
    const over = range(-2, 6);
    if (vertical) c.push([x0 + (x1 - x0) * f + range(-2, 2), i % 2 ? y1 + over : y0 - over]);
    else c.push([i % 2 ? x1 + over : x0 - over, y0 + (y1 - y0) * f + range(-2, 2)]);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const rot = (p: P): P => [cx + (p[0] - cx) * Math.cos(angle) - (p[1] - cy) * Math.sin(angle), cy + (p[0] - cx) * Math.sin(angle) + (p[1] - cy) * Math.cos(angle)];
  return jitter(interp(c.map(rot), 1.6), 0.8);
}
/** Looping "cloud" scribble (circular motion moving across). */
function loops(x0: number, x1: number, cy: number, r: number, turns: number): P[] {
  const pts: P[] = [];
  const n = turns * 40;
  for (let i = 0; i <= n; i++) {
    const a = (i / 40) * Math.PI * 2;
    pts.push([x0 + ((x1 - x0) * i) / n + Math.cos(a) * r, cy + Math.sin(a) * r]);
  }
  return jitter(pts, 0.6);
}

interface Case { name: string; existing: InkStroke[]; candidate: InkStroke; expect: Set<string> | null; required?: Set<string>; zoom: number }

/** Writing zoomed in is smaller on the page; the engine scales its tolerance the same way. */
const ZOOMS = [0.6, 1, 1, 1.5, 2.5];
function atZoom(c: Case): Case {
  const k = 1 / c.zoom;
  const sc = (st: InkStroke): InkStroke => ({ ...st, size: st.size * Math.max(k, 0.5), points: st.points.map((p) => ({ ...p, x: p.x * k, y: p.y * k })) });
  return { ...c, existing: c.existing.map(sc), candidate: sc(c.candidate) };
}
const opts = (c: Case) => ({ overInkTolerance: Math.max(1.5, 5 / c.zoom) });

function positives(): Case[] {
  const cases: Case[] = [];
  for (let k = 0; k < 250; k++) {
    const w = range(40, 160), h = range(12, 22);
    const x = 100, y = 200;
    const target = word('t', x, y, w, h);
    const other = word('o', x + w + range(18, 40), y + range(-3, 3), range(40, 120), h);
    const below = word('b', x, y + h * 2.4, range(60, 140), h);
    const existing = [...target, ...other, ...below];
    const kind = k % 5;
    const right = x + w * range(0.97, 1) + range(0, 6);
    const vertical = kind === 1 || kind === 3;
    let pts: P[];
    if (kind === 4) pts = loops(x - 4, right, y, h * range(0.5, 0.8), Math.max(3, Math.round(w / 16)));
    else if (vertical) pts = scribble(x - range(2, 6), right, y - h * range(0.45, 0.7), y + h * range(0.45, 0.7), Math.max(4, Math.round(w / range(6, 14))), true);
    else {
      // A tilted scribble still has to cover the word, so its band grows with the tilt.
      // Long words get scribbled along their line; only short ones get a real tilt.
      const angle = kind === 2 ? range(-1, 1) * Math.min(0.35, Math.asin(Math.min(1, (0.6 * h) / w))) : 0;
      const grow = Math.abs(Math.sin(angle)) * w * 0.5;
      pts = scribble(x - range(2, 6), right, y - h * range(0.45, 0.7) - grow, y + h * range(0.45, 0.7) + grow, Math.round(range(3, 9) + grow / 6), false, angle);
    }
    if (k % 3 === 1) pts = pts.filter((_, i) => i % 4 === 0); // a fast flick: ~6 units between samples
    const required = new Set(target.filter((s) => !s.id.endsWith('dot')).map((s) => s.id));
    const zoom = ZOOMS[k % ZOOMS.length]!;
    cases.push(atZoom({ name: `scribble#${k} kind${kind} @${zoom}x`, existing, candidate: toStroke('s', pts), expect: required, required, zoom }));
  }
  return cases;
}

function negatives(): Case[] {
  const cases: Case[] = [];
  for (let k = 0; k < 330; k++) {
    const w = range(60, 160), h = range(12, 22);
    const x = 100, y = 200;
    const existing = [...word('t', x, y, w, h), ...word('o', x, y + h * 2.4, range(60, 140), h)];
    const kind = k % 11;
    let pts: P[];
    switch (kind) {
      case 0: { // the next word on the same line
        const s = word('n', x + w + range(12, 30), y, range(30, 100), h); pts = s.flatMap((st) => st.points.map((p) => [p.x, p.y] as P)).slice(0, 120); break;
      }
      case 1: pts = jitter(interp([[x - 4, y + h * 0.7], [x + w + 4, y + h * 0.75]]), 0.6); break; // underline
      case 2: pts = jitter(interp([[x - 4, y], [x + w + 4, y + range(-2, 2)]]), 0.6); break; // strike-through
      case 3: { // circle around the word
        const c: P[] = []; for (let i = 0; i <= 60; i++) { const a = (i / 56) * Math.PI * 2; c.push([x + w / 2 + Math.cos(a) * (w / 2 + 12), y + Math.sin(a) * (h + 10)]); } pts = jitter(c, 0.8); break;
      }
      case 4: pts = jitter(interp([[x + w * 0.3, y - 2], [x + w * 0.4, y + 8], [x + w * 0.6, y - 14]]), 0.5); break; // check mark over word
      case 5: pts = scribble(x + 260, x + 360, y - 10, y + 10, Math.round(range(4, 9)), rnd() < 0.5); break; // shading on blank paper
      case 6: { // cursive "mmm/www" written just below the line, touching descenders
        const c: P[] = []; for (let i = 0; i <= 8; i++) c.push([x + i * 9, y + h * 1.45 + (i % 2 ? -h * 0.5 : 0)]); pts = jitter(interp(c), 0.6); break;
      }
      case 8: { // shading inside a box drawn earlier
        const bx = x + w + 60, by = y - 20, bw = range(40, 90), bh = range(30, 60);
        existing.push(toStroke('box', jitter(interp([[bx, by], [bx + bw, by], [bx + bw, by + bh], [bx, by + bh], [bx, by]]), 0.4)));
        pts = scribble(bx + 3, bx + bw - 3, by + 3, by + bh - 3, Math.round(range(5, 12)), rnd() < 0.5);
        break;
      }
      case 9: { // a bracket or brace hugging the word
        const c: P[] = [[x - 4, y - h], [x - 10, y - h + 3], [x - 10, y - 2], [x - 15, y], [x - 10, y + 2], [x - 10, y + h - 3], [x - 4, y + h]];
        pts = jitter(interp(c), 0.5); break;
      }
      case 10: { // a star doodle next to the word, tips touching it
        const c: P[] = []; const sx = x + w + 12, r = h; for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + (i * 4 * Math.PI) / 5; c.push([sx + Math.cos(a) * r, y + Math.sin(a) * r]); }
        pts = jitter(interp(c), 0.5); break;
      }
      default: pts = jitter(interp([[x + w + 30, y + 30], [x + w + 4, y + 4], [x + w + 12, y + 4], [x + w + 4, y + 4], [x + w + 4, y + 12]]), 0.5); // arrow to word
    }
    const zoom = ZOOMS[(k * 3) % ZOOMS.length]!;
    cases.push(atZoom({ name: `negative#${k} kind${kind} @${zoom}x`, existing, candidate: toStroke('c', pts), expect: null, zoom }));
  }
  return cases;
}

describe('scratch-out eval', () => {
  it('meets the quality bar', () => {
    seed = 12345;
    const pos = positives();
    const neg = negatives();
    let tp = 0, fn = 0, fp = 0, overreach = 0;
    const misses: string[] = [];
    const over: string[] = [];
    const fps: string[] = [];
    for (const c of pos) {
      const r = detectScratchOut(c.candidate, c.existing, opts(c));
      const ok = r.isScratch && [...c.required!].every((id) => r.targetIds.has(id));
      if (ok) tp++; else { fn++; if (misses.length < 6) misses.push(`${c.name}: ${r.reason} (${r.targetIds.size} targets)`); }
      if (r.isScratch && [...r.targetIds].some((id) => !id.startsWith('t-'))) { overreach++; if (fps.length < 0) break; over.push(`${c.name}: ${[...r.targetIds].filter((id) => !id.startsWith('t-')).join(',')}`); }
    }
    for (const c of neg) { const r = detectScratchOut(c.candidate, c.existing, opts(c)); if (r.isScratch) { fp++; if (fps.length < 8) fps.push(`${c.name}: erased ${[...r.targetIds].join(',')}`); } }
    const q = (xs: number[], f: number) => { const a = [...xs].sort((u, v) => u - v); return a.length ? a[Math.floor(f * (a.length - 1))]!.toFixed(2) : '-'; };
    const posInk = pos.map((c) => detectScratchOut(c.candidate, c.existing, opts(c)).onInk).filter((v): v is number => v != null);
    const negInk = neg.map((c) => detectScratchOut(c.candidate, c.existing, opts(c)).onInk).filter((v): v is number => v != null);
    process.stdout.write(`on-ink: scribbles p5 ${q(posInk, 0.05)} p50 ${q(posInk, 0.5)} | non-scribbles p50 ${q(negInk, 0.5)} p95 ${q(negInk, 0.95)} max ${q(negInk, 1)}\n`);
    const recall = tp / pos.length, fpr = fp / neg.length;
    process.stdout.write(`\nScratch-out eval — recall ${(recall * 100).toFixed(1)}% (${tp}/${pos.length}), false positives ${(fpr * 100).toFixed(1)}% (${fp}/${neg.length}), erased neighbours ${overreach}\n${misses.map((m) => '  miss ' + m).join('\n')}\n${fps.map((m) => '  false+ ' + m).join('\n')}\n${over.slice(0, 6).map((m) => '  overreach ' + m).join('\n')}\n`);
    expect(recall).toBeGreaterThanOrEqual(0.95);
    expect(fpr).toBeLessThanOrEqual(0.01);
    expect(overreach / pos.length).toBeLessThanOrEqual(0.03);
  });
});
