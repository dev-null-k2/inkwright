import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MemoryFS, Vault, decodeNote, decodePage, newId, newPage, point, walk, type InkStroke, type VaultFS } from '@inkwright/core';
import {
  FileSystemAccessFS,
  FolderRemote,
  FsStateStore,
  MemoryRemote,
  MemoryStateStore,
  RemoteError,
  SyncEngine,
  SyncSafetyError,
  decide,
  hasLocalChanges,
  isIgnoredPath,
  type SyncEngineOptions,
  type SyncProgress,
  type SyncStateStore,
} from '../src/index.ts';
import { NodeFS } from '../src/node.ts';
import { FakeDirectoryHandle } from './helpers/fake-fsa.ts';

let now = 1_700_000_000_000;
const clock = () => (now += 1000);

function stroke(createdAt: number, x = 0): InkStroke {
  return { id: newId(createdAt), pen: 'ballpoint', color: '#FF1B1F24', size: 1.8, createdAt, points: [point(x, 10, 0, 0.5), point(x + 20, 30, 16, 0.7), point(x + 40, 12, 33, 0.6)] };
}

interface Device {
  fs: MemoryFS;
  vault: Vault;
  state: SyncStateStore;
  engine: SyncEngine;
}

function device(remote: MemoryRemote, opts: Partial<SyncEngineOptions> = {}): Device {
  const fs = new MemoryFS(clock);
  const state = opts.state ?? new MemoryStateStore();
  return { fs, vault: new Vault(fs, clock), state, engine: new SyncEngine({ local: fs, remote, state, clock, ...opts }) };
}

async function snapshot(fs: VaultFS): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of (await walk(fs)).sort()) out[p] = (await fs.readText(p))!;
  return out;
}

function remoteSnapshot(r: MemoryRemote): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of r.paths()) out[p] = r.text(p)!;
  return out;
}

async function seedVault(d: Device, notes = 1) {
  await d.vault.init();
  const created = [];
  for (let i = 0; i < notes; i++) {
    const { note, pages } = await d.vault.createNote({ title: `Note ${i}` });
    pages[0]!.strokes.push(stroke(clock(), 10), stroke(clock(), 60));
    await d.vault.saveNote(note, pages);
    created.push({ note, pages });
  }
  return created;
}

describe('decide()', () => {
  const b = { hash: 'h', rev: 'r' };
  it('covers the action table', () => {
    expect(decide(null, null, null)).toBe('skip');
    expect(decide(null, null, b)).toBe('forget');
    expect(decide('h', null, null)).toBe('push');
    expect(decide(null, 'r', null)).toBe('pull');
    expect(decide('h', 'r', null)).toBe('conflict');
    expect(decide('h', 'r', b)).toBe('skip');
    expect(decide('h2', 'r', b)).toBe('push');
    expect(decide(null, 'r', b)).toBe('delete-remote');
    expect(decide('h', 'r2', b)).toBe('pull');
    expect(decide('h', null, b)).toBe('delete-local');
    expect(decide('h2', 'r2', b)).toBe('conflict');
    expect(decide(null, 'r2', b)).toBe('pull'); // remote edit beats local delete
    expect(decide('h2', null, b)).toBe('push'); // local edit beats remote delete
  });

  it('ignores app-internal and junk paths', () => {
    expect(isIgnoredPath('.inkwright/index.sqlite')).toBe(true);
    expect(isIgnoredPath('notes/n/.DS_Store')).toBe(true);
    expect(isIgnoredPath('notes/n/note.json.abc.inkwright-tmp')).toBe(true);
    expect(isIgnoredPath('notes/n/note.json')).toBe(false);
  });
});

