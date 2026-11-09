#!/usr/bin/env node
/**
 * The website's hero: a meeting page written with the app's own pen (packages/core handwrite.ts).
 * Your notes go down first in your ink; then, as if the meeting had ended, Inkwright's additions
 * are written beneath each in AI ink, in a hand matched to the writer's (`handStyleOf`), each with
 * the moment it was said. One SVG that plays once, follows light and dark mode, and stands still
 * for people who asked for reduced motion.
 *
 *   node --experimental-strip-types scripts/brand/site-art.mjs
 *
 * Output: docs/media/site-meeting.svg (deterministic: fixed seeds and times).
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handStyleOf, handwrite } from '../../packages/core/src/handwrite.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const W = 640;
const H = 540;
const LEFT = 92;
const RULE = 34;

const pathD = (pts) => pts.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('');

// Your notes, fast and a little hurried, as written in the meeting.
const NOTES = [
  { text: 'acme - 40 reps', at: 0 },
  { text: 'spreadsheets, hate it', at: 1 },
  { text: 'security review?', at: 2 },
  { text: 'price', at: 3 },
];
// What Inkwright added under each, with when it was said.
const ADDED = [
  { under: 0, text: 'Dana runs sales ops, two regions', stamp: '0:11' },
  { under: 1, text: 'forecasts take two days a month', stamp: '0:24' },
  { under: 1, text: 'tried Salesforce, rollout stalled', stamp: '0:41' },
  { under: 2, text: 'CFO Priya signs off; IT review 3 wks', stamp: '1:26' },
  { under: 3, text: '$24 per rep / month, within budget', stamp: '2:02' },
];
const ACTION = { text: 'send the SOC 2 report today', stamp: '2:30' };

let seed = 40;
const yourHand = { style: 'script', pen: 'fountain', xHeight: 11, messiness: 0.55, slant: 8, size: 2.1 };
const BASE0 = 136;
const baseline = (row) => BASE0 + row * RULE;
const NOTE_ROWS = [0, 2, 5, 7];
const blocks = []; // { kind: 'mine'|'ai'|'box', strokes, delay (s), dur (s), stamp?, stampY? }

// First pass: your notes, written during the meeting (0 – 3.6 s).
const noteY = [];
let clock = 0;
NOTES.forEach((n, i) => {
  const row = NOTE_ROWS[i];
  const r = handwrite(n.text, { x: LEFT, y: baseline(row) - yourHand.xHeight, width: W - LEFT - 40, ...yourHand, seed: ++seed, startTime: clock });
  noteY.push(row);
  blocks.push({ kind: 'mine', strokes: r.strokes, start: 0.35 + n.at * 0.85, span: 0.8 });
  clock += 4000;
});

// The hand Inkwright matches: measured from your strokes, like the app does.
const hand = handStyleOf(blocks.flatMap((b) => b.strokes)) ?? { xHeight: 9, slant: 6, messiness: 0.3, pen: 'ballpoint', size: 1.4, style: 'print' };
const aiHand = { style: 'print', pen: 'ballpoint', xHeight: Math.max(7.5, hand.xHeight * 0.78), slant: hand.slant, messiness: Math.min(0.35, hand.messiness), size: 1.35 };

// Second pass: after the meeting, the additions (4.4 s on).
const perNote = new Map();
ADDED.forEach((a, i) => {
  const k = perNote.get(a.under) ?? 0;
  perNote.set(a.under, k + 1);
  const b = baseline(noteY[a.under] + k + 1);
  const r = handwrite(a.text, { x: LEFT + 22, y: b - aiHand.xHeight, width: Infinity, ...aiHand, seed: 100 + i, startTime: 0 });
  blocks.push({ kind: 'ai', strokes: r.strokes, start: 4.4 + i * 0.75, span: 0.7, stamp: a.stamp, stampY: b - 4 });
});
// The action item, with a hand-drawn box.
const ab = baseline(10);
const box = { createdAt: 0, points: [[0, 0], [14, 0.6], [14.4, 14], [0.4, 14.4], [0, 0]].map(([dx, dy], i) => ({ x: LEFT + dx, y: ab - 14 + dy, t: i * 60 })) };
const act = handwrite(ACTION.text, { x: LEFT + 24, y: ab - aiHand.xHeight, width: Infinity, ...aiHand, seed: 140, startTime: 0 });
blocks.push({ kind: 'ai', strokes: [box, ...act.strokes], start: 4.4 + ADDED.length * 0.75 + 0.2, span: 0.8, stamp: ACTION.stamp, stampY: ab - 4 });

function strokesSvg(b) {
  const t0 = Math.min(...b.strokes.map((s) => s.createdAt));
  const t1 = Math.max(...b.strokes.map((s) => s.createdAt + (s.points.at(-1)?.t ?? 0)));
  const k = (t1 - t0) / 1000 / b.span || 1;
  return b.strokes.map((s) => {
    const delay = (b.start + (s.createdAt - t0) / 1000 / k).toFixed(3);
    const dur = Math.max(0.03, ((s.points.at(-1)?.t ?? 0) - (s.points[0]?.t ?? 0)) / 1000 / k).toFixed(3);
    return `<path class="${b.kind}" d="${pathD(s.points)}" pathLength="1" style="animation-delay:${delay}s;animation-duration:${dur}s"/>`;
  }).join('');
}

const rules = [];
for (let row = -1; baseline(row) < H - 20; row++) rules.push(`<line x1="0" x2="${W}" y1="${baseline(row) + 4}" y2="${baseline(row) + 4}"/>`);

const stamps = blocks.filter((b) => b.stamp).map((b) => {
  const delay = (b.start + b.span).toFixed(2);
  return `<g class="stamp" style="animation-delay:${delay}s"><rect x="${W - 92}" y="${b.stampY - 14}" width="50" height="20" rx="10"/><text x="${W - 67}" y="${b.stampY + 0.5}">${b.stamp}</text></g>`;
}).join('');

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">A meeting page in Inkwright</title>
<desc id="d">Handwritten meeting notes: acme, 40 reps; spreadsheets, hate it; security review?; price. Beneath each, Inkwright has written what was said, in blue AI ink with the time it was said: Dana runs sales ops in two regions (0:11); forecasts take two days a month (0:24); they tried Salesforce and the rollout stalled (0:41); the CFO Priya signs off and IT's review takes about three weeks (1:26); $24 per rep per month is within budget (2:02); and an action item, send the SOC 2 report today (2:30).</desc>
<style>
  :root { --paper:#fffdf7; --rule:rgba(53,107,83,.13); --margin:rgba(179,65,47,.3); --ink:#2b2330; --ai:#2d5a8c; --chip:#eef2f7; --chip-ink:#2d5a8c; --meta:#746a7b; --rec:#b3412f; }
  @media (prefers-color-scheme: dark) { :root { --paper:#25202a; --rule:rgba(140,196,168,.13); --margin:rgba(224,122,102,.35); --ink:#efe9f2; --ai:#8fb8e6; --chip:#2f3a4a; --chip-ink:#a9c9ee; --meta:#a69cad; --rec:#e07a66; } }
  .paper { fill: var(--paper); }
  .rules line { stroke: var(--rule); stroke-width: 1; }
  .margin { stroke: var(--margin); stroke-width: 1.2; }
  path { fill: none; stroke-linecap: round; stroke-linejoin: round; stroke-dasharray: 1; stroke-dashoffset: 1; animation-name: w; animation-timing-function: cubic-bezier(.3,.1,.4,1); animation-fill-mode: forwards; }
  path.mine { stroke: var(--ink); stroke-width: 2.3; }
  path.ai { stroke: var(--ai); stroke-width: 1.45; }
  .stamp { opacity: 0; animation: f .35s ease-out forwards; }
  .stamp rect { fill: var(--chip); }
  .stamp text { fill: var(--chip-ink); font: 600 11.5px 'Hanken Grotesk', system-ui, sans-serif; text-anchor: middle; dominant-baseline: middle; font-variant-numeric: tabular-nums; }
  .meta { fill: var(--meta); font: 500 13px 'Hanken Grotesk', system-ui, sans-serif; }
  .title { fill: var(--ink); font: 500 22px 'Brygada 1918', Georgia, serif; }
  .rec { fill: var(--rec); animation: p 1.2s ease-in-out 5 alternate; }
  @keyframes w { to { stroke-dashoffset: 0; } }
  @keyframes f { to { opacity: 1; } }
  @keyframes p { to { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { path { animation: none; stroke-dashoffset: 0; } .stamp { animation: none; opacity: 1; } .rec { animation: none; } }
</style>
<rect class="paper" width="${W}" height="${H}" rx="6"/>
<g class="rules">${rules.join('')}</g>
<line class="margin" x1="${LEFT - 18}" x2="${LEFT - 18}" y1="0" y2="${H}"/>
<text class="title" x="${LEFT}" y="56">Acme discovery call</text>
<circle class="rec" cx="${LEFT + 6}" cy="80" r="4.5"/>
<text class="meta" x="${LEFT + 18}" y="84.5">Mon 10:00 · Dana Ross, Priya Shah · recorded 2:58</text>
${blocks.map(strokesSvg).join('')}
${stamps}
</svg>
`;
writeFileSync(join(root, 'docs', 'media', 'site-meeting.svg'), svg);
console.log(`wrote docs/media/site-meeting.svg (${(svg.length / 1024).toFixed(0)} kB)`);
