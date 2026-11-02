#!/usr/bin/env node
// npm create inkwright-plugin <folder> [--id com.example.thing] [--name "My thing"]
// (from this repository: node examples/create-inkwright-plugin/index.mjs <folder>)
//
// Copies the template into a new folder with the id, name and author filled in.
import { cpSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { id: { type: 'string' }, name: { type: 'string' }, author: { type: 'string' } } });
const target = positionals[0];
if (!target) {
  console.error('Usage: npm create inkwright-plugin <folder> [--id com.example.thing] [--name "My thing"] [--author "You"]');
  process.exit(2);
}
const dir = resolve(target);
if (existsSync(dir)) {
  console.error(`${dir} already exists.`);
  process.exit(1);
}
const slug = basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'my-plugin';
const id = values.id ?? `com.example.${slug}`;
if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(id) || id.length < 3 || id.length > 64) {
  console.error(`"${id}" is not a valid plugin id (a–z, 0–9, with ".", "-" or "_" between parts).`);
  process.exit(1);
}
const name = values.name ?? slug.replace(/-/g, ' ').replace(/^./, (c) => c.toUpperCase());
cpSync(new URL('./template', import.meta.url), dir, { recursive: true });
const manifestPath = resolve(dir, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
Object.assign(manifest, { id, name, author: values.author ?? userInfo().username, contributes: { ...manifest.contributes, panels: [{ id: 'main', title: name }] } });
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
const pkgPath = resolve(dir, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
writeFileSync(pkgPath, `${JSON.stringify({ ...pkg, name: slug }, null, 2)}\n`);
writeFileSync(resolve(dir, 'README.md'), readFileSync(resolve(dir, 'README.md'), 'utf8').replace(/^# My plugin/, `# ${name}`).replaceAll('"My plugin"', `"${name}"`));
console.log(`Created ${name} (${id}) in ${dir}.\nNext: Inkwright › Settings › Plugins › From a folder, and pick it.`);
