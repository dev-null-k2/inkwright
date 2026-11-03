import { readdir, readFile, symlink, mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VaultLayout, contentBounds, decodeNote, decodePage, textBoxHeight } from '@inkwright/core';
import { createContext, type ServerContext } from '../src/context.ts';
import { NodeFS } from '../src/nodefs.ts';
import { dailyReviewPrompt, summarizeNotePrompt, todosFromNotesPrompt } from '../src/prompts.ts';
import { listNoteResources, readNoteResource, readPageSvgResource } from '../src/resources.ts';
import { activeTools } from '../src/server.ts';
import {
  TOOLS,
  appendToNote,
  createNote,
  createNotebook,
  getPageImage,
  getRecentHandwriting,
  listNotebooks,
  listNotes,
  readNote,
  restoreNote,
  searchNotes,
  splitToFit,
  trashNote,
  updateNote,
} from '../src/tools.ts';
import { parseCli } from '../src/cli.ts';
import { HOUR, json, makeFixture, text, type Fixture } from './fixtures.ts';

let fx: Fixture;
let ctx: ServerContext;

beforeEach(async () => {
  fx = await makeFixture();
  ctx = await fx.ctx();
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fx.cleanup();
});

async function diskNote(id: string) {
  return decodeNote(await readFile(path.join(fx.dir, VaultLayout.noteMeta(id)), 'utf8'));
}
async function diskPage(noteId: string, pageId: string) {
  return decodePage(await readFile(path.join(fx.dir, VaultLayout.pageInk(noteId, pageId)), 'utf8'));
}

describe('list_notes', () => {
  it('lists live notes newest first with metadata', async () => {
    const r = json(await listNotes(ctx, {}));
    expect(r.total).toBe(4);
    expect(r.notes.map((n: any) => n.id)).toEqual(['SKETCH', 'LAUNCH', 'GROCERIES', 'OLDNOTE']);
    const launch = r.notes.find((n: any) => n.id === 'LAUNCH');
    expect(launch).toMatchObject({ title: 'Launch plan', tags: ['work', 'launch'], notebook: 'Work / Projects', pages: 2, pinned: false });
    expect(launch.updated).toBe(new Date(fx.notes.launch.updatedAt).toISOString());
    expect(r.notes.find((n: any) => n.id === 'OLDNOTE').summary).toBe('Thoughts on Deep Work');
  });

  it('filters by notebook (name or id, including sections), tag, limit and trash', async () => {
    expect(json(await listNotes(ctx, { notebook: 'work' })).notes.map((n: any) => n.id).sort()).toEqual(['LAUNCH', 'OLDNOTE']);
    expect(json(await listNotes(ctx, { notebook: 'NBPROJECTS' })).notes.map((n: any) => n.id)).toEqual(['LAUNCH']);
    expect(json(await listNotes(ctx, { notebook: 'Work / Projects' })).total).toBe(1);
    expect(json(await listNotes(ctx, { tag: '#HOME' })).notes.map((n: any) => n.id)).toEqual(['GROCERIES']);
    expect(json(await listNotes(ctx, { limit: 1 }))).toMatchObject({ total: 4, returned: 1 });
    const all = json(await listNotes(ctx, { includeTrashed: true }));
    expect(all.total).toBe(5);
    expect(all.notes.find((n: any) => n.id === 'TRASHED').trashed).toBeTruthy();
  });

  it('explains an unknown notebook', async () => {
    await expect(listNotes(ctx, { notebook: 'Nope' })).rejects.toThrow(/Notebook not found.*Work \/ Projects/);
  });
});

