/**
 * Device-to-device sync with the ordinary SyncEngine: the other device's vault, served over the
 * encrypted peer link, is just another `Remote`.
 *
 * The device that starts a sync drives it: its SyncEngine lists, reads, writes and deletes files
 * on the peer exactly as it would on Google Drive or WebDAV, so the same three-way merge of note
 * sources, conflict copies for assets, optimistic-concurrency guards and safety stops (empty
 * listing, mass delete) apply. The other device only serves its vault through a `FolderRemote`,
 * whose revs are content hashes — exact and stable — so a write guarded by a rev fails cleanly
 * when the person there edits the same file mid-sync, and the engine re-reads and merges again.
 */
import { PreconditionFailedError, RemoteError, type Remote, type RemoteCallOptions, type RemoteEntry, type RemoteFile } from '../remote.ts';
import { isIgnoredPath } from '../engine.ts';
import { safePath } from '../util.ts';
import { PeerRpcError, type PeerRpc } from './rpc.ts';

const M = { list: 'vault.list', read: 'vault.read', write: 'vault.write', delete: 'vault.delete' } as const;

function mapError(e: unknown, path?: string): never {
  if (e instanceof PeerRpcError) {
    if (e.status === 412) throw new PreconditionFailedError(path ?? '', 'changed on the other device');
    throw new RemoteError(e.message, e.status, e.status === undefined);
  }
  throw e;
}

/** The other device's vault, as a Remote for this device's SyncEngine. */
export class PeerRemote implements Remote {
  constructor(private readonly rpc: PeerRpc) {}

  async list(opts: RemoteCallOptions = {}): Promise<RemoteEntry[]> {
    try {
      const r = await this.rpc.call(M.list, null, undefined, opts);
      const list = r.result as RemoteEntry[];
      if (!Array.isArray(list)) throw new RemoteError('The other device sent an invalid listing.');
      return list.filter((e) => e && typeof e.path === 'string' && typeof e.rev === 'string');
    } catch (e) {
      return mapError(e);
    }
  }

  async read(path: string, opts: RemoteCallOptions = {}): Promise<RemoteFile | null> {
    try {
      const r = await this.rpc.call(M.read, { path: safePath(path) }, undefined, opts);
      const meta = r.result as { rev: string; mtime?: number } | null;
      if (!meta) return null;
      return { bytes: r.bin ?? new Uint8Array(0), rev: meta.rev, ...(meta.mtime !== undefined ? { mtime: meta.mtime } : {}) };
    } catch (e) {
      return mapError(e, path);
    }
  }

  async write(path: string, bytes: Uint8Array, ifMatch?: string | null, opts: RemoteCallOptions = {}): Promise<RemoteEntry> {
    try {
      const r = await this.rpc.call(M.write, { path: safePath(path), ifMatch: ifMatch === undefined ? { any: true } : ifMatch }, bytes, opts);
      return r.result as RemoteEntry;
    } catch (e) {
      return mapError(e, path);
    }
  }

  async delete(path: string, ifMatch?: string, opts: RemoteCallOptions = {}): Promise<void> {
    try {
      await this.rpc.call(M.delete, { path: safePath(path), ...(ifMatch !== undefined ? { ifMatch } : {}) }, undefined, opts);
    } catch (e) {
      mapError(e, path);
    }
  }
}

export interface ServeVaultOptions {
  /** Refuse writes and deletes (a device paired for viewing only). */
  readOnly?: boolean;
  /** Called after each change the other device made here (the app reloads the open note). */
  onChange?: (path: string) => void;
}

function refuseDotPaths(path: string): string {
  const p = safePath(path);
  // Same exclusions as the engine: app state under dot-folders never crosses the link.
  if (!p || isIgnoredPath(p)) throw Object.assign(new Error(`Not a vault file: ${path}`), { status: 403 });
  return p;
}

function status(e: unknown): never {
  if (e instanceof PreconditionFailedError) throw Object.assign(new Error(e.message), { status: 412 });
  throw e;
}

/**
 * Serves this device's vault (as a Remote, normally a FolderRemote over the vault's file system)
 * to the other device. Returns a function that stops serving.
 */
export function servePeerVault(rpc: PeerRpc, local: Remote, opts: ServeVaultOptions = {}): () => void {
  const offs = [
    rpc.handle(M.list, async () => ({ result: (await local.list()).filter((e) => !isIgnoredPath(e.path)) })),
    rpc.handle(M.read, async (p) => {
      const path = refuseDotPaths((p as { path: string }).path);
      const f = await local.read(path);
      if (!f) return { result: null };
      return { result: { rev: f.rev, ...(f.mtime !== undefined ? { mtime: f.mtime } : {}) }, bin: f.bytes };
    }),
    rpc.handle(M.write, async (p, bin) => {
      if (opts.readOnly) throw Object.assign(new Error('This device only shares its notes for reading.'), { status: 403 });
      const { path: raw, ifMatch } = p as { path: string; ifMatch: string | null | { any: true } };
      const path = refuseDotPaths(raw);
      const guard = ifMatch && typeof ifMatch === 'object' ? undefined : ifMatch;
      const entry = await local.write(path, bin ?? new Uint8Array(0), guard).catch(status);
      opts.onChange?.(path);
      return { result: entry };
    }),
    rpc.handle(M.delete, async (p) => {
      if (opts.readOnly) throw Object.assign(new Error('This device only shares its notes for reading.'), { status: 403 });
      const { path: raw, ifMatch } = p as { path: string; ifMatch?: string };
      const path = refuseDotPaths(raw);
      await local.delete(path, ifMatch).catch(status);
      opts.onChange?.(path);
      return {};
    }),
  ];
  return () => offs.forEach((off) => off());
}
