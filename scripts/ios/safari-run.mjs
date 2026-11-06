#!/usr/bin/env node
// Runs the web app in Safari on the newest iPhone and iPad simulators, the way people on iPhone and
// iPad use it without the native app. Serves two production builds of the web app (dist-a, then
// dist-b as "the next deployment"), adds scripts/ios/safari-test.js to the page, opens it in Safari
// and records what the walk reports: writing a note and keeping it across a reload, the offline
// app, the on-device AI (download the model, ask, get an answer; iPhone only, it takes a while on
// CI) and the update banner from one deployment to the next. Screenshots of each step and
// report.json go to <out>. Fails when a step fails or the walk doesn't finish.
//
//   node scripts/ios/safari-run.mjs <dist-a> <dist-b> <out-dir> [--no-ai]
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [distA, distB, outArg = 'safari-out'] = args;
const withAI = !process.argv.includes('--no-ai');
if (!distA || !distB) { console.error('usage: safari-run.mjs <dist-a> <dist-b> <out-dir> [--no-ai]'); process.exit(2); }
const out = resolve(outArg);
mkdirSync(out, { recursive: true });
const PORT = 4310;
const simctl = (a, o = {}) => execFileSync('xcrun', ['simctl', ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...o });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const testScript = readFileSync(new URL('./safari-test.js', import.meta.url), 'utf8');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.onnx': 'application/octet-stream', '.txt': 'text/plain' };

// ---- The test server: the app as static files, plus the walk's reporting endpoints ----
let assets = resolve(distA);
let manifestFrom = resolve(distA);
let current = null; // { label, udid, steps, logs, done }
const server = createServer((req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const body = () => new Promise((r) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => r(b)); });
  const ok = (text = 'ok') => { res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end(text); };
  if (req.method === 'POST' && url.pathname.startsWith('/__')) {
    void body().then((b) => {
      if (!current) return ok();
      if (url.pathname === '/__log') { current.logs.push(b); console.log(`[${current.label}] ${b}`); }
      if (url.pathname === '/__step') { const s = JSON.parse(b); current.steps.push(s); console.log(`[${current.label}] ${s.ok ? 'PASS' : 'FAIL'} ${s.name}${s.detail ? ` (${s.detail})` : ''}`); }
      if (url.pathname === '/__snap' && current.udid) { try { simctl(['io', current.udid, 'screenshot', join(out, `${current.label}-${current.snaps++}-${url.searchParams.get('name')}.png`)]); } catch (e) { console.log(`screenshot failed: ${e.message}`); } }
      if (url.pathname === '/__switch') {
        if (url.searchParams.get('what') === 'all') assets = resolve(distB);
        manifestFrom = resolve(distB);
        console.log(`[${current.label}] now serving ${url.searchParams.get('what') === 'all' ? 'deployment B' : 'version.json of deployment B'}`);
      }
      if (url.pathname === '/__done') current.done = true;
      ok();
    });
    return;
  }
  if (url.pathname === '/__safari-test.js') { res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' }); res.end(testScript); return; }
  let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '') || 'index.html';
  if (rel.endsWith('/')) rel += 'index.html';
  const root = rel === 'version.json' ? manifestFrom : assets;
  const file = normalize(join(root, rel));
  if (!file.startsWith(root) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
  let data = readFileSync(file);
  if (rel === 'index.html') data = Buffer.from(data.toString('utf8').replace('</head>', '<script src="./__safari-test.js"></script></head>'));
  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream', 'cache-control': rel === 'index.html' || rel === 'sw.js' || rel === 'version.json' ? 'no-cache' : 'max-age=3600' });
  res.end(data);
});
await new Promise((r) => server.listen(PORT, r));

// --serve-only: no simulator; open http://localhost:4310/ in any browser (local debugging).
if (process.argv.includes('--serve-only')) {
  current = { label: 'local', udid: null, steps: [], logs: [], done: false, snaps: 1 };
  console.log(`Serving on http://localhost:${PORT}/`);
  while (!current.done) await sleep(1000);
  writeFileSync(join(out, 'report.json'), JSON.stringify(current, null, 2));
  server.close();
  process.exit(current.steps.every((x) => x.ok) ? 0 : 1);
}

// ---- Simulators ----
const list = JSON.parse(simctl(['list', '-j', 'runtimes', 'devicetypes']));
const runtime = list.runtimes.filter((r) => r.isAvailable && r.platform === 'iOS').sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
if (!runtime) throw new Error('No iOS simulator runtime is installed');
const supported = new Set((runtime.supportedDeviceTypes ?? []).map((t) => t.identifier));
const types = list.devicetypes.filter((t) => supported.size === 0 || supported.has(t.identifier));
const pick = (re) => types.filter((t) => re.test(t.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))[0];
const targets = [
  { label: 'iphone', type: pick(/^iPhone \d+ Pro$/) ?? pick(/^iPhone/), ai: withAI, minutes: withAI ? 75 : 20 },
  { label: 'ipad', type: pick(/^iPad Pro .*13/) ?? pick(/^iPad Pro/) ?? pick(/^iPad/), ai: false, minutes: 25 },
];
const REQUIRED = ['Add to Home Screen suggested', 'wrote a note', 'note kept after reload', 'offline app installed', 'update offered', 'updated to the new version'];

const report = { runtime: runtime.name, devices: [] };
let failed = false;
for (const t of targets) {
  if (!t.type) { failed = true; continue; }
  assets = resolve(distA);
  manifestFrom = resolve(distA);
  const udid = simctl(['create', `Inkwright Safari ${t.label}`, t.type.identifier, runtime.identifier]).trim();
  current = { label: t.label, udid, steps: [], logs: [], done: false, snaps: 1 };
  const entry = { label: t.label, device: t.type.name, ai: t.ai };
  try {
    simctl(['boot', udid]);
    simctl(['bootstatus', udid, '-b'], { timeout: 1_200_000 });
    await sleep(10_000);
    // A busy simulator can time out opening Safari the first time; try again before giving up.
    for (let i = 1; ; i++) {
      try { simctl(['openurl', udid, `http://localhost:${PORT}/${t.ai ? '?ai=1' : ''}`], { timeout: 180_000 }); break; } catch (e) {
        if (i === 3) throw e;
        console.log(`[${t.label}] opening Safari failed (try ${i}), retrying`);
        await sleep(20_000);
      }
    }
    const deadline = Date.now() + t.minutes * 60_000;
    while (Date.now() < deadline && !current.done) await sleep(3000);
    simctl(['io', udid, 'screenshot', join(out, `${t.label}-end.png`)]);
    entry.finished = current.done;
  } catch (e) {
    entry.error = String(e?.stderr || e?.message || e);
  } finally {
    try { simctl(['shutdown', udid]); } catch { /* down */ }
  }
  entry.steps = current.steps;
  entry.logs = current.logs;
  const need = [...REQUIRED, ...(t.ai ? ['on-device AI answered'] : [])];
  entry.missing = need.filter((n) => !current.steps.some((s) => s.name === n && s.ok));
  if (!entry.finished || entry.missing.length || entry.error) failed = true;
  report.devices.push(entry);
  console.log(`${t.type.name}: ${entry.finished ? 'walk finished' : 'walk did NOT finish'}${entry.missing.length ? `, failed: ${entry.missing.join(', ')}` : ', every step passed'}`);
}
server.close();
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
if (failed) { console.error('Safari on iPhone/iPad did not pass every step (see report.json)'); process.exit(1); }