describe('search_notes', () => {
  it('finds recognized handwriting, typed text and titles with prefix matching', async () => {
    const r = json(await searchNotes(ctx, { query: 'lau bet' }));
    expect(r.hits[0]).toMatchObject({ id: 'LAUNCH', title: 'Launch plan', notebook: 'Work / Projects', uri: 'inkwright://notes/LAUNCH' });
    const maria = json(await searchNotes(ctx, { query: 'maria' }));
    expect(maria.hits).toHaveLength(1);
    expect(maria.hits[0].page).toBe(1);
    expect(maria.hits[0].snippet).toContain('«Maria»');
    expect(json(await searchNotes(ctx, { query: 'budget' })).hits[0]).toMatchObject({ id: 'LAUNCH', page: 2 });
    expect(json(await searchNotes(ctx, { query: 'coffee' })).hits[0].id).toBe('GROCERIES');
  });

  it('never returns trashed notes and hints on no results', async () => {
    const r = json(await searchNotes(ctx, { query: 'zeppelin' }));
    expect(r.count).toBe(0);
    expect(r.hint).toMatch(/No matches/);
  });

  it('picks up changes made by other writers (app, sync) and deletions', async () => {
    expect(json(await searchNotes(ctx, { query: 'kangaroo' })).count).toBe(0);
    const { note, pages } = await fx.external.createNote({ title: 'Trip ideas' });
    pages[0]!.recognizedText = 'kangaroo island road trip';
    await fx.external.saveNote({ ...note, updatedAt: note.updatedAt + 1 }, pages);
    expect(json(await searchNotes(ctx, { query: 'kangaroo' })).hits[0].id).toBe(note.id);
    await fx.external.deleteNote(note.id);
    expect(json(await searchNotes(ctx, { query: 'kangaroo' })).count).toBe(0);
  });

  it('with a watcher, sees external changes too', async () => {
    const watched = await fx.ctx({ watch: true });
    expect(json(await searchNotes(watched, { query: 'maria' })).count).toBe(1);
    const { note, pages } = await fx.external.createNote({ title: 'Wombat facts' });
    await fx.external.saveNote(note, pages);
    await vi.waitFor(async () => expect(json(await searchNotes(watched, { query: 'wombat' })).count).toBe(1), { timeout: 3000, interval: 50 });
  });
});

describe('read_note', () => {
  it('returns Markdown with front matter and per-page text plus metadata', async () => {
    const r = await readNote(ctx, { id: 'LAUNCH' });
    const md = text(r, 0);
    expect(md).toMatch(/^---\nid: LAUNCH\ntitle: Launch plan\n/);
    expect(md).toContain('notebook: NBPROJECTS');
    expect(md).toContain('## Page 1');
    expect(md).toContain('Launch the beta on Friday');
    expect(md).toContain('## Page 2');
    expect(md).toContain('Budget: 5k for the **beta** cohort');
    const meta = json(r, 1);
    expect(meta).toMatchObject({ id: 'LAUNCH', notebook: 'Work / Projects', uri: 'inkwright://notes/LAUNCH' });
    expect(meta.pageDetails[0]).toMatchObject({ page: 1, strokes: 2, handwritingRecognized: true, recognizedBy: 'mlkit', needsRecognition: false });
    expect(meta.pageDetails[1]).toMatchObject({ page: 2, textBoxes: 1, needsRecognition: false });
  });

  it('flags unrecognized handwriting', async () => {
    const r = await readNote(ctx, { id: 'SKETCH' });
    expect(text(r)).toContain('_(handwriting not yet recognized)_');
    expect(json(r, 1).pageDetails[0].needsRecognition).toBe(true);
  });

  it('rejects unknown and unsafe ids', async () => {
    await expect(readNote(ctx, { id: 'MISSING' })).rejects.toThrow(/Note not found/);
    await expect(readNote(ctx, { id: '../../etc/passwd' })).rejects.toThrow(/Invalid id/);
    await expect(readNote(ctx, { id: 'notes/LAUNCH' })).rejects.toThrow(/Invalid id/);
  });
});

