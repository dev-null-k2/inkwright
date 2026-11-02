import type { VaultFS } from '@inkwright/core';
import { isJunkName, safePath, sha256Hex, throwIfAborted, walkFiles } from './util.ts';

/** One file on a remote, as listed. `rev` changes whenever the content changes (ETag, Drive id+md5, hash). */
export interface RemoteEntry {
  path: string;
  rev: string;
  mtime?: number;
  size?: number;
}

export interface RemoteFile {
  bytes: Uint8Array;
  rev: string;
  mtime?: number;
}

export interface RemoteCallOptions {
  signal?: AbortSignal;
}

/**
 * A place the vault is mirrored to, file for file. Paths are vault-relative POSIX paths.
 *
 * `ifMatch` on write/delete is an optimistic-concurrency guard:
 * - `undefined`: unconditional;
 * - `null`: only if the file does not exist (create);
 * - a rev string: only if the current rev equals it.
 * A failed guard throws {@link PreconditionFailedError}.
 */
export interface Remote {
  /** Every file under the remote vault root, recursively. Must throw on failure — never return a partial or empty list. */
  list(opts?: RemoteCallOptions): Promise<RemoteEntry[]>;
  /** Null when the file doesn't exist. */
  read(path: string, opts?: RemoteCallOptions): Promise<RemoteFile | null>;
  write(path: string, bytes: Uint8Array, ifMatch?: string | null, opts?: RemoteCallOptions): Promise<RemoteEntry>;
  /** No-op when missing (unless `ifMatch` is a rev, which then fails). */
  delete(path: string, ifMatch?: string, opts?: RemoteCallOptions): Promise<void>;
}

export class RemoteError extends Error {
  override name = 'RemoteError';
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
  }
}

/** The remote file changed (or appeared/disappeared) since the rev the caller expected. */
export class PreconditionFailedError extends RemoteError {
  override name = 'PreconditionFailedError';
  constructor(path: string, detail = '') {
    super(`Remote file changed concurrently: ${path}${detail ? ` (${detail})` : ''}`, 412, false);
  }
}

function checkGuard(path: string, ifMatch: string | null | undefined, currentRev: string | null): void {
  if (ifMatch === undefined) return;
  if (ifMatch === null) {
    if (currentRev !== null) throw new PreconditionFailedError(path, 'exists');
  } else if (currentRev !== ifMatch) {
    throw new PreconditionFailedError(path, currentRev === null ? 'missing' : `rev ${currentRev}`);
  }
}

// ---- MemoryRemote ---------------------------------------------------------------------------

export type RemoteOp = 'list' | 'read' | 'write' | 'delete';

export interface MemoryRemoteOptions {
  clock?: () => number;
}

/**
 * In-memory remote for tests and demos. Simulates ETag-style revs, other writers (`put`,
 * `remove`), injected failures (`failNext`, `hook`) and broken listings (`listOverride`).
 */
export class MemoryRemote implements Remote {
  private files = new Map<string, { bytes: Uint8Array; rev: string; mtime: number }>();
  private seq = 0;
  private failures: { op: RemoteOp | '*'; path?: string; error: Error; times: number }[] = [];
  private readonly clock: () => number;
  /** Every call, in order (tests assert on traffic). */
  readonly calls: { op: RemoteOp; path?: string }[] = [];
  /** Runs before every operation; may throw or mutate the remote (simulate a concurrent writer). */
  hook: ((op: RemoteOp, path?: string) => void | Promise<void>) | null = null;
  /** Replaces the listing result (e.g. `() => []` to simulate a broken server). */
  listOverride: (() => RemoteEntry[]) | null = null;

  constructor(opts: MemoryRemoteOptions = {}) {
    this.clock = opts.clock ?? Date.now;
  }

  /** Makes the next `times` matching operations throw `error` (default: a retryable 503). */
  failNext(op: RemoteOp | '*', opts: { path?: string; error?: Error; times?: number } = {}): void {
    this.failures.push({
      op,
      path: opts.path,
      error: opts.error ?? new RemoteError(`Injected ${op} failure`, 503, true),
      times: opts.times ?? 1,
    });
  }

  private async before(op: RemoteOp, path?: string, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    this.calls.push({ op, path });
    const f = this.failures.find((x) => (x.op === '*' || x.op === op) && (x.path === undefined || x.path === path));
    if (f) {
      if (--f.times <= 0) this.failures.splice(this.failures.indexOf(f), 1);
      throw f.error;
    }
    await this.hook?.(op, path);
  }

  private nextRev(): string {
    return `"m${++this.seq}"`;
  }

  async list(opts: RemoteCallOptions = {}): Promise<RemoteEntry[]> {
    await this.before('list', undefined, opts.signal);
    if (this.listOverride) return this.listOverride();
    return [...this.files].map(([path, f]) => ({ path, rev: f.rev, mtime: f.mtime, size: f.bytes.length }));
  }

