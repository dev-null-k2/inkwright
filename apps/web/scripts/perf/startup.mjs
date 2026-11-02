#!/usr/bin/env node
/**
 * Cold-start measurements of a production build in Chromium, and the startup performance budget.
 *
 *   node scripts/perf/startup.mjs [distDir] [--runs 5] [--profile cpu4|mid-tier|both] [--json out.json]
 *   node scripts/perf/startup.mjs dist --budget perf/budget.json     # exits 1 on a regression
 *   node scripts/perf/startup.mjs dist --runs 1 --trace              # long tasks and JS fetches per run
 *   node scripts/perf/startup.mjs dist --against ../base/dist        # before/after, builds alternated run by run
 *
 * Every run is a cold start: a fresh browser context (empty HTTP cache, storage and service
 * worker), the app served from `distDir` by a small static server that compresses like a real host
 * (gzip; Vite's preview server does not compress). Profiles (Chrome DevTools Protocol):
 *
 * - `cpu4`:     4× CPU slowdown, unthrottled network: what the code costs on a mid-range phone.
 * - `mid-tier`: 4× CPU plus Lighthouse's mobile network (150 ms RTT, 1.6 Mbps down, 750 kbps up):
 *               the whole first visit on a mid-tier phone over a mediocre connection.
 *
 * Metrics (medians over the runs):
 * - FCP and LCP from the paint timeline;
 * - library visible: the first frame with a note card in the library;
 * - library interactive: from then, the end of the first 300 ms window without a long task, i.e.
 *   from when a tap is handled within 50 ms;
 * - long tasks and total blocking time (sum of each long task's time over 50 ms) until interactive;
 * - JS: bytes over the wire before interactive;
 * - note open: from tapping the welcome note to the editor's first painted frame (the editor is a
 *   separate chunk, fetched while the library is idle).
 *
 * The budget file (perf/budget.json) caps initial JS/CSS gzip (from bundle-report.mjs) and the
 * `cpu4` medians. See docs/PERFORMANCE.md.
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { report as bundleReport } from './bundle-report.mjs';

// Same browsers as the e2e suite (playwright.config.ts) where that shared install exists.
if (!process.env.PLAYWRIGHT_BROWSERS_PATH && existsSync('/opt/pw-browsers')) process.env.PLAYWRIGHT_BROWSERS_PATH = '/opt/pw-browsers';
const { chromium } = await import('@playwright/test');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.woff2': 'font/woff2', '.wasm': 'application/wasm', '.map': 'application/json',
};
const COMPRESS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.webmanifest', '.svg', '.wasm', '.map']);

export const PROFILES = {
  cpu4: { cpu: 4, network: null },
  'mid-tier': { cpu: 4, network: { latency: 150, downloadThroughput: (1.6e6 / 8) * 0.9, uploadThroughput: (750e3 / 8) * 0.9 } },
};

/** Serves a build directory with gzip and long-lived caching for hashed assets, like a CDN. */
function serve(dist) {
  const cache = new Map();
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');
    let path = normalize(join(dist, decodeURIComponent(url.pathname)));
    if (!path.startsWith(dist)) { res.writeHead(403).end(); return; }
    if (!existsSync(path) || statSync(path).isDirectory()) path = join(dist, 'index.html');
    const ext = extname(path);
    const gz = COMPRESS.has(ext) && /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''));
    const key = `${path}:${gz}`;
    if (!cache.has(key)) {
      const raw = readFileSync(path);
      cache.set(key, gz ? gzipSync(raw, { level: 6 }) : raw);
    }
    const body = cache.get(key);
    res.writeHead(200, {
      'content-type': TYPES[ext] ?? 'application/octet-stream',
      'content-length': body.length,
      ...(gz ? { 'content-encoding': 'gzip' } : {}),
      'cache-control': path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    res.end(body);
  });
  return new Promise((ok) => server.listen(0, '127.0.0.1', () => ok({ server, origin: `http://localhost:${server.address().port}` })));
}

/** Installed before the app's own scripts: records paints, long tasks and the library's first frame. */
function instrument() {
  const w = window;
  w.__perf = { longTasks: [], lcp: 0, fcp: 0, libraryVisible: 0 };
  new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.longTasks.push([e.startTime, e.startTime + e.duration]); }).observe({ type: 'longtask', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) w.__perf.lcp = e.startTime; }).observe({ type: 'largest-contentful-paint', buffered: true });
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'first-contentful-paint') w.__perf.fcp = e.startTime; }).observe({ type: 'paint', buffered: true });
  const seen = () => {
    if (w.__perf.libraryVisible || !document.querySelector('.library .note-card')) return false;
    requestAnimationFrame((t) => { w.__perf.libraryVisible = t; });
    return true;
  };
  new MutationObserver((_, obs) => { if (seen()) obs.disconnect(); }).observe(document, { childList: true, subtree: true });
}

