#!/usr/bin/env node
/**
 * The README showcase: real app captures framed into designed cards, light and dark.
 *
 *   SHOWCASE=/tmp/shots npm run e2e -w @inkwright/web -- e2e/showcase.spec.ts --workers=1   # captures
 *   npx tsx scripts/brand/showcase-mcp.ts /tmp/shots                                        # real MCP session
 *   node scripts/brand/showcase.mjs /tmp/shots                                              # this: compose
 *
 * Every pixel inside a device frame is a screenshot of the running app (apps/web/e2e/showcase.spec.ts),
 * and every line in the terminal panel is what the MCP server returned (mcp.json). This script only
 * adds the frames, the type and the background, rendered by Playwright from HTML, then palettes the
 * PNG (sharp/libimagequant) so each card stays light enough for a README.
 *
 * Output: docs/media/showcase/<card>-<light|dark>.png at 1760 px wide (2× GitHub's 880 px column).
 */
import { chromium } from 'playwright';
import sharp from 'sharp';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = process.argv[2];
if (!src) throw new Error('usage: node scripts/brand/showcase.mjs <captures-dir>');
const out = join(root, 'docs', 'media', 'showcase');
mkdirSync(out, { recursive: true });

// Inlined as data: URLs: a page set with setContent() has no origin to load file:// fonts from.
const font = (pkg, file) => `data:font/woff2;base64,${readFileSync(join(root, 'node_modules', '@fontsource-variable', pkg, 'files', file)).toString('base64')}`;
const FONTS = `
  @font-face{font-family:'Brygada';src:url(${font('brygada-1918', 'brygada-1918-latin-wght-normal.woff2')}) format('woff2');font-weight:400 700}
  @font-face{font-family:'Hanken';src:url(${font('hanken-grotesk', 'hanken-grotesk-latin-wght-normal.woff2')}) format('woff2');font-weight:100 900}
  @font-face{font-family:'Mono';src:url(${font('jetbrains-mono', 'jetbrains-mono-latin-wght-normal.woff2')}) format('woff2');font-weight:100 800}`;

/** Duan tokens (apps/web/src/styles/tokens.css), day and night. */
const THEME = {
  light: { desk: '#e8e5ea', desk2: '#dcd7df', ink: '#2b2330', ink2: '#5f5666', iron: '#356b53', eye: '#5e9c7e', seal: '#b3412f', bezel: '#1f1a22', bezelHi: '#3a3240', glow: 'rgba(94,156,126,0.20)', shadow: 'rgba(43,30,50,0.42)', window: '#f1eff3' },
  dark: { desk: '#1a161c', desk2: '#120f14', ink: '#eee8f0', ink2: '#b5abb9', iron: '#8cc4a8', eye: '#5e9c7e', seal: '#e07a66', bezel: '#0b090c', bezelHi: '#2c2530', glow: 'rgba(94,156,126,0.16)', shadow: 'rgba(0,0,0,0.6)', window: '#231e26' },
};

const img = (name, scheme) => {
  const p = join(src, `${name}-${scheme}.png`);
  return `data:image/png;base64,${readFileSync(p).toString('base64')}`;
};

/**
 * A screen inside a frame. `crop` is [x, y, w, h] in CSS px of the capture (captures are 2×), so a
 * device can show the part of the screen that matters; `width` is the frame's screen width here.
 */
function screen(shot, scheme, { width, crop, kind = 'fold', label }) {
  const [cx, cy, cw, ch] = crop;
  const k = width / cw;
  const full = kind === 'fold' ? [720, 800] : [1280, 800];
  const inner = `<div class="scr" style="width:${width}px;height:${Math.round(ch * k)}px">
    <img src="${img(shot, scheme)}" style="width:${full[0] * k}px;height:${full[1] * k}px;left:${-cx * k}px;top:${-cy * k}px">
</div>`;
  const cap = label ? `<div class="label"><b>${label[0]}</b>${label[1] ? ` ${label[1]}` : ''}</div>` : '';
  if (kind === 'fold') return `<figure class="dev fold">${inner}${cap}</figure>`;
  return `<figure class="dev win"><div class="bar"><i></i><i></i><i></i></div>${inner}${cap}</figure>`;
}

