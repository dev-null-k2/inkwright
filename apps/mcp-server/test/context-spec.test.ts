/**
 * Conformance for the Personal Context Pack format (spec/personal-context/): every case in the
 * conformance suite against both the published JSON Schema (an independent JSON Schema 2020-12
 * validator, Ajv) and Inkwright's validator, what Inkwright itself produces, and
 * `inkwright context validate`.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { buildContextPack, validateContextPack, type ProvClaim } from '@inkwright/core';
import { runInkwrightCli } from '../src/inkwright-cli.ts';

const SPEC = fileURLToPath(new URL('../../../spec/personal-context/', import.meta.url));
const read = (f: string) => JSON.parse(readFileSync(path.join(SPEC, f), 'utf8'));
const manifest = read('conformance/manifest.json') as { valid: string[]; invalid: Array<{ file: string; path: string; schemaCatches: boolean }> };
const schema = read('v1.schema.json');
const ajv = new Ajv2020({ allErrors: true, strict: false });
const schemaValidate = ajv.compile(schema);

describe('the conformance suite', () => {
  it.each(manifest.valid)('valid/%s is accepted by the schema and the validator', (f) => {
    const doc = read(`conformance/valid/${f}`);
    expect(schemaValidate(doc), JSON.stringify(schemaValidate.errors)).toBe(true);
    const r = validateContextPack(doc);
    expect(r.issues.filter((i) => i.level === 'error')).toEqual([]);
    expect(r.ok).toBe(true);
  });

  it.each(manifest.invalid.map((c) => [c.file, c] as const))('invalid/%s is rejected at the right place', (_f, c) => {
    const doc = read(`conformance/invalid/${c.file}`);
    const r = validateContextPack(doc);
    expect(r.ok).toBe(false);
    expect(r.issues.filter((i) => i.level === 'error').map((i) => i.path)).toContain(c.path);
    // The manifest says which rules the schema can express; the rest are in v1.md §6.
    expect(schemaValidate(doc), `${c.file}: schemaCatches is ${c.schemaCatches}`).toBe(!c.schemaCatches);
  });

  it('covers every rule family at least once', () => {
    const paths = manifest.invalid.map((c) => c.path);
    for (const p of ['/format', '/id', '/createdAt', '/memory', '/notes/', '/compiled/', '/images/']) expect(paths.some((x) => x.startsWith(p)), p).toBe(true);
  });
});

describe('what Inkwright produces', () => {
  it('buildContextPack output conforms (after JSON serialisation)', () => {
    const claims: ProvClaim[] = [
      { s: 'The beta ships on Friday.', t: 'E', src: ['LAUNCH/0#abc123'], c: 0.9 },
      { s: 'Pricing is still open.', t: 'A', src: ['LAUNCH/1#def456', 'garbage'] },
    ];
    const pack = buildContextPack({
      title: 'Launch plan — Q4',
      createdAt: Date.UTC(2026, 10, 2, 9),
      notes: [{ id: 'LAUNCH', title: 'Launch plan', notebook: 'Work / Projects', tags: ['work'], updatedAt: Date.UTC(2026, 10, 1), pages: [{ index: 0, text: 'Launch the beta on Friday' }, { index: 1, text: 'Price at $12?' }] }],
      compiled: [{ title: 'Launch', kind: 'topic', claims }],
      images: [{ name: 'ink-LAUNCH-1.png', noteId: 'LAUNCH', noteTitle: 'Launch plan', page: 1, alt: 'pricing sketch', mediaType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) }],
      memory: { instructions: ['Be brief.'], facts: [] },
    });
    const doc = JSON.parse(JSON.stringify(pack.json));
    expect(schemaValidate(doc), JSON.stringify(schemaValidate.errors)).toBe(true);
    const r = validateContextPack(doc);
    expect(r.ok, JSON.stringify(r.issues)).toBe(true);
    // An unresolvable source is kept as a string: allowed, with a warning.
    expect(r.issues.map((i) => i.level)).toEqual(['warning']);
  });
});

describe('inkwright context validate', () => {
  it('exits 0 for a valid pack (file or saved folder), 1 with errors listed, 2 for usage', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'iw-ctx-'));
    try {
      let out = '';
      const say = (s: string) => (out += `${s}\n`);
      expect(await runInkwrightCli(['context', 'validate', path.join(SPEC, 'conformance/valid/full.json')], say)).toBe(0);
      expect(out).toMatch(/valid inkwright-context-pack\/1 \(1 warning\)/);
      expect(await runInkwrightCli(['context', 'validate', '--strict', path.join(SPEC, 'conformance/valid/full.json')], () => {})).toBe(1);
      await mkdir(path.join(dir, 'ai/packs/p1'), { recursive: true });
      await writeFile(path.join(dir, 'ai/packs/p1/pack.json'), readFileSync(path.join(SPEC, 'conformance/valid/minimal.json')));
      expect(await runInkwrightCli(['context', 'validate', path.join(dir, 'ai/packs/p1')], () => {})).toBe(0);
      out = '';
      expect(await runInkwrightCli(['context', 'validate', path.join(SPEC, 'conformance/invalid/link-mismatch.json')], say)).toBe(1);
      expect(out).toMatch(/error \/compiled\/0\/claims\/0\/sources\/0\/link: link points at note OTHER/);
      out = '';
      expect(await runInkwrightCli(['context', 'validate', '--json', path.join(SPEC, 'conformance/invalid/bad-tag.json')], say)).toBe(1);
      expect(JSON.parse(out).issues[0]).toMatchObject({ path: '/compiled/0/claims/0/tag', level: 'error' });
      await writeFile(path.join(dir, 'broken.json'), '{"format":');
      expect(await runInkwrightCli(['context', 'validate', path.join(dir, 'broken.json')], () => {})).toBe(1);
      expect(await runInkwrightCli(['context', 'validate'], () => {}, () => {})).toBe(2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
