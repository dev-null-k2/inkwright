import { describe, expect, it } from 'vitest';
import {
  MemoryFS, Vault, VaultLayout, decodeNote, decodePage, decodePoint, encodePage, encodePoint, exportMarkdown, exportPageSvg,
  newId, isSafeId, parseArgb, formatArgb, argbToCss, cssHexToArgb, sanitizePoints, walk, type PageInk,
} from '../src/index.ts';
import { stroke, word } from './helpers.ts';

describe('ids & colors', () => {
  it('ids are 22 chars, safe and time-sortable', () => {
    const a = newId(1000), b = newId(2000);
    expect(a).toHaveLength(22);
    expect(isSafeId(a)).toBe(true);
    expect(a < b).toBe(true);
    expect(isSafeId('../x')).toBe(false);
  });
  it('round-trips colors', () => {
    expect(formatArgb(parseArgb('#80112233'))).toBe('#80112233');
    expect(parseArgb('#112233')).toBe(0xff112233);
    expect(parseArgb('nonsense')).toBe(0xff000000);
    expect(argbToCss('#80FF0000')).toBe('rgba(255,0,0,0.502)');
    expect(cssHexToArgb('#ff0000')).toBe('#FFFF0000');
  });
  it('sanitizes points', () => {
    const p = (x: number, t: number) => ({ x, y: 0, t, p: -1, tilt: -1, orient: -1 });
    const out = sanitizePoints([p(0, 5), p(0, 6), p(1, 3), p(NaN, 9), p(2, -1)]);
    expect(out.map((q) => q.x)).toEqual([0, 1, 2]);
    expect(out.map((q) => q.t)).toEqual([5, 5, 5]);
  });
});

describe('codec', () => {
  it('encodes points compactly and only with present fields', () => {
    expect(encodePoint({ x: 1.234, y: 2, t: 3, p: -1, tilt: -1, orient: -1 })).toEqual([1.23, 2, 3]);
    expect(encodePoint({ x: 1, y: 2, t: 3, p: 0.51234, tilt: -1, orient: -1 })).toEqual([1, 2, 3, 0.512]);
    expect(encodePoint({ x: 1, y: 2, t: 3, p: -1, tilt: -1, orient: 1 })).toEqual([1, 2, 3, -1, -1, 1]);
    expect(decodePoint([1, 2, 3])).toEqual({ x: 1, y: 2, t: 3, p: -1, tilt: -1, orient: -1 });
  });
  it('round-trips a page and tolerates unknown fields', () => {
    const page: PageInk = { id: 'p', strokes: [stroke('s', word(0, 0))], formatVersion: 2, texts: [{ id: 't', x: 0, y: 0, width: 10, text: 'hi', fontSize: 12, color: '#FF000000', font: 'sans', createdAt: 0 }] };
    const back = decodePage(encodePage(page));
    expect(back.strokes[0]!.points).toHaveLength(101);
    expect(back.texts![0]!.text).toBe('hi');
    const withExtra = decodePage(JSON.stringify({ id: 'p', strokes: [], futureField: 42 }));
    expect((withExtra as any).futureField).toBe(42);
  });
  it('reads v1 notes from the Android prototype', () => {
    const v1 = '{"id":"n","title":"Old","kind":"paged","paper":{"style":"ruled_narrow","tint":"ivory","texture":"standard","spacing":0.0},"pageSize":{"name":"A4","width":793.7,"height":1122.5},"pageIds":["p"],"notebookId":null,"tags":[],"createdAt":1,"updatedAt":2,"pinned":false,"formatVersion":1}';
    const n = decodeNote(v1);
    expect(n.title).toBe('Old');
    expect(n.paper.style).toBe('ruled_narrow');
    expect(n.formatVersion).toBe(1);
  });
});

