#!/usr/bin/env node
/**
 * Google Play listing graphics from the raw app screenshots (docs/store/screenshots, made by
 * apps/web/e2e/store.spec.ts): framed phone/tablet screenshots with a one-line caption, and the
 * 1024×500 feature graphic. Output: fastlane/metadata/android/en-US/images/.
 *
 *   node scripts/brand/store-frames.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
// Raw captures (git-ignored) in, Play-ready listing images out — straight into the fastlane
// metadata folder, so `fastlane supply` (or a manual upload) uses exactly these files.
const src = join(root, 'docs', 'store', 'screenshots');
const out = join(root, 'fastlane', 'metadata', 'android', 'en-US', 'images');
const DIRS = { phone: 'phoneScreenshots', 'tablet-7': 'sevenInchScreenshots', 'tablet-10': 'tenInchScreenshots' };
const media = join(root, 'docs', 'media');

const CAPTIONS = {
  '01-library': ['Your notebooks,', 'beautifully kept'],
  '02-ai-answers-in-ink': ['Ask on the page.', 'The AI answers in ink.'],
  '03-lecture': ['Feels like paper.', 'Thinks like you do.'],
  '04-design-review': ['Ink, text and diagrams', 'on one page'],
  '05-library-night': ['Calm by day,', 'calmer by night'],
  '06-search-handwriting': ['Search your', 'handwriting'],
};
const SIZES = { phone: [1080, 1920], 'tablet-7': [1200, 1920], 'tablet-10': [2560, 1600] };

const dataUrl = (p) => `data:image/${p.endsWith('.svg') ? 'svg+xml' : 'png'};base64,${readFileSync(p).toString('base64')}`;
const FONTS = `<link href="https://fonts.googleapis.com/css2?family=Brygada+1918:wght@500&family=Hanken+Grotesk:wght@500;600&display=swap" rel="stylesheet">`;

function framed(shot, [w, h], [l1, l2]) {
  const landscape = w > h;
  const cap = landscape ? 64 : Math.round(w * 0.075);
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
    html,body{margin:0;width:${w}px;height:${h}px;overflow:hidden}
    body{background:#e8e5ea;display:flex;flex-direction:${landscape ? 'row' : 'column'};align-items:center;justify-content:center;gap:${landscape ? 80 : Math.round(h * 0.035)}px;font-family:'Hanken Grotesk',sans-serif;color:#2b2330}
    .cap{font:500 ${cap}px/1.12 'Brygada 1918',Georgia,serif;text-align:${landscape ? 'left' : 'center'};letter-spacing:-0.01em;${landscape ? 'width:620px' : `padding:0 ${Math.round(w * 0.07)}px`}}
    .cap em{font-style:normal;color:#356b53}
    .eye{display:block;width:${Math.round(cap * 0.32)}px;height:${Math.round(cap * 0.32)}px;border-radius:50%;background:radial-gradient(circle,#2b2330 0 34%,#5e9c7e 36% 100%);margin:${landscape ? '0 0 28px' : '0 auto 22px'}}
    .frame{background:#1f1a22;padding:${landscape ? 18 : Math.round(w * 0.022)}px;border-radius:${landscape ? 36 : Math.round(w * 0.06)}px;box-shadow:0 2px 4px rgba(43,30,50,.12),0 40px 80px -40px rgba(43,30,50,.55)}
    .frame img{display:block;border-radius:${landscape ? 20 : Math.round(w * 0.04)}px;${landscape ? 'height:1280px' : `width:${Math.round(w * 0.78)}px`}}
  </style></head><body>
    <div class="cap"><span class="eye"></span>${l1}<br><em>${l2}</em></div>
    <div class="frame"><img src="${dataUrl(shot)}"></div>
  </body></html>`;
}

function feature() {
  return `<!doctype html><html><head><meta charset="utf-8">${FONTS}<style>
    html,body{margin:0;width:1024px;height:500px;overflow:hidden}
    body{background:#e8e5ea;display:grid;grid-template-columns:470px 1fr;align-items:center;font-family:'Hanken Grotesk',sans-serif;color:#2b2330}
    .l{padding-left:56px}.l img{width:400px;display:block;margin-left:-22px}
    h1{font:500 27px/1.25 'Brygada 1918',Georgia,serif;margin:10px 0 0}
    .r{position:relative;height:500px}
    .sheet{position:absolute;top:56px;left:20px;width:560px;background:#fffdf7;padding:10px;border-radius:4px;transform:rotate(1.5deg);box-shadow:0 30px 60px -30px rgba(43,30,50,.5)}
    .sheet img{width:100%;display:block}
  </style></head><body>
    <div class="l"><img src="${dataUrl(join(media, 'hero-static-light.svg'))}"><h1>Handwriting that feels like paper.<br>An agent that answers in ink.</h1></div>
    <div class="r"><div class="sheet"><img src="${dataUrl(join(media, 'screens', 'ask.png'))}"></div></div>
  </body></html>`;
}

const browser = await chromium.launch();
const page = await browser.newPage();
async function render(html, w, h, file) {
  await page.setViewportSize({ width: w, height: h });
  await page.setContent(html, { waitUntil: 'networkidle' }).catch(() => {});
  await page.evaluate(() => document.fonts.ready);
  // JPEG at high quality: Play accepts it and it keeps the repository light.
  await page.screenshot({ path: file, type: 'jpeg', quality: 90 });
}
for (const [dev, size] of Object.entries(SIZES)) {
  mkdirSync(join(out, DIRS[dev]), { recursive: true });
  for (const f of readdirSync(join(src, dev)).filter((x) => x.endsWith('.png')).sort()) {
    const key = f.replace('.png', '');
    await render(framed(join(src, dev, f), size, CAPTIONS[key] ?? [key, '']), size[0], size[1], join(out, DIRS[dev], f.replace('.png', '.jpg')));
  }
}
await render(feature(), 1024, 500, join(out, 'featureGraphic.jpg'));
await browser.close();
console.log(`wrote listing graphics to ${out}`);
