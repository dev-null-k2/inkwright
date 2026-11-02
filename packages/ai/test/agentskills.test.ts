import { describe, expect, it } from 'vitest';
import { MemoryFS } from '@inkwright/core';
import {
  SKILLS_DIR,
  SkillFormatError,
  SkillStore,
  builtinSkills,
  createScriptedProvider,
  createSkillTools,
  isScriptPath,
  parseFrontmatterYaml,
  parseSkillMd,
  runAgent,
  skillFromFiles,
  skillFromMarkdown,
  skillMdUrl,
  skillsPromptSection,
  validateSkillFrontmatter,
} from '../src/index.ts';

const enc = new TextEncoder();
const file = (path: string, text: string) => ({ path, bytes: enc.encode(text) });

const PDF_SKILL = `---
name: pdf-processing
description: >
  Extract PDF text, fill forms, merge files.
  Use when handling PDFs.
license: Apache-2.0
metadata:
  author: example-org
  version: "1.0"   # quoted so it stays text
allowed-tools: Bash(git:*) Read
---

# PDF processing

See [the forms guide](references/FORMS.md).
Run scripts/extract.py for big files.
`;

describe('SKILL.md parsing and validation (agentskills.io spec)', () => {
  it('parses frontmatter: folded/literal blocks, quotes, nested metadata, comments', () => {
    const { frontmatter: fm, body } = parseSkillMd(PDF_SKILL);
    expect(fm.name).toBe('pdf-processing');
    expect(fm.description).toBe('Extract PDF text, fill forms, merge files. Use when handling PDFs.');
    expect(fm.metadata).toEqual({ author: 'example-org', version: '1.0' });
    expect(fm['allowed-tools']).toBe('Bash(git:*) Read');
    expect(body.startsWith('# PDF processing')).toBe(true);
    expect(parseFrontmatterYaml('description: |\n  line one\n  line two\nname: x')).toEqual({ description: 'line one\nline two', name: 'x' });
    expect(parseFrontmatterYaml("name: 'it''s'")).toEqual({ name: "it's" });
    expect(() => parseSkillMd('# no frontmatter')).toThrow(SkillFormatError);
  });

  it('enforces the name and description rules', () => {
    const v = (fm: Record<string, unknown>, dir?: string) => validateSkillFrontmatter(fm, dir).errors;
    expect(v({ name: 'pdf-processing', description: 'ok' })).toEqual([]);
    expect(v({ name: 'PDF-Processing', description: 'x' })[0]).toMatch(/lowercase/);
    expect(v({ name: '-pdf', description: 'x' })[0]).toMatch(/start or end/);
    expect(v({ name: 'pdf--processing', description: 'x' })[0]).toMatch(/consecutive/);
    expect(v({ name: 'a'.repeat(65), description: 'x' })[0]).toMatch(/64/);
    expect(v({ name: 'x', description: '' })[0]).toMatch(/description/);
    expect(v({ name: 'x', description: 'd'.repeat(1025) })[0]).toMatch(/1024/);
    expect(v({ name: 'x', description: 'd', compatibility: 'c'.repeat(501) })[0]).toMatch(/compatibility/);
    expect(v({ name: 'x', description: 'd', metadata: { a: 1 } })[0]).toMatch(/metadata.a/);
    expect(v({ name: 'pdf', description: 'd' }, 'other')[0]).toMatch(/must match/);
    expect(validateSkillFrontmatter({ name: 'x', description: 'd', homepage: 'h' }).warnings[0]).toMatch(/homepage/);
  });

  it('imports a folder (skill at the root or in one top folder), keeping bundled files', () => {
    const b = skillFromFiles([
      file('pdf-processing/SKILL.md', PDF_SKILL),
      file('pdf-processing/references/FORMS.md', '# Forms'),
      file('pdf-processing/scripts/extract.py', 'print(1)'),
      { path: 'pdf-processing/assets/logo.png', bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe]) },
      file('pdf-processing/.DS_Store', 'junk'),
      file('__MACOSX/pdf-processing/._SKILL.md', 'junk'),
    ]);
    expect(b.name).toBe('pdf-processing');
    expect(b.files.map((f) => f.path)).toEqual(['assets/logo.png', 'references/FORMS.md', 'scripts/extract.py']);
    expect(b.files.find((f) => f.path === 'assets/logo.png')!.text).toBeUndefined();
    expect(b.files.find((f) => f.path === 'references/FORMS.md')!.text).toBe('# Forms');
    expect(isScriptPath('scripts/extract.py')).toBe(true);
    expect(isScriptPath('references/FORMS.md')).toBe(false);
    // At the root (zip without a folder).
    expect(skillFromFiles([file('SKILL.md', PDF_SKILL)]).name).toBe('pdf-processing');
  });

  it('rejects broken imports with clear messages', () => {
    expect(() => skillFromFiles([file('README.md', 'x')])).toThrow(/No SKILL.md/);
    expect(() => skillFromFiles([file('a/SKILL.md', PDF_SKILL), file('b/SKILL.md', PDF_SKILL)])).toThrow(/several skills/);
    expect(() => skillFromFiles([file('wrong-name/SKILL.md', PDF_SKILL)])).toThrow(/must match/);
    expect(() => skillFromFiles([file('x/../SKILL.md', PDF_SKILL)])).toThrow(/No SKILL.md/);
    // A downloaded archive's renamed folder is tolerated with a warning.
    expect(skillFromFiles([file('pdf-processing (1)/SKILL.md', PDF_SKILL)]).warnings[0]).toMatch(/renamed/);
  });

  it('turns GitHub page links into raw SKILL.md links and refuses http', () => {
    expect(skillMdUrl('https://github.com/anthropics/skills/blob/main/pdf/SKILL.md')).toBe('https://raw.githubusercontent.com/anthropics/skills/main/pdf/SKILL.md');
    expect(skillMdUrl('https://example.com/s/SKILL.md')).toBe('https://example.com/s/SKILL.md');
    expect(() => skillMdUrl('http://example.com/SKILL.md')).toThrow(/https/);
  });
});

