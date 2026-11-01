import type { VaultFS } from '@inkstone/core';
import { noteIdOf, regenerateDerived } from './derived.ts';
import { mergeFileBytes } from './merge.ts';
import { isJunkName, safePath, toBufferView, utf8Decode, utf8Encode, walkFiles, bytesEqual } from './util.ts';

// ---- CRC-32 (IEEE 802.3, as used by ZIP) --------------------------------------------------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---- deflate via Compression Streams (browsers, Node ≥ 21.2) --------------------------------

function hasStream(kind: 'CompressionStream' | 'DecompressionStream'): boolean {
  const C = (globalThis as Record<string, unknown>)[kind] as (new (f: string) => unknown) | undefined;
  if (!C) return false;
  try {
    new C('deflate-raw');
    return true;
  } catch {
    return false;
  }
}

async function transform(bytes: Uint8Array, stream: TransformStream<Uint8Array, Uint8Array> | CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([toBufferView(bytes)]).stream().pipeThrough(stream as TransformStream<Uint8Array, Uint8Array>);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

export function canDeflate(): boolean {
  return hasStream('CompressionStream');
}

export function canInflate(): boolean {
  return hasStream('DecompressionStream');
}

// ---- Writer -----------------------------------------------------------------------------------

export interface ZipEntry {
  path: string;
  bytes: Uint8Array;
  /** Epoch ms; stored as DOS time (2 s resolution, local time). */
  mtime?: number;
}

export interface WriteZipOptions {
  /** Deflate entries when the runtime supports it and it saves space (default true). */
  compress?: boolean;
}

function dosDateTime(ms: number | undefined): { time: number; date: number } {
  const d = new Date(ms ?? Date.now());
  if (d.getFullYear() < 1980) return { time: 0, date: (1 << 5) | 1 }; // 1980-01-01
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function fromDos(time: number, date: number): number {
  return new Date(1980 + (date >> 9), ((date >> 5) & 15) - 1, date & 31, time >> 11, (time >> 5) & 63, (time & 31) * 2).getTime();
}

const FLAG_UTF8 = 0x0800;

/** Writes a ZIP archive (stored or deflated entries, UTF-8 names, no ZIP64). */
export async function writeZip(entries: readonly ZipEntry[], opts: WriteZipOptions = {}): Promise<Uint8Array> {
  if (entries.length > 0xffff) throw new Error('Too many entries for a ZIP without ZIP64');
  const compress = (opts.compress ?? true) && canDeflate();
  const chunks: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const name = utf8Encode(e.path);
    if (seen.has(e.path)) throw new Error(`Duplicate ZIP entry: ${e.path}`);
    seen.add(e.path);
    const crc = crc32(e.bytes);
    let data = e.bytes;
    let method = 0;
    if (compress && e.bytes.length > 64) {
      const deflated = await transform(e.bytes, new CompressionStream('deflate-raw'));
      if (deflated.length < e.bytes.length) {
        data = deflated;
        method = 8;
      }
    }
    if (data.length > 0xfffffffe || e.bytes.length > 0xfffffffe || offset > 0xfffffffe) throw new Error('ZIP64 is not supported (archive over 4 GB)');
    const { time, date } = dosDateTime(e.mtime);

    const lh = new Uint8Array(30 + name.length);
    const l = new DataView(lh.buffer);
    l.setUint32(0, 0x04034b50, true);
    l.setUint16(4, 20, true); // version needed
    l.setUint16(6, FLAG_UTF8, true);
    l.setUint16(8, method, true);
    l.setUint16(10, time, true);
    l.setUint16(12, date, true);
    l.setUint32(14, crc, true);
    l.setUint32(18, data.length, true);
    l.setUint32(22, e.bytes.length, true);
    l.setUint16(26, name.length, true);
    l.setUint16(28, 0, true);
    lh.set(name, 30);

    const ch = new Uint8Array(46 + name.length);
    const c = new DataView(ch.buffer);
    c.setUint32(0, 0x02014b50, true);
    c.setUint16(4, (3 << 8) | 20, true); // made by: Unix, 2.0
    c.setUint16(6, 20, true);
    c.setUint16(8, FLAG_UTF8, true);
    c.setUint16(10, method, true);
    c.setUint16(12, time, true);
    c.setUint16(14, date, true);
    c.setUint32(16, crc, true);
    c.setUint32(20, data.length, true);
    c.setUint32(24, e.bytes.length, true);
    c.setUint16(28, name.length, true);
    // extra len, comment len, disk start, internal attrs = 0
    c.setUint32(38, (0o100644 << 16) >>> 0, true); // external attrs: regular file rw-r--r--
    c.setUint32(42, offset, true);
    ch.set(name, 46);

    chunks.push(lh, data);
    central.push(ch);
    offset += lh.length + data.length;
  }
  const cdSize = central.reduce((n, x) => n + x.length, 0);
  const eocd = new Uint8Array(22);
  const v = new DataView(eocd.buffer);
  v.setUint32(0, 0x06054b50, true);
  v.setUint16(8, entries.length, true);
  v.setUint16(10, entries.length, true);
  v.setUint32(12, cdSize, true);
  v.setUint32(16, offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let o = 0;
  for (const x of [...chunks, ...central, eocd]) {
    out.set(x, o);
    o += x.length;
  }
  return out;
}

// ---- Reader -----------------------------------------------------------------------------------

/** Reads every file entry of a ZIP (stored or deflated), verifying sizes and CRC-32. */
export async function readZip(zip: Uint8Array): Promise<ZipEntry[]> {
  const v = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (v.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP file (no end of central directory)');
  const count = v.getUint16(eocd + 10, true);
  const cdOffset = v.getUint32(eocd + 16, true);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const out: ZipEntry[] = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > zip.length || v.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const flags = v.getUint16(p + 8, true);
    const method = v.getUint16(p + 10, true);
    const time = v.getUint16(p + 12, true);
    const date = v.getUint16(p + 14, true);
    const crc = v.getUint32(p + 16, true);
    const csize = v.getUint32(p + 20, true);
    const usize = v.getUint32(p + 24, true);
    const nameLen = v.getUint16(p + 28, true);
    const extraLen = v.getUint16(p + 30, true);
    const commentLen = v.getUint16(p + 32, true);
    const lho = v.getUint32(p + 42, true);
    const nameBytes = zip.subarray(p + 46, p + 46 + nameLen);
    const name = utf8Decode(nameBytes);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue; // directory entry
    if (flags & 1) throw new Error(`Encrypted ZIP entries are not supported: ${name}`);
    if (lho + 30 > zip.length || v.getUint32(lho, true) !== 0x04034b50) throw new Error(`Corrupt ZIP local header: ${name}`);
    const localNameLen = v.getUint16(lho + 26, true);
    if (localNameLen !== nameLen || !bytesEqual(zip.subarray(lho + 30, lho + 30 + localNameLen), nameBytes)) {
      throw new Error(`Corrupt ZIP: local header does not match central directory for ${name}`);
    }
    const start = lho + 30 + localNameLen + v.getUint16(lho + 28, true);
    if (start + csize > zip.length) throw new Error(`Truncated ZIP entry: ${name}`);
    const raw = zip.subarray(start, start + csize);
    let bytes: Uint8Array;
    if (method === 0) bytes = raw.slice();
    else if (method === 8) {
      if (!canInflate()) throw new Error('This runtime cannot inflate deflated ZIP entries');
      bytes = await transform(raw, new DecompressionStream('deflate-raw'));
    } else throw new Error(`Unsupported ZIP compression method ${method}: ${name}`);
    if (bytes.length !== usize) throw new Error(`ZIP size mismatch: ${name}`);
    if (crc32(bytes) !== crc) throw new Error(`ZIP CRC mismatch: ${name}`);
    out.push({ path: name, bytes, mtime: fromDos(time, date) });
  }
  return out;
}

// ---- Vault backup -------------------------------------------------------------------------------

export interface ExportZipOptions extends WriteZipOptions {
  /** Include dot-folders such as `.inkstone/` (app caches). Default false. */
  includeHidden?: boolean;
}

/** Zips the whole vault (a portable backup any unzip tool can open). */
export async function exportVaultZip(fs: VaultFS, opts: ExportZipOptions = {}): Promise<Uint8Array> {
  const files = await walkFiles(fs, '', (_p, e) => isJunkName(e.name) || (!opts.includeHidden && e.name.startsWith('.')));
  const entries: ZipEntry[] = [];
  for (const f of files.sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const bytes = await fs.readBytes(f.path);
    if (bytes) entries.push({ path: f.path, bytes, mtime: f.mtime });
  }
  return writeZip(entries, opts);
}

export interface ImportZipOptions {
  /**
   * 'replace': the vault becomes exactly the archive (everything else is deleted).
   * 'merge': files missing locally are added; notes/pages/notebooks present on both sides are
   * merged (union of strokes, pages, tags...); other existing files are kept as they are.
   */
  mode: 'merge' | 'replace';
}

export interface ImportZipReport {
  written: string[];
  merged: string[];
  /** Existing files kept unchanged (identical, or not mergeable in 'merge' mode). */
  kept: string[];
}

/** Restores a vault ZIP. The whole archive is validated (paths, CRCs) before anything is written. */
export async function importVaultZip(fs: VaultFS, zip: Uint8Array, opts: ImportZipOptions): Promise<ImportZipReport> {
  const entries = (await readZip(zip)).map((e) => {
    const path = safePath(e.path.replace(/\\/g, '/'));
    if (!path) throw new Error(`Invalid ZIP entry name: ${e.path}`);
    return { ...e, path };
  });
  const report: ImportZipReport = { written: [], merged: [], kept: [] };
  if (opts.mode === 'replace') {
    await fs.deleteDir('');
    for (const e of entries) {
      await fs.writeBytes(e.path, e.bytes);
      report.written.push(e.path);
    }
    return report;
  }
  const mergedNotes = new Set<string>();
  for (const e of entries) {
    const cur = await fs.readBytes(e.path);
    if (!cur) {
      await fs.writeBytes(e.path, e.bytes);
      report.written.push(e.path);
      continue;
    }
    if (bytesEqual(cur, e.bytes)) {
      report.kept.push(e.path);
      continue;
    }
    const merged = mergeFileBytes(e.path, null, cur, e.bytes, { prefer: 'local' });
    if (!merged || bytesEqual(merged, cur)) {
      report.kept.push(e.path);
      continue;
    }
    await fs.writeBytes(e.path, merged);
    report.merged.push(e.path);
    const id = noteIdOf(e.path);
    if (id) mergedNotes.add(id);
  }
  for (const id of mergedNotes) await regenerateDerived(fs, id);
  return report;
}
