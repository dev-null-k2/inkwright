#!/usr/bin/env node
/**
 * Dependency audit for CI and release checks: runs `npm audit --json` over the workspace and
 * fails when an advisory at or above `--level` (default high) affects a package that ships —
 * runtime dependencies of the app, the packages or the server. Dev-only tooling (test runners,
 * bundlers) is reported but does not fail the build unless `--include-dev` is given, because it
 * never reaches users; it is still listed so it gets fixed.
 *
 *   node scripts/audit-deps.mjs [--level low|moderate|high|critical] [--include-dev] [--json]
 *
 * Exit codes: 0 clean, 1 advisories at or above the level, 2 the audit itself failed.
 */
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const LEVELS = ['info', 'low', 'moderate', 'high', 'critical'];
const level = value('level', 'high');
if (!LEVELS.includes(level)) {
  console.error(`--level must be one of ${LEVELS.join(', ')}`);
  process.exit(2);
}

function audit(omitDev) {
  const r = spawnSync('npm', ['audit', '--json', ...(omitDev ? ['--omit=dev'] : [])], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, shell: process.platform === 'win32' });
  try {
    return JSON.parse(r.stdout || '{}');
  } catch {
    console.error(`npm audit did not return JSON:\n${r.stderr || r.stdout}`);
    process.exit(2);
  }
}

const shipped = audit(true);
const all = flag('include-dev') ? shipped : audit(false);
const rank = (s) => LEVELS.indexOf(s);
const rows = (report) => Object.values(report.vulnerabilities ?? {}).map((v) => ({
  name: v.name,
  severity: v.severity,
  range: v.range,
  fix: v.fixAvailable ? (typeof v.fixAvailable === 'object' ? `${v.fixAvailable.name}@${v.fixAvailable.version}` : 'npm audit fix') : 'none yet',
  via: (v.via ?? []).map((x) => (typeof x === 'string' ? x : x.title)).filter(Boolean).slice(0, 2).join('; '),
}));

const shippedRows = rows(shipped);
const shippedNames = new Set(shippedRows.map((r) => r.name));
const devRows = flag('include-dev') ? [] : rows(all).filter((r) => !shippedNames.has(r.name));
const failing = shippedRows.filter((r) => rank(r.severity) >= rank(level));

if (flag('json')) {
  console.log(JSON.stringify({ level, failing, shipped: shippedRows, devOnly: devRows }, null, 2));
} else {
  const show = (title, list) => {
    if (!list.length) return;
    console.log(`\n${title}`);
    for (const r of list.sort((a, b) => rank(b.severity) - rank(a.severity))) console.log(`  ${r.severity.padEnd(9)} ${r.name} ${r.range}  fix: ${r.fix}${r.via ? `  (${r.via})` : ''}`);
  };
  show('Shipped dependencies', shippedRows);
  show('Development-only dependencies (not shipped; reported, not failing)', devRows);
  console.log(failing.length ? `\n${failing.length} shipped package(s) with ${level}+ advisories.` : `\nNo shipped package has a ${level} or higher advisory.`);
}
process.exit(failing.length ? 1 : 0);
