#!/usr/bin/env node
/**
 * Writes `android-update.json`, the release asset the Android app's updater reads
 * (docs/UPDATES.md, "The release manifest").
 *
 *   node scripts/release/android-update.mjs --version 0.9.0-beta.6 --dir ../../out \
 *        --notes ../../out/notes.md [--repo dev-null-k2/inkwright] [--published 2026-11-04T10:00:00Z]
 *
 * It lists every `Inkwright-<version>-<abi>.apk` in --dir with its size and SHA-256 and the
 * address GitHub serves it from once the release is published (…/releases/download/v<version>/…).
 * The app downloads the APK for its ABI only if the file matches that size and checksum, and
 * installs it only if it is signed by the same key as the installed app.
 *
 * Fails (exit 1) when the version is outside the versionCode scheme or arm64-v8a is missing: a
 * release the updater can't describe should not be published as if it could.
 */
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseVersion, versionCode } from './version-code.mjs';

export const SCHEMA = 1;
export const APP_ID = 'app.inkwright';
export const ABIS = ['arm64-v8a', 'armeabi-v7a', 'x86_64'];
/** Matches UpdateManifest.MAX_NOTES_CHARS on the Android side. */
export const MAX_NOTES = 20_000;

/**
 * The manifest object.
 * @param {{ version: string, repo: string, apks: { abi: string, size: number, sha256: string }[], notes?: string, published: string, minSdk: number }} o
 */
export function buildManifest({ version, repo, apks, notes = '', published, minSdk }) {
  const code = versionCode(version);
  if (code == null) throw new Error(`${version} is not in the versionCode scheme (docs/UPDATES.md)`);
  if (!/^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/.test(repo)) throw new Error(`repo must be owner/name, not ${repo}`);
  if (!apks.some((a) => a.abi === 'arm64-v8a')) throw new Error('the arm64-v8a APK is missing');
  const base = `https://github.com/${repo}/releases/download/v${version}`;
  let text = notes.trim();
  if (text.length > MAX_NOTES) text = `${text.slice(0, MAX_NOTES - 40).replace(/\s+\S*$/, '')}\n\n(See the release page for more.)`;
  return {
    schema: SCHEMA,
    app: APP_ID,
    version,
    versionCode: code,
    channel: parseVersion(version).stage ? 'beta' : 'stable',
    published,
    minSdk,
    notes: text,
    apks: Object.fromEntries(
      [...apks].sort((a, b) => ABIS.indexOf(a.abi) - ABIS.indexOf(b.abi)).map((a) => [a.abi, { url: `${base}/Inkwright-${version}-${a.abi}.apk`, size: a.size, sha256: a.sha256 }]),
    ),
  };
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** minSdkVersion from android/variables.gradle, so the manifest can't disagree with the build. */
export function readMinSdk(variablesGradle) {
  const m = /minSdkVersion\s*=\s*(\d+)/.exec(variablesGradle);
  if (!m) throw new Error('minSdkVersion not found in variables.gradle');
  return Number(m[1]);
}

function args(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[++i];
  return out;
}

async function main() {
  const a = args(process.argv.slice(2));
  if (!a.version || !a.dir) {
    console.error('usage: android-update.mjs --version <v> --dir <folder with the APKs> [--notes notes.md] [--repo owner/name] [--published ISO date]');
    return 2;
  }
  const dir = resolve(a.dir);
  const apks = [];
  for (const abi of ABIS) {
    const file = join(dir, `Inkwright-${a.version}-${abi}.apk`);
    if (!existsSync(file)) continue;
    apks.push({ abi, size: statSync(file).size, sha256: await sha256File(file) });
  }
  const web = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
  const manifest = buildManifest({
    version: a.version,
    repo: a.repo ?? process.env.GITHUB_REPOSITORY ?? 'dev-null-k2/inkwright',
    apks,
    notes: a.notes && existsSync(a.notes) ? readFileSync(a.notes, 'utf8') : '',
    published: a.published ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    minSdk: readMinSdk(readFileSync(join(web, 'android/variables.gradle'), 'utf8')),
  });
  writeFileSync(join(dir, 'android-update.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`android-update.json: ${manifest.version} (versionCode ${manifest.versionCode}, ${manifest.channel}), ${apks.map((x) => x.abi).join(', ')}`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then((code) => { process.exitCode = code; }, (e) => { console.error(`android-update: ${e.message}`); process.exitCode = 1; });
}