  async read(path: string, opts: RemoteCallOptions = {}): Promise<RemoteFile | null> {
    const p = safePath(path);
    await this.before('read', p, opts.signal);
    const f = this.files.get(p);
    return f ? { bytes: f.bytes.slice(), rev: f.rev, mtime: f.mtime } : null;
  }

  async write(path: string, bytes: Uint8Array, ifMatch?: string | null, opts: RemoteCallOptions = {}): Promise<RemoteEntry> {
    const p = safePath(path);
    await this.before('write', p, opts.signal);
    checkGuard(p, ifMatch, this.files.get(p)?.rev ?? null);
    return this.put(p, bytes);
  }

  async delete(path: string, ifMatch?: string, opts: RemoteCallOptions = {}): Promise<void> {
    const p = safePath(path);
    await this.before('delete', p, opts.signal);
    const cur = this.files.get(p)?.rev ?? null;
    if (cur === null && ifMatch === undefined) return;
    checkGuard(p, ifMatch, cur);
    this.files.delete(p);
  }

  // -- Direct access, bypassing hooks and failures ("another device wrote this") --

  put(path: string, content: Uint8Array | string): RemoteEntry {
    const p = safePath(path);
    const bytes = typeof content === 'string' ? new TextEncoder().encode(content) : content.slice();
    const f = { bytes, rev: this.nextRev(), mtime: this.clock() };
    this.files.set(p, f);
    return { path: p, rev: f.rev, mtime: f.mtime, size: bytes.length };
  }

  remove(path: string): void {
    this.files.delete(safePath(path));
  }

  get(path: string): Uint8Array | null {
    return this.files.get(safePath(path))?.bytes.slice() ?? null;
  }

  text(path: string): string | null {
    const b = this.get(path);
    return b ? new TextDecoder().decode(b) : null;
  }

  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}

// ---- FolderRemote -----------------------------------------------------------------------------

export interface FolderRemoteOptions {
  /**
   * Reuse a file's hash while its (mtime, size) is unchanged (default true). Turn off for
   * backends whose clocks are coarse or fake (e.g. a MemoryFS with a frozen clock in tests).
   */
  cacheHashes?: boolean;
}

/**
 * Treats any VaultFS as a remote — "sync to a folder" (a USB stick, a Dropbox/iCloud folder
 * opened via File System Access, a second IndexedDB vault) through the same engine. The rev is
 * the content's SHA-256, so it is exact and stable across restarts.
 */
export class FolderRemote implements Remote {
  private hashCache = new Map<string, { key: string; rev: string }>();
  private readonly cacheHashes: boolean;

  constructor(
    readonly fs: VaultFS,
    opts: FolderRemoteOptions = {},
  ) {
    this.cacheHashes = opts.cacheHashes ?? true;
  }

  private static revOf(hash: string): string {
    return `sha256:${hash}`;
  }

  async list(opts: RemoteCallOptions = {}): Promise<RemoteEntry[]> {
    throwIfAborted(opts.signal);
    const files = await walkFiles(this.fs, '', (_p, e) => isJunkName(e.name));
    const out: RemoteEntry[] = [];
    for (const f of files) {
      throwIfAborted(opts.signal);
      const key = f.mtime !== undefined && f.size !== undefined ? `${f.mtime}:${f.size}` : null;
      const cached = this.hashCache.get(f.path);
      let rev: string;
      if (this.cacheHashes && key && cached?.key === key) rev = cached.rev;
      else {
        const bytes = await this.fs.readBytes(f.path);
        if (!bytes) continue; // vanished mid-walk
        rev = FolderRemote.revOf(await sha256Hex(bytes));
        if (key) this.hashCache.set(f.path, { key, rev });
      }
      out.push({ path: f.path, rev, mtime: f.mtime, size: f.size });
    }
    return out;
  }

  async read(path: string, opts: RemoteCallOptions = {}): Promise<RemoteFile | null> {
    throwIfAborted(opts.signal);
    const bytes = await this.fs.readBytes(safePath(path));
    if (!bytes) return null;
    return { bytes, rev: FolderRemote.revOf(await sha256Hex(bytes)) };
  }

  private async currentRev(path: string): Promise<string | null> {
    const b = await this.fs.readBytes(path);
    return b ? FolderRemote.revOf(await sha256Hex(b)) : null;
  }

  async write(path: string, bytes: Uint8Array, ifMatch?: string | null, opts: RemoteCallOptions = {}): Promise<RemoteEntry> {
    throwIfAborted(opts.signal);
    const p = safePath(path);
    if (ifMatch !== undefined) checkGuard(p, ifMatch, await this.currentRev(p));
    await this.fs.writeBytes(p, bytes);
    this.hashCache.delete(p);
    return { path: p, rev: FolderRemote.revOf(await sha256Hex(bytes)), size: bytes.length };
  }

  async delete(path: string, ifMatch?: string, opts: RemoteCallOptions = {}): Promise<void> {
    throwIfAborted(opts.signal);
    const p = safePath(path);
    if (ifMatch !== undefined) checkGuard(p, ifMatch, await this.currentRev(p));
    await this.fs.delete(p);
    this.hashCache.delete(p);
  }
}
