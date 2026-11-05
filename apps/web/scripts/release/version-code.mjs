#!/usr/bin/env node
/**
 * The Android versionCode of a release version (docs/UPDATES.md, "Version codes").
 *
 *   node scripts/release/version-code.mjs 0.9.0-beta.6     → 900206
 *
 * release.yml stamps it into app/build.gradle. Android installs an update only when its
 * versionCode is higher, so every release — pre-releases too — needs a higher code than the one
 * before, and a final release must sort above its own betas:
 *
 *   MAJOR.MINOR.PATCH[-alpha|beta|rc[.N]]
 *   versionCode = (MAJOR·10 000 + MINOR·100 + PATCH) · 1000 + stage + N
 *   stage: alpha 100, beta 200, rc 300, final 900;  N = 0…99 (absent = 0)
 *
 * The same scheme is in android/app/src/main/java/app/inkwright/updates/VersionCode.kt (which
 * checks downloaded manifests) and src/updates/versionCode.ts (which picks the newest release);
 * all three are tested against android/app/src/test/resources/version-codes.json.
 *
 * A version outside the scheme exits with status 1, so a mistyped tag fails the release instead
 * of shipping an APK no installed copy would accept as an update.
 */
import { pathToFileURL } from 'node:url';

const PATTERN = /^v?(\d{1,3})\.(\d{1,2})\.(\d{1,2})(?:-(alpha|beta|rc)(?:\.(\d{1,2}))?)?$/;
const STAGES = { alpha: 100, beta: 200, rc: 300 };
const FINAL = 900;

/** @returns {{ major: number, minor: number, patch: number, stage: 'alpha'|'beta'|'rc'|null, number: number } | null} */
export function parseVersion(version) {
  const m = PATTERN.exec(String(version).trim());
  if (!m) return null;
  const major = Number(m[1]);
  if (major > 209) return null;
  return { major, minor: Number(m[2]), patch: Number(m[3]), stage: /** @type {any} */ (m[4] ?? null), number: m[5] ? Number(m[5]) : 0 };
}

/** The versionCode of `version` ("0.9.0-beta.6", a leading "v" allowed), or null outside the scheme. */
export function versionCode(version) {
  const p = parseVersion(version);
  if (!p) return null;
  return (p.major * 10_000 + p.minor * 100 + p.patch) * 1000 + (p.stage ? STAGES[p.stage] : FINAL) + p.number;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const code = versionCode(process.argv[2] ?? '');
  if (code == null) {
    console.error(`version-code: "${process.argv[2] ?? ''}" is not MAJOR.MINOR.PATCH[-alpha|beta|rc[.N]] (docs/UPDATES.md)`);
    process.exitCode = 1;
  } else {
    console.log(code);
  }
}
