import { mkdtemp, readdir, rm, symlink, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { MemoryFS, Vault, walk } from '@inkstone/core';
import { CapacitorFS, FileSystemAccessFS, IndexedDBFS } from '../src/index.ts';
import { NodeFS } from '../src/node.ts';
import { vaultFsConformance } from './helpers/conformance.ts';
import { FakeCapacitorFilesystem } from './helpers/fake-capacitor.ts';
import { FakeDirectoryHandle } from './helpers/fake-fsa.ts';

let tick = 1_000;
const clock = () => ++tick;

vaultFsConformance('MemoryFS (reference)', () => ({ fs: new MemoryFS(clock) }));

vaultFsConformance('IndexedDBFS', () => {
  const fs = new IndexedDBFS({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, dbName: 'conf', clock });
  return { fs, cleanup: () => fs.close() };
});

vaultFsConformance('FileSystemAccessFS', () => ({ fs: new FileSystemAccessFS(new FakeDirectoryHandle('vault', clock)) }));

vaultFsConformance('CapacitorFS (atomic rename)', () => ({ fs: new CapacitorFS(new FakeCapacitorFilesystem({ clock }), { directory: 'DATA', root: 'Inkstone' }) }));

vaultFsConformance('CapacitorFS (iOS-like rename, legacy readdir, blob reads)', () => ({
  fs: new CapacitorFS(new FakeCapacitorFilesystem({ clock, renameRefusesOverwrite: true, legacyReaddir: true, blobReads: true }), { directory: 'DOCUMENTS', root: '' }),
}));

vaultFsConformance('CapacitorFS (non-atomic)', () => ({ fs: new CapacitorFS(new FakeCapacitorFilesystem({ clock }), { atomic: false }) }));

vaultFsConformance('NodeFS', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'inkstone-nodefs-'));
  return { fs: new NodeFS(dir, { fsync: false }), cleanup: () => rm(dir, { recursive: true, force: true }) };
});

describe('IndexedDBFS specifics', () => {
  it('persists across instances sharing a database and isolates databases', async () => {
    const factory = new IDBFactory();
    const a = new IndexedDBFS({ indexedDB: factory, keyRange: IDBKeyRange, dbName: 'v1' });
    await a.writeText('notes/n/note.json', '{"id":"n"}');
    await a.close();
    const b = new IndexedDBFS({ indexedDB: factory, keyRange: IDBKeyRange, dbName: 'v1' });
    expect(await b.readText('notes/n/note.json')).toBe('{"id":"n"}');
    const other = new IndexedDBFS({ indexedDB: factory, keyRange: IDBKeyRange, dbName: 'v2' });
    expect(await other.list('')).toEqual([]);
    await b.destroy();
    const c = new IndexedDBFS({ indexedDB: factory, keyRange: IDBKeyRange, dbName: 'v1' });
    expect(await c.readText('notes/n/note.json')).toBeNull();
  });

  it('records mtime from the injected clock and supports a whole Vault', async () => {
    let t = 500;
    const fs = new IndexedDBFS({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange, clock: () => t });
    await fs.writeText('a.txt', 'a');
    expect((await fs.list(''))[0]).toMatchObject({ name: 'a.txt', mtime: 500, size: 1 });
    t = 600;
    const vault = new Vault(fs, () => t);
    await vault.init();
    const { note } = await vault.createNote({ title: 'Hello' });
    expect((await vault.listNotes()).map((n) => n.title)).toEqual(['Hello']);
    expect((await walk(fs)).filter((p) => p.startsWith(`notes/${note.id}/`)).length).toBeGreaterThanOrEqual(3);
  });

  it('lists a large flat directory and skips subtrees efficiently', async () => {
    const fs = new IndexedDBFS({ indexedDB: new IDBFactory(), keyRange: IDBKeyRange });
    for (let i = 0; i < 30; i++) await fs.writeText(`notes/n${String(i).padStart(2, '0')}/pages/p.ink.json`, 'x');
    const entries = await fs.list('notes');
    expect(entries).toHaveLength(30);
    expect(entries.every((e) => e.kind === 'dir')).toBe(true);
  });

  it('throws a clear error when IndexedDB is unavailable', () => {
    expect(() => new IndexedDBFS()).toThrow(/IndexedDB is not available/);
  });
});

