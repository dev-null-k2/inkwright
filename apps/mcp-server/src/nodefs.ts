import { randomBytes } from 'node:crypto';
import { promises as fsp, realpathSync } from 'node:fs';
import * as path from 'node:path';
import { normalizePath, type FsEntry, type VaultFS } from '@inkwright/core';

/** Prefix of in-flight temp files; hidden from listings so readers never see half-written data. */
export const TEMP_PREFIX = '.inkwright-tmp-';

/**
 * VaultFS over a real folder (the user's synced vault). Every path is resolved inside the root and
 * re-checked after following symlinks, so nothing can be read or written outside the vault. Writes
 * go to a temp file in the same directory and are renamed into place, so sync clients (Google
 * Drive, iCloud, Dropbox) and the Inkwright app never observe a truncated note.
 */
export class NodeFS implements VaultFS {
  readonly root: string;
  private realRoot: string;

  constructor(root: string) {
    this.root = path.resolve(root);
    this.realRoot = realpathSync(this.root);
  }

  /** Absolute path for a vault-relative path; throws for anything that could escape the vault. */
  resolve(rel: string): string {
    if (typeof rel !== 'string' || rel.includes('\0') || rel.includes('\\') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) {
      throw new Error(`Unsafe vault path: ${JSON.stringify(rel)}`);
    }
    const norm = normalizePath(rel); // throws on ".."
    const abs = path.resolve(this.root, norm);
    if (abs !== this.root && !abs.startsWith(this.root + path.sep)) throw new Error(`Path escapes vault: ${rel}`);
    return abs;
  }

  /** Follows symlinks for the deepest existing ancestor and checks it is still inside the vault. */
  private async assertInside(abs: string): Promise<void> {
    let probe = abs;
    for (;;) {
      try {
        const real = await fsp.realpath(probe);
        if (real !== this.realRoot && !real.startsWith(this.realRoot + path.sep)) {
          throw new Error(`Path escapes vault via symlink: ${path.relative(this.root, abs)}`);
        }
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        const parent = path.dirname(probe);
        if (parent === probe) return;
        probe = parent;
      }
    }
  }

  async readText(p: string): Promise<string | null> {
    const b = await this.readBytes(p);
    return b == null ? null : new TextDecoder().decode(b);
  }

  async readBytes(p: string): Promise<Uint8Array | null> {
    const abs = this.resolve(p);
    await this.assertInside(abs);
    try {
      return new Uint8Array(await fsp.readFile(abs));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EISDIR' || code === 'ENOTDIR') return null;
      throw e;
    }
  }

  async writeText(p: string, text: string): Promise<void> {
    await this.writeBytes(p, new TextEncoder().encode(text));
  }

  async writeBytes(p: string, bytes: Uint8Array): Promise<void> {
    const abs = this.resolve(p);
    if (abs === this.root) throw new Error('Cannot write the vault root');
    const dir = path.dirname(abs);
    await this.assertInside(dir);
    await fsp.mkdir(dir, { recursive: true });
    await this.assertInside(dir);
    const tmp = path.join(dir, `${TEMP_PREFIX}${process.pid}-${randomBytes(6).toString('hex')}`);
    try {
      await fsp.writeFile(tmp, bytes);
      await fsp.rename(tmp, abs);
    } catch (e) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw e;
    }
  }

  async delete(p: string): Promise<void> {
    const abs = this.resolve(p);
    if (abs === this.root) throw new Error('Cannot delete the vault root');
    await this.assertInside(path.dirname(abs));
    await fsp.rm(abs, { force: true });
  }

  async deleteDir(p: string): Promise<void> {
    const abs = this.resolve(p);
    if (abs === this.root) throw new Error('Cannot delete the vault root');
    await this.assertInside(abs);
    await fsp.rm(abs, { recursive: true, force: true });
  }

  async list(dir: string): Promise<FsEntry[]> {
    const abs = this.resolve(dir);
    await this.assertInside(abs);
    let names: string[];
    try {
      names = await fsp.readdir(abs);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw e;
    }
    const out: FsEntry[] = [];
    for (const name of names) {
      if (name.startsWith(TEMP_PREFIX)) continue;
      try {
        const st = await fsp.stat(path.join(abs, name));
        if (st.isDirectory()) out.push({ name, kind: 'dir', mtime: st.mtimeMs });
        else if (st.isFile()) out.push({ name, kind: 'file', size: st.size, mtime: st.mtimeMs });
      } catch {
        // Vanished between readdir and stat (sync in progress); skip.
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** mtime (ms) and size of a file, or null when missing. */
  async stat(p: string): Promise<{ mtime: number; size: number } | null> {
    const abs = this.resolve(p);
    // Like every other read: a symlink must not report on a file outside the vault (SR-08).
    await this.assertInside(abs);
    try {
      const st = await fsp.stat(abs);
      return { mtime: st.mtimeMs, size: st.size };
    } catch {
      return null;
    }
  }
}