function css(t) {
  return `${FONTS}
  *{box-sizing:border-box}
  html,body{margin:0}
  body{width:1760px;font-family:'Hanken',system-ui,sans-serif;color:${t.ink};-webkit-font-smoothing:antialiased}
  .card{position:relative;overflow:hidden;width:1760px;background:
      radial-gradient(1100px 620px at 78% 18%, ${t.glow}, transparent 70%),
      radial-gradient(900px 600px at 8% 100%, ${t.glow}, transparent 70%),
      linear-gradient(180deg, ${t.desk}, ${t.desk2});border-radius:36px}
  .card::after{content:'';position:absolute;inset:0;border-radius:36px;box-shadow:inset 0 0 0 2px ${t.ink}14;pointer-events:none}
  .copy{position:absolute;left:96px;top:84px;width:1560px}
  .eyebrow{display:flex;align-items:center;gap:14px;font:600 26px/1 'Hanken';color:${t.iron};letter-spacing:.01em}
  .eyebrow .eye{width:16px;height:16px;border-radius:50%;background:radial-gradient(circle, ${t.ink} 0 34%, ${t.eye} 38% 100%)}
  h1{font:500 64px/1.06 'Brygada',Georgia,serif;letter-spacing:-.018em;margin:22px 0 0}
  h1 em{font-style:normal;color:${t.iron}}
  .sub{font:400 30px/1.42 'Hanken';color:${t.ink2};margin:20px 0 0;max-width:1240px}
  .dev{position:absolute;margin:0}
  .fold{background:linear-gradient(145deg, ${t.bezelHi}, ${t.bezel} 30%);padding:16px;border-radius:52px;
    box-shadow:0 0 0 2px ${t.bezel}, 0 2px 6px ${t.shadow}, 0 60px 110px -40px ${t.shadow}}
  .fold .scr{border-radius:38px}
  .win{background:${t.window};border-radius:22px;padding:0;overflow:hidden;
    box-shadow:0 0 0 2px ${t.ink}1a, 0 2px 6px ${t.shadow}, 0 60px 110px -40px ${t.shadow}}
  .win .bar{height:44px;display:flex;gap:12px;align-items:center;padding:0 22px;background:${t.window}}
  .win .bar i{width:14px;height:14px;border-radius:50%;background:${t.ink}2a}
  .scr{position:relative;overflow:hidden;background:#000}
  .scr img{position:absolute;max-width:none}
  .crease{position:absolute;left:50%;top:0;bottom:0;width:22px;margin-left:-11px;pointer-events:none;
    background:linear-gradient(90deg, transparent, rgba(0,0,0,.035) 45%, rgba(255,255,255,.05) 55%, transparent)}
  .label{position:absolute;left:0;right:0;bottom:-58px;text-align:center;font:500 24px/1 'Hanken';color:${t.ink2}}
  .label b{font-weight:600;color:${t.ink}}
  .step{position:absolute;display:flex;align-items:center;gap:16px;font:500 27px/1.2 'Hanken';color:${t.ink}}
  .step .n{flex:none;width:44px;height:44px;border-radius:50%;display:grid;place-items:center;font:600 22px/1 'Hanken';background:${t.ink};color:${t.desk}}
  .step small{display:block;font-size:21px;color:${t.ink2};margin-top:4px}
  .term{position:absolute;background:#141016;border-radius:22px;overflow:hidden;color:#e9e3ec;
    box-shadow:0 0 0 2px #ffffff12, 0 2px 6px ${t.shadow}, 0 60px 110px -40px ${t.shadow}}
  .term .bar{height:46px;display:flex;align-items:center;gap:12px;padding:0 22px;background:#1d1820;font:500 19px/1 'Hanken';color:#9d93a3}
  .term .bar i{width:14px;height:14px;border-radius:50%;background:#ffffff22}
  .term .bar span{margin-left:12px}
  .term pre{margin:0;padding:22px 28px 28px;font:400 19px/1.62 'Mono',ui-monospace,monospace}
  .term pre div{white-space:pre;overflow:hidden;text-overflow:ellipsis;min-height:1.62em}
  .c-dim{color:#8d8492}.c-ok{color:#8cc4a8}.c-key{color:#e0b77a}.c-str{color:#b9d6ff}.c-hi{color:#fff;background:#8cc4a833;border-radius:4px}.c-ai{color:#9fc1e6}.c-cmd{color:#fff}`;
}

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The terminal panel from the recorded MCP session: the command a person runs, then each tool call
 * and a faithful excerpt of what came back (fields picked from the JSON, lines from the Markdown).
 */
