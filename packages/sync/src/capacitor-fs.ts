import type { FsEntry, VaultFS } from '@inkwright/core';
import { TEMP_SUFFIX, base64Decode, base64Encode, isJunkName, randomToken, safePath, utf8Decode, utf8Encode } from './util.ts';

/*
 * The slice of `@capacitor/filesystem`'s `Filesystem` plugin this adapter needs. The app passes
 * the real plugin object; this package never imports Capacitor. `directory` takes the plugin's
 * `Directory` enum values ('DATA', 'DOCUMENTS', 'LIBRARY', 'CACHE', 'EXTERNAL', ...).
 */

export interface CapacitorFileInfo {
  name?: string;
  type: 'file' | 'directory';
  size: number;
  mtime: number;
  ctime?: number;
  uri?: string;
}

export interface CapacitorFilesystemLike {
  readFile(o: { path: string; directory?: string }): Promise<{ data: string | Blob }>;
  writeFile(o: { path: string; data: string; directory?: string; recursive?: boolean }): Promise<unknown>;
  deleteFile(o: { path: string; directory?: string }): Promise<void>;
  rmdir(o: { path: string; directory?: string; recursive?: boolean }): Promise<void>;
  /** Capacitor ≥ 4 returns FileInfo objects; older versions returned plain names. */
  readdir(o: { path: string; directory?: string }): Promise<{ files: (CapacitorFileInfo | string)[] }>;
  stat(o: { path: string; directory?: string }): Promise<CapacitorFileInfo>;
  rename?(o: { from: string; to: string; directory?: string; toDirectory?: string }): Promise<void>;
}

export interface CapacitorFSOptions {
  /** Capacitor `Directory` value. Default 'DATA' (app-private, backed up by the OS). */
  directory?: string;
  /** Folder inside `directory` holding the vault. Default 'Inkwright'. '' = the directory itself. */
  root?: string;
  /** Write to a temp file and rename over the target (default true when `rename` exists). */
  atomic?: boolean;
}

/**
 * VaultFS over Capacitor Filesystem (Android/iOS). Binary data crosses the bridge as base64
 * (no `encoding` option), which is what the plugin expects for arbitrary bytes.
 */
export class CapacitorFS implements VaultFS {
  private readonly directory: string;
  private readonly root: string;
  private readonly atomic: boolean;

  constructor(private readonly fs: CapacitorFilesystemLike, opts: CapacitorFSOptions = {}) {
    this.directory = opts.directory ?? 'DATA';
    this.root = safePath(opts.root ?? 'Inkwright');
    this.atomic = (opts.atomic ?? true) && typeof fs.rename === 'function';
  }

  private full(path: string): string {
    const p = safePath(path);
    return this.root && p ? `${this.root}/${p}` : this.root || p;
  }

  private async exists(full: string): Promise<CapacitorFileInfo | null> {
    try {
      return await this.fs.stat({ path: full, directory: this.directory });
    } catch {
      return null;
    }
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const full = this.full(path);
    let data: string | Blob;
    try {
      ({ data } = await this.fs.readFile({ path: full, directory: this.directory }));
    } catch (e) {
      const st = await this.exists(full);
      if (!st || st.type === 'directory') return null;
      throw e;
    }
    if (typeof data === 'string') return base64Decode(data);
    return new Uint8Array(await data.arrayBuffer()); // the web implementation may return a Blob
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.readBytes(path);
    return b ? utf8Decode(b) : null;
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const full = this.full(path);
    if (safePath(path) === '') throw new Error('Cannot write to the vault root');
    const data = base64Encode(bytes);
    if (!this.atomic) {
      await this.fs.writeFile({ path: full, data, directory: this.directory, recursive: true });
      return;
    }
    const tmp = `${full}.${randomToken(4)}${TEMP_SUFFIX}`;
    await this.fs.writeFile({ path: tmp, data, directory: this.directory, recursive: true });
    try {
      await this.fs.rename!({ from: tmp, to: full, directory: this.directory, toDirectory: this.directory });
    } catch {
      // Some platform versions refuse to rename over an existing file: replace it explicitly.
      try {
        await this.fs.deleteFile({ path: full, directory: this.directory });
      } catch {
        /* target didn't exist */
      }
      try {
        await this.fs.rename!({ from: tmp, to: full, directory: this.directory, toDirectory: this.directory });
      } catch (e) {
        await this.fs.deleteFile({ path: tmp, directory: this.directory }).catch(() => {});
        throw e;
      }
    }
  }

  writeText(path: string, text: string): Promise<void> {
    return this.writeBytes(path, utf8Encode(text));
  }

  async delete(path: string): Promise<void> {
    const full = this.full(path);
    if (safePath(path) === '') return;
    try {
      await this.fs.deleteFile({ path: full, directory: this.directory });
    } catch (e) {
      const st = await this.exists(full);
      if (st && st.type === 'file') throw e;
    }
  }

  async deleteDir(path: string): Promise<void> {
    const p = safePath(path);
    if (p === '' && this.root === '') {
      // Never remove the platform directory itself; empty it.
      for (const e of await this.list('')) {
        if (e.kind === 'dir') await this.deleteDir(e.name);
        else await this.delete(e.name);
      }
      return;
    }
    const full = this.full(p);
    try {
      await this.fs.rmdir({ path: full, directory: this.directory, recursive: true });
    } catch (e) {
      const st = await this.exists(full);
      if (st && st.type === 'directory') throw e;
    }
  }

  async list(dir: string): Promise<FsEntry[]> {
    const full = this.full(dir);
    let files: (CapacitorFileInfo | string)[];
    try {
      ({ files } = await this.fs.readdir({ path: full, directory: this.directory }));
    } catch (e) {
      const st = await this.exists(full);
      if (!st || st.type !== 'directory') return [];
      throw e;
    }
    const out: FsEntry[] = [];
    for (const f of files) {
      let info: CapacitorFileInfo & { name: string };
      if (typeof f === 'string') {
        const st = await this.exists(full ? `${full}/${f}` : f);
        if (!st) continue;
        info = { ...st, name: f };
      } else {
        info = { ...f, name: f.name ?? '' };
      }
      if (!info.name || isJunkName(info.name)) continue;
      if (info.type === 'directory') out.push({ name: info.name, kind: 'dir' });
      else out.push({ name: info.name, kind: 'file', size: info.size, mtime: info.mtime });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