describe('SyncEngine', () => {
  it('pushes a new vault, pulls it on a second device, then is a no-op', async () => {
    const remote = new MemoryRemote({ clock });
    const a = device(remote);
    const b = device(remote);
    await seedVault(a, 2);
    const files = (await walk(a.fs)).length;

    const r1 = await a.engine.sync();
    expect(r1.pushed).toHaveLength(files);
    expect(r1.errors).toEqual([]);
    expect(remote.paths()).toEqual((await walk(a.fs)).sort());

    const r2 = await b.engine.sync();
    expect(r2.pulled).toHaveLength(files);
    expect(hasLocalChanges(r2)).toBe(true);
    expect(await snapshot(b.fs)).toEqual(await snapshot(a.fs));
    await b.vault.invalidate();
    expect((await b.vault.listNotes()).map((n) => n.title).sort()).toEqual(['Note 0', 'Note 1']);

    remote.calls.length = 0;
    const r3 = await a.engine.sync();
    expect(r3).toMatchObject({ pushed: [], pulled: [], merged: [], errors: [], unchanged: files });
    expect(remote.calls.map((c) => c.op)).toEqual(['list']);
  });

  it('two devices editing the same note offline converge to identical vaults with no lost strokes', async () => {
    const remote = new MemoryRemote({ clock });
    const a = device(remote);
    const b = device(remote);
    const [{ note }] = await seedVault(a);
    await a.engine.sync();
    await b.engine.sync();

    // --- offline on A: two strokes on page 1, a new page with a stroke, a tag.
    const na = (await a.vault.readNote(note!.id))!;
    const pa = await a.vault.readPages(na);
    const a1 = stroke(clock(), 100);
    const a2 = stroke(clock(), 140);
    pa[0]!.strokes.push(a1, a2);
    const p2 = newPage(newId(clock()));
    const a3 = stroke(clock(), 5);
    p2.strokes.push(a3);
    await a.vault.saveNote({ ...na, pageIds: [...na.pageIds, p2.id], tags: ['from-a'], updatedAt: clock() }, [...pa, p2]);

    // --- offline on B: one stroke on page 1, erase the first original stroke, rename (later).
    const nb = (await b.vault.readNote(note!.id))!;
    const pb = await b.vault.readPages(nb);
    const erased = pb[0]!.strokes[0]!.id;
    const b1 = stroke(clock(), 200);
    pb[0]!.strokes = [...pb[0]!.strokes.slice(1), b1];
    await b.vault.saveNote({ ...nb, title: 'Renamed on B', updatedAt: clock() }, pb);

    const ra = await a.engine.sync();
    expect(ra.merged).toEqual([]);
    const rb = await b.engine.sync();
    expect(rb.merged.sort()).toEqual([`notes/${note!.id}/note.json`, `notes/${note!.id}/pages/${na.pageIds[0]}.ink.json`].sort());
    expect(rb.errors).toEqual([]);
    const ra2 = await a.engine.sync();
    expect(ra2.errors).toEqual([]);

    // Identical everywhere.
    const sa = await snapshot(a.fs);
    expect(await snapshot(b.fs)).toEqual(sa);
    expect(remoteSnapshot(remote)).toEqual(sa);

    // Nothing lost: every stroke except the one B erased.
    const merged = decodeNote(sa[`notes/${note!.id}/note.json`]!);
    expect(merged.title).toBe('Renamed on B');
    expect(merged.tags).toEqual(['from-a']);
    expect(merged.pageIds).toEqual([na.pageIds[0], p2.id]);
    const page1 = decodePage(sa[`notes/${note!.id}/pages/${na.pageIds[0]}.ink.json`]!);
    const ids = page1.strokes.map((s) => s.id);
    expect(ids).toHaveLength(4);
    expect(ids).not.toContain(erased);
    for (const s of [a1, a2, b1]) expect(ids).toContain(s.id);
    expect(decodePage(sa[`notes/${note!.id}/pages/${p2.id}.ink.json`]!).strokes.map((s) => s.id)).toEqual([a3.id]);
    // Derived files were regenerated from the merged sources.
    expect(sa[`notes/${note!.id}/note.md`]).toContain('Renamed on B');
    expect(sa[`notes/${note!.id}/pages/${p2.id}.svg`]).toContain('<svg');

    // Stable: further syncs change nothing.
    for (const d of [a, b]) {
      const r = await d.engine.sync();
      expect([...r.pushed, ...r.pulled, ...r.merged]).toEqual([]);
    }
  });

  it('propagates deletions and keeps edits that race with a deletion', async () => {
    const remote = new MemoryRemote({ clock });
    const a = device(remote);
    const b = device(remote);
    const [n0, n1] = await seedVault(a, 2);
    await a.engine.sync();
    await b.engine.sync();

    // A purges note 0; B edits note 1's page while A deletes that page's file.
    await a.vault.deleteNote(n0!.note.id);
    const pagePath = `notes/${n1!.note.id}/pages/${n1!.pages[0]!.id}.ink.json`;
    await a.fs.delete(pagePath);
    const pb = await b.vault.readPage(n1!.note.id, n1!.pages[0]!.id);
    pb.strokes.push(stroke(clock()));
    await b.vault.saveNote(n1!.note, [pb]);

    const ra = await a.engine.sync();
    expect(ra.deleted.remote).toContain(`notes/${n0!.note.id}/note.json`);
    const rb = await b.engine.sync();
    expect(rb.deleted.local).toContain(`notes/${n0!.note.id}/note.json`);
    expect(rb.pushed).toContain(pagePath); // edit beats deletion
    await a.engine.sync();
    expect(await a.fs.readText(pagePath)).toBe(await b.fs.readText(pagePath));
    expect((await walk(b.fs)).some((p) => p.includes(n0!.note.id))).toBe(false);
    expect(await snapshot(a.fs)).toEqual(await snapshot(b.fs));
  });

  it('never treats derived files as conflicts (newest wins)', async () => {
    const remote = new MemoryRemote({ clock });
    const a = device(remote, { regenerateDerived: false });
    await a.fs.writeText('notes/n/note.md', 'base');
    await a.engine.sync();
    await a.fs.writeText('notes/n/note.md', 'local, older');
    remote.put('notes/n/note.md', 'remote, newer');
    const r = await a.engine.sync();
    expect(r.merged).toEqual([]);
    expect(r.pulled).toEqual(['notes/n/note.md']);
    expect(await a.fs.readText('notes/n/note.md')).toBe('remote, newer');
  });

  it('keeps both versions of an asset changed on both sides', async () => {
    const remote = new MemoryRemote({ clock });
    const a = device(remote);
    const b = device(remote);
    await a.fs.writeBytes('notes/n/assets/photo.png', new Uint8Array([1]));
    await a.engine.sync();
    await b.engine.sync();
    await a.fs.writeBytes('notes/n/assets/photo.png', new Uint8Array([2]));
    await b.fs.writeBytes('notes/n/assets/photo.png', new Uint8Array([3]));
    await a.engine.sync();
    const rb = await b.engine.sync();
    expect(rb.conflicts).toHaveLength(1);
    expect(rb.conflicts[0]).toMatch(/^notes\/n\/assets\/photo\.conflict-\d+\.png$/);
    await a.engine.sync();
    for (const d of [a, b]) {
      expect(Array.from((await d.fs.readBytes('notes/n/assets/photo.png'))!)).toEqual([2]);
      expect(Array.from((await d.fs.readBytes(rb.conflicts[0]!))!)).toEqual([3]);
    }
  });

  it('treats identical content on both sides as in sync (re-linking a copied vault)', async () => {
    const remote = new MemoryRemote({ clock });
    const a = device(remote);
    const b = device(remote);
    await seedVault(a);
    await a.engine.sync();
    for (const p of await walk(a.fs)) await b.fs.writeBytes(p, (await a.fs.readBytes(p))!);
    const r = await b.engine.sync();
    expect([...r.pushed, ...r.pulled, ...r.merged]).toEqual([]);
    expect(r.unchanged).toBe((await walk(a.fs)).length);
  });

  it('never syncs .inkwright/ or junk files', async () => {
    const remote = new MemoryRemote({ clock });
    const a = device(remote);
    await a.fs.writeText('.inkwright/search.idx', 'local index');
    await a.fs.writeText('notes/n/.DS_Store', 'junk');
    await a.fs.writeText('notes/n/note.json', '{"id":"n"}');
    remote.put('.inkwright/other-device.idx', 'theirs');
    const r = await a.engine.sync();
    expect(r.pushed).toEqual(['notes/n/note.json']);
    expect(remote.paths()).toEqual(['.inkwright/other-device.idx', 'notes/n/note.json']);
    expect(await a.fs.readText('.inkwright/search.idx')).toBe('local index');
    expect(await a.fs.readText('.inkwright/other-device.idx')).toBeNull();
  });

  describe('safety', () => {
    it('aborts when the remote suddenly lists nothing, without touching local files', async () => {
      const remote = new MemoryRemote({ clock });
      const a = device(remote);
      await seedVault(a, 3);
      await a.engine.sync();
      const before = await snapshot(a.fs);
      remote.listOverride = () => [];
      remote.calls.length = 0;
      const err = await a.engine.sync().catch((e) => e);
      expect(err).toBeInstanceOf(SyncSafetyError);
      expect(err.reason).toBe('remote-empty');
      expect(await snapshot(a.fs)).toEqual(before);
      expect(remote.calls.filter((c) => c.op !== 'list')).toEqual([]);
      // With explicit confirmation the deletion goes through.
      const r = await a.engine.sync({ allowMassDelete: true });
      expect(r.deleted.local.length).toBe(Object.keys(before).length);
    });

    it('aborts when the local vault was wiped instead of deleting everything remotely', async () => {
      const remote = new MemoryRemote({ clock });
      const a = device(remote);
      await seedVault(a, 2);
      await a.engine.sync();
      await a.fs.deleteDir('');
      await expect(a.engine.sync()).rejects.toMatchObject({ name: 'SyncSafetyError', reason: 'local-empty' });
      expect(remote.paths().length).toBeGreaterThan(0);
    });

    it('aborts when a run would delete most of the vault', async () => {
      const remote = new MemoryRemote({ clock });
      const a = device(remote, { massDelete: { fraction: 0.5, minFiles: 5 } });
      for (let i = 0; i < 10; i++) await a.fs.writeText(`notes/n${i}/note.json`, `{"id":"n${i}"}`);
      await a.engine.sync();
      for (let i = 0; i < 7; i++) remote.remove(`notes/n${i}/note.json`);
      await expect(a.engine.sync()).rejects.toMatchObject({ reason: 'mass-delete-local', count: 7 });
      expect((await walk(a.fs)).length).toBe(10);
    });

    it('propagates a failing remote listing instead of syncing against nothing', async () => {
      const remote = new MemoryRemote({ clock });
      const a = device(remote);
      await seedVault(a);
      await a.engine.sync();
      remote.failNext('list', { error: new RemoteError('PROPFIND failed: HTTP 500', 500, true) });
      await expect(a.engine.sync()).rejects.toThrow('PROPFIND failed');
      expect((await walk(a.fs)).length).toBeGreaterThan(0);
    });
  });

  describe('robustness', () => {
    it('records per-file errors, keeps going, and resumes on the next run', async () => {
      const remote = new MemoryRemote({ clock });
      const state = new MemoryStateStore();
      const a = device(remote, { state });
      for (let i = 0; i < 6; i++) await a.fs.writeText(`f${i}.txt`, `${i}`);
      remote.failNext('write', { path: 'f3.txt', error: new RemoteError('quota', 507) });
      const r1 = await a.engine.sync();
      expect(r1.errors.map((e) => e.path)).toEqual(['f3.txt']);
      expect(r1.pushed).toHaveLength(5);
      expect(state.size).toBe(5);
      const r2 = await a.engine.sync();
      expect(r2.pushed).toEqual(['f3.txt']);
    });

    it('is cancellable and persists progress after every file', async () => {
      const remote = new MemoryRemote({ clock });
      const state = new MemoryStateStore();
      const a = device(remote, { state, concurrency: 1 });
      for (let i = 0; i < 10; i++) await a.fs.writeText(`f${i}.txt`, `${i}`);
      const ctrl = new AbortController();
      let writes = 0;
      remote.hook = (op) => {
        if (op === 'write' && ++writes === 4) ctrl.abort();
      };
      await expect(a.engine.sync({ signal: ctrl.signal })).rejects.toMatchObject({ name: 'AbortError' });
      // The write in flight when the user cancelled completes; nothing after it starts.
      expect(remote.paths()).toHaveLength(4);
      expect(state.size).toBe(4);
      expect(state.writes).toBe(4); // persisted file by file
      remote.hook = null;
      const r = await a.engine.sync();
      expect(r.pushed).toHaveLength(6);
      expect(remote.paths()).toHaveLength(10);
    });

    it('merges when another device writes between listing and upload', async () => {
      const remote = new MemoryRemote({ clock });
      const a = device(remote);
      const page = (ids: string[]) => JSON.stringify({ id: 'P', formatVersion: 2, strokes: ids.map((id, i) => ({ id, pen: 'pencil', color: '#FF000000', size: 1, createdAt: i, points: [[0, 0, 0]] })) });
      await a.fs.writeText('notes/n/pages/P.ink.json', page(['s1']));
      await a.engine.sync();
      await a.fs.writeText('notes/n/pages/P.ink.json', page(['s1', 'local']));
      let raced = false;
      remote.hook = (op, path) => {
        if (op === 'write' && !raced) {
          raced = true;
          remote.put(path!, page(['s1', 'remote']));
        }
      };
      const r = await a.engine.sync();
      expect(r.errors).toEqual([]);
      expect(r.merged).toEqual(['notes/n/pages/P.ink.json']);
      const ids = decodePage(remote.text('notes/n/pages/P.ink.json')!).strokes.map((s) => s.id);
      expect(ids.sort()).toEqual(['local', 'remote', 's1']);
      expect(await a.fs.readText('notes/n/pages/P.ink.json')).toBe(remote.text('notes/n/pages/P.ink.json'));
    });

    it('does not clobber a local edit made while a pull is in flight', async () => {
      const remote = new MemoryRemote({ clock });
      const a = device(remote);
      const note = (title: string, tags: string[], t: number) => JSON.stringify({ id: 'n', title, kind: 'paged', pageIds: [], tags, createdAt: 1, updatedAt: t, pinned: false, formatVersion: 2 });
      await a.fs.writeText('notes/n/note.json', note('T', [], 1));
      await a.engine.sync();
      remote.put('notes/n/note.json', note('Remote', [], 5));
      remote.hook = async (op) => {
        if (op === 'read') {
          remote.hook = null;
          await a.fs.writeText('notes/n/note.json', note('T', ['typed-meanwhile'], 3));
        }
      };
      const r = await a.engine.sync();
      expect(r.merged).toEqual(['notes/n/note.json']);
      const merged = JSON.parse((await a.fs.readText('notes/n/note.json'))!);
      expect(merged).toMatchObject({ title: 'Remote', tags: ['typed-meanwhile'] });
    });

    it('stops the whole run on authentication failure', async () => {
      const remote = new MemoryRemote({ clock });
      const a = device(remote);
      for (let i = 0; i < 5; i++) await a.fs.writeText(`f${i}.txt`, `${i}`);
      remote.failNext('write', { error: new RemoteError('unauthorized', 401), times: 99 });
      await expect(a.engine.sync()).rejects.toMatchObject({ status: 401 });
    });

    it('limits concurrency to 4 and reports progress', async () => {
      const remote = new MemoryRemote({ clock });
      const events: SyncProgress[] = [];
      const a = device(remote, { onProgress: (p) => events.push(p) });
      for (let i = 0; i < 20; i++) await a.fs.writeText(`f${i}.txt`, `${i}`);
      let inflight = 0;
      let peak = 0;
      remote.hook = async (op) => {
        if (op !== 'write') return;
        peak = Math.max(peak, ++inflight);
        await new Promise((r) => setTimeout(r, 2));
        inflight--;
      };
      await a.engine.sync();
      expect(peak).toBe(4);
      expect(events[0]!.phase).toBe('scanning');
      expect(events.at(-1)).toMatchObject({ phase: 'done', done: 20, total: 20 });
      expect(events.filter((e) => e.phase === 'syncing' && e.path).length).toBe(20);
    });

    it('returns the running sync to concurrent callers', async () => {
      const remote = new MemoryRemote({ clock });
      const a = device(remote);
      await a.fs.writeText('x.txt', 'x');
      const [r1, r2] = await Promise.all([a.engine.sync(), a.engine.sync()]);
      expect(r1).toBe(r2);
      expect(a.engine.isRunning).toBe(false);
    });

    it('skips re-hashing unchanged files when trustLocalMtime is on', async () => {
      const remote = new MemoryRemote({ clock });
      const fs = new MemoryFS(clock);
      let reads = 0;
      const counting: VaultFS = Object.assign(Object.create(fs), {
        readBytes: (p: string) => {
          reads++;
          return fs.readBytes(p);
        },
      });
      const engine = new SyncEngine({ local: counting, remote, state: new MemoryStateStore(), clock, trustLocalMtime: true });
      for (let i = 0; i < 5; i++) await fs.writeText(`f${i}.txt`, `${i}`);
      await engine.sync();
      await engine.sync(); // records stats
      reads = 0;
      await engine.sync();
      expect(reads).toBe(0);
      await fs.writeText('f2.txt', 'changed!');
      const r = await engine.sync();
      expect(r.pushed).toEqual(['f2.txt']);
    });
  });

  it('removes note folders emptied by remote deletions on a real file system', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkwright-engine-'));
    try {
      const remote = new MemoryRemote({ clock });
      const a = device(remote);
      const [{ note }] = await seedVault(a);
      await a.vault.createNote({ title: 'Keep me' });
      await a.engine.sync();
      const local = new NodeFS(dir, { fsync: false });
      const engine = new SyncEngine({ local, remote, state: new MemoryStateStore(), clock });
      await engine.sync();
      expect(await readdir(join(dir, 'notes'))).toHaveLength(2);
      await a.vault.deleteNote(note!.id);
      await a.engine.sync();
      const r = await engine.sync();
      expect(r.deleted.local.length).toBeGreaterThanOrEqual(3);
      expect(await readdir(join(dir, 'notes'))).toHaveLength(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  describe('state stores and folder remotes', () => {
    it('FsStateStore ignores a torn journal record', async () => {
      const stateFs = new MemoryFS(clock);
      const s1 = new FsStateStore(stateFs);
      await s1.put({ path: 'a', hash: 'h1', rev: 'r1', syncedAt: 1 });
      await s1.put({ path: 'b', hash: 'h2', rev: 'r2', syncedAt: 2 });
      await stateFs.writeText('sync-state/journal/000000000003.json', '{"op":"put","entr');
      const s2 = new FsStateStore(stateFs);
      expect([...(await s2.load()).keys()].sort()).toEqual(['a', 'b']);
      await s2.put({ path: 'c', hash: 'h3', rev: 'r3', syncedAt: 3 });
      expect([...(await new FsStateStore(stateFs).load()).keys()].sort()).toEqual(['a', 'b', 'c']);
    });

    it('persists state in a separate FS across restarts (journal + compaction)', async () => {
      const remote = new MemoryRemote({ clock });
      const stateFs = new MemoryFS(clock);
      const fs = new MemoryFS(clock);
      for (let i = 0; i < 12; i++) await fs.writeText(`notes/n${i}/note.json`, `{"id":"n${i}"}`);
      const s1 = new FsStateStore(stateFs, { prefix: 'sync/main', compactEvery: 5 });
      await new SyncEngine({ local: fs, remote, state: s1, clock }).sync();
      expect(stateFs.paths().some((p) => p === 'sync/main/state.json')).toBe(true);
      expect(stateFs.paths().filter((p) => p.startsWith('sync/main/journal/')).length).toBeLessThan(5);
      expect(stateFs.paths().filter((p) => p.startsWith('sync/main/base/'))).toHaveLength(12);
      expect(await walk(fs)).not.toContain('sync/main/state.json');

      const s2 = new FsStateStore(stateFs, { prefix: 'sync/main', compactEvery: 5 });
      expect((await s2.load()).size).toBe(12);
      remote.calls.length = 0;
      const r = await new SyncEngine({ local: fs, remote, state: s2, clock }).sync();
      expect(r.unchanged).toBe(12);
      expect(remote.calls.map((c) => c.op)).toEqual(['list']);
      await s2.remove('notes/n0/note.json');
      const s3 = new FsStateStore(stateFs, { prefix: 'sync/main' });
      expect((await s3.load()).has('notes/n0/note.json')).toBe(false);
      expect(await s3.getBase('notes/n0/note.json')).toBeNull();
      expect(new TextDecoder().decode((await s3.getBase('notes/n1/note.json'))!)).toBe('{"id":"n1"}');
      await s3.clear();
      expect((await s3.load()).size).toBe(0);
      expect(stateFs.paths()).toEqual([]);
    });

    it('syncs to a local folder through FolderRemote (File System Access)', async () => {
      const folder = new FileSystemAccessFS(new FakeDirectoryHandle('Inkwright', clock));
      const mk = () => {
        const fs = new MemoryFS(clock);
        return { fs, vault: new Vault(fs, clock), engine: new SyncEngine({ local: fs, remote: new FolderRemote(folder), state: new MemoryStateStore(), clock }) };
      };
      const a = mk();
      const b = mk();
      await a.vault.init();
      const { note, pages } = await a.vault.createNote({ title: 'Folder note' });
      await a.engine.sync();
      expect((await walk(folder)).sort()).toEqual((await walk(a.fs)).sort());
      await b.engine.sync();
      pages[0]!.strokes.push(stroke(clock()));
      await a.vault.saveNote(note, pages);
      const pb = await b.vault.readPage(note.id, pages[0]!.id);
      pb.strokes.push(stroke(clock(), 300));
      await b.vault.saveNote({ ...note, updatedAt: clock() }, [pb]);
      await a.engine.sync();
      const rb = await b.engine.sync();
      expect(rb.merged).toContain(`notes/${note.id}/pages/${pages[0]!.id}.ink.json`);
      await a.engine.sync();
      expect(await snapshot(a.fs)).toEqual(await snapshot(b.fs));
      expect(await snapshot(folder)).toEqual(await snapshot(a.fs));
      expect(decodePage((await a.fs.readText(`notes/${note.id}/pages/${pages[0]!.id}.ink.json`))!).strokes).toHaveLength(2);
    });
  });
});