function terminal(mcp) {
  const [search, read] = mcp.calls;
  const hits = JSON.parse(search.result);
  const h = hits.hits[0];
  const snippet = esc(h.snippet).replace(/«([^»]+)»/g, '<span class="c-hi">$1</span>');
  const md = read.result.split('\n{')[0];
  const body = md.split('## Page 1')[1].split('![')[0].trim().split('\n');
  const meta = JSON.parse(read.result.slice(read.result.indexOf('\n{') + 1));
  const page = meta.pageDetails[0];
  const call = (tool, args) => `<span class="c-ok">●</span> <span class="c-cmd">inkwright</span><span class="c-dim"> · </span><span class="c-key">${tool}</span> <span class="c-dim">${esc(JSON.stringify(args))}</span>`;
  const shortId = (id) => `${id.slice(0, 6)}…${id.slice(-3)}`;
  return [
    `<span class="c-dim"># claude mcp add inkwright -- inkwright-mcp --vault ~/Notes --read-only</span>`,
    `<span class="c-ok">✓</span> ${esc(mcp.server.title ?? mcp.server.name)} ${esc(mcp.server.version ?? '')} <span class="c-dim">· ${mcp.tools.length} read-only tools</span>`,
    '',
    call('search_notes', search.args),
    `<span class="c-dim">  ⎿ </span>${hits.count} note · <span class="c-str">${esc(h.title)}</span> <span class="c-dim">· ${esc(h.notebook)} · page ${h.page}</span>`,
    `<span class="c-dim">    </span>${snippet}`,
    '',
    call('read_note', { id: shortId(read.args.id) }),
    `<span class="c-dim">  ⎿ </span><span class="c-str"># ${esc(meta.title)}</span>`,
    ...body.slice(1, 5).map((l) => `<span class="c-dim">    </span>${esc(l)}`),
    `<span class="c-dim">    … ${body.length - 5} more lines</span>`,
    `<span class="c-dim">    ${page.strokes} strokes · handwriting ${page.handwritingRecognized ? "recognized" : "not recognized yet"}</span>`,
  ].map((l) => `<div>${l}</div>`).join('');
}