describe('get_page_image', () => {
  it('returns SVG markup', async () => {
    const r = await getPageImage(ctx, { noteId: 'LAUNCH', page: 1, format: 'svg' });
    expect(text(r, 0)).toContain('Page 1 of 2 of "Launch plan"');
    expect(text(r, 1)).toMatch(/^<svg [^>]*viewBox="0 0 793.7 1122.5"/);
    expect(text(r, 1)).toContain('<g id="ink"');
  });

  it('returns a PNG image when a renderer is available', async () => {
    const fake = vi.fn(async () => new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const c = await fx.ctx({ renderPng: fake });
    const r = await getPageImage(c, { noteId: 'SKETCH', page: 1, width: 800 });
    const img = r.content[0]!;
    expect(img.type).toBe('image');
    if (img.type === 'image') {
      expect(img.mimeType).toBe('image/png');
      expect(Buffer.from(img.data, 'base64')[1]).toBe(0x50);
    }
    expect(fake).toHaveBeenCalledWith(expect.stringContaining('<svg'), 800);
  });

  it('renders a real PNG with @resvg/resvg-js when installed', async () => {
    const c = await fx.ctx({ renderPng: undefined });
    const r = await getPageImage(c, { noteId: 'LAUNCH', page: 1, format: 'png', width: 300 });
    const first = r.content[0]!;
    if (first.type === 'image') {
      expect(Buffer.from(first.data, 'base64').subarray(1, 4).toString()).toBe('PNG');
    } else {
      expect(text(r, 0)).toMatch(/PNG rendering is unavailable/); // optional dependency missing
    }
  }, 30_000); // first native load + system font scan can be slow on a cold machine

  it('falls back to SVG with a note when PNG rendering is unavailable', async () => {
    const r = await getPageImage(ctx, { noteId: 'LAUNCH', page: 2 });
    expect(r.content.every((c) => c.type === 'text')).toBe(true);
    expect(text(r, 0)).toMatch(/PNG rendering is unavailable.*returning the page as SVG/);
    expect(text(r, 1)).toContain('<svg');
  });

  it('validates the page number', async () => {
    await expect(getPageImage(ctx, { noteId: 'LAUNCH', page: 3 })).rejects.toThrow(/has 2 pages/);
    await expect(getPageImage(ctx, { noteId: 'LAUNCH', page: 0 })).rejects.toThrow();
  });
});

describe('notebooks', () => {
  it('lists notebooks with paths and counts', async () => {
    const r = json(await listNotebooks(ctx));
    expect(r.notebooks.map((n: any) => n.path)).toEqual(['Personal', 'Work', 'Work / Projects']);
    expect(r.notebooks.find((n: any) => n.id === 'NBPROJECTS')).toMatchObject({ parentId: 'NBWORK', notes: 1 });
    expect(r.unfiledNotes).toBe(1);
  });

  it('creates notebooks and sections without duplicating', async () => {
    const r = json(await createNotebook(ctx, { name: 'Ideas', color: '#336699', parentId: 'NBPERSONAL' }));
    expect(r).toMatchObject({ created: true, notebook: { name: 'Ideas', color: '#FF336699', parentId: 'NBPERSONAL', path: 'Personal / Ideas' } });
    const onDisk = JSON.parse(await readFile(path.join(fx.dir, VaultLayout.notebookMeta(r.notebook.id)), 'utf8'));
    expect(onDisk).toMatchObject({ name: 'Ideas', formatVersion: 2 });
    expect(json(await createNotebook(ctx, { name: 'ideas', parentId: 'NBPERSONAL' }))).toMatchObject({ created: false, notebook: { id: r.notebook.id } });
    await expect(createNotebook(ctx, { name: 'X', parentId: 'NOPE' })).rejects.toThrow(/Parent notebook not found/);
    await expect(createNotebook(ctx, { name: 'X', color: 'red' })).rejects.toThrow();
  });
});

describe('create_note', () => {
  it('writes a paged note with the text on page 1 and all derived files', async () => {
    const r = json(await createNote(ctx, { title: 'Meeting notes', text: '# Agenda\n- ship it\n- [[Launch plan]]', notebookId: 'Personal', tags: ['meeting', '#Meeting', ' sync '], paper: 'dot_grid' }));
    expect(r).toMatchObject({ created: true, title: 'Meeting notes', notebook: 'Personal', tags: ['meeting', 'sync'], pages: 1 });
    const note = await diskNote(r.id);
    expect(note).toMatchObject({ title: 'Meeting notes', kind: 'paged', notebookId: 'NBPERSONAL', paper: { style: 'dot_grid' }, formatVersion: 2 });
    const page = await diskPage(r.id, note.pageIds[0]!);
    expect(page.texts).toHaveLength(1);
    expect(page.texts![0]).toMatchObject({ text: '# Agenda\n- ship it\n- [[Launch plan]]', font: 'sans', x: 128, y: 96 });
    const files = await readdir(path.join(fx.dir, 'notes', r.id, 'pages'));
    expect(files.sort()).toEqual([`${page.id}.ink.json`, `${page.id}.svg`]);
    expect(await readFile(path.join(fx.dir, VaultLayout.noteMarkdown(r.id)), 'utf8')).toContain('- ship it');
    // Immediately searchable and readable.
    expect(json(await searchNotes(ctx, { query: 'agenda' })).hits[0].id).toBe(r.id);
    expect(text(await readNote(ctx, { id: r.id }))).toContain('# Agenda');
  });

  it('creates an empty note without text and flows long text onto more pages', async () => {
    const empty = json(await createNote(ctx, { title: 'Blank' }));
    const page = await diskPage(empty.id, (await diskNote(empty.id)).pageIds[0]!);
    expect(page.texts ?? []).toHaveLength(0);
    const long = Array.from({ length: 120 }, (_, i) => `Line ${i + 1} of a long dictated memo`).join('\n');
    const r = json(await createNote(ctx, { title: 'Long memo', text: long }));
    expect(r.pages).toBeGreaterThan(1);
    const note = await diskNote(r.id);
    const pages = await Promise.all(note.pageIds.map((p) => diskPage(r.id, p)));
    const joined = pages.flatMap((p) => p.texts!.map((t) => t.text)).join('\n');
    expect(joined).toBe(long);
    for (const p of pages) for (const t of p.texts!) expect(t.y + textBoxHeight(t)).toBeLessThanOrEqual(note.pageSize.height);
  });

  it('rejects unknown notebooks', async () => {
    await expect(createNote(ctx, { title: 'X', notebookId: 'Nowhere' })).rejects.toThrow(/Notebook not found/);
  });
});

describe('append_to_note', () => {
  it('adds a text box below all existing content and bumps updatedAt', async () => {
    const before = await diskPage('LAUNCH', 'LAUNCHP2');
    const bottom = contentBounds(before).maxY;
    const r = json(await appendToNote(ctx, { id: 'LAUNCH', text: 'Follow-up: confirm the date' }));
    expect(r).toMatchObject({ appended: true, page: 2, newPages: 0, totalPages: 2 });
    const after = await diskPage('LAUNCH', 'LAUNCHP2');
    expect(after.texts).toHaveLength(2);
    expect(after.texts![1]!.text).toBe('Follow-up: confirm the date');
    expect(after.texts![1]!.y).toBeGreaterThan(bottom);
    expect((await diskNote('LAUNCH')).updatedAt).toBeGreaterThan(fx.notes.launch.updatedAt);
    expect(text(await readNote(ctx, { id: 'LAUNCH' }))).toContain('Follow-up: confirm the date');
  });

  it('places text below handwriting on an explicit page, leaving strokes untouched', async () => {
    const before = await diskPage('LAUNCH', 'LAUNCHP1');
    await appendToNote(ctx, { id: 'LAUNCH', text: 'Typed under the ink', page: 1 });
    const after = await diskPage('LAUNCH', 'LAUNCHP1');
    expect(after.strokes).toEqual(before.strokes);
    expect(after.recognizedText).toBe(before.recognizedText);
    expect(after.texts![0]!.y).toBeGreaterThan(contentBounds(before).maxY);
  });

  it('continues on a new page when the last page is full', async () => {
    const lines = Array.from({ length: 30 }, (_, i) => `item ${i}`).join('\n');
    for (let i = 0; i < 3; i++) await appendToNote(ctx, { id: 'GROCERIES', text: lines });
    const note = await diskNote('GROCERIES');
    expect(note.pageIds.length).toBeGreaterThan(1);
    const md = await readFile(path.join(fx.dir, VaultLayout.noteMarkdown('GROCERIES')), 'utf8');
    expect(md).toContain('## Page 2');
  });

  it('re-reads note.json before writing and keeps a concurrent change', async () => {
    const realRead = ctx.fs.readText.bind(ctx.fs);
    let metaReads = 0;
    vi.spyOn(ctx.fs, 'readText').mockImplementation(async (p: string) => {
      if (p === VaultLayout.noteMeta('LAUNCH') && ++metaReads === 2) {
        // Another device renames the note between our read and our write.
        await fx.external.updateNote('LAUNCH', (n) => ({ ...n, title: 'Launch plan v2', updatedAt: fx.now + 10 * HOUR }), { touch: false });
      }
      return realRead(p);
    });
    await appendToNote(ctx, { id: 'LAUNCH', text: 'Appended concurrently' });
    const note = await diskNote('LAUNCH');
    expect(note.title).toBe('Launch plan v2');
    expect(note.updatedAt).toBeGreaterThan(fx.now + 10 * HOUR);
    expect((await diskPage('LAUNCH', 'LAUNCHP2')).texts!.map((t) => t.text)).toContain('Appended concurrently');
  });

  it('refuses trashed notes and bad pages', async () => {
    await expect(appendToNote(ctx, { id: 'TRASHED', text: 'x' })).rejects.toThrow(/Trash/);
    await expect(appendToNote(ctx, { id: 'LAUNCH', text: 'x', page: 9 })).rejects.toThrow(/does not exist/);
  });
});

describe('update_note', () => {
  it('updates metadata and regenerates note.md', async () => {
    const r = json(await updateNote(ctx, { id: 'GROCERIES', title: 'Shopping', tags: ['errands'], pinned: true, summary: 'Weekly shop', notebookId: 'Work' }));
    expect(r.note).toMatchObject({ title: 'Shopping', tags: ['errands'], pinned: true, summary: 'Weekly shop', notebook: 'Work' });
    const note = await diskNote('GROCERIES');
    expect(note).toMatchObject({ title: 'Shopping', notebookId: 'NBWORK', pinned: true });
    expect(note.updatedAt).toBeGreaterThan(fx.notes.groceries.updatedAt);
    const md = await readFile(path.join(fx.dir, VaultLayout.noteMarkdown('GROCERIES')), 'utf8');
    expect(md).toContain('title: Shopping');
    expect(md).toContain('> Weekly shop');
    expect(md).toContain('- coffee');
  });

  it('unfiles with null and clears the summary', async () => {
    await updateNote(ctx, { id: 'OLDNOTE', notebookId: null, summary: null });
    const note = await diskNote('OLDNOTE');
    expect(note.notebookId).toBeUndefined();
    expect(note.summary).toBeUndefined();
  });

  it('keeps the newest updatedAt when the file on disk is ahead of our clock', async () => {
    const future = fx.now + 48 * HOUR;
    await fx.external.updateNote('SKETCH', (n) => ({ ...n, updatedAt: future }), { touch: false });
    await updateNote(ctx, { id: 'SKETCH', pinned: true });
    expect((await diskNote('SKETCH')).updatedAt).toBeGreaterThan(future);
  });

  it('requires at least one field', async () => {
    await expect(updateNote(ctx, { id: 'SKETCH' })).rejects.toThrow(/Nothing to update/);
  });
});

describe('trash_note / restore_note', () => {
  it('soft-deletes reversibly', async () => {
    const def = TOOLS.find((t) => t.name === 'trash_note')!;
    expect(def.description).toMatch(/reversible/i);
    const r = json(await trashNote(ctx, { id: 'SKETCH' }));
    expect(r).toMatchObject({ trashed: true, title: 'Whiteboard sketch' });
    expect((await diskNote('SKETCH')).trashedAt).toBeGreaterThan(0);
    expect(json(await listNotes(ctx, {})).notes.map((n: any) => n.id)).not.toContain('SKETCH');
    // Files are still there.
    expect(await readdir(path.join(fx.dir, 'notes', 'SKETCH', 'pages'))).toContain('SKETCHP1.ink.json');
    await restoreNote(ctx, { id: 'SKETCH' });
    expect((await diskNote('SKETCH')).trashedAt).toBeUndefined();
    expect(json(await listNotes(ctx, {})).notes.map((n: any) => n.id)).toContain('SKETCH');
  });
});

describe('get_recent_handwriting', () => {
  it('returns notes updated in the window with recognized text', async () => {
    const md = text(await getRecentHandwriting(ctx, { sinceHours: 24 }));
    expect(md).toContain('2 notes updated');
    expect(md).toContain('## Launch plan');
    expect(md).toContain('Launch the beta on Friday');
    expect(md).toMatch(/### Page 1 — 2 new strokes/);
    expect(md).toContain('## Whiteboard sketch');
    expect(md).toMatch(/not yet recognized — use get_page_image with noteId SKETCH and page 1/);
    expect(md).not.toContain('Grocery list');
    expect(md).not.toContain('Discarded idea');
  });

  it('widens with sinceHours and reports an empty window', async () => {
    expect(text(await getRecentHandwriting(ctx, { sinceHours: 24 * 30 }))).toContain('Deep work needs long uninterrupted blocks');
    expect(text(await getRecentHandwriting(ctx, { sinceHours: 0.2 }))).toMatch(/Nothing new/);
  });
});

describe('resources and prompts', () => {
  it('serves notes as Markdown and pages as SVG', async () => {
    const note = await readNoteResource(ctx, 'LAUNCH');
    expect(note.contents[0]).toMatchObject({ uri: 'inkwright://notes/LAUNCH', mimeType: 'text/markdown' });
    expect((note.contents[0] as { text: string }).text).toContain('Call Maria about pricing');
    const svg = await readPageSvgResource(ctx, 'LAUNCH', '2');
    expect(svg.contents[0]).toMatchObject({ uri: 'inkwright://notes/LAUNCH/pages/2.svg', mimeType: 'image/svg+xml' });
    await expect(readPageSvgResource(ctx, 'LAUNCH', '5')).rejects.toThrow(/does not exist/);
    await expect(readNoteResource(ctx, '..%2F..%2Fetc')).rejects.toThrow(/Invalid note id/);
    const list = await listNoteResources(ctx);
    expect(list.resources.map((r) => r.uri)).toContain('inkwright://notes/GROCERIES');
    expect(list.resources.map((r) => r.uri)).not.toContain('inkwright://notes/TRASHED');
  });

  it('builds prompts from note content', async () => {
    const s = await summarizeNotePrompt(ctx, { id: 'LAUNCH' });
    expect((s.messages[0]!.content as { text: string }).text).toContain('Launch the beta on Friday');
    const today = await dailyReviewPrompt(ctx, {});
    expect((today.messages[0]!.content as { text: string }).text).toContain('Whiteboard sketch');
    const todos = await todosFromNotesPrompt(ctx, { days: '30', notebook: 'Work' });
    const t = (todos.messages[0]!.content as { text: string }).text;
    expect(t).toContain('Launch plan');
    expect(t).not.toContain('Grocery list');
    await expect(dailyReviewPrompt(ctx, { date: 'yesterday' })).rejects.toThrow(/YYYY-MM-DD/);
  });
});

describe('read-only mode', () => {
  it('hides write tools and rejects writes without touching the vault', async () => {
    const ro = await fx.ctx({ readOnly: true });
    const names = activeTools(ro).map((t) => t.name);
    // The developer module's tools (dev/tools.ts) only read, and the context tools (proxy/tools.ts) don't touch the vault, so they stay.
    expect(names).toEqual(['list_notes', 'search_notes', 'read_note', 'get_page_image', 'list_notebooks', 'get_recent_handwriting', 'code_search', 'code_symbol', 'drift_report', 'get_runbook', 'validate_diagram', 'compress_and_store', 'retrieve_original']);
    expect(activeTools(ctx).map((t) => t.name)).toContain('create_note');
    const before = (await readdir(path.join(fx.dir, 'notes'))).sort();
    await expect(createNote(ro, { title: 'nope' })).rejects.toThrow(/read-only/);
    await expect(appendToNote(ro, { id: 'LAUNCH', text: 'nope' })).rejects.toThrow(/read-only/);
    await expect(updateNote(ro, { id: 'LAUNCH', title: 'nope' })).rejects.toThrow(/read-only/);
    await expect(trashNote(ro, { id: 'LAUNCH' })).rejects.toThrow(/read-only/);
    await expect(createNotebook(ro, { name: 'nope' })).rejects.toThrow(/read-only/);
    expect((await readdir(path.join(fx.dir, 'notes'))).sort()).toEqual(before);
    expect((await diskNote('LAUNCH')).title).toBe('Launch plan');
    expect(json(await listNotes(ro, {})).total).toBe(4);
  });

  it('does not create a manifest in a read-only empty folder', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'inkwright-ro-'));
    try {
      const ro = await createContext({ root: dir, readOnly: true, watch: false });
      expect(json(await listNotes(ro, {})).total).toBe(0);
      expect(await readdir(dir)).toEqual([]);
      ro.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('path safety (NodeFS)', () => {
  it('refuses paths that escape the vault', async () => {
    const fs = new NodeFS(fx.dir);
    for (const bad of ['../x', 'notes/../../x', '/etc/passwd', 'C:/x', 'notes\\..\\x', 'a\0b']) {
      await expect(fs.readText(bad)).rejects.toThrow(/Unsafe|escapes/);
      await expect(fs.writeText(bad, 'x')).rejects.toThrow(/Unsafe|escapes/);
    }
    await expect(fs.deleteDir('')).rejects.toThrow(/vault root/);
  });

  it('refuses to follow symlinks out of the vault', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'inkwright-outside-'));
    try {
      await mkdir(path.join(outside, 'EVIL'), { recursive: true });
      await writeFile(path.join(outside, 'EVIL', 'note.json'), JSON.stringify({ id: 'EVIL', title: 'outside' }));
      await symlink(path.join(outside, 'EVIL'), path.join(fx.dir, 'notes', 'EVIL'));
      await expect(ctx.fs.readText('notes/EVIL/note.json')).rejects.toThrow(/escapes/);
      await expect(ctx.fs.writeText('notes/EVIL/pages/x.ink.json', '{}')).rejects.toThrow(/escapes/);
      await expect(readNote(ctx, { id: 'EVIL' })).rejects.toThrow(/escapes/);
      expect(await readdir(path.join(outside, 'EVIL'))).toEqual(['note.json']);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('writes atomically and hides temp files', async () => {
    const fs = new NodeFS(fx.dir);
    await fs.writeText('notes/NEW/note.json', '{"id":"NEW"}');
    await writeFile(path.join(fx.dir, 'notes', 'NEW', '.inkwright-tmp-123-abc'), 'partial');
    expect((await fs.list('notes/NEW')).map((e) => e.name)).toEqual(['note.json']);
    expect(await fs.readText('notes/NEW/note.json')).toBe('{"id":"NEW"}');
    expect(await fs.readText('notes/NEW/missing.json')).toBeNull();
    expect(await fs.list('does/not/exist')).toEqual([]);
  });
});

describe('helpers', () => {
  it('splits text at paragraph boundaries to fit a height', () => {
    const [a, b] = splitToFit('one\ntwo\nthree\nfour', 400, 16 * 1.35 * 2 + 1);
    expect(a).toBe('one\ntwo');
    expect(b).toBe('three\nfour');
    expect(splitToFit('short', 400, Infinity)).toEqual(['short', '']);
    expect(splitToFit('x', 400, 1)).toEqual(['', 'x']);
  });

  it('parses the command line', () => {
    expect(parseCli(['--vault', '/tmp/v', '--read-only'], {})).toMatchObject({ vault: '/tmp/v', readOnly: true, watch: true });
    expect(parseCli([], { INKWRIGHT_VAULT: '/x/y' }).vault).toBe('/x/y');
    expect(parseCli(['--vault', '~/Notes'], {}).vault).toMatch(/Notes$/);
    expect(parseCli(['--vault', 'v', '--http', '8765', '--token', 's'], {})).toMatchObject({ http: 8765, token: 's' });
    expect(() => parseCli(['--http', 'abc'], {})).toThrow(/port/);
    expect(() => parseCli(['--token', 's'], {})).toThrow(/--http/);
    expect(() => parseCli(['--bogus'], {})).toThrow();
  });
});
