import type { FsEntry, VaultFS } from '@inkstone/core';
import { isJunkName, safePath, segments, toBufferView, utf8Decode, utf8Encode } from './util.ts';

/*
 * Minimal structural slices of the File System Access API. The real `FileSystemDirectoryHandle`
 * (Chrome/Edge `showDirectoryPicker()`) satisfies these, and tests use a small in-memory fake.
 */

export interface FsaFile {
  readonly size: number;
  readonly lastModified: number;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface FsaWritable {
  write(data: BufferSource): Promise<void>;
  close(): Promise<void>;
  abort(reason?: unknown): Promise<void>;
}

export interface FsaFileHandle {
  readonly kind: 'file';
  readonly name: string;
  getFile(): Promise<FsaFile>;
  createWritable(options?: { keepExistingData?: boolean }): Promise<FsaWritable>;
}

export interface FsaDirectoryHandle {
  readonly kind: 'directory';
  readonly name: string;
  getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<FsaDirectoryHandle>;
  getFileHandle(name: string, options?: { create?: boolean }): Promise<FsaFileHandle>;
  removeEntry(name: string, options?: { recursive?: boolean }): Promise<void>;
  values(): AsyncIterable<FsaDirectoryHandle | FsaFileHandle>;
}

function isMissing(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'NotFoundError' || name === 'TypeMismatchError';
}

/**
 * VaultFS over a directory the user picked (desktop Chrome/Edge "Open folder"), e.g. their
 * Google Drive / iCloud Drive / Dropbox folder on a Mac. `createWritable()` writes to a swap
 * file and swaps it in on `close()`, so writes are atomic. Permission prompts
 * (`requestPermission`) are the caller's job; this class assumes read/write access.
 */
export class FileSystemAccessFS implements VaultFS {
  private readonly root: FsaDirectoryHandle;

  constructor(root: FsaDirectoryHandle | FileSystemDirectoryHandle) {
    this.root = root as FsaDirectoryHandle;
  }

  /** Resolves a directory handle; null when any segment is missing (and `create` is false). */
  private async dir(parts: string[], create: boolean): Promise<FsaDirectoryHandle | null> {
    let d = this.root;
    for (const name of parts) {
      try {
        d = await d.getDirectoryHandle(name, { create });
      } catch (e) {
        if (!create && isMissing(e)) return null;
        throw e;
      }
    }
    return d;
  }

  private async fileHandle(path: string): Promise<FsaFileHandle | null> {
    const parts = segments(safePath(path));
    const name = parts.pop();
    if (name === undefined) return null;
    const d = await this.dir(parts, false);
    if (!d) return null;
    try {
      return await d.getFileHandle(name);
    } catch (e) {
      if (isMissing(e)) return null;
      throw e;
    }
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const h = await this.fileHandle(path);
    if (!h) return null;
    try {
      return new Uint8Array(await (await h.getFile()).arrayBuffer());
    } catch (e) {
      if (isMissing(e)) return null; // deleted between lookup and read
      throw e;
    }
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.readBytes(path);
    return b ? utf8Decode(b) : null;
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const parts = segments(safePath(path));
    const name = parts.pop();
    if (name === undefined) throw new Error('Cannot write to the vault root');
    const d = (await this.dir(parts, true))!;
    const h = await d.getFileHandle(name, { create: true });
    const w = await h.createWritable({ keepExistingData: false });
    try {
      await w.write(toBufferView(bytes));
      await w.close();
    } catch (e) {
      await w.abort(e).catch(() => {});
      throw e;
    }
  }

  writeText(path: string, text: string): Promise<void> {
    return this.writeBytes(path, utf8Encode(text));
  }

  async delete(path: string): Promise<void> {
    const parts = segments(safePath(path));
    const name = parts.pop();
    if (name === undefined) return;
    const d = await this.dir(parts, false);
    if (!d) return;
    // Only files: removing a directory here would be a deleteDir in disguise.
    try {
      await d.getFileHandle(name);
    } catch (e) {
      if (isMissing(e)) return;
      throw e;
    }
    try {
      await d.removeEntry(name);
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
  }

  async deleteDir(path: string): Promise<void> {
    const parts = segments(safePath(path));
    const name = parts.pop();
    if (name === undefined) {
      // The root handle itself can't be removed; empty it instead.
      const names: string[] = [];
      for await (const e of this.root.values()) names.push(e.name);
      for (const n of names) await this.root.removeEntry(n, { recursive: true });
      return;
    }
    const d = await this.dir(parts, false);
    if (!d) return;
    try {
      await d.getDirectoryHandle(name);
      await d.removeEntry(name, { recursive: true });
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
  }

  async list(dirPath: string): Promise<FsEntry[]> {
    const d = await this.dir(segments(safePath(dirPath)), false);
    if (!d) return [];
    const out: FsEntry[] = [];
    for await (const h of d.values()) {
      if (isJunkName(h.name)) continue;
      if (h.kind === 'directory') out.push({ name: h.name, kind: 'dir' });
      else {
        try {
          const f = await h.getFile();
          out.push({ name: h.name, kind: 'file', size: f.size, mtime: f.lastModified });
        } catch (e) {
          if (!isMissing(e)) throw e;
        }
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