/** First moment after `from` with `quiet` ms free of long tasks. */
export function interactiveAt(from, longTasks, quiet = 300) {
  let t = from;
  for (const [s, e] of [...longTasks].sort((a, b) => a[0] - b[0])) {
    if (e <= t) continue;
    if (s >= t + quiet) break;
    t = e;
  }
  return t;
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : NaN; };

/** A fresh (cold) context and page with the profile's CPU and network throttling applied. */
async function coldPage(browser, profile) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: profile.cpu });
  if (profile.network) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', { offline: false, ...profile.network });
  }
  await page.addInitScript(instrument);
  return { context, page };
}

const libraryVisible = (page) => page.waitForFunction(() => window.__perf.libraryVisible > 0, null, { timeout: 120_000, polling: 50 });

/** Taps the first note and returns the time until the editor's first frame with its canvas. */
async function openNote(page) {
  const t0 = await page.evaluate(() => performance.now());
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!document.querySelector('.ed-canvas canvas'), null, { timeout: 60_000, polling: 'raf' });
  return (await page.evaluate(() => new Promise((ok) => requestAnimationFrame((t) => ok(t))))) - t0;
}

async function measureOnce(browser, origin, profile, trace = false) {
  const { context, page } = await coldPage(browser, profile);
  await page.goto(origin + '/', { waitUntil: 'commit' });
  await libraryVisible(page);
  // Let background work run, so "interactive" and blocking time see what follows the first frame.
  await page.waitForTimeout(4500);
  const r = await page.evaluate(() => {
    const p = window.__perf;
    const js = performance.getEntriesByType('resource').filter((e) => /\.m?js(\?|$)/.test(e.name));
    return { ...p, js: js.map((e) => ({ name: e.name, start: e.startTime, end: e.responseEnd, bytes: e.transferSize || e.encodedBodySize })) };
  });
  const interactive = interactiveAt(r.libraryVisible, r.longTasks);
  const before = r.longTasks.filter(([s]) => s < interactive);
  const blocking = (tasks) => tasks.reduce((n, [s, e]) => n + Math.max(0, e - s - 50), 0);
  const result = {
    fcp: r.fcp,
    lcp: r.lcp,
    libraryVisible: r.libraryVisible,
    libraryInteractive: interactive,
    longTasks: before.length,
    totalBlockingTime: blocking(before),
    // Everything until 4.5 s after the library appeared, background work included: nothing hides.
    blockingTime5s: blocking(r.longTasks.filter(([s]) => s >= r.fcp)),
    jsBytesBeforeInteractive: r.js.filter((e) => e.start < interactive).reduce((n, e) => n + e.bytes, 0),
  };
  if (trace) {
    const ms = (n) => `${n.toFixed(0).padStart(6)} ms`;
    console.log(`    library visible at ${ms(r.libraryVisible)}, interactive at ${ms(interactive)}`);
    for (const [s, e] of r.longTasks) console.log(`    long task ${ms(s)} – ${ms(e)} (${(e - s).toFixed(0)} ms)`);
    for (const j of r.js) console.log(`    js ${ms(j.start)} – ${ms(j.end)} ${(j.bytes / 1000).toFixed(1).padStart(7)} kB ${j.name.split('/').pop()}`);
  }
  // Opening a note once the app has settled (the editor chunk preloaded at idle).
  result.noteOpen = await openNote(page);
  await context.close();
  // And a tap the moment the library appears, before any preloading: the editor loads on demand.
  const early = await coldPage(browser, profile);
  await early.page.goto(origin + '/', { waitUntil: 'commit' });
  await libraryVisible(early.page);
  result.noteOpenEarly = await openNote(early.page);
  await early.context.close();
  return result;
}

/** Runs `runs` cold starts per profile and returns the medians (and every run). */
export async function measure(dist, { runs = 5, profiles = ['cpu4', 'mid-tier'], log = console.log, trace = false } = {}) {
  const { server, origin } = await serve(resolve(dist));
  const browser = await chromium.launch();
  const out = {};
  try {
    for (const name of profiles) {
      const all = [];
      // One unmeasured warm-up: the first browser start pays for disk caches of its own.
      await measureOnce(browser, origin, PROFILES[name]);
      for (let i = 0; i < runs; i++) {
        const r = await measureOnce(browser, origin, PROFILES[name], trace);
        all.push(r);
        log(`  ${name} run ${i + 1}: library interactive ${r.libraryInteractive.toFixed(0)} ms, LCP ${r.lcp.toFixed(0)} ms, note open ${r.noteOpen.toFixed(0)} ms (early tap ${r.noteOpenEarly.toFixed(0)} ms)`);
      }
      const keys = Object.keys(all[0]);
      out[name] = { median: Object.fromEntries(keys.map((k) => [k, Math.round(median(all.map((r) => r[k])))])), runs: all };
    }
  } finally {
    await browser.close();
    server.close();
  }
  return out;
}

