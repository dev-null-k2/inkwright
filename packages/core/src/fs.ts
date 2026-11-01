/**
 * Minimal file-system abstraction the vault is written against. Implementations: in-memory
 * (tests, previews), IndexedDB (web), File System Access (desktop folders), Capacitor
 * Filesystem (mobile), Node fs (MCP server, CLI). Paths are POSIX-style, relative to the vault
 * root, never starting with "/" and never containing "..".
 */
export interface FsEntry {
  name: string;
  kind: 'file' | 'dir';
  size?: number;
  /** Last modified, epoch ms, when the backend knows it. */
  mtime?: number;
}

export interface VaultFS {
  readText(path: string): Promise<string | null>;
  readBytes(path: string): Promise<Uint8Array | null>;
  /** Writes atomically where the backend allows (temp + rename). Creates parent dirs. */
  writeText(path: string, text: string): Promise<void>;
  writeBytes(path: string, bytes: Uint8Array): Promise<void>;
  /** Deletes a file; no-op when missing. */
  delete(path: string): Promise<void>;
  /** Deletes a directory recursively; no-op when missing. */
  deleteDir(path: string): Promise<void>;
  /** Immediate children of a directory; empty when missing. */
  list(dir: string): Promise<FsEntry[]>;
}

export function normalizePath(path: string): string {
  const parts = path.split('/').filter((p) => p !== '' && p !== '.');
  if (parts.some((p) => p === '..')) throw new Error(`Path escapes vault: ${path}`);
  return parts.join('/');
}

export function dirname(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? path : path.slice(i + 1);
}

const enc = new TextEncoder();
const dec = new TextDecoder();

/** In-memory VaultFS. Fast, deterministic; used by tests, previews and as a cache. */
export class MemoryFS implements VaultFS {
  private files = new Map<string, { bytes: Uint8Array; mtime: number }>();
  constructor(private clock: () => number = Date.now) {}

  async readText(path: string) {
    const f = this.files.get(normalizePath(path));
    return f ? dec.decode(f.bytes) : null;
  }
  async readBytes(path: string) {
    const f = this.files.get(normalizePath(path));
    return f ? f.bytes.slice() : null;
  }
  async writeText(path: string, text: string) {
    this.files.set(normalizePath(path), { bytes: enc.encode(text), mtime: this.clock() });
  }
  async writeBytes(path: string, bytes: Uint8Array) {
    this.files.set(normalizePath(path), { bytes: bytes.slice(), mtime: this.clock() });
  }
  async delete(path: string) {
    this.files.delete(normalizePath(path));
  }
  async deleteDir(path: string) {
    const p = normalizePath(path);
    const prefix = p === '' ? '' : p + '/';
    for (const k of [...this.files.keys()]) if (k.startsWith(prefix)) this.files.delete(k);
  }
  async list(dir: string): Promise<FsEntry[]> {
    const p = normalizePath(dir);
    const prefix = p === '' ? '' : p + '/';
    const out = new Map<string, FsEntry>();
    for (const [k, f] of this.files) {
      if (!k.startsWith(prefix)) continue;
      const rest = k.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) out.set(rest, { name: rest, kind: 'file', size: f.bytes.length, mtime: f.mtime });
      else {
        const name = rest.slice(0, slash);
        if (!out.has(name)) out.set(name, { name, kind: 'dir' });
      }
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** All file paths (tests, zip export). */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}

/** Walks a VaultFS recursively, yielding file paths. */
export async function walk(fs: VaultFS, dir = ''): Promise<string[]> {
  const out: string[] = [];
  for (const e of await fs.list(dir)) {
    const p = dir ? `${dir}/${e.name}` : e.name;
    if (e.kind === 'dir') out.push(...(await walk(fs, p)));
    else out.push(p);
  }
  return out;
}
