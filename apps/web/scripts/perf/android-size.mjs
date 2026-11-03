#!/usr/bin/env node
/**
 * What an Android build weighs, and why.
 *
 *   node scripts/perf/android-size.mjs <app.apk|app.aab> [...] [--json out.json]
 *
 * For each APK or app bundle: its size on disk and a breakdown by category (native libraries per
 * ABI, dex, web assets by kind, resources), compressed as stored and uncompressed. For an app
 * bundle it also asks bundletool what Google Play would send to a phone: the download size for an
 * arm64-v8a device (xxhdpi, English, Android 14), and the smallest/largest over every
 * configuration. bundletool comes from $BUNDLETOOL or the Gradle cache; signing uses the debug key.
 * See docs/PERFORMANCE.md.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Category of an entry in an APK (`lib/…`, `assets/…`) or a bundle module (`base/lib/…`). */
export function categoryOf(path) {
  // R8's mapping and native debug symbols ride along in a bundle for Play Console; no device gets them.
  if (path.startsWith('BUNDLE-METADATA/')) return 'bundle metadata (not installed)';
  const p = path.replace(/^base\//, '');
  const lib = p.match(/^lib\/([^/]+)\//);
  if (lib) return `native ${lib[1]}`;
  if (/(^|\/)classes\d*\.dex$|^dex\//.test(p)) return 'dex';
  if (/\.map$/.test(p)) return 'web: source maps';
  if (/^assets\/public\/engines\//.test(p)) return 'web: engines (bundled)';
  if (/^assets\/public\/.*\.wasm$/.test(p)) return 'web: wasm';
  if (/^assets\/public\/.*\.(woff2?|ttf)$/.test(p)) return 'web: fonts';
  if (/^assets\/public\/.*\.m?js$/.test(p)) return 'web: js';
  if (/^assets\/public\//.test(p)) return 'web: other';
  if (/^assets\//.test(p)) return 'assets: other';
  if (/^res\/|resources\.(arsc|pb)$/.test(p)) return 'resources';
  if (/^META-INF\//.test(p)) return 'signature & metadata';
  return 'other';
}

/** Entries of a zip with stored (compressed) and uncompressed sizes, via `unzip -Zl`. */
function entries(zip) {
  const out = execFileSync('unzip', ['-Zl', zip], { maxBuffer: 64 << 20 }).toString().split('\n');
  const rows = [];
  for (const line of out) {
    // -rw-r--r--  0.0 unx     1234 b-      567 defN 81-Jan-01 01:01 path
    const m = line.match(/^\S+\s+\S+\s+\S+\s+(\d+)\s+\S+\s+(\d+)\s+(\S+)\s+\S+\s+\S+\s+(.+)$/);
    if (m) rows.push({ path: m[4], raw: Number(m[1]), stored: Number(m[2]), method: m[3] });
  }
  return rows;
}

function breakdown(zip) {
  const by = {};
  for (const e of entries(zip)) {
    const c = categoryOf(e.path);
    by[c] ??= { stored: 0, raw: 0, files: 0 };
    by[c].stored += e.stored;
    by[c].raw += e.raw;
    by[c].files++;
  }
  return Object.fromEntries(Object.entries(by).sort((a, b) => b[1].stored - a[1].stored));
}

const GRADLE_CACHE = join(homedir(), '.gradle/caches/modules-2/files-2.1');

/** Newest `<group>/<artifact>` jar in the Gradle cache (any version), or null. */
function cachedJar(groupArtifact) {
  const dir = join(GRADLE_CACHE, groupArtifact);
  if (!existsSync(dir)) return null;
  const byVersion = (a, b) => a.localeCompare(b, 'en', { numeric: true });
  for (const v of readdirSync(dir).sort(byVersion).reverse()) {
    for (const hash of readdirSync(join(dir, v))) {
      const jar = readdirSync(join(dir, v, hash)).find((f) => f.endsWith('.jar') && !f.endsWith('-sources.jar'));
      if (jar) return join(dir, v, hash, jar);
    }
  }
  return null;
}

/**
 * How to run bundletool: `$BUNDLETOOL` (the all-in-one jar from github.com/google/bundletool), or
 * the copy the Android Gradle plugin downloaded, which is a plain library jar: it runs with its
 * dependencies, all of which the plugin also resolved into the Gradle cache. So any machine that
 * has built the app can measure it, offline.
 */
function findBundletool() {
  if (process.env.BUNDLETOOL && existsSync(process.env.BUNDLETOOL)) return { args: ['-jar', process.env.BUNDLETOOL], name: basename(process.env.BUNDLETOOL) };
  const main = cachedJar('com.android.tools.build/bundletool');
  if (!main) return null;
  const deps = [
    'com.android.tools.build/aapt2-proto', 'com.google.guava/guava', 'com.google.guava/failureaccess',
    'com.google.protobuf/protobuf-java', 'com.google.protobuf/protobuf-java-util', 'com.google.dagger/dagger',
    'javax.inject/javax.inject', 'org.bitbucket.b_c/jose4j', 'org.slf4j/slf4j-api', 'com.google.code.gson/gson',
  ].map(cachedJar);
  if (deps.some((d) => !d)) return null;
  return { args: ['-cp', [main, ...deps].join(':'), 'com.android.tools.build.bundletool.BundleToolMain'], name: basename(main) };
}

/** aapt2 from the Android SDK (newest build-tools): bundletool's library jar does not embed one. */
function findAapt2() {
  for (const sdk of [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT].filter(Boolean)) {
    const bt = join(sdk, 'build-tools');
    if (!existsSync(bt)) continue;
    const versions = readdirSync(bt).sort((a, b) => a.localeCompare(b, 'en', { numeric: true })).reverse();
    for (const v of versions) if (existsSync(join(bt, v, 'aapt2'))) return join(bt, v, 'aapt2');
  }
  return null;
}

/** Play download sizes for a bundle: one arm64 phone, and the range over all configurations. */
function playSizes(aab) {
  const tool = findBundletool();
  if (!tool) return { error: 'bundletool not found (build the app once with Gradle, or set BUNDLETOOL=/path/to/bundletool-all.jar)' };
  const dir = mkdtempSync(join(tmpdir(), 'inkwright-size-'));
  const run = (args, stdout) => execFileSync('java', [...tool.args, ...args], { stdio: ['ignore', stdout, 'pipe'] });
  try {
    const apks = join(dir, 'app.apks');
    const aapt2 = findAapt2();
    run(['build-apks', `--bundle=${aab}`, `--output=${apks}`, ...(aapt2 ? [`--aapt2=${aapt2}`] : [])], 'ignore');
    const spec = join(dir, 'arm64-phone.json');
    writeFileSync(spec, JSON.stringify({ supportedAbis: ['arm64-v8a'], supportedLocales: ['en-US'], screenDensity: 480, sdkVersion: 34 }));
    const csv = (args) => run(['get-size', 'total', `--apks=${apks}`, ...args], 'pipe').toString().trim().split('\n');
    const [, phone] = csv([`--device-spec=${spec}`]);
    const [lo, hi] = phone.split(',').map(Number);
    const all = csv(['--dimensions=ABI']).slice(1).map((l) => l.split(',')).map(([abi, min, max]) => ({ abi, min: Number(min), max: Number(max) }));
    return { arm64Phone: { min: lo, max: hi }, byAbi: all, bundletool: tool.name };
  } catch (e) {
    // bundletool's own message, without the JVM's banner lines.
    const why = String(e.stderr ?? e.message).split('\n').filter((l) => l && !l.startsWith('Picked up ')).slice(0, 5).join(' ');
    return { error: `bundletool failed: ${why}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// Decimal units (1 MB = 10^6 bytes), as `ls -h --si`, Vite and the Play Console report sizes.
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;

function main() {
  const args = process.argv.slice(2);
  const jsonAt = args.indexOf('--json');
  const json = jsonAt >= 0 ? args.splice(jsonAt, 2)[1] : undefined;
  const result = {};
  for (const file of args) {
    const size = statSync(file).size;
    const parts = breakdown(file);
    const r = { size, parts };
    console.log(`\n${file}: ${mb(size)}`);
    console.log(`  ${'category'.padEnd(32)} ${'stored'.padStart(10)} ${'raw'.padStart(10)} files`);
    for (const [k, v] of Object.entries(parts)) console.log(`  ${k.padEnd(32)} ${mb(v.stored).padStart(10)} ${mb(v.raw).padStart(10)} ${String(v.files).padStart(5)}`);
    if (file.endsWith('.aab')) {
      r.play = playSizes(file);
      if (r.play.error) console.log(`  Play download: ${r.play.error}`);
      else {
        console.log(`  Play download, arm64-v8a phone (xxhdpi, en, API 34): ${mb(r.play.arm64Phone.max)}`);
        for (const a of r.play.byAbi) console.log(`  Play download, ${a.abi.padEnd(12)} ${mb(a.min)} – ${mb(a.max)}`);
      }
    }
    result[file] = r;
  }
  if (json) writeFileSync(json, JSON.stringify(result, null, 2));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