/** Cards: copy, then absolutely placed frames. Sizes are in the 1760 px canvas. */
function cards(scheme, mcp) {
  const s = (shot, o) => screen(shot, scheme, o);
  const at = (html, left, top) => html.replace('class="dev', `style="left:${left}px;top:${top}px" class="dev`);
  const copy = (eyebrow, h1, sub) => `<div class="copy"><div class="eyebrow"><span class="eye"></span>${eyebrow}</div><h1>${h1}</h1><p class="sub">${sub}</p></div>`;
  // Two foldables side by side, rising out of the bottom edge of the card.
  const F = [0, 0, 720, 800];
  const pair = (a, b, top = 420) => at(s(a, { width: 740, crop: F }), 96, top) + at(s(b, { width: 740, crop: F }), 892, top);
  return {
    hero: {
      height: 1180,
      html: `
        <div class="copy" style="top:70px"><h1 style="font-size:60px">Written by hand. <em>Answered in ink.</em> Read by your agents.</h1>
        <p class="sub" style="font-size:28px">One note, three places: a question written on a foldable, the answer written back on the page in the AI&rsquo;s own ink, and the same page read by an agent over MCP.</p></div>
        ${at(s('hero-laptop', { width: 1040, crop: [0, 0, 1280, 800], kind: 'window' }), 650, 290)}
        ${at(s('hero-fold', { width: 600, crop: [0, 0, 720, 800] }), 72, 310)}
        <div class="term" style="left:800px;top:640px;width:900px"><div class="bar"><i></i><i></i><i></i><span>A real MCP session: inkwright-mcp over stdio, on the same note</span></div><pre>${terminal(mcp)}</pre></div>`,
    },
    students: {
      height: 1180,
      html: copy('For students', 'Your lecture notes, <em>solved and studied.</em>', 'Lasso a handwritten equation and it is solved exactly, step by step, on the device. Definitions you wrote become flashcards, scheduled with FSRS and linked to your page.')
        + pair('solve-steps-fold', 'study-a-fold'),
    },
    professionals: {
      height: 1180,
      html: copy('For professionals', 'Meeting notes that <em>answer back.</em>', 'Ask about what you wrote by hand and the answer cites the page it came from, or is written beside your question in the AI&rsquo;s own ink. Open any PDF, fill it in, sign it with your pen.')
        + pair('actions-fold', 'sign-fold'),
    },
    engineers: {
      height: 1180,
      html: copy('For engineers', 'Sketches that <em>run.</em> Notes that know your code.', 'Draw boxes and arrows and press Run: fetch, filter, sort, then an AI step. Link a note to a function and it is flagged when the signature changes. Agents read it all over MCP.')
        + at(s('pipeline-laptop', { width: 900, crop: [240, 50, 700, 560], kind: 'window' }), 96, 420)
        + at(s('drift-fold', { width: 640, crop: F }), 1024, 410),
    },
    researchers: {
      height: 1180,
      html: copy('For researchers', 'Every sentence knows <em>where it came from.</em>', 'Notes compile into a wiki where each claim is tagged extracted, inferred or ambiguous and cites its source. A linter flags notes that contradict each other.')
        + pair('wiki-fold', 'conflict-fold'),
    },
    enterprise: {
      height: 1180,
      html: copy('For security and IT', 'Rules per notebook. <em>A signed audit trail.</em>', 'Keep a notebook on the device, make one read-only, hide one from every model and agent. Personal data is redacted before it leaves, and the record of every AI call verifies offline.')
        + pair('policy-fold', 'audit-fold'),
    },
  };
}

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });
const mcp = JSON.parse(readFileSync(join(src, 'mcp.json'), 'utf8'));
const only = process.argv[3];
for (const scheme of ['light', 'dark']) {
  if (!existsSync(join(src, `hero-fold-${scheme}.png`))) { console.log(`no ${scheme} captures, skipped`); continue; }
  const t = THEME[scheme];
  for (const [name, card] of Object.entries(cards(scheme, mcp))) {
    if (only && name !== only) continue;
    await page.setViewportSize({ width: 1760, height: card.height });
    await page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>${css(t)}</style></head><body><div class="card" style="height:${card.height}px">${card.html}</div></body></html>`);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(150);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: 1760, height: card.height } });
    const file = join(out, `${name}-${scheme}.png`);
    // 256-colour palette with dithering: screenshots of flat UI survive it well and shrink ~4×.
    await sharp(png).png({ palette: true, quality: 90, effort: 10, compressionLevel: 9 }).toFile(file);
    console.log(`${file.replace(root + '/', '')}  ${Math.round(statSync(file).size / 1024)} KB`);
  }
}
await browser.close();
