import { describe, expect, it } from 'vitest';
import { BranchStore, MemoryFS, Vault, newId, point, type InkStroke, type NoteMeta, type PageInk, type TextBox } from '@inkwright/core';
import { mergeBranchNote, mergePage } from '../src/index.ts';

let now = 10_000;
const clock = () => now;

const ink = (x: number, author?: { id: string; name: string }): InkStroke => ({
  id: newId(++now),
  pen: 'ballpoint',
  color: '#FF1B1F24',
  size: 1.8,
  createdAt: now,
  points: [point(x, 10, 0, 0.5), point(x + 30, 20, 16, 0.6)],
  ...(author ? { author } : {}),
});
const box = (s: string): TextBox => ({ id: newId(++now), x: 10, y: 300, width: 200, text: s, fontSize: 16, color: '#FF000000', font: 'sans', createdAt: now });

async function read(vault: Vault, id: string) {
  const meta = (await vault.readNote(id))!;
  return { meta, pages: await vault.readPages(meta) };
}

describe('merging a branch into the notes', () => {
  it('keeps edits made in the notes since the branch started, and adds the branch’s', async () => {
    const fs = new MemoryFS(clock);
    const vault = new Vault(fs, clock);
    await vault.init();
    const { note, pages } = await vault.createNote({ title: 'Trip' });
    pages[0]!.strokes.push(ink(10));
    await vault.saveNote({ ...note, updatedAt: ++now }, pages);

    // The assistant's proposal goes onto a branch: a text box and a new title.
    const store = new BranchStore(fs, clock);
    const b = await store.create('Assistant', { source: 'assistant', label: 'Assistant' });
    const ws = await store.workspace(b);
    const w = await read(ws.vault, note.id);
    w.pages[0] = { ...w.pages[0]!, texts: [box('Packing list from the assistant')] };
    await ws.vault.saveNote({ ...w.meta, title: 'Trip to Lisbon', updatedAt: ++now }, w.pages);
    await store.capture(b, ws);

    // Meanwhile the person keeps writing in the note and adds a tag.
    const mine = await read(vault, note.id);
    const s2 = ink(80);
    mine.pages[0]!.strokes.push(s2);
    await vault.saveNote({ ...mine.meta, tags: ['travel'], updatedAt: ++now }, mine.pages);

    const sides = (await store.sides((await store.get(b.id))!, note.id))!;
    const merged = mergeBranchNote(sides.base, await read(vault, note.id), sides.head);
    expect(merged.threeWay).toBe(true);
    expect(merged.meta.title).toBe('Trip to Lisbon');
    expect(merged.meta.tags).toEqual(['travel']);
    expect(merged.pages[0]!.strokes.map((s) => s.id)).toContain(s2.id);
    expect(merged.pages[0]!.texts!.map((t) => t.text)).toEqual(['Packing list from the assistant']);
  });

  it('brings a note created on the branch over as it is', () => {
    const meta = { id: 'n', title: 'New', pageIds: ['p'], updatedAt: 1 } as NoteMeta;
    const pages: PageInk[] = [{ id: 'p', strokes: [], formatVersion: 2 }];
    expect(mergeBranchNote(null, null, { meta, pages })).toEqual({ meta, pages, threeWay: false });
  });

  it('keeps a page added on either side and drops one the branch deleted untouched', () => {
    const p = (id: string, strokes: InkStroke[] = []): PageInk => ({ id, strokes, formatVersion: 2 });
    const m = (pageIds: string[]) => ({ id: 'n', title: 'T', pageIds, updatedAt: 1, tags: [], createdAt: 0, kind: 'paged', pinned: false, formatVersion: 2 }) as unknown as NoteMeta;
    const a = p('a');
    const gone = p('gone');
    const base = { meta: m(['a', 'gone']), pages: [a, gone] };
    const main = { meta: m(['a', 'gone', 'mainNew']), pages: [a, gone, p('mainNew')] };
    const head = { meta: m(['a', 'branchNew']), pages: [a, p('branchNew')] };
    const merged = mergeBranchNote(base, main, head);
    expect(merged.meta.pageIds[0]).toBe('a');
    expect([...merged.meta.pageIds].sort()).toEqual(['a', 'branchNew', 'mainNew']);
    expect(merged.pages.map((x) => x.id)).toEqual(merged.meta.pageIds);
  });
});

describe('collaborator authorship through sync', () => {
  it('keeps who wrote a stroke when pages merge three ways', () => {
    const grace = { id: 'G1', name: 'Grace' };
    const theirs = ink(10, grace);
    const base: PageInk = { id: 'p', strokes: [], formatVersion: 2 };
    const local: PageInk = { ...base, strokes: [theirs] };
    const remote: PageInk = { ...base, strokes: [ink(50)] };
    const merged = mergePage(base, local, remote);
    expect(merged.strokes.find((s) => s.id === theirs.id)!.author).toEqual(grace);
    expect(merged.strokes).toHaveLength(2);
  });
});
