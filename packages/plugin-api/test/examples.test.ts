/**
 * The example plugins and the template must stay valid as the API evolves, and their logic is
 * plain functions we can test without a sandbox.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { validateManifest } from '../src/index.ts';
// @ts-expect-error -- plain-JS example plugins (no type declarations)
import { plainText, stats } from '../../../examples/plugins/word-count/main.js';
// @ts-expect-error -- plain-JS example plugins (no type declarations)
import { payload } from '../../../examples/plugins/webhook/main.js';

const read = (p: string) => JSON.parse(readFileSync(new URL(`../../../examples/${p}`, import.meta.url), 'utf8'));

describe('example plugins', () => {
  for (const p of ['plugins/word-count/manifest.json', 'plugins/webhook/manifest.json', 'create-inkwright-plugin/template/manifest.json']) {
    it(`${p} is a valid manifest`, () => {
      const r = validateManifest(read(p));
      expect(r.ok ? r.warnings : r.errors).toEqual([]);
    });
  }

  it('word count handles Markdown, links and CJK', () => {
    expect(plainText('# Title\n- [x] done [[Other note|alias]] and [a link](https://x)')).toBe('Title\ndone alias and a link');
    expect(stats('one two three', 60)).toMatchObject({ words: 3, characters: 11 });
    expect(stats('漢字かな two').words).toBe(5);
    expect(stats('word '.repeat(460), 230).minutes).toBe(2);
  });

  it('webhook payloads match each format', () => {
    const p = { title: 'T', text: 'hello', noteId: 'N', page: 2, sentAt: '2026-01-01T00:00:00Z' };
    expect(payload('json', p)).toEqual(p);
    expect(payload('slack', p)).toEqual({ text: '*T* (p. 2)\nhello' });
  });
});
