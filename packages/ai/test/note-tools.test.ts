import { describe, expect, it } from 'vitest';
import { exportMarkdown, type MemoryFS } from '@inkstone/core';
import {
  MemoryNoteToolHost,
  NOTE_TOOL_NAMES,
  READ_ONLY_NOTE_TOOLS,
  TEXT_LAYOUT,
  createNoteTools,
  createScriptedProvider,
  isRichResult,
  normalizeTags,
  notesAgentSystemPrompt,
  runAgent,
  validateArgs,
  type AgentTool,
} from '../src/index.ts';
import { PNG_1PX } from './helpers.ts';

async function setup(withRenderer = false) {
  let t = Date.UTC(2026, 10, 1, 9, 0, 0);
  const host = await MemoryNoteToolHost.create({
    clock: () => (t += 1000),
    ...(withRenderer ? { renderPage: async () => ({ mediaType: 'image/png', base64: PNG_1PX }) } : {}),
  });
  const tools = createNoteTools(host);
  const byName = Object.fromEntries(tools.map((x) => [x.name, x])) as Record<string, AgentTool>;
  const run = async (name: string, args: Record<string, unknown>) => {
    const tool = byName[name];
    if (!tool) throw new Error(`no tool ${name}`);
    const v = validateArgs(tool.parameters, args);
    if (!v.ok) throw new Error(v.errors.join('; '));
    return (await tool.execute(v.value, { toolCallId: 't', messages: [] })) as any;
  };
  return { host, tools, byName, run };
}

