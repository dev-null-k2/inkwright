#!/usr/bin/env node
// Runs the simulator build of the iOS app on a new iPhone and a new iPad simulator: installs it,
// launches it, waits for the web app to start, and saves light and dark screenshots plus the
// app's log (JavaScript console lines included) to <out>. Fails when the app does not stay up.
//
//   node scripts/ios/simulator-run.mjs <path/to/App.app> <out-dir>
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [appPath, out = 'ios-out'] = process.argv.slice(2);
if (!appPath) { console.error('usage: simulator-run.mjs <App.app> <out-dir>'); process.exit(2); }
mkdirSync(out, { recursive: true });
const BUNDLE = 'app.inkwright';
const sh = (args, opts = {}) => execFileSync('xcrun', ['simctl', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = JSON.parse(sh(['list', '-j', 'runtimes', 'devicetypes']));
const runtime = list.runtimes.filter((r) => r.isAvailable && r.platform === 'iOS').sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
if (!runtime) throw new Error('No iOS simulator runtime is installed');
const supported = new Set((runtime.supportedDeviceTypes ?? []).map((t) => t.identifier));
const types = list.devicetypes.filter((t) => supported.size === 0 || supported.has(t.identifier));
const pick = (re) => types.filter((t) => re.test(t.name)).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))[0];
const targets = [
  { label: 'iphone', type: pick(/^iPhone \d+ Pro$/) ?? pick(/^iPhone/) },
  { label: 'ipad', type: pick(/^iPad Pro .*13/) ?? pick(/^iPad Pro/) ?? pick(/^iPad/) },
];
console.log(`Runtime ${runtime.name}; devices: ${targets.map((t) => t.type?.name).join(', ')}`);

const report = { runtime: runtime.name, devices: [] };
let failed = false;
for (const t of targets) {
  if (!t.type) { console.error(`No ${t.label} device type`); failed = true; continue; }
  const udid = sh(['create', `Inkwright ${t.label}`, t.type.identifier, runtime.identifier]).trim();
  const entry = { label: t.label, device: t.type.name, udid, running: false };
  try {
    sh(['boot', udid]);
    sh(['bootstatus', udid, '-b'], { timeout: 300_000 });
    sh(['ui', udid, 'appearance', 'light']);
    sh(['install', udid, appPath]);
    const started = new Date();
    const pid = sh(['launch', udid, BUNDLE]).trim();
    console.log(`${t.type.name}: launched (${pid})`);
    await sleep(25_000);
    sh(['io', udid, 'screenshot', join(out, `${t.label}-light.png`)]);
    sh(['ui', udid, 'appearance', 'dark']);
    await sleep(4_000);
    sh(['io', udid, 'screenshot', join(out, `${t.label}-dark.png`)]);
    // Still running? A crash leaves no App process behind.
    const procs = sh(['spawn', udid, 'launchctl', 'list']);
    entry.running = procs.includes(`UIKitApplication:${BUNDLE}`);
    const since = started.toISOString().replace('T', ' ').slice(0, 19);
    const log = sh(['spawn', udid, 'log', 'show', '--style', 'compact', '--start', since, '--predicate', 'process == "App"'], { maxBuffer: 64 * 1024 * 1024 });
    writeFileSync(join(out, `${t.label}.log`), log);
    entry.jsErrors = log.split('\n').filter((l) => /⚡️\s+\[error\]|Uncaught|TypeError|ReferenceError/.test(l)).slice(0, 50);
    if (!entry.running) failed = true;
  } catch (e) {
    entry.error = String(e?.stderr || e?.message || e);
    failed = true;
  } finally {
    try { sh(['shutdown', udid]); } catch { /* already down */ }
  }
  report.devices.push(entry);
  console.log(JSON.stringify(entry, null, 2));
}
writeFileSync(join(out, 'report.json'), JSON.stringify(report, null, 2));
if (failed) { console.error('The app did not run on every simulator (see report.json)'); process.exit(1); }