describe('built-in skills', () => {
  it('ships the nine built-in skills as valid SKILL.md files', () => {
    const b = builtinSkills();
    expect(b.map((s) => s.name)).toEqual(['transcribe-handwriting', 'summarize-note', 'extract-todos', 'make-flashcards', 'explain-selection', 'translate-text', 'suggest-title', 'suggest-tags', 'answer-from-notes']);
    for (const s of b) {
      expect(s.builtin).toBe(true);
      expect(s.description.length).toBeGreaterThan(40);
      expect(s.warnings).toEqual([]);
      expect(s.body.length).toBeGreaterThan(100);
    }
  });
});

describe('skill store and progressive disclosure', () => {
  async function store() {
    const fs = new MemoryFS();
    const s = new SkillStore(fs, builtinSkills());
    await s.install(skillFromFiles([file('pdf-processing/SKILL.md', PDF_SKILL), file('pdf-processing/references/FORMS.md', '# Forms\nField list'), file('pdf-processing/scripts/extract.py', 'print(1)')]));
    return { fs, s };
  }

  it('stores imported skills in the vault under ai/skills/<name>/', async () => {
    const { fs, s } = await store();
    expect(await fs.readText(`${SKILLS_DIR}/pdf-processing/SKILL.md`)).toBe(PDF_SKILL);
    expect(await fs.readText(`${SKILLS_DIR}/pdf-processing/references/FORMS.md`)).toContain('Field list');
    const all = await s.list();
    expect(all.length).toBe(10);
    expect(all.find((x) => x.name === 'pdf-processing')!.files.map((f) => f.path)).toEqual(['references/FORMS.md', 'scripts/extract.py']);
    await expect(s.install(skillFromMarkdown(PDF_SKILL))).rejects.toThrow(/already installed/);
    await expect(s.install(skillFromMarkdown(PDF_SKILL.replace('pdf-processing', 'summarize-note')))).rejects.toThrow(/built-in/);
  });

  it('enable/disable, delete, export', async () => {
    const { fs, s } = await store();
    await s.setEnabled('pdf-processing', false);
    await s.setEnabled('make-flashcards', false);
    const enabled = (await s.enabled()).map((x) => x.name);
    expect(enabled).not.toContain('pdf-processing');
    expect(enabled).not.toContain('make-flashcards');
    expect(enabled).toContain('summarize-note');
    const exp = await s.exportEntries('pdf-processing');
    expect(exp.map((e) => e.path)).toEqual(['pdf-processing/SKILL.md', 'pdf-processing/references/FORMS.md', 'pdf-processing/scripts/extract.py']);
    expect((await s.exportEntries('summarize-note'))[0]!.path).toBe('summarize-note/SKILL.md');
    await s.remove('pdf-processing');
    expect(await fs.list(`${SKILLS_DIR}/pdf-processing`)).toEqual([]);
    await s.remove('summarize-note'); // built-ins can't be deleted
    expect((await s.list()).some((x) => x.name === 'summarize-note')).toBe(true);
  });

  it('only names and descriptions go in the prompt; load_skill returns the body; resources on demand', async () => {
    const { s } = await store();
    const prompt = skillsPromptSection(await s.enabled());
    expect(prompt).toContain('- pdf-processing: Extract PDF text');
    expect(prompt).not.toContain('See [the forms guide]');
    const provider = createScriptedProvider([
      { toolCalls: [{ name: 'load_skill', arguments: { name: 'pdf-processing' } }] },
      { toolCalls: [{ name: 'read_skill_resource', arguments: { name: 'pdf-processing', path: 'references/FORMS.md' } }] },
      { toolCalls: [{ name: 'read_skill_resource', arguments: { name: 'pdf-processing', path: '../../notes/x/note.json' } }] },
      { toolCalls: [{ name: 'load_skill', arguments: { name: 'nope' } }] },
      { text: 'ok' },
    ]);
    const res = await runAgent({ provider, model: 'm', messages: [{ role: 'user', content: 'fill my pdf form' }], tools: createSkillTools(s) });
    const [load, read, escape, missing] = res.toolRuns;
    expect(load!.ok).toBe(true);
    expect((load!.result as any).instructions).toContain('See [the forms guide]');
    expect((load!.result as any).files).toEqual([{ path: 'references/FORMS.md', size: expect.any(Number) }, { path: 'scripts/extract.py', size: expect.any(Number), note: expect.stringMatching(/cannot be run/) }]);
    expect(read!.result).toContain('Field list');
    expect(escape!.ok).toBe(false);
    expect(missing!.ok).toBe(false);
    expect(missing!.error).toMatch(/Available: .*pdf-processing/);
  });

  it('disabled skills are invisible to the agent', async () => {
    const { s } = await store();
    await s.setEnabled('pdf-processing', false);
    expect(skillsPromptSection(await s.enabled())).not.toContain('pdf-processing');
    const provider = createScriptedProvider([{ toolCalls: [{ name: 'load_skill', arguments: { name: 'pdf-processing' } }] }, { text: 'x' }]);
    const res = await runAgent({ provider, model: 'm', messages: [{ role: 'user', content: 'x' }], tools: createSkillTools(s) });
    expect(res.toolRuns[0]!.ok).toBe(false);
  });

  it('built-in skill resources include their SKILL.md', async () => {
    const { s } = await store();
    expect((await s.readResource('summarize-note', 'SKILL.md'))!.text).toMatch(/^---\nname: summarize-note/);
  });
});
