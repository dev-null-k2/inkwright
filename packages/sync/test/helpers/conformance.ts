import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { walk, type VaultFS } from '@inkstone/core';

export interface FsFixture {
  fs: VaultFS;
  cleanup?: () => Promise<void> | void;
}

const enc = new TextEncoder();

/**
 * Behaviour every VaultFS backend must share (MemoryFS from core is the reference). Run it with
 * a factory that returns a fresh, empty backend per test.
 */
export function vaultFsConformance(name: string, make: () => Promise<FsFixture> | FsFixture): void {
  describe(`VaultFS conformance: ${name}`, () => {
    let fx: FsFixture;
    let fs: VaultFS;
    beforeEach(async () => {
      fx = await make();
      fs = fx.fs;
    });
    afterEach(async () => {
      await fx.cleanup?.();
    });

    it('returns null for missing files', async () => {
      expect(await fs.readText('nope.txt')).toBeNull();
      expect(await fs.readBytes('a/b/c.bin')).toBeNull();
    });

    it('round-trips text, including non-ASCII', async () => {
      await fs.writeText('inkstone.json', '{"app":"Inkstone"}');
      await fs.writeText('notes/n1/note.md', 'Grüße — 筆 ✍️\nline 2');
      expect(await fs.readText('inkstone.json')).toBe('{"app":"Inkstone"}');
      expect(await fs.readText('notes/n1/note.md')).toBe('Grüße — 筆 ✍️\nline 2');
    });

    it('round-trips arbitrary bytes and empty files', async () => {
      const all = new Uint8Array(256).map((_, i) => i);
      await fs.writeBytes('notes/n1/assets/all.bin', all);
      await fs.writeBytes('empty.bin', new Uint8Array(0));
      expect(Array.from((await fs.readBytes('notes/n1/assets/all.bin'))!)).toEqual(Array.from(all));
      const empty = await fs.readBytes('empty.bin');
      expect(empty).not.toBeNull();
      expect(empty!.length).toBe(0);
    });

    it('overwrites completely (shorter content leaves no tail)', async () => {
      await fs.writeText('a.txt', 'a much longer original content');
      await fs.writeText('a.txt', 'short');
      expect(await fs.readText('a.txt')).toBe('short');
    });

    it('isolates stored bytes from caller buffers', async () => {
      const b = enc.encode('hello');
      await fs.writeBytes('x.bin', b);
      b[0] = 0;
      const r = (await fs.readBytes('x.bin'))!;
      r[1] = 0;
      expect(await fs.readText('x.bin')).toBe('hello');
    });

    it('creates parent directories and lists immediate children with kinds and sizes', async () => {
      await fs.writeText('notes/n1/note.json', '{}');
      await fs.writeText('notes/n1/pages/p1.ink.json', '12345');
      await fs.writeText('notes/n2/note.json', '{}');
      await fs.writeText('inkstone.json', 'm');
      const root = await fs.list('');
      expect(root.map((e) => [e.name, e.kind])).toEqual([
        ['inkstone.json', 'file'],
        ['notes', 'dir'],
      ]);
      const n1 = await fs.list('notes/n1');
      expect(n1.map((e) => e.name)).toEqual(['note.json', 'pages']);
      const pages = await fs.list('notes/n1/pages');
      expect(pages).toHaveLength(1);
      expect(pages[0]).toMatchObject({ name: 'p1.ink.json', kind: 'file', size: 5 });
      if (pages[0]!.mtime !== undefined) expect(typeof pages[0]!.mtime).toBe('number');
    });

    it('lists entries sorted by name', async () => {
      for (const n of ['c', 'a', 'b']) await fs.writeText(`d/${n}.txt`, n);
      expect((await fs.list('d')).map((e) => e.name)).toEqual(['a.txt', 'b.txt', 'c.txt']);
    });

    it('lists nothing for missing directories or files', async () => {
      await fs.writeText('f.txt', 'x');
      expect(await fs.list('missing')).toEqual([]);
      expect(await fs.list('missing/deeper')).toEqual([]);
      expect(await fs.list('f.txt')).toEqual([]);
    });

    it('walks nested trees', async () => {
      const paths = ['inkstone.json', 'notebooks/b1/notebook.json', 'notes/n1/note.json', 'notes/n1/pages/p1.ink.json', 'notes/n1/assets/img.png'];
      for (const p of paths) await fs.writeText(p, p);
      expect((await walk(fs)).sort()).toEqual([...paths].sort());
    });

    it('deletes files; deleting missing files is a no-op', async () => {
      await fs.writeText('d/a.txt', 'a');
      await fs.writeText('d/b.txt', 'b');
      await fs.delete('d/a.txt');
      await fs.delete('d/a.txt');
      await fs.delete('nowhere/x.txt');
      expect(await fs.readText('d/a.txt')).toBeNull();
      expect(await fs.readText('d/b.txt')).toBe('b');
    });

    it('deletes directories recursively without touching prefix-sharing siblings', async () => {
      await fs.writeText('notes/a/note.json', '1');
      await fs.writeText('notes/a/pages/p.ink.json', '2');
      await fs.writeText('notes/ab/note.json', '3');
      await fs.writeText('notes/a.txt', '4');
      await fs.deleteDir('notes/a');
      await fs.deleteDir('notes/missing');
      expect(await fs.readText('notes/a/note.json')).toBeNull();
      expect(await fs.readText('notes/a/pages/p.ink.json')).toBeNull();
      expect(await fs.readText('notes/ab/note.json')).toBe('3');
      expect(await fs.readText('notes/a.txt')).toBe('4');
      expect((await walk(fs)).sort()).toEqual(['notes/a.txt', 'notes/ab/note.json']);
    });

    it('normalizes equivalent spellings of a path', async () => {
      await fs.writeText('/notes//n1/./note.json', 'x');
      expect(await fs.readText('notes/n1/note.json')).toBe('x');
      expect((await fs.list('/notes/')).map((e) => e.name)).toEqual(['n1']);
    });

    it('refuses paths that escape the vault', async () => {
      await expect(fs.writeText('../escape.txt', 'x')).rejects.toThrow();
      await expect(fs.writeText('notes/../../escape.txt', 'x')).rejects.toThrow();
      await expect(fs.readText('../etc/passwd')).rejects.toThrow();
      await expect(fs.readBytes('a/../../b')).rejects.toThrow();
      await expect(fs.delete('../x')).rejects.toThrow();
      await expect(fs.deleteDir('..')).rejects.toThrow();
      await expect(fs.list('../')).rejects.toThrow();
      expect(await walk(fs)).toEqual([]);
    });

    it('handles concurrent writes into the same new directories', async () => {
      await Promise.all(Array.from({ length: 12 }, (_, i) => fs.writeText(`notes/n9/pages/p${i}.ink.json`, String(i))));
      expect((await fs.list('notes/n9/pages')).length).toBe(12);
      expect(await fs.readText('notes/n9/pages/p7.ink.json')).toBe('7');
    });
  });
}
