import { describe, expect, it } from 'vitest';
import {
  AsOfFS,
  BranchStore,
  MemoryFS,
  OverlayFS,
  Vault,
  VaultLayout,
  VersionHistory,
  walk,
  type NoteMeta,
  type PageInk,
  type TextBox,
} from '../src/index.ts';
import { stroke, word } from './helpers.ts';

let now = 1_000_000;
const clock = () => now;
const at = (t: number) => {
  now = t;
};

function text(id: string, s: string): TextBox {
  return { id, x: 10, y: 10, width: 200, text: s, fontSize: 16, color: '#FF000000', font: 'sans', createdAt: now };
}

async function setup() {
  const fs = new MemoryFS(clock);
  const vault = new Vault(fs, clock);
  await vault.init();
  return { fs, vault, history: new VersionHistory(vault, clock) };
}

async function save(vault: Vault, meta: NoteMeta, pages: PageInk[]) {
  const m = { ...meta, updatedAt: now };
  await vault.saveNote(m, pages);
  return m;
}

describe('AsOfFS: the vault as of a date', () => {
  it('shows each note as it was, leaves out later notes, and keeps the present untouched', async () => {
    const { fs, vault, history } = await setup();
    at(1000);
    const { note, pages } = await vault.createNote({ title: 'Lecture 1' });
    pages[0]!.texts = [text('t1', 'first draft')];
    let meta = await save(vault, note, pages);
    at(2000);
    await history.take(meta, pages, 'close');
    at(3000);
    pages[0]!.texts = [text('t1', 'rewritten later')];
    meta = await save(vault, { ...meta, title: 'Lecture 1 (final)' }, pages);
    at(4000);
    await vault.createNote({ title: 'Born later' });

    const past = await AsOfFS.open(fs, 2500);
    const pv = new Vault(past);
    const list = await pv.listNotes();
    expect(list.map((n) => n.title)).toEqual(['Lecture 1']);
    const pPages = await pv.readPages(list[0]!);
    expect(pPages[0]!.texts![0]!.text).toBe('first draft');
    expect(past.report.notes.get(note.id)!.source).toBe('snapshot');

    // Writes to the past are dropped; the present is unchanged.
    await pv.saveNote({ ...list[0]!, title: 'tampered' }, pPages);
    const present = new Vault(fs);
    expect((await present.readNote(note.id))!.title).toBe('Lecture 1 (final)');

    const later = new Vault(await AsOfFS.open(fs, 5000));
    expect((await later.listNotes()).map((n) => n.title).sort()).toEqual(['Born later', 'Lecture 1 (final)']);
  });

  it('reports notes whose past is not recorded instead of showing today’s content', async () => {
    const { fs, vault } = await setup();
    at(1000);
    const { note, pages } = await vault.createNote({ title: 'No history' });
    at(3000);
    await save(vault, note, pages);
    const past = await AsOfFS.open(fs, 2000);
    expect(past.report.unknown.map((u) => u.title)).toEqual(['No history']);
    expect(await new Vault(past).listNotes()).toEqual([]);
  });

  it('follows the trash in time', async () => {
    const { fs, vault } = await setup();
    at(1000);
    const { note } = await vault.createNote({ title: 'Old' });
    at(5000);
    await vault.updateNote(note.id, (n) => ({ ...n, trashedAt: 5000 }), { touch: false });
    const before = new Vault(await AsOfFS.open(fs, 2000));
    expect((await before.listNotes()).map((n) => n.title)).toEqual(['Old']);
    const after = new Vault(await AsOfFS.open(fs, 6000));
    expect(await after.listNotes()).toEqual([]);
  });
});

describe('OverlayFS', () => {
  it('reads through, writes and deletes only in the overlay', async () => {
    const base = new MemoryFS(clock);
    await base.writeText('a/x.txt', 'x');
    await base.writeText('a/y.txt', 'y');
    const o = new OverlayFS(base);
    await o.writeText('a/z.txt', 'z');
    await o.delete('a/x.txt');
    expect((await o.list('a')).map((e) => e.name)).toEqual(['y.txt', 'z.txt']);
    expect(await o.readText('a/x.txt')).toBeNull();
    expect(await base.readText('a/x.txt')).toBe('x');
    await o.deleteDir('a');
    expect(await o.list('')).toEqual([]);
    expect(base.paths()).toEqual(['a/x.txt', 'a/y.txt']);
  });
});

describe('BranchStore', () => {
  it('records a branch as references to shared blobs, leaves the notes alone, and survives pruning', async () => {
    const { fs, vault, history } = await setup();
    at(1000);
    const { note, pages } = await vault.createNote({ title: 'Plan' });
    pages[0]!.strokes.push(stroke('ink1', word(10, 40, 60)));
    pages.push({ id: 'second', strokes: [stroke('ink2', word(10, 80, 60))], formatVersion: 2 });
    const meta = await save(vault, { ...note, pageIds: [pages[0]!.id, 'second'] }, pages);
    await history.take(meta, pages, 'close');

    const store = new BranchStore(fs, clock);
    at(2000);
    const b = await store.create('Assistant tidy-up', { source: 'assistant', label: 'Assistant' });
    const ws = await store.workspace(b);
    const loaded = (await ws.vault.readNote(note.id))!;
    const wsPages = await ws.vault.readPages(loaded);
    wsPages[0] = { ...wsPages[0]!, texts: [text('t-new', 'Summary from the assistant')] };
    await ws.vault.saveNote({ ...loaded, title: 'Plan (tidied)', updatedAt: now }, wsPages);
    expect(await store.capture(b, ws, 'proposal1')).toEqual([note.id]);

    // Main is untouched.
    expect((await vault.readNote(note.id))!.title).toBe('Plan');
    // Both sides are there; the unchanged second page is the very blob version history has.
    const sides = (await store.sides((await store.get(b.id))!, note.id))!;
    expect(sides.base!.meta.title).toBe('Plan');
    expect(sides.head.meta.title).toBe('Plan (tidied)');
    expect(sides.head.pages[0]!.texts![0]!.text).toBe('Summary from the assistant');
    const blobs = (await walk(fs)).filter((p) => p.includes('/history/blobs/'));
    expect(blobs).toHaveLength(3); // two pages in history + one changed page on the branch

    // Pruning version history down to nothing keeps what the open branch still shows.
    for (const s of await history.list(note.id)) await fs.delete(`${VaultLayout.noteDir(note.id)}/history/${s.id}.json`);
    await history.prune(note.id, now);
    expect((await store.sides((await store.get(b.id))!, note.id))!.head.pages).toHaveLength(2);

    // A second proposal stacks on the branch.
    const again = (await store.get(b.id))!;
    const ws2 = await store.workspace(again);
    const m2 = (await ws2.vault.readNote(note.id))!;
    expect(m2.title).toBe('Plan (tidied)');
    const created = await ws2.vault.createNote({ title: 'New on branch' });
    await store.capture(again, ws2, 'proposal2');
    const info = (await store.list())[0]!;
    expect(info.notes.map((n) => [n.title, n.isNew]).sort()).toEqual([['New on branch', true], ['Plan (tidied)', false]]);
    expect(info.proposals).toBe(2);
    expect(await vault.readNote(created.note.id)).toBeNull();

    // Discarding removes what only the branch had.
    await store.decide(b.id, 'discarded');
    expect((await walk(fs)).some((p) => p.startsWith(VaultLayout.noteDir(created.note.id)))).toBe(false);
    expect((await store.get(b.id))!.status).toBe('discarded');
  });
});
