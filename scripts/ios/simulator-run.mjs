#!/usr/bin/env node
// Runs the simulator build of the iOS app on a new iPhone and a new iPad simulator. For each, it
// fills the app's Documents folder with a vault of real handwritten notes (seed-vault.ts), then in
// light and in dark mode launches the app with a walk through it (tour.js: welcome, library, a
// lecture, a pen stroke on it, the assistant, a meeting, settings) and keeps the pictures the app
// saves at each step, a full-screen screenshot (status bar and safe areas) and the app's log. Fails
// when the app does not start, crashes, doesn't finish the walk, or the stroke isn't saved to disk.
// After each walk it also opens an inkwright://new link, as Shortcuts or another app would, and
// checks the note it asks for was created.
//
//   node scripts/ios/simulator-run.mjs <path/to/App.app> <out-dir>
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [appPath, outArg = 'ios-out'] = process.argv.slice(2);
// Absolute: the simulator service resolves the console file paths, not this process.
const out = resolve(outArg);
if (!appPath) { console.error('usage: simulator-run.mjs <App.app> <out-dir>'); process.exit(2); }
mkdirSync(out, { recursive: true });
const BUNDLE = 'app.inkwright';
const simctl = (args, opts = {}) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The notes the tour opens.
const vault = mkdtempSync(join(tmpdir(), 'inkwright-vault-'));
const ids = JSON.parse(execFileSync('npx', ['tsx', 'scripts/ios/seed-vault.ts', vault], { encoding: 'utf8' }).trim().split('\n').pop());
const tourSource = readFileSync(new URL('./tour.js', import.meta.url), 'utf8');
const strokesOf = (dir, id) => JSON.parse(execFileSync('npx', ['tsx', 'scripts/ios/seed-vault.ts', '--strokes', dir, id], { encoding: 'utf8' }).trim().split('\n').pop()).strokes;
const titlesOf = (dir) => JSON.parse(execFileSync('npx', ['tsx', 'scripts/ios/seed-vault.ts', '--titles', dir], { encoding: 'utf8' }).trim().split('\n').pop());
const tourFor = (prefix) => Buffer.from(tourSource.replaceAll('__IDS__', JSON.stringify(ids)).replaceAll('__PREFIX__', JSON.stringify(prefix))).toString('base64');

const list = JSON.parse(simctl(['list', '-j', 'runtimes', 'devicetypes']));
const runtime = list.runtimes.filter((r) => r.isAvailable && r.platform === 'iOS').sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
if (!runtime) throw new Error('No iOS simulator runtime is installed');
const supported = new Set((runtime.supportedDeviceTypes ?? []).map((t) => t.identifier));
const types = list.devicetypes.filter((t) => supported.size === 0 || supported.has(t.identifier));
const pick = (re) => types.filter((t) => re.test(t.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))[0];
const targets = [
  { label: 'iphone', type: pick(/^iPhone \d+ Pro$/) ?? pick(/^iPhone/) },
  { label: 'ipad', type: pick(/^iPad Pro .*13/) ?? pick(/^iPad Pro/) ?? pick(/^iPad/) },
];
console.log(`Runtime ${runtime.name}; devices: ${targets.map((t) => t.type?.name).join(', ')}; notes: ${Object.keys(ids).join(', ')}`);

