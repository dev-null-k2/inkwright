import { describe, expect, it } from 'vitest';
import { MemoryFS } from '@inkwright/core';
import { GoogleDriveRemote, MemoryStateStore, PreconditionFailedError, RemoteError, SyncEngine, driveQuote, type GoogleDriveRemoteOptions } from '../src/index.ts';
import { FakeDrive, ROOT_ID, parseMultipart, parseQ } from './helpers/fake-drive.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function setup(opts: Partial<GoogleDriveRemoteOptions> = {}) {
  const drive = new FakeDrive();
  const sleeps: number[] = [];
  let tokenCalls = 0;
  const remote = new GoogleDriveRemote({
    getAccessToken: async () => {
      tokenCalls++;
      return drive.validToken;
    },
    fetch: drive.fetch,
    retry: { sleep: async (ms) => void sleeps.push(ms), random: () => 1 },
    ...opts,
  });
  return { drive, remote, sleeps, tokenCalls: () => tokenCalls };
}

function rootFolder(drive: FakeDrive, name = 'Inkwright') {
  return [...drive.files.values()].filter((f) => f.meta.name === name && f.meta.parents?.includes(ROOT_ID) && !f.meta.trashed);
}

describe('fake Drive server self-checks', () => {
  it('parses q expressions', () => {
    const f = { id: 'x', name: "it's", mimeType: 'text/plain', parents: ['p1'], trashed: false };
    expect(parseQ(`name = ${driveQuote("it's")} and trashed = false`)(f)).toBe(true);
    expect(parseQ(`('p0' in parents or 'p1' in parents) and trashed = false`)(f)).toBe(true);
    expect(parseQ(`mimeType != 'text/plain'`)(f)).toBe(false);
  });

  it('parses multipart bodies with binary content', () => {
    const bin = new Uint8Array([0, 13, 10, 45, 45, 255]);
    const body = new Uint8Array([...enc.encode('--b\r\nContent-Type: application/json\r\n\r\n{"a":1}\r\n--b\r\nContent-Type: x/y\r\n\r\n'), ...bin, ...enc.encode('\r\n--b--\r\n')]);
    const parts = parseMultipart(body, 'multipart/related; boundary=b');
    expect(dec.decode(parts[0]!.body)).toBe('{"a":1}');
    expect(Array.from(parts[1]!.body)).toEqual(Array.from(bin));
  });
});

