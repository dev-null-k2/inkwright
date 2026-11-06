#!/usr/bin/env node
// Checks a web build's offline app before it is published: sw.js must parse, and every file it
// installs must be in the build (one missing file and browsers refuse the whole install).
//   node scripts/check-offline-app.mjs apps/web/dist
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Script } from 'node:vm';

const dir = process.argv[2] ?? 'apps/web/dist';
const src = readFileSync(join(dir, 'sw.js'), 'utf8');
new Script(src, { filename: 'sw.js' }); // throws on a syntax error
const m = src.match(/const FILES = (\[.*?\]);/s);
if (!m) throw new Error('sw.js has no FILES list');
const files = JSON.parse(m[1]).filter((f) => f !== './');
const missing = files.filter((f) => !existsSync(join(dir, f)));
if (missing.length) { console.error(`sw.js installs files that are not in the build: ${missing.join(', ')}`); process.exit(1); }
console.log(`Offline app OK: sw.js parses and all ${files.length} files it installs are in the build.`);