const report = { runtime: runtime.name, devices: [] };
let failed = false;
for (const t of targets) {
  if (!t.type) { console.error(`No ${t.label} device type`); failed = true; continue; }
  const udid = simctl(['create', `Inkwright ${t.label}`, t.type.identifier, runtime.identifier]).trim();
  const entry = { label: t.label, device: t.type.name, runs: [] };
  try {
    simctl(['boot', udid]);
    simctl(['bootstatus', udid, '-b'], { timeout: 1_200_000 });
    await sleep(10_000); // SpringBoard refuses launches for a moment after boot on slow runners
    simctl(['install', udid, appPath]);
    const data = simctl(['get_app_container', udid, BUNDLE, 'data']).trim();
    cpSync(vault, join(data, 'Documents', 'Inkwright'), { recursive: true });
    const tourDir = join(data, 'Documents', 'tour');
    const vaultDir = join(data, 'Documents', 'Inkwright');
    let strokes = strokesOf(vaultDir, ids.lecture);
    for (const look of ['light', 'dark']) {
      const run = { appearance: look, steps: [], finished: false, running: false };
      simctl(['ui', udid, 'appearance', look]);
      await sleep(1500);
      const started = new Date();
      // The app's standard output carries the JavaScript console (Capacitor prints it there).
      const consoleFile = join(out, `${t.label}-${look}-console.txt`);
      for (let attempt = 1; ; attempt++) {
        try {
          simctl(['launch', '--terminate-running-process', `--stdout=${consoleFile}`, `--stderr=${consoleFile}`, udid, BUNDLE], { timeout: 120_000, env: { ...process.env, SIMCTL_CHILD_INKWRIGHT_TOUR: tourFor(`${look}-`) } });
          break;
        } catch (e) {
          if (attempt >= 4) throw e;
          console.log(`${t.type.name}: launch attempt ${attempt} failed, retrying`);
          await sleep(15_000);
        }
      }
      // The first launch on a fresh simulator compiles WebKit's caches; Intel runners are slow.
      const deadline = Date.now() + 600_000;
      while (Date.now() < deadline && !existsSync(join(tourDir, `${look}-done.png`))) await sleep(2000);
      run.finished = existsSync(join(tourDir, `${look}-done.png`));
      simctl(['io', udid, 'screenshot', join(out, `${t.label}-${look}-screen.png`)]);
      run.running = simctl(['spawn', udid, 'launchctl', 'list']).includes(`UIKitApplication:${BUNDLE}`);
      for (const f of existsSync(tourDir) ? readdirSync(tourDir) : []) {
        if (!f.startsWith(`${look}-`) || f === `${look}-done.png`) continue;
        cpSync(join(tourDir, f), join(out, `${t.label}-${f}`));
        run.steps.push(f.replace(/\.png$/, ''));
      }
      const since = started.toISOString().replace('T', ' ').slice(0, 19);
      let log = '';
      const consoleText = existsSync(consoleFile) ? readFileSync(consoleFile, 'utf8') : '';
      run.tour = consoleText.split('\n').filter((l) => /TOUR /.test(l)).map((l) => l.replace(/^.*TOUR /, '')).slice(0, 40);
      // Optional files a fresh vault doesn't have yet (OS-PLUG-FILE-0008 "does not exist") are expected.
      run.jsErrors = (consoleText + '\n' + log).split('\n').filter((l) => /⚡️\s+\[error\]|Uncaught|TypeError|ReferenceError|Unhandled Promise/.test(l) && !/OS-PLUG-FILE-0008|does not exist/.test(l)).slice(0, 40);
      // The pen stroke the walk drew on the lecture must be in the note's file on disk.
      const after = strokesOf(vaultDir, ids.lecture);
      run.inkSaved = after > strokes;
      run.strokes = { before: strokes, after };
      strokes = after;
      // A link from another app (Info.plist URL scheme → Capacitor's appUrlOpen → deeplinks.ts).
      const linked = `Opened by a link (${look})`;
      try {
        simctl(['openurl', udid, `inkwright://new?title=${encodeURIComponent(linked)}&text=${encodeURIComponent('Made by the iOS simulator run')}`], { timeout: 60_000 });
        const until = Date.now() + 60_000;
        while (Date.now() < until && !(run.linkOpened = titlesOf(vaultDir).includes(linked))) await sleep(3000);
      } catch (e) {
        run.linkError = String(e?.stderr || e?.message || e).slice(0, 400);
      }
      run.linkOpened = !!run.linkOpened;
      simctl(['io', udid, 'screenshot', join(out, `${t.label}-${look}-link.png`)]);
      log = simctl(['spawn', udid, 'log', 'show', '--style', 'compact', '--start', since, '--predicate', 'process == "App" OR eventMessage CONTAINS "inkwright://"']);
      writeFileSync(join(out, `${t.label}-${look}.log`), log);
      const after2 = existsSync(consoleFile) ? readFileSync(consoleFile, 'utf8') : '';
      run.jsErrors.push(...after2.slice(consoleText.length).split('\n').filter((l) => /⚡️\s+\[error\]|Uncaught|TypeError|ReferenceError|Unhandled Promise/.test(l) && !/OS-PLUG-FILE-0008|does not exist/.test(l)));
      if (!run.finished || !run.running || !run.inkSaved || !run.linkOpened) failed = true;
      entry.runs.push(run);
      console.log(`${t.type.name} (${look}): ${run.finished ? 'walk finished' : 'walk did NOT finish'}, ${run.running ? 'running' : 'NOT running'}, ink ${run.inkSaved ? 'saved' : 'NOT saved'} (${run.strokes.before} → ${run.strokes.after} strokes), link ${run.linkOpened ? 'opened a note' : 'did NOT open a note'}, steps: ${run.steps.join(', ')}`);
    }
  } catch (e) {
    entry.error = String(e?.stderr || e?.message || e);
    failed = true;
  } finally {
    try { simctl(['shutdown', udid]); } catch { /* already down */ }
  }
  report.devices.push(entry);
}
rmSync(vault, { recursive: true, force: true });
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
if (failed) { console.error('The app did not complete the walk on every simulator (see report.json)'); process.exit(1); }
