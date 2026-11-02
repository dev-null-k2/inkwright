import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import { MemoryFS, Vault, decodePage, newId, point, walk } from '@inkwright/core';
import { crc32, exportVaultZip, importVaultZip, readZip, writeZip } from '../src/index.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

let now = 1_750_000_000_000;
const clock = () => (now += 1000);

async function sampleVault() {
  const fs = new MemoryFS(clock);
  const vault = new Vault(fs, clock);
  await vault.init();
  const { note, pages } = await vault.createNote({ title: 'Zipped — 筆記' });
  pages[0]!.strokes.push({ id: newId(clock()), pen: 'fountain', color: '#FF000000', size: 2, createdAt: clock(), points: [point(1, 2, 0, 0.5), point(3, 4, 10, 0.6)] });
  await vault.saveNote(note, pages);
  await vault.writeAsset(note.id, 'image.bin', Uint8Array.from({ length: 300 }, (_, i) => (i * 7) & 255));
  await fs.writeText('.inkwright/cache.json', '{}');
  return { fs, vault, note, pages };
}

async function contents(fs: MemoryFS): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const p of fs.paths()) out[p] = Array.from((await fs.readBytes(p))!).join(',');
  return out;
}

describe('crc32', () => {
  it('matches the standard check values', () => {
    expect(crc32(enc.encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array(0))).toBe(0);
    expect(crc32(enc.encode('The quick brown fox jumps over the lazy dog'))).toBe(0x414fa339);
  });
});

describe('zip writer/reader', () => {
  it('round-trips stored and deflated entries with UTF-8 names', async () => {
    const entries = [
      { path: 'a.txt', bytes: enc.encode('hello') },
      { path: 'dir/ünïcödé.json', bytes: enc.encode(JSON.stringify({ x: 'y'.repeat(500) })) },
      { path: 'bin', bytes: Uint8Array.from({ length: 256 }, (_, i) => i) },
      { path: 'empty', bytes: new Uint8Array(0) },
    ];
    for (const compress of [false, true]) {
      const zip = await writeZip(entries, { compress });
      const back = await readZip(zip);
      expect(back.map((e) => e.path)).toEqual(entries.map((e) => e.path));
      back.forEach((e, i) => expect(Array.from(e.bytes)).toEqual(Array.from(entries[i]!.bytes)));
    }
    const stored = await writeZip(entries, { compress: false });
    const deflated = await writeZip(entries, { compress: true });
    expect(deflated.length).toBeLessThan(stored.length);
  });

  it('keeps modification times to DOS precision', async () => {
    const t = new Date(2025, 5, 15, 13, 45, 30).getTime();
    const [e] = await readZip(await writeZip([{ path: 'x', bytes: enc.encode('x'), mtime: t }]));
    expect(e!.mtime).toBe(t);
  });

  it('reads archives deflated by another implementation (zlib), skipping directory entries', async () => {
    // Hand-build an archive with a directory entry and a zlib-deflated file.
    const data = enc.encode('compressed by zlib '.repeat(20));
    const comp = new Uint8Array(deflateRawSync(data));
    const parts: number[] = [];
    const central: number[] = [];
    const u16 = (a: number[], v: number) => a.push(v & 255, (v >> 8) & 255);
    const u32 = (a: number[], v: number) => a.push(v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255);
    const add = (name: string, method: number, raw: Uint8Array, stored: Uint8Array) => {
      const n = enc.encode(name);
      const off = parts.length;
      u32(parts, 0x04034b50); u16(parts, 20); u16(parts, 0); u16(parts, method); u16(parts, 0); u16(parts, 0x21);
      u32(parts, crc32(raw)); u32(parts, stored.length); u32(parts, raw.length); u16(parts, n.length); u16(parts, 0);
      parts.push(...n, ...stored);
      u32(central, 0x02014b50); u16(central, 20); u16(central, 20); u16(central, 0); u16(central, method); u16(central, 0); u16(central, 0x21);
      u32(central, crc32(raw)); u32(central, stored.length); u32(central, raw.length); u16(central, n.length);
      u16(central, 0); u16(central, 0); u16(central, 0); u16(central, 0); u32(central, 0); u32(central, off);
      central.push(...n);
    };
    add('folder/', 0, new Uint8Array(0), new Uint8Array(0));
    add('folder/file.txt', 8, data, comp);
    const eocd: number[] = [];
    u32(eocd, 0x06054b50); u16(eocd, 0); u16(eocd, 0); u16(eocd, 2); u16(eocd, 2); u32(eocd, central.length); u32(eocd, parts.length); u16(eocd, 0);
    const zip = new Uint8Array([...parts, ...central, ...eocd]);
    const entries = await readZip(zip);
    expect(entries.map((e) => e.path)).toEqual(['folder/file.txt']);
    expect(dec.decode(entries[0]!.bytes)).toBe(dec.decode(data));
  });

  it('detects corruption', async () => {
    const zip = await writeZip([{ path: 'a.txt', bytes: enc.encode('hello world') }], { compress: false });
    const bad = zip.slice();
    bad[30 + 'a.txt'.length] ^= 0xff; // flip a data byte
    await expect(readZip(bad)).rejects.toThrow(/CRC/);
    await expect(readZip(enc.encode('not a zip at all, definitely not'))).rejects.toThrow(/Not a ZIP/);
    await expect(readZip(zip.slice(0, zip.length - 30))).rejects.toThrow();
  });

  it('refuses duplicate entry names', async () => {
    await expect(writeZip([{ path: 'a', bytes: new Uint8Array(1) }, { path: 'a', bytes: new Uint8Array(1) }])).rejects.toThrow(/Duplicate/);
  });
});

