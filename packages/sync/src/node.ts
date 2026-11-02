/**
 * Node-only entry (`@inkwright/sync/node`): a VaultFS over a real directory, used by the MCP
 * server and CLI tools. Kept out of the main entry so browser bundles never see `node:fs`.
 */
import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import { randomBytes } from 'node:crypto';
import type { FsEntry, VaultFS } from '@inkwright/core';
import { TEMP_SUFFIX, isJunkName, safePath, segments, utf8Decode, utf8Encode } from './util.ts';

function code(e: unknown): string | undefined {
  return (e as { code?: string } | null)?.code;
}

export interface NodeFSOptions {
  /** fsync file contents before the rename (default true): survives power loss, slightly slower. */
  fsync?: boolean;
}

export class NodeFS implements VaultFS {
  readonly root: string;
  private readonly fsync: boolean;

  constructor(root: string, opts: NodeFSOptions = {}) {
    this.root = nodePath.resolve(root);
    this.fsync = opts.fsync ?? true;
  }

  /** Absolute path for a vault path; refuses anything resolving outside the root. */
  resolve(path: string): string {
    const parts = segments(safePath(path));
    const full = nodePath.resolve(this.root, ...parts);
    if (full !== this.root && !full.startsWith(this.root + nodePath.sep)) throw new Error(`Path escapes vault: ${path}`);
    return full;
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    try {
      const b = await fsp.readFile(this.resolve(path));
      return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    } catch (e) {
      const c = code(e);
      if (c === 'ENOENT' || c === 'EISDIR' || c === 'ENOTDIR') return null;
      throw e;
    }
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.readBytes(path);
    return b ? utf8Decode(b) : null;
  }

  /** Atomic: write `<name>.<random>.inkwright-tmp` next to the target, fsync, rename over it. */
  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const full = this.resolve(path);
    if (full === this.root) throw new Error('Cannot write to the vault root');
    await fsp.mkdir(nodePath.dirname(full), { recursive: true });
    const tmp = `${full}.${randomBytes(4).toString('hex')}${TEMP_SUFFIX}`;
    try {
      const fh = await fsp.open(tmp, 'wx');
      try {
        await fh.writeFile(bytes);
        if (this.fsync) await fh.sync();
      } finally {
        await fh.close();
      }
      await fsp.rename(tmp, full);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  writeText(path: string, text: string): Promise<void> {
    return this.writeBytes(path, utf8Encode(text));
  }

  async delete(path: string): Promise<void> {
    const full = this.resolve(path);
    if (full === this.root) return;
    try {
      await fsp.unlink(full);
    } catch (e) {
      const c = code(e);
      if (c === 'ENOENT' || c === 'ENOTDIR') return;
      if (c === 'EISDIR' || c === 'EPERM') {
        // unlink on a directory: EISDIR on Linux, EPERM on macOS. delete() only removes files.
        const st = await fsp.stat(full).catch(() => null);
        if (st?.isDirectory()) return;
      }
      throw e;
    }
  }

  async deleteDir(path: string): Promise<void> {
    const full = this.resolve(path);
    if (full === this.root) {
      // Empty the vault but keep the root folder (it may be a mount point or a synced folder).
      const names = await fsp.readdir(full).catch(() => [] as string[]);
      await Promise.all(names.map((n) => fsp.rm(nodePath.join(full, n), { recursive: true, force: true })));
      return;
    }
    const st = await fsp.lstat(full).catch(() => null);
    if (!st || !st.isDirectory()) return;
    await fsp.rm(full, { recursive: true, force: true });
  }

  async list(dir: string): Promise<FsEntry[]> {
    const full = this.resolve(dir);
    let names: string[];
    try {
      names = await fsp.readdir(full);
    } catch (e) {
      const c = code(e);
      if (c === 'ENOENT' || c === 'ENOTDIR') return [];
      throw e;
    }
    const out: FsEntry[] = [];
    await Promise.all(
      names.map(async (name) => {
        if (isJunkName(name)) return;
        const st = await fsp.stat(nodePath.join(full, name)).catch(() => null); // follows symlinks
        if (!st) return;
        if (st.isDirectory()) out.push({ name, kind: 'dir' });
        else if (st.isFile()) out.push({ name, kind: 'file', size: st.size, mtime: Math.floor(st.mtimeMs) });
      }),
    );
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }
}
