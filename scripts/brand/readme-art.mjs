#!/usr/bin/env node
/**
 * Generates the README's hand-written artwork with the app's own pen (packages/core/src/handwrite.ts):
 * animated SVGs that write themselves out stroke by stroke, in the timing the synthesizer produced.
 *
 *   node --experimental-strip-types scripts/brand/readme-art.mjs
 *
 * Output: docs/media/{hero,tagline-*,section-*}-{light,dark}.svg. Deterministic (fixed seeds), so
 * regenerating produces identical files and diffs stay clean.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handwrite } from '../../packages/core/src/handwrite.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'docs', 'media');
mkdirSync(out, { recursive: true });

const THEMES = {
  light: { ink: '#2b2330', accent: '#356b53', seal: '#b3412f', soft: 'rgba(43,35,48,0.35)' },
  dark: { ink: '#eee8f0', accent: '#8cc4a8', seal: '#e07a66', soft: 'rgba(238,232,240,0.4)' },
};

const r2 = (n) => Math.round(n * 100) / 100;

/** Smooth centreline path through the stroke's points (midpoint quadratics). */
function pathD(points) {
  if (points.length < 2) return '';
  let d = `M${r2(points[0].x)} ${r2(points[0].y)}`;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i], q = points[i + 1];
    d += `Q${r2(p.x)} ${r2(p.y)} ${r2((p.x + q.x) / 2)} ${r2((p.y + q.y) / 2)}`;
  }
  const last = points[points.length - 1];
  return d + `L${r2(last.x)} ${r2(last.y)}`;
}

/**
 * One SVG from several written blocks. Each stroke is drawn on with a dash animation that starts when
 * the synthesizer "put the pen down", compressed by `speed`, so the page writes itself like a replay.
 */
function svg(blocks, { width, height, theme, seconds = 4, animate = true, pad = 8 }) {
  const t = THEMES[theme];
  const all = blocks.flatMap((b) => b.strokes.map((s) => ({ s, color: t[b.color ?? 'ink'], width: b.width })));
  const t0 = Math.min(...all.map(({ s }) => s.createdAt));
  const t1 = Math.max(...all.map(({ s }) => s.createdAt + s.points[s.points.length - 1].t));
  // Replay at whatever pace makes the whole thing take `seconds`.
  const speed = Math.max(1, (t1 - t0) / 1000 / seconds);
  const paths = all.map(({ s, color, width: w }, i) => {
    const delay = ((s.createdAt - t0) / 1000 / speed).toFixed(3);
    const dur = Math.max(0.06, (s.points[s.points.length - 1].t - s.points[0].t) / 1000 / speed).toFixed(3);
    const style = animate ? ` style="animation-delay:${delay}s;animation-duration:${dur}s"` : '';
    return `<path d="${pathD(s.points)}" stroke="${color}" stroke-width="${w}"${animate ? ' pathLength="1"' : ''}${style}/>`;
  });
  const css = animate
    ? `<style>path{fill:none;stroke-linecap:round;stroke-linejoin:round;stroke-dasharray:1;stroke-dashoffset:1;animation-name:w;animation-timing-function:cubic-bezier(.3,.1,.4,1);animation-fill-mode:forwards}@keyframes w{to{stroke-dashoffset:0}}@media (prefers-reduced-motion:reduce){path{animation:none;stroke-dashoffset:0}}</style>`
    : `<style>path{fill:none;stroke-linecap:round;stroke-linejoin:round}</style>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${width + 2 * pad} ${height + 2 * pad}" width="${width + 2 * pad}" height="${height + 2 * pad}" role="img">${css}${paths.join('')}</svg>\n`;
}

let written = 0;
function write(name, make) {
  for (const theme of Object.keys(THEMES)) {
    const file = join(out, `${name}-${theme}.svg`);
    writeFileSync(file, make(theme));
    written++;
  }
}

// Hero: the name in script, a hand-drawn underline, the line beneath in print.
function hero(theme, animate) {
  const name = handwrite('inkwright', { x: 40, y: 52, xHeight: 34, style: 'script', seed: 11, messiness: 0.3, startTime: 0 });
  const underline = {
    strokes: [{ createdAt: name.strokes[name.strokes.length - 1].createdAt + 300, points: Array.from({ length: 60 }, (_, i) => ({ x: 46 + i * 7.4, y: 176 + Math.sin(i / 9) * 3 - i * 0.05, t: i * 9 })) }],
    width: 3.2, color: 'accent',
  };
  const tag = handwrite('the notebook that writes back', { x: 70, y: 200, xHeight: 13, style: 'print', seed: 5, messiness: 0.25, startTime: underline.strokes[0].createdAt + 900 });
  return svg([{ strokes: name.strokes, width: 4.6 }, underline, { strokes: tag.strokes, width: 2.1, color: 'accent' }], { width: 560, height: 236, theme, seconds: 4.5, animate });
}
write('hero', (theme) => hero(theme, true));
// A still version for places that don't animate (social preview, store graphics).
write('hero-static', (theme) => hero(theme, false));

// Section headings for the README, written in script.
const sections = [['why', 'why it exists'], ['features', 'what it does'], ['agents', 'for your agents'], ['start', 'start in a minute'], ['story', 'the story'], ['under', 'under the hood'], ['roadmap', 'where it goes next']];
sections.forEach(([id, label], i) =>
  write(`section-${id}`, (theme) => {
    const h = handwrite(label, { x: 0, y: 14, xHeight: 15, style: 'script', seed: 31 + i, messiness: 0.3, startTime: 0 });
    const right = Math.max(...h.strokes.flatMap((s) => s.points.map((p) => p.x)));
    return svg([{ strokes: h.strokes, width: 2.6 }], { width: Math.ceil(right) + 6, height: 66, theme, seconds: 1.8 });
  }),
);

console.log(`wrote ${written} SVGs to ${out}`);