describe('vault backup', () => {
  it('exports and re-imports a vault byte-for-byte (replace mode)', async () => {
    const { fs } = await sampleVault();
    const zip = await exportVaultZip(fs);
    const names = (await readZip(zip)).map((e) => e.path);
    expect(names).not.toContain('.inkwright/cache.json');
    const target = new MemoryFS(clock);
    await target.writeText('stale/file.txt', 'to be replaced');
    const report = await importVaultZip(target, zip, { mode: 'replace' });
    expect(report.written).toHaveLength(names.length);
    const expected = await contents(fs);
    delete expected['.inkwright/cache.json'];
    expect(await contents(target)).toEqual(expected);
    const all = await exportVaultZip(fs, { includeHidden: true });
    expect((await readZip(all)).map((e) => e.path)).toContain('.inkwright/cache.json');
  });

  it('merges a backup into a vault that has moved on, without losing new strokes', async () => {
    const { fs, vault, note, pages } = await sampleVault();
    const zip = await exportVaultZip(fs);
    // After the backup: one more stroke, and an unrelated new note.
    const p = (await vault.readPages(note))[0]!;
    const added = { id: newId(clock()), pen: 'pencil' as const, color: '#FF000000', size: 1, createdAt: clock(), points: [point(9, 9, 0)] };
    p.strokes.push(added);
    await vault.saveNote({ ...note, updatedAt: clock() }, [p]);
    const { note: other } = await vault.createNote({ title: 'After backup' });
    // Something in the backup the vault no longer has.
    await fs.delete(`notes/${note.id}/assets/image.bin`);

    const report = await importVaultZip(fs, zip, { mode: 'merge' });
    expect(report.written).toEqual([`notes/${note.id}/assets/image.bin`]);
    const page = decodePage((await fs.readText(`notes/${note.id}/pages/${pages[0]!.id}.ink.json`))!);
    expect(page.strokes.map((s) => s.id)).toContain(added.id);
    expect(page.strokes).toHaveLength(2);
    expect(await fs.readText(`notes/${other.id}/note.json`)).not.toBeNull();
  });

  // Security review SR-10: a "backup" someone sends could carry api/keys.json with the hash of a
  // key they hold (admin scope), opening every server that serves this vault to them.
  it('never takes API key records from an archive, and keeps this vault\'s own', async () => {
    const { fs } = await sampleVault();
    const mine = '{"formatVersion":1,"keys":[{"id":"mine000000","hash":"' + 'a'.repeat(64) + '","scopes":["notes:read"]}]}\n';
    const theirs = '{"formatVersion":1,"keys":[{"id":"evil000000","hash":"' + 'b'.repeat(64) + '","scopes":["admin"]}]}\n';
    const evil = await writeZip([{ path: 'api/keys.json', bytes: enc.encode(theirs) }, { path: 'notes/x/hello.txt', bytes: enc.encode('hi') }]);

    const fresh = new MemoryFS(clock);
    const merged = await importVaultZip(fresh, evil, { mode: 'merge' });
    expect(await fresh.readText('api/keys.json')).toBeNull();
    expect(merged.skipped).toEqual(['api/keys.json']);
    expect(merged.written).toEqual(['notes/x/hello.txt']);

    await fs.writeText('api/keys.json', mine);
    await importVaultZip(fs, evil, { mode: 'merge' });
    expect(await fs.readText('api/keys.json')).toBe(mine);
    await importVaultZip(fs, evil, { mode: 'replace' });
    expect(await fs.readText('api/keys.json')).toBe(mine);
    expect(await fs.readText('notes/x/hello.txt')).toBe('hi');
  });

  it('validates the archive before touching the vault', async () => {
    const { fs } = await sampleVault();
    const before = await contents(fs);
    const evil = await writeZip([{ path: '../outside.txt', bytes: enc.encode('x') }]);
    await expect(importVaultZip(fs, evil, { mode: 'replace' })).rejects.toThrow();
    const corrupt = (await exportVaultZip(fs, { compress: false })).slice();
    corrupt[40] ^= 0xff;
    await expect(importVaultZip(fs, corrupt, { mode: 'replace' })).rejects.toThrow();
    expect(await contents(fs)).toEqual(before);
    expect((await walk(fs)).length).toBeGreaterThan(0);
  });
});