/**
 * Before/after: alternates two builds run by run (one cold start of each per round), so a machine
 * whose load changes over minutes affects both alike. Returns the medians per build.
 */
export async function compare(builds, { runs = 5, profile = 'cpu4', log = console.log } = {}) {
  const all = Object.fromEntries(Object.keys(builds).map((name) => [name, []]));
  for (let i = 0; i < runs; i++) {
    for (const [name, dist] of Object.entries(builds)) {
      const r = (await measure(dist, { runs: 1, profiles: [profile], log: () => {} }))[profile].runs[0];
      all[name].push(r);
      log(`  ${profile} round ${i + 1}, ${name}: library interactive ${r.libraryInteractive.toFixed(0)} ms, LCP ${r.lcp.toFixed(0)} ms, note open ${r.noteOpen.toFixed(0)} ms (early tap ${r.noteOpenEarly.toFixed(0)} ms)`);
    }
  }
  return Object.fromEntries(Object.entries(all).map(([name, rs]) => [name, Object.fromEntries(Object.keys(rs[0]).map((k) => [k, Math.round(median(rs.map((r) => r[k])))]))]));
}

function main() {
  const args = process.argv.slice(2);
  const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
  const valueFlags = ['--runs', '--profile', '--json', '--budget', '--against'];
  const dist = args.find((a, i) => !a.startsWith('--') && !valueFlags.includes(args[i - 1])) ?? 'dist';
  const runs = Number(opt('--runs') ?? 5);
  const profile = opt('--profile') ?? (opt('--budget') ? 'cpu4' : 'both');
  const profiles = profile === 'both' ? ['cpu4', 'mid-tier'] : [profile];
  const against = opt('--against');
  if (against) {
    return (async () => {
      const medians = {};
      for (const p of profiles) {
        medians[p] = await compare({ before: against, after: dist }, { runs, profile: p });
        console.log(`\n${p} medians (ms; bytes), ${against} → ${dist}:`);
        console.table(medians[p]);
      }
      const json = opt('--json');
      if (json) writeFileSync(json, JSON.stringify({ before: against, after: dist, medians, at: new Date().toISOString() }, null, 2));
      return 0;
    })();
  }
  return (async () => {
    const bundle = bundleReport(dist);
    const initial = { jsGzip: bundle.totals['initial-js']?.gzip ?? 0, cssGzip: bundle.totals['initial-css']?.gzip ?? 0, jsFiles: bundle.initial.js.length };
    console.log(`Startup of ${dist}: initial JS ${(initial.jsGzip / 1000).toFixed(1)} kB gzip in ${initial.jsFiles} files, CSS ${(initial.cssGzip / 1000).toFixed(1)} kB gzip`);
    const results = await measure(dist, { runs, profiles, trace: args.includes('--trace') });
    console.log('\nMedians (ms; bytes):');
    console.table(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.median])));
    const json = opt('--json');
    if (json) writeFileSync(json, JSON.stringify({ dist, initial, results, at: new Date().toISOString() }, null, 2));
    const budgetPath = opt('--budget');
    if (!budgetPath) return 0;
    const budget = JSON.parse(readFileSync(budgetPath, 'utf8'));
    // CI runners are not phones: PERF_BUDGET_SLACK (e.g. 1.5) widens the time budgets, never the bytes.
    const slack = Number(process.env.PERF_BUDGET_SLACK ?? 1);
    const checks = [
      ['initial JS (gzip, bytes)', initial.jsGzip, budget.initialJsGzipBytes],
      ['initial CSS (gzip, bytes)', initial.cssGzip, budget.initialCssGzipBytes],
      ...Object.entries(budget.cpu4 ?? {}).map(([k, max]) => [`cpu4 ${k} (ms)`, results.cpu4?.median[k], max * slack]),
    ];
    let failed = 0;
    console.log('\nBudget:');
    for (const [label, value, max] of checks) {
      if (max == null || value == null) continue;
      const ok = value <= max;
      if (!ok) failed++;
      console.log(`  ${ok ? 'ok  ' : 'OVER'} ${label}: ${Math.round(value)} / ${Math.round(max)}`);
    }
    if (failed) console.error(`\n${failed} budget(s) exceeded. If the increase is deliberate, raise perf/budget.json in the same change and say why.`);
    return failed ? 1 : 0;
  })();
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = await main();