describe('createNoteTools', () => {
  it('exposes snake_case tools with schemas and flags', async () => {
    const { tools, byName } = await setup();
    expect(tools.map((t) => t.name)).toEqual(NOTE_TOOL_NAMES.filter((n) => n !== 'get_page_image'));
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z_]{1,64}$/);
      expect(t.description.length).toBeGreaterThan(60);
      expect(t.parameters).toMatchObject({ type: 'object' });
    }
    expect(byName.trash_note!.destructive).toBe(true);
    expect(tools.filter((t) => t.destructive).map((t) => t.name)).toEqual(['trash_note']);
    expect(byName.search_notes!.readOnly).toBe(true);
    expect(byName.create_note!.readOnly).toBeUndefined();
  });

  it('includes get_page_image only when the host can render, and honours include/exclude', async () => {
    const { host } = await setup(true);
    expect(createNoteTools(host).map((t) => t.name)).toContain('get_page_image');
    expect(createNoteTools(host, { include: READ_ONLY_NOTE_TOOLS }).map((t) => t.name)).toEqual(['list_notes', 'search_notes', 'read_note', 'get_page_image', 'list_notebooks']);
    expect(createNoteTools(host, { exclude: ['trash_note'] }).some((t) => t.name === 'trash_note')).toBe(false);
  });

  it('create_note writes a text box, indexes it and generates note.md', async () => {
    const { host, run } = await setup();
    const out = await run('create_note', { title: 'Groceries', text: '- [ ] eggs\n- [ ] milk\n- [ ] spinach', tags: ['#Shopping', 'shopping', ' Home '] });
    expect(out.created).toBe(true);
    expect(out.note).toMatchObject({ title: 'Groceries', tags: ['shopping', 'home'] });
    const id = out.note.id as string;

    const note = (await host.vault.readNote(id))!;
    const [page] = await host.vault.readPages(note);
    expect(page!.texts).toHaveLength(1);
    expect(page!.texts![0]).toMatchObject({ x: TEXT_LAYOUT.marginX, y: TEXT_LAYOUT.top, text: '- [ ] eggs\n- [ ] milk\n- [ ] spinach', font: 'sans' });
    expect(page!.texts![0]!.width).toBeCloseTo(note.pageSize.width - 2 * TEXT_LAYOUT.marginX);

    const md = await host.vault.fs.readText(`notes/${id}/note.md`);
    expect(md).toContain('- [ ] spinach');
    expect(md).toBe(exportMarkdown(note, [page!]));

    const found = await run('search_notes', { query: 'spinach' });
    expect(found.results[0]).toMatchObject({ note_id: id, title: 'Groceries', page_index: 0 });
    expect(found.results[0].snippet).toContain('«spinach»');
  });

  it('read_note returns metadata and per-page text, flagging unrecognized handwriting', async () => {
    const { host, run } = await setup();
    const n = await host.seed({ title: 'Lecture 4', text: ['Typed intro', ''], recognizedText: ['', 'Entropy always increases'], strokes: 3, tags: ['physics'], summary: 'Thermodynamics' });
    const ink = await host.seed({ title: 'Sketches', strokes: 5 });
    const r = await run('read_note', { note_id: n.id });
    expect(r).toMatchObject({ id: n.id, title: 'Lecture 4', tags: ['physics'], page_count: 2, summary: 'Thermodynamics' });
    expect(r.pages).toEqual([
      { page_index: 0, text: 'Typed intro', has_handwriting: true, handwriting_recognized: false },
      { page_index: 1, text: 'Entropy always increases', has_handwriting: true, handwriting_recognized: true },
    ]);
    const s = await run('read_note', { note_id: ink.id });
    expect(s.pages[0]).toEqual({ page_index: 0, text: '', has_handwriting: true, handwriting_recognized: false });
    await expect(run('read_note', { note_id: 'missing' })).rejects.toThrow(/No note with id "missing"/);
    await expect(run('read_note', { note_id: '../../etc' })).rejects.toThrow(/No note/);
  });

  it('append_to_note stacks text below existing content and spills onto a new page when full', async () => {
    const { host, run } = await setup();
    const created = await run('create_note', { title: 'Wedding planning', text: 'Venue: the old mill' });
    const id = created.note.id;
    const a = await run('append_to_note', { note_id: id, text: 'Call the florist' });
    expect(a).toEqual({ appended: true, note_id: id, page_index: 0 });
    let note = (await host.vault.readNote(id))!;
    let [page] = await host.vault.readPages(note);
    const [b1, b2] = page!.texts!;
    expect(b2!.y).toBeGreaterThan(b1!.y);
    expect(b2!.y).toBeGreaterThanOrEqual(b1!.y + 16 * 1.4 + TEXT_LAYOUT.gap - 0.01);

    // Nearly fill the page (41 lines × 21.6 units); the next append must go to a new page 1.
    const long = Array.from({ length: 41 }, (_, i) => `line ${i}`).join('\n');
    expect((await run('append_to_note', { note_id: id, text: long })).page_index).toBe(0);
    const spill = await run('append_to_note', { note_id: id, text: 'Book the band' });
    expect(spill.page_index).toBe(1);
    note = (await host.vault.readNote(id))!;
    expect(note.pageIds).toHaveLength(2);
    const pages = await host.vault.readPages(note);
    expect(pages[1]!.texts![0]).toMatchObject({ text: 'Book the band', y: TEXT_LAYOUT.top });

    // Explicit page index is honoured, out of range is an error.
    expect((await run('append_to_note', { note_id: id, text: 'p0 extra', page_index: 0 })).page_index).toBe(0);
    await expect(run('append_to_note', { note_id: id, text: 'x', page_index: 9 })).rejects.toThrow(/page_index must be 0–1/);
    expect((await run('search_notes', { query: 'florist' })).count).toBe(1);
  });

  it('append below handwriting', async () => {
    const { host, run } = await setup();
    const n = await host.seed({ title: 'Ink', strokes: 4 });
    await run('append_to_note', { note_id: n.id, text: 'typed after ink' });
    const [page] = await host.vault.readPages((await host.vault.readNote(n.id))!);
    const inkBottom = Math.max(...page!.strokes.flatMap((s) => s.points.map((p) => p.y)));
    expect(page!.texts![0]!.y).toBeGreaterThan(inkBottom);
  });

  it('update_note renames, retags, moves, pins and summarizes', async () => {
    const { host, run } = await setup();
    const n = await host.seed({ title: 'Pancakes', text: 'flour, eggs, milk' });
    const nb = await run('create_notebook', { name: 'Recipes' });
    expect(nb).toMatchObject({ created: true, notebook: { name: 'Recipes' } });
    const u = await run('update_note', { note_id: n.id, title: 'Fluffy pancakes', tags: ['Breakfast'], notebook_id: nb.notebook.id, pinned: true, summary: 'Weekend recipe' });
    expect(u.note).toMatchObject({ title: 'Fluffy pancakes', tags: ['breakfast'], notebook_id: nb.notebook.id, pinned: true, summary: 'Weekend recipe' });
    const nbs = await run('list_notebooks', {});
    expect(nbs.notebooks).toEqual([{ id: nb.notebook.id, name: 'Recipes', notes: 1 }]);
    const listed = await run('list_notes', { notebook_id: nb.notebook.id });
    expect(listed.notes[0]).toMatchObject({ title: 'Fluffy pancakes', notebook: 'Recipes', page_count: 1 });
    expect((await run('search_notes', { query: 'fluffy' })).count).toBe(1);

    const unfiled = await run('update_note', { note_id: n.id, notebook_id: '' });
    expect(unfiled.note.notebook_id).toBeUndefined();
    await expect(run('update_note', { note_id: n.id })).rejects.toThrow(/Nothing to change/);
    await expect(run('update_note', { note_id: n.id, notebook_id: 'nope' })).rejects.toThrow(/No notebook/);
    await expect(run('update_note', { note_id: 'nope', title: 'x' })).rejects.toThrow(/No note/);
    await expect(run('create_note', { title: 'x', text: 'y', notebook_id: 'nope' })).rejects.toThrow(/No notebook/);
  });

  it('list_notes filters by tag and pinned, newest first', async () => {
    const { host, run } = await setup();
    await host.seed({ title: 'A', tags: ['work'] });
    await host.seed({ title: 'B', tags: ['home'], pinned: true });
    await host.seed({ title: 'C', tags: ['work'] });
    await host.seed({ title: 'Old', trashed: true });
    expect((await run('list_notes', {})).notes.map((n: any) => n.title)).toEqual(['C', 'B', 'A']);
    expect((await run('list_notes', { tag: '#Work' })).notes.map((n: any) => n.title)).toEqual(['C', 'A']);
    expect((await run('list_notes', { pinned_only: true })).notes.map((n: any) => n.title)).toEqual(['B']);
    expect((await run('list_notes', { limit: 1 })).count).toBe(1);
  });

  it('trash_note moves to trash and removes from search', async () => {
    const { host, run, byName } = await setup();
    const n = await host.seed({ title: 'Old shopping list', text: 'bananas' });
    expect(byName.trash_note!.destructive).toBe(true);
    expect(await run('trash_note', { note_id: n.id })).toEqual({ trashed: true, note_id: n.id });
    expect((await host.vault.readNote(n.id))!.trashedAt).toBeTypeOf('number');
    expect((await run('search_notes', { query: 'bananas' })).count).toBe(0);
    expect((await run('list_notes', {})).count).toBe(0);
    await expect(run('trash_note', { note_id: n.id })).rejects.toThrow(/No note/);
  });

  it('get_page_image returns an image rich result', async () => {
    const { host, run } = await setup(true);
    const n = await host.seed({ title: 'Diagram', strokes: 2 });
    const r = await run('get_page_image', { note_id: n.id, page_index: 0 });
    expect(isRichResult(r)).toBe(true);
    expect(r.parts[1]).toEqual({ type: 'image', mediaType: 'image/png', data: PNG_1PX });
    await expect(run('get_page_image', { note_id: n.id, page_index: 3 })).rejects.toThrow(/No page 3/);
  });

  it('search hints when nothing matches', async () => {
    const { run } = await setup();
    expect(await run('search_notes', { query: 'zebra' })).toMatchObject({ count: 0, hint: expect.stringMatching(/fewer or different/) });
  });

  it('host persists to the vault filesystem', async () => {
    const { host, run } = await setup();
    const out = await run('create_note', { title: 'Saved', text: 'body' });
    const paths = (host.vault.fs as MemoryFS).paths();
    expect(paths).toEqual(expect.arrayContaining([`notes/${out.note.id}/note.json`, `notes/${out.note.id}/note.md`, 'inkstone.json']));
    expect(paths.some((p) => p.endsWith('.ink.json'))).toBe(true);
    // A fresh host over the same vault sees the note.
    const again = await MemoryNoteToolHost.create({ vault: host.vault });
    expect((await again.searchNotes('saved')).map((h) => h.noteId)).toEqual([out.note.id]);
  });

  it('normalizeTags and system prompt', () => {
    expect(normalizeTags(['#A', 'a', '', ' b '])).toEqual(['a', 'b']);
    const p = notesAgentSystemPrompt({ now: new Date('2026-11-01T10:00:00Z') });
    expect(p).toContain('2026-11-01');
    expect(p).toMatch(/search_notes/);
    expect(p).toMatch(/\[Beta launch plan\]/);
  });

  it('drives the tools through the agent loop', async () => {
    const { host, tools } = await setup();
    await host.seed({ title: 'Beta launch plan', text: 'Launch date: March 3. Budget $12,000.' });
    const provider = createScriptedProvider([
      { toolCalls: [{ name: 'search_notes', arguments: { query: 'launch' } }] },
      (ctx) => ({ toolCalls: [{ name: 'read_note', arguments: { note_id: (ctx.toolResults[0]!.value as any).results[0].note_id } }] }),
      (ctx) => ({ text: `From [${(ctx.toolResults[0]!.value as any).title}]: launch is March 3.` }),
    ]);
    const r = await runAgent({ provider, model: 'm', system: notesAgentSystemPrompt(), messages: [{ role: 'user', content: 'When is the launch?' }], tools });
    expect(r.text).toBe('From [Beta launch plan]: launch is March 3.');
    expect(r.toolRuns.every((t) => t.ok)).toBe(true);
  });
});