describe('Vault', () => {
  it('creates, lists, saves, trashes, restores and deletes notes', async () => {
    const fs = new MemoryFS();
    const v = new Vault(fs, () => 5000);
    await v.init();
    const { note, pages } = await v.createNote({ title: 'Lecture 1', tags: ['bio'] });
    expect((await v.listNotes()).map((n) => n.title)).toEqual(['Lecture 1']);
    const page = { ...pages[0]!, strokes: [stroke('s1', word(100, 200))], recognizedText: 'mitochondria' };
    await v.saveNote(note, [page]);
    expect((await v.readPage(note.id, page.id)).strokes).toHaveLength(1);
    const md = await fs.readText(VaultLayout.noteMarkdown(note.id));
    expect(md).toContain('mitochondria');
    expect(await fs.readText(VaultLayout.pageSvg(note.id, page.id))).toContain('<path');
    await v.trashNote(note.id);
    expect(await v.listNotes()).toHaveLength(0);
    expect(await v.listNotes({ includeTrashed: true })).toHaveLength(1);
    await v.restoreNote(note.id);
    expect(await v.listNotes()).toHaveLength(1);
    await v.deleteNote(note.id);
    expect(await walk(fs, 'notes')).toEqual([]);
  });

  it('a fresh Vault instance re-reads everything from files', async () => {
    const fs = new MemoryFS();
    const v1 = new Vault(fs);
    await v1.init();
    const nb = await v1.createNotebook('School');
    const { note } = await v1.createNote({ title: 'A', notebookId: nb.id });
    const v2 = new Vault(fs);
    expect((await v2.listNotes())[0]!.id).toBe(note.id);
    expect((await v2.listNotebooks())[0]!.name).toBe('School');
  });

  it('skips corrupt files instead of failing the library', async () => {
    const fs = new MemoryFS();
    const v = new Vault(fs);
    await v.createNote({ title: 'Good' });
    await fs.writeText('notes/BAD/note.json', '{not json');
    expect((await new Vault(fs).listNotes()).map((n) => n.title)).toEqual(['Good']);
  });

  it('duplicates notes with fresh ids and copied assets', async () => {
    const fs = new MemoryFS();
    const v = new Vault(fs);
    const { note, pages } = await v.createNote({ title: 'A' });
    await v.writeAsset(note.id, 'img.png', new Uint8Array([1, 2, 3]));
    await v.saveNote(note, [{ ...pages[0]!, strokes: [stroke('s', word(0, 0))] }]);
    const copy = (await v.duplicateNote(note.id))!;
    expect(copy.id).not.toBe(note.id);
    expect(copy.title).toBe('A (copy)');
    const cp = await v.readPages(copy);
    expect(cp[0]!.strokes[0]!.id).not.toBe('s');
    expect(await v.readAsset(copy.id, 'img.png')).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('deleting a notebook unfiles its notes and re-parents children', async () => {
    const v = new Vault(new MemoryFS());
    const parent = await v.createNotebook('P');
    const nb = await v.createNotebook('School', undefined, parent.id);
    const child = await v.createNotebook('Bio', undefined, nb.id);
    const { note } = await v.createNote({ title: 'A', notebookId: nb.id });
    await v.deleteNotebook(nb.id);
    expect((await v.readNote(note.id))!.notebookId).toBeUndefined();
    expect((await v.listNotebooks()).find((n) => n.id === child.id)!.parentId).toBe(parent.id);
  });

  it('rejects unsafe ids and asset names', async () => {
    const v = new Vault(new MemoryFS());
    await expect(v.readNote('../../etc')).rejects.toThrow();
    const { note } = await v.createNote({ title: 'A' });
    await expect(v.writeAsset(note.id, '../x', new Uint8Array())).rejects.toThrow();
  });

  it('purges old trash only', async () => {
    let now = 0;
    const v = new Vault(new MemoryFS(), () => now);
    const a = (await v.createNote({ title: 'old' })).note;
    const b = (await v.createNote({ title: 'new' })).note;
    await v.trashNote(a.id);
    now = 40 * 864e5;
    await v.trashNote(b.id);
    expect(await v.purgeTrash()).toBe(1);
    expect((await v.listNotes({ includeTrashed: true })).map((n) => n.title)).toEqual(['new']);
  });
});

describe('exporters', () => {
  const note = { id: 'n', title: 'Plan: Q3 "launch"', kind: 'paged' as const, paper: { style: 'cornell' as const, tint: 'ivory' as const, texture: 'standard' as const, spacing: 0 }, pageSize: { name: 'A4', width: 793.7, height: 1122.5 }, pageIds: ['p'], tags: ['work'], createdAt: 0, updatedAt: 0, pinned: false, formatVersion: 2 };
  it('svg includes paper, ink, text and escapes titles', () => {
    const svg = exportPageSvg(note, { id: 'p', strokes: [stroke('s', word(100, 200)), stroke('h', word(100, 260), 16, 'highlighter')], texts: [{ id: 't', x: 10, y: 10, width: 300, text: 'A & B', fontSize: 14, color: '#FF000000', font: 'serif', createdAt: 0 }], formatVersion: 2 });
    expect(svg).toContain('viewBox="0 0 793.7 1122.5"');
    expect(svg).toContain('&quot;launch&quot;');
    expect(svg).toContain('A &amp; B');
    expect(svg).toContain('mix-blend-mode:multiply');
    expect(svg.indexOf('mix-blend-mode')).toBeLessThan(svg.lastIndexOf('<path d'));
  });
  it('board svg fits its ink', () => {
    const svg = exportPageSvg({ ...note, kind: 'board', pageSize: { name: 'Infinite', width: 0, height: 0 } }, { id: 'p', strokes: [stroke('s', word(100, 200))], formatVersion: 2 });
    const vb = /viewBox="([^"]+)"/.exec(svg)![1]!.split(' ').map(Number);
    expect(vb[0]).toBeLessThan(100);
    expect(vb[2]).toBeGreaterThan(100);
  });
  it('markdown has front matter, text and image links', () => {
    const md = exportMarkdown(note, [{ id: 'p', strokes: [stroke('s', word(0, 0))], recognizedText: 'buy milk', formatVersion: 2 }, { id: 'q', strokes: [], formatVersion: 2 }]);
    expect(md).toMatch(/^---\nid: n\ntitle: "Plan: Q3 \\"launch\\""/);
    expect(md).toContain('tags: [work]');
    expect(md).toContain('buy milk');
    expect(md).toContain('_(blank)_');
    expect(md).toContain('![Page 2](pages/q.svg)');
  });
});

describe('Vault robustness', () => {
  it('ignores note.json files whose id is unsafe or does not match their folder', async () => {
    const fs = new MemoryFS();
    const v = new Vault(fs);
    await v.createNote({ title: 'Good' });
    await fs.writeText('notes/Meeting notes.v2/note.json', JSON.stringify({ id: 'Meeting notes.v2', title: 'Bad', pageIds: ['x'], createdAt: 0, updatedAt: 0 }));
    await fs.writeText('notes/AAA/note.json', JSON.stringify({ id: 'BBB', title: 'Mismatch', pageIds: [], createdAt: 0, updatedAt: 0 }));
    const notes = await new Vault(fs).listNotes();
    expect(notes.map((n) => n.title)).toEqual(['Good']);
  });
});
