#!/usr/bin/env node
/**
 * `npm run e2e:all`: the e2e suite on every engine Inkstone ships to.
 *   Chromium  — Chrome/Edge on Windows, macOS, Linux, ChromeOS; Android's WebView (projects desktop,
 *               foldable, phone)
 *   WebKit    — Safari on macOS, and every browser on iPhone/iPad, including the Capacitor iOS app
 *               (webkit-desktop, webkit-ipad, webkit-iphone)
 *   Firefox   — firefox-desktop
 *
 * WebKit and Firefox are installed on first use for the pinned @playwright/test version. When the
 * machine keeps a read-only/shared Chromium in /opt/pw-browsers (CI images, this repo's dev
 * container), the extra engines go to a separate folder (INKSTONE_PW_EXTRA, default /opt/pw-extra or
 * ~/.cache/pw-extra) that links to that Chromium, so the shared install is never modified.
 *
 * Extra arguments go to `playwright test` (e.g. `npm run e2e:all -- --project webkit-ipad`).
 */
import { spawnSync } from 'node:child_process';
import { accessSync, constants, existsSync, mkdirSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const web = join(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env, INKSTONE_ENGINES: 'all' };

const SHARED = '/opt/pw-browsers';
if (!env.PLAYWRIGHT_BROWSERS_PATH && existsSync(SHARED)) {
  const writable = (p) => { try { mkdirSync(p, { recursive: true }); accessSync(p, constants.W_OK); return true; } catch { return false; } };
  const extra = env.INKSTONE_PW_EXTRA ?? ['/opt/pw-extra', join(homedir(), '.cache', 'pw-extra')].find(writable);
  if (!extra) throw new Error('No writable folder for the extra browsers; set INKSTONE_PW_EXTRA');
  mkdirSync(extra, { recursive: true });
  // Reuse the shared Chromium builds instead of downloading them again.
  for (const name of readdirSync(SHARED)) {
    if (name.startsWith('chromium') && !existsSync(join(extra, name))) symlinkSync(join(SHARED, name), join(extra, name));
  }
  env.PLAYWRIGHT_BROWSERS_PATH = extra;
}

const run = (args) => {
  const r = spawnSync('npx', args, { cwd: web, env, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

run(['playwright', 'install', 'webkit', 'firefox']);
run(['playwright', 'test', ...process.argv.slice(2)]);