describe('FileSystemAccessFS specifics', () => {
  it('hides Chrome .crswap files and OS junk; writes via swap files', async () => {
    const root = new FakeDirectoryHandle();
    const fs = new FileSystemAccessFS(root);
    await fs.writeText('notes/n/note.json', '{}');
    const notes = await root.getDirectoryHandle('notes');
    const n = await notes.getDirectoryHandle('n');
    n.files.set('note.json.crswap', { data: new Uint8Array(3), lastModified: 1 });
    n.files.set('.DS_Store', { data: new Uint8Array(3), lastModified: 1 });
    expect((await fs.list('notes/n')).map((e) => e.name)).toEqual(['note.json']);
  });

  it('delete() leaves directories alone and deleteDir("") empties the root', async () => {
    const root = new FakeDirectoryHandle();
    const fs = new FileSystemAccessFS(root);
    await fs.writeText('d/x.txt', 'x');
    await fs.delete('d');
    expect(await fs.readText('d/x.txt')).toBe('x');
    await fs.deleteDir('');
    expect(await fs.list('')).toEqual([]);
    expect(root.dirs.size + root.files.size).toBe(0);
  });

  it('treats a file where a directory is expected as missing', async () => {
    const fs = new FileSystemAccessFS(new FakeDirectoryHandle());
    await fs.writeText('a', 'file');
    expect(await fs.readText('a/b')).toBeNull();
    expect(await fs.list('a')).toEqual([]);
  });

  it('accepts a real FileSystemDirectoryHandle type', () => {
    // Compile-time check: the DOM type is structurally compatible with the constructor.
    const take = (h: FileSystemDirectoryHandle) => new FileSystemAccessFS(h);
    expect(typeof take).toBe('function');
  });
});

describe('CapacitorFS specifics', () => {
  it('stores bytes as base64 under the chosen directory and root', async () => {
    const cap = new FakeCapacitorFilesystem();
    const fs = new CapacitorFS(cap, { directory: 'DOCUMENTS', root: 'Vaults/Main' });
    await fs.writeBytes('notes/n/assets/a.bin', new Uint8Array([0, 255, 1, 2]));
    const node = cap.nodes.get('DOCUMENTS:Vaults/Main/notes/n/assets/a.bin');
    expect(node).toMatchObject({ type: 'file', data: 'AP8BAg==' });
    expect([...cap.nodes.keys()].some((k) => k.endsWith('.inkstone-tmp'))).toBe(false);
  });

  it('writes atomically through a temp file + rename', async () => {
    const cap = new FakeCapacitorFilesystem();
    const fs = new CapacitorFS(cap);
    await fs.writeText('a.txt', 'one');
    expect(cap.calls.some((c) => c.startsWith('rename ') && c.includes('.inkstone-tmp -> Inkstone/a.txt'))).toBe(true);
  });

  it('cleans up the temp file when rename keeps failing', async () => {
    const cap = new FakeCapacitorFilesystem();
    cap.rename = async () => {
      throw new Error('disk full');
    };
    const fs = new CapacitorFS(cap);
    await expect(fs.writeText('a.txt', 'x')).rejects.toThrow('disk full');
    expect([...cap.nodes.keys()].filter((k) => k.includes('.inkstone-tmp'))).toEqual([]);
  });

  it('propagates real errors instead of reporting a missing file', async () => {
    const cap = new FakeCapacitorFilesystem();
    const fs = new CapacitorFS(cap);
    await fs.writeText('a.txt', 'x');
    cap.readFile = async () => {
      throw new Error('I/O error');
    };
    await expect(fs.readText('a.txt')).rejects.toThrow('I/O error');
    expect(await fs.readText('missing.txt')).toBeNull();
  });
});

describe('NodeFS specifics', () => {
  it('writes atomically (no temp files left) and keeps the root on deleteDir("")', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-nodefs-'));
    try {
      const fs = new NodeFS(dir);
      await fs.writeText('notes/n/note.json', '{"a":1}');
      await fs.writeText('notes/n/note.json', '{"a":2}');
      expect(await readdir(join(dir, 'notes/n'))).toEqual(['note.json']);
      expect(await fs.readText('notes/n/note.json')).toBe('{"a":2}');
      await fs.deleteDir('');
      expect(await readdir(dir)).toEqual([]);
      expect(await fs.list('')).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('hides leftover temp files and refuses backslash tricks', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-nodefs-'));
    try {
      const fs = new NodeFS(dir);
      await mkdir(join(dir, 'd'));
      await writeFile(join(dir, 'd', 'x.json.abcd.inkstone-tmp'), 'partial');
      await writeFile(join(dir, 'd', 'x.json'), 'ok');
      expect((await fs.list('d')).map((e) => e.name)).toEqual(['x.json']);
      await expect(fs.readText('d\\..\\..\\x')).rejects.toThrow(/Unsafe path/);
      expect(() => fs.resolve('a/../../b')).toThrow();
      expect(fs.resolve('')).toBe(fs.root);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('follows symlinked folders inside the vault', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'inkstone-nodefs-'));
    const other = await mkdtemp(join(tmpdir(), 'inkstone-nodefs-other-'));
    try {
      await writeFile(join(other, 'a.txt'), 'linked');
      await symlink(other, join(dir, 'linked'));
      const fs = new NodeFS(dir);
      expect(await fs.list('')).toMatchObject([{ name: 'linked', kind: 'dir' }]);
      expect(await fs.readText('linked/a.txt')).toBe('linked');
    } finally {
      await rm(dir, { recursive: true, force: true });
      await rm(other, { recursive: true, force: true });
    }
  });
});