describe('GoogleDriveRemote', () => {
  it('creates one visible Inkwright folder and mirrors the vault tree', async () => {
    const { drive, remote } = setup();
    await Promise.all([
      remote.write('notes/n1/note.json', enc.encode('{"id":"n1"}')),
      remote.write('notes/n1/pages/p1.ink.json', enc.encode('{"id":"p1"}')),
      remote.write('notes/n1/pages/p2.ink.json', enc.encode('{"id":"p2"}')),
      remote.write('inkwright.json', enc.encode('{}')),
    ]);
    const roots = rootFolder(drive);
    expect(roots).toHaveLength(1);
    const root = roots[0]!.meta.id;
    expect(dec.decode(drive.find('notes/n1/pages/p2.ink.json', root)!.content)).toBe('{"id":"p2"}');
    // Exactly one folder per directory, despite the concurrent uploads.
    const folders = [...drive.files.values()].filter((f) => f.meta.mimeType === 'application/vnd.google-apps.folder');
    expect(folders.map((f) => f.meta.name).sort()).toEqual(['Inkwright', 'n1', 'notes', 'pages']);
    // New files go up as multipart with the right MIME type.
    expect(drive.find('notes/n1/note.json', root)!.meta.mimeType).toBe('application/json');
    expect(drive.count((m, p) => m === 'POST' && p === '/upload/drive/v3/files')).toBe(4);
  });

  it('lists every file with paths, paging through results (flat and tree modes)', async () => {
    for (const listMode of ['flat', 'tree'] as const) {
      const { drive, remote } = setup({ listMode });
      const paths = ['inkwright.json', 'notebooks/b1/notebook.json', ...Array.from({ length: 7 }, (_, i) => `notes/n${i}/pages/p.ink.json`), 'notes/n0/assets/img.png'];
      for (const p of paths) await remote.write(p, enc.encode(p));
      const fresh = new GoogleDriveRemote({ getAccessToken: async () => drive.validToken, fetch: drive.fetch, listMode });
      const listed = await fresh.list();
      expect(listed.map((e) => e.path).sort()).toEqual([...paths].sort());
      const e = listed.find((x) => x.path === 'notes/n3/pages/p.ink.json')!;
      expect(e.size).toBe('notes/n3/pages/p.ink.json'.length);
      expect(e.mtime).toBeGreaterThan(0);
      expect(e.rev).toMatch(/^id\d+:[0-9a-f]{32}$/);
      // More files than one page holds: paging was needed.
      expect(drive.log.some((l) => l.search.includes('pageToken'))).toBe(true);
    }
  });

  it('ignores trashed files, Google Docs, and files outside the vault folder', async () => {
    const { drive, remote } = setup();
    await remote.write('notes/n/note.json', enc.encode('{}'));
    const root = rootFolder(drive)[0]!.meta.id;
    drive.seed('old.json', root, { content: 'x', trashed: true });
    const doc = drive.seed('Doc', root);
    doc.mimeType = 'application/vnd.google-apps.document';
    drive.seed('elsewhere.json', ROOT_ID, { content: 'y' });
    const trashedFolder = drive.seed('gone', root, { folder: true, trashed: true });
    drive.seed('inside-trashed.json', trashedFolder.id, { content: 'z' });
    expect((await remote.list()).map((e) => e.path)).toEqual(['notes/n/note.json']);
  });

  it('reuses an existing vault folder (oldest wins) and supports custom names', async () => {
    const drive = new FakeDrive();
    const older = drive.seed("Ink'stone", 'root', { folder: true });
    drive.seed("Ink'stone", 'root', { folder: true });
    drive.seed('a.txt', older.id, { content: 'hello' });
    const remote = new GoogleDriveRemote({ getAccessToken: async () => drive.validToken, fetch: drive.fetch, folderName: "Ink'stone" });
    expect(await remote.rootId()).toBe(older.id);
    expect((await remote.list()).map((e) => e.path)).toEqual(['a.txt']);
  });

  it('lists files from duplicate folders created by racing devices', async () => {
    const drive = new FakeDrive();
    const root = drive.seed('Inkwright', 'root', { folder: true });
    const notesA = drive.seed('notes', root.id, { folder: true });
    const notesB = drive.seed('notes', root.id, { folder: true });
    drive.seed('a.json', notesA.id, { content: 'a' });
    drive.seed('b.json', notesB.id, { content: 'b' });
    const remote = new GoogleDriveRemote({ getAccessToken: async () => drive.validToken, fetch: drive.fetch });
    expect((await remote.list()).map((e) => e.path).sort()).toEqual(['notes/a.json', 'notes/b.json']);
    // New files land in the oldest duplicate.
    await remote.write('notes/c.json', enc.encode('c'));
    expect(drive.find('notes/c.json', root.id)!.meta.parents).toEqual([notesA.id]);
  });

  it('reads content with its rev and returns null for missing files', async () => {
    const { remote } = setup();
    const w = await remote.write('notes/n/note.json', enc.encode('v1'));
    const r = (await remote.read('notes/n/note.json'))!;
    expect(dec.decode(r.bytes)).toBe('v1');
    expect(r.rev).toBe(w.rev);
    expect(await remote.read('notes/n/missing.json')).toBeNull();
    expect(await remote.read('nowhere/at/all.json')).toBeNull();
  });

  it('updates existing files with a media PATCH, changing the rev', async () => {
    const { drive, remote } = setup();
    const v1 = await remote.write('a.json', enc.encode('one'));
    const v2 = await remote.write('a.json', enc.encode('two'), v1.rev);
    expect(v2.rev).not.toBe(v1.rev);
    expect(v2.rev.split(':')[0]).toBe(v1.rev.split(':')[0]); // same file id
    expect(drive.count((m, p) => m === 'PATCH' && p.startsWith('/upload/drive/v3/files/'))).toBe(1);
    const fresh = new GoogleDriveRemote({ getAccessToken: async () => drive.validToken, fetch: drive.fetch });
    expect(dec.decode((await fresh.read('a.json'))!.bytes)).toBe('two');
  });

  it('enforces ifMatch preconditions against concurrent writers', async () => {
    const { drive, remote } = setup();
    const v1 = await remote.write('a.json', enc.encode('one'));
    await expect(remote.write('a.json', enc.encode('x'), null)).rejects.toBeInstanceOf(PreconditionFailedError);
    // Another device changes the file behind our back.
    const id = v1.rev.split(':')[0]!;
    drive.modify(id, 'theirs');
    await expect(remote.write('a.json', enc.encode('mine'), v1.rev)).rejects.toBeInstanceOf(PreconditionFailedError);
    await expect(remote.delete('a.json', v1.rev)).rejects.toBeInstanceOf(PreconditionFailedError);
    const cur = (await remote.read('a.json'))!;
    expect(dec.decode(cur.bytes)).toBe('theirs');
    await remote.write('a.json', enc.encode('merged'), cur.rev);
    await expect(remote.write('new.json', enc.encode('x'), 'id999:abc')).rejects.toBeInstanceOf(PreconditionFailedError);
  });

  it('finds files created by another device when writing with ifMatch=null', async () => {
    const { drive, remote } = setup();
    await remote.write('notes/n/note.json', enc.encode('mine'));
    const root = rootFolder(drive)[0]!.meta.id;
    const other = new GoogleDriveRemote({ getAccessToken: async () => drive.validToken, fetch: drive.fetch });
    await expect(other.write('notes/n/note.json', enc.encode('theirs'), null)).rejects.toBeInstanceOf(PreconditionFailedError);
    expect(dec.decode(drive.find('notes/n/note.json', root)!.content)).toBe('mine');
  });

  it('moves deleted files to the trash by default, or deletes permanently', async () => {
    const { drive, remote } = setup();
    const w = await remote.write('a.json', enc.encode('x'));
    await remote.delete('a.json', w.rev);
    await remote.delete('a.json'); // missing: no-op
    expect((await remote.list()).map((e) => e.path)).toEqual([]);
    expect(drive.files.get(w.rev.split(':')[0]!)!.meta.trashed).toBe(true);

    const p = setup({ permanentDelete: true });
    const w2 = await p.remote.write('b.json', enc.encode('x'));
    await p.remote.delete('b.json');
    expect(p.drive.files.has(w2.rev.split(':')[0]!)).toBe(false);
    expect(p.drive.count((m) => m === 'DELETE')).toBe(1);
  });

  it('refreshes the token once on 401 and retries', async () => {
    const drive = new FakeDrive();
    let refreshes = 0;
    const remote = new GoogleDriveRemote({
      getAccessToken: async () => 'stale-token',
      refreshAccessToken: async () => {
        refreshes++;
        return drive.validToken;
      },
      fetch: drive.fetch,
      retry: { sleep: async () => {} },
    });
    await remote.write('a.json', enc.encode('x'));
    expect(refreshes).toBe(1);
    expect(drive.count(() => true)).toBeGreaterThan(1);
    // The refreshed token is reused afterwards.
    await remote.list();
    expect(refreshes).toBe(1);
  });

  it('gives up with a 401 RemoteError when refreshing does not help', async () => {
    const drive = new FakeDrive();
    let refreshes = 0;
    const remote = new GoogleDriveRemote({
      getAccessToken: async () => 'bad',
      refreshAccessToken: async () => {
        refreshes++;
        return 'still-bad';
      },
      fetch: drive.fetch,
    });
    const err = await remote.list().catch((e) => e);
    expect(err).toBeInstanceOf(RemoteError);
    expect(err.status).toBe(401);
    expect(refreshes).toBe(1);
  });

  it('backs off on 429 (honouring Retry-After), 403 rate limits and 5xx', async () => {
    const { drive, remote, sleeps } = setup();
    drive.fault((m, u) => m === 'GET' && u.pathname === '/drive/v3/files', 429, { headers: { 'Retry-After': '2' } });
    drive.fault((m, u) => m === 'GET' && u.pathname === '/drive/v3/files', 403, {
      body: { error: { code: 403, message: 'Rate Limit Exceeded', errors: [{ reason: 'userRateLimitExceeded' }] } },
    });
    drive.fault((m, u) => m === 'POST' && u.pathname === '/upload/drive/v3/files', 503, { times: 2 });
    await remote.write('a.json', enc.encode('x'));
    // Retry-After: 2 → 2 s; then exponential per request (jitter pinned to 1): 1 s on the 2nd
    // attempt of the listing, 0.5 s and 1 s for the two 503s on the upload.
    expect(sleeps).toEqual([2000, 1000, 500, 1000]);
    expect((await remote.list()).map((e) => e.path)).toEqual(['a.json']);
  });

  it('does not retry permission errors, and fails listing loudly after retries run out', async () => {
    const sleeps: number[] = [];
    const { drive, remote } = setup({ retry: { retries: 2, sleep: async (ms) => void sleeps.push(ms) } });
    await remote.write('a.json', enc.encode('x'));
    drive.fault((m) => m === 'GET', 403, { body: { error: { code: 403, message: 'Forbidden', errors: [{ reason: 'insufficientFilePermissions' }] } } });
    await expect(remote.read('a.json')).rejects.toMatchObject({ status: 403 });
    expect(sleeps).toHaveLength(0);
    drive.fault((m, u) => u.pathname === '/drive/v3/files', 500, { times: 10 });
    await expect(remote.list()).rejects.toMatchObject({ status: 500, retryable: true });
    expect(sleeps).toHaveLength(2);
  });

  it('syncs two devices through Drive end to end', async () => {
    const drive = new FakeDrive();
    const mk = () => new GoogleDriveRemote({ getAccessToken: async () => drive.validToken, fetch: drive.fetch });
    const a = new MemoryFS();
    const b = new MemoryFS();
    await a.writeText('inkwright.json', '{"app":"Inkwright"}');
    await a.writeText('notes/n/note.json', '{"id":"n","title":"T","pageIds":[],"tags":[],"updatedAt":1}');
    await a.writeBytes('notes/n/assets/x.bin', new Uint8Array([1, 2, 3]));
    const ea = new SyncEngine({ local: a, remote: mk(), state: new MemoryStateStore() });
    const eb = new SyncEngine({ local: b, remote: mk(), state: new MemoryStateStore() });
    expect((await ea.sync()).pushed).toHaveLength(3);
    expect((await eb.sync()).pulled).toHaveLength(3);
    expect(b.paths()).toEqual(a.paths());
    await b.delete('notes/n/assets/x.bin');
    await eb.sync();
    const r = await ea.sync();
    expect(r.deleted.local).toEqual(['notes/n/assets/x.bin']);
    expect(a.paths()).toEqual(['inkwright.json', 'notes/n/note.json']);
  });
});
