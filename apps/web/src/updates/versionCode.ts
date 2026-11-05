/**
 * Android versionCodes from release versions (docs/UPDATES.md, "Version codes"):
 *
 *   MAJOR.MINOR.PATCH[-alpha|beta|rc[.N]]
 *   versionCode = (MAJOR·10 000 + MINOR·100 + PATCH) · 1000 + stage + N
 *   stage: alpha 100, beta 200, rc 300, final 900;  N = 0…99 (absent = 0)
 *
 * The updater compares release tags by it to pick the newest release without downloading every
 * release's manifest. The same scheme stamps the build (scripts/release/version-code.mjs) and
 * checks manifests natively (updates/VersionCode.kt); versionCode.test.ts runs all of them against
 * one table.
 */

export type Stage = 'alpha' | 'beta' | 'rc';

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  stage: Stage | null;
  number: number;
}

const PATTERN = /^v?(\d{1,3})\.(\d{1,2})\.(\d{1,2})(?:-(alpha|beta|rc)(?:\.(\d{1,2}))?)?$/;
const STAGES: Record<Stage, number> = { alpha: 100, beta: 200, rc: 300 };
const FINAL = 900;

/** The parts of "0.9.0-beta.6" (a leading "v" allowed), or null if it isn't a release version. */
export function parseVersion(version: string): ParsedVersion | null {
  const m = PATTERN.exec(version.trim());
  if (!m) return null;
  const major = Number(m[1]);
  if (major > 209) return null;
  return { major, minor: Number(m[2]), patch: Number(m[3]), stage: (m[4] as Stage | undefined) ?? null, number: m[5] ? Number(m[5]) : 0 };
}

/** The versionCode of a release version, or null if it isn't one. */
export function versionCode(version: string): number | null {
  const p = parseVersion(version);
  if (!p) return null;
  return (p.major * 10_000 + p.minor * 100 + p.patch) * 1000 + (p.stage ? STAGES[p.stage] : FINAL) + p.number;
}

export const isPrerelease = (version: string): boolean => parseVersion(version)?.stage != null;
