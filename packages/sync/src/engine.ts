import { dirname, type VaultFS } from '@inkstone/core';
import { noteIdOf, regenerateDerived } from './derived.ts';
import { isDerivedPath, mergeFileBytes, mergeKindOf } from './merge.ts';
import { PreconditionFailedError, RemoteError, type Remote, type RemoteEntry, type RemoteFile } from './remote.ts';
import type { FileSyncState, SyncStateStore } from './state.ts';
import { isAbortError, isJunkName, mapLimit, sha256Hex, throwIfAborted, walkFiles } from './util.ts';

export type SyncAction = 'skip' | 'forget' | 'push' | 'pull' | 'delete-local' | 'delete-remote' | 'conflict';

export interface SyncProgress {
  phase: 'scanning' | 'syncing' | 'finishing' | 'done';
  done: number;
  total: number;
  path?: string;
}

export interface SyncReport {
  pushed: string[];
  pulled: string[];
  merged: string[];
  deleted: { local: string[]; remote: string[] };
  /** Conflict copies written (unmergeable assets changed on both sides; both versions kept). */
  conflicts: string[];
  errors: { path: string; message: string; error: unknown }[];
  /** Files already in sync. */
  unchanged: number;
}

/** True when the sync changed local files (the app should reload: `vault.invalidate()`). */
export function hasLocalChanges(r: SyncReport): boolean {
  return r.pulled.length > 0 || r.merged.length > 0 || r.deleted.local.length > 0 || r.conflicts.length > 0;
}

export type SafetyReason = 'remote-empty' | 'local-empty' | 'mass-delete-local' | 'mass-delete-remote';

/**
 * Thrown before anything is changed when a sync looks like data loss rather than user intent:
 * an empty listing on one side while the state says files were synced (broken server, wiped
 * storage, unmounted folder), or deleting a large share of the vault. Re-run with
 * `allowMassDelete` after the user confirms.
 */
export class SyncSafetyError extends Error {
  override name = 'SyncSafetyError';
  constructor(
    readonly reason: SafetyReason,
    message: string,
    readonly count: number,
  ) {
    super(message);
  }
}

export interface SyncEngineOptions {
  local: VaultFS;
  remote: Remote;
  state: SyncStateStore;
  onProgress?: (p: SyncProgress) => void;
  clock?: () => number;
  /** Files transferred in parallel (default 4). */
  concurrency?: number;
  /** Extra exclusions on top of the defaults (dot-folders such as `.inkstone/`, OS junk, temp files). */
  ignore?: (path: string) => boolean;
  /** Rewrite note.md / page SVGs after merging a note's sources (default true). */
  regenerateDerived?: boolean;
  /**
   * Skip re-hashing local files whose size and mtime match the last sync (default false).
   * Much cheaper for big vaults on real file systems; unsafe with coarse/fake clocks.
   */
  trustLocalMtime?: boolean;
  /** Abort when a run would delete at least `minFiles` and more than `fraction` of synced files. */
  massDelete?: { fraction: number; minFiles: number };
}

export interface SyncRunOptions {
  signal?: AbortSignal;
  /** The user confirmed a large deletion / an emptied side; skip the safety checks. */
  allowMassDelete?: boolean;
}

/** Default exclusions: anything under a dot-folder (`.inkstone/`, `.git/`, `.Trash/`), dotfiles, OS junk. */
export function isIgnoredPath(path: string): boolean {
  return path.split('/').some((seg) => seg.startsWith('.') || isJunkName(seg));
}

/** Decides what to do with one path from (local hash, remote rev, last-synced state). */
export function decide(localHash: string | null, remoteRev: string | null, base: Pick<FileSyncState, 'hash' | 'rev'> | null): SyncAction {
  if (localHash === null && remoteRev === null) return base ? 'forget' : 'skip';
  if (!base) {
    if (remoteRev === null) return 'push';
    if (localHash === null) return 'pull';
    return 'conflict'; // both exist, never synced: compare (and merge if different)
  }
  const localChanged = localHash !== base.hash;
  const remoteChanged = remoteRev !== base.rev;
  if (!localChanged && !remoteChanged) return 'skip';
  if (localChanged && !remoteChanged) return localHash === null ? 'delete-remote' : 'push';
  if (!localChanged && remoteChanged) return remoteRev === null ? 'delete-local' : 'pull';
  // Both changed. An edit beats a deletion on the other side: never lose content.
  if (localHash === null) return 'pull';
  if (remoteRev === null) return 'push';
  return 'conflict';
}

class Retry extends Error {
  constructor(why: string) {
    super(`Changed during sync: ${why}`);
  }
}

interface LocalInfo {
  hash: string;
  size?: number;
  mtime?: number;
}

interface RunCtx {
  signal?: AbortSignal;
  state: Map<string, FileSyncState>;
  local: Map<string, LocalInfo>;
  remote: Map<string, RemoteEntry>;
  report: SyncReport;
  mergedNotes: Set<string>;
  touchedDirs: Set<string>;
}

function conflictCopyName(path: string, now: number): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash + 1 ? `${path.slice(0, dot)}.conflict-${now}${path.slice(dot)}` : `${path}.conflict-${now}`;
}

function isAssetPath(path: string): boolean {
  return /^notes\/[^/]+\/assets\/[^/]+$/.test(path);
}

/**
 * Two-way file sync between a local VaultFS and a Remote, with three-way merges of note
 * sources. Safe to interrupt at any point: state is persisted after every file, and every
 * remote write is guarded by the rev it was based on.
 */
export class SyncEngine {
  private readonly local: VaultFS;
  private readonly remote: Remote;
  private readonly store: SyncStateStore;
  private readonly clock: () => number;
  private running: Promise<SyncReport> | null = null;

  constructor(private readonly opts: SyncEngineOptions) {
    this.local = opts.local;
    this.remote = opts.remote;
    this.store = opts.state;
    this.clock = opts.clock ?? Date.now;
  }

  private ignored(path: string): boolean {
    return isIgnoredPath(path) || (this.opts.ignore?.(path) ?? false);
  }

  private progress(p: SyncProgress): void {
    try {
      this.opts.onProgress?.(p);
    } catch {
      /* a UI callback must not break sync */
    }
  }

  /** Runs one sync. A call while a sync is running returns the running one. */
  sync(opts: SyncRunOptions = {}): Promise<SyncReport> {
    if (!this.running) this.running = this.run(opts).finally(() => (this.running = null));
    return this.running;
  }

  get isRunning(): boolean {
    return this.running !== null;
  }

  private async run(opts: SyncRunOptions): Promise<SyncReport> {
    const signal = opts.signal;
    throwIfAborted(signal);
    const report: SyncReport = { pushed: [], pulled: [], merged: [], deleted: { local: [], remote: [] }, conflicts: [], errors: [], unchanged: 0 };
    this.progress({ phase: 'scanning', done: 0, total: 0 });

    const state = await this.store.load();
    for (const p of [...state.keys()]) if (this.ignored(p)) state.delete(p);

    // List both sides. A failing remote listing throws here: it is never mistaken for "empty".
    const [local, remoteList] = await Promise.all([this.scanLocal(state, signal), this.remote.list({ signal })]);
    const remote = new Map<string, RemoteEntry>();
    for (const e of remoteList) if (!this.ignored(e.path)) remote.set(e.path, e);
    throwIfAborted(signal);

    const ctx: RunCtx = { signal, state, local, remote, report, mergedNotes: new Set(), touchedDirs: new Set() };
    const paths = [...new Set([...local.keys(), ...remote.keys(), ...state.keys()])].sort();
    const actions = new Map(paths.map((p) => [p, decide(local.get(p)?.hash ?? null, remote.get(p)?.rev ?? null, state.get(p) ?? null)]));

    if (!opts.allowMassDelete) this.checkSafety(ctx, actions);

    const statRefresh: FileSyncState[] = [];
    const work = paths.filter((p) => {
      if (actions.get(p) !== 'skip') return true;
      if (state.has(p)) report.unchanged++;
      const st = state.get(p);
      const li = local.get(p);
      if (this.opts.trustLocalMtime && st && li && li.mtime !== undefined && (st.mtime !== li.mtime || st.size !== li.size)) {
        statRefresh.push({ ...st, mtime: li.mtime, size: li.size });
      }
      return false;
    });
    // Record current stats of unchanged files so the next scan can trust them (keeps stored bases).
    for (const st of statRefresh) {
      await this.store.put(st);
      state.set(st.path, st);
    }

    let done = 0;
    this.progress({ phase: 'syncing', done, total: work.length });
    await mapLimit(
      work,
      this.opts.concurrency ?? 4,
      async (path) => {
        await this.syncPathSafely(ctx, path, false);
        this.progress({ phase: 'syncing', done: ++done, total: work.length, path });
      },
      signal,
    );

    this.progress({ phase: 'finishing', done, total: work.length });
    if ((this.opts.regenerateDerived ?? true) && ctx.mergedNotes.size) {
      for (const noteId of ctx.mergedNotes) {
        throwIfAborted(signal);
        let written: string[];
        try {
          written = await regenerateDerived(this.local, noteId);
        } catch (e) {
          report.errors.push({ path: `notes/${noteId}`, message: `Regenerating derived files failed: ${(e as Error)?.message ?? e}`, error: e });
          continue;
        }
        for (const p of written) {
          const bytes = await this.local.readBytes(p);
          if (!bytes) continue;
          local.set(p, { hash: await sha256Hex(bytes), size: bytes.length, mtime: this.clock() });
          await this.syncPathSafely(ctx, p, true);
        }
      }
    }
    await this.pruneEmptyDirs(ctx.touchedDirs);
    this.progress({ phase: 'done', done, total: work.length });
    return report;
  }

  private checkSafety(ctx: RunCtx, actions: Map<string, SyncAction>): void {
    const synced = ctx.state.size;
    if (synced === 0) return;
    if (ctx.remote.size === 0 && ctx.local.size > 0) {
      throw new SyncSafetyError(
        'remote-empty',
        `The remote listing is empty but ${synced} files were synced before. Refusing to delete them locally; check the remote, or confirm to continue.`,
        synced,
      );
    }
    if (ctx.local.size === 0 && ctx.remote.size > 0) {
      throw new SyncSafetyError(
        'local-empty',
        `The local vault is empty but ${synced} files were synced before. Refusing to delete them remotely; confirm to continue.`,
        synced,
      );
    }
    const { fraction, minFiles } = this.opts.massDelete ?? { fraction: 0.5, minFiles: 25 };
    let delLocal = 0;
    let delRemote = 0;
    for (const a of actions.values()) {
      if (a === 'delete-local') delLocal++;
      else if (a === 'delete-remote') delRemote++;
    }
    for (const [n, reason] of [
      [delLocal, 'mass-delete-local'],
      [delRemote, 'mass-delete-remote'],
    ] as const) {
      if (n >= minFiles && n > fraction * synced) {
        throw new SyncSafetyError(reason, `This sync would delete ${n} of ${synced} synced files ${reason === 'mass-delete-local' ? 'on this device' : 'on the remote'}; confirm to continue.`, n);
      }
    }
  }

  private async scanLocal(state: Map<string, FileSyncState>, signal?: AbortSignal): Promise<Map<string, LocalInfo>> {
    const files = await walkFiles(this.local, '', (p) => this.ignored(p));
    const out = new Map<string, LocalInfo>();
    await mapLimit(
      files,
      8,
      async (f) => {
        const st = state.get(f.path);
        if (this.opts.trustLocalMtime && st && f.mtime !== undefined && st.mtime === f.mtime && st.size === f.size) {
          out.set(f.path, { hash: st.hash, size: f.size, mtime: f.mtime });
          return;
        }
        const bytes = await this.local.readBytes(f.path);
        if (bytes) out.set(f.path, { hash: await sha256Hex(bytes), size: bytes.length, mtime: f.mtime });
      },
      signal,
    );
    return out;
  }

  /** syncPath + error accounting. Aborts and auth failures stop the whole run. */
  private async syncPathSafely(ctx: RunCtx, path: string, preferLocal: boolean): Promise<void> {
    try {
      await this.syncPath(ctx, path, preferLocal);
    } catch (e) {
      if (isAbortError(e) || ctx.signal?.aborted) throw e;
      if (e instanceof RemoteError && e.status === 401) throw e;
      ctx.report.errors.push({ path, message: (e as Error)?.message ?? String(e), error: e });
    }
  }

  private async syncPath(ctx: RunCtx, path: string, preferLocal: boolean): Promise<void> {
    let localHash = ctx.local.get(path)?.hash ?? null;
    let remote = ctx.remote.get(path) ?? null;
    let remoteFile: RemoteFile | null | undefined;
    for (let attempt = 0; ; attempt++) {
      throwIfAborted(ctx.signal);
      try {
        await this.step(ctx, path, localHash, remote, remoteFile, preferLocal);
        return;
      } catch (e) {
        if (!(e instanceof Retry) && !(e instanceof PreconditionFailedError)) throw e;
        if (attempt >= 3) throw new Error(`Gave up on ${path} after repeated concurrent changes`);
        // Someone changed a side under us: look again at both and decide afresh.
        const lb = await this.local.readBytes(path);
        localHash = lb ? await sha256Hex(lb) : null;
        if (lb) ctx.local.set(path, { ...ctx.local.get(path), hash: localHash!, size: lb.length });
        else ctx.local.delete(path);
        remoteFile = await this.remote.read(path, { signal: ctx.signal });
        remote = remoteFile ? { path, rev: remoteFile.rev, mtime: remoteFile.mtime, size: remoteFile.bytes.length } : null;
        if (remote) ctx.remote.set(path, remote);
        else ctx.remote.delete(path);
      }
    }
  }

  private async step(ctx: RunCtx, path: string, localHash: string | null, remote: RemoteEntry | null, remoteFile: RemoteFile | null | undefined, preferLocal: boolean): Promise<void> {
    const base = ctx.state.get(path) ?? null;
    const signal = ctx.signal;
    switch (decide(localHash, remote?.rev ?? null, base)) {
      case 'skip':
        if (base) ctx.report.unchanged++;
        return;
      case 'forget':
        await this.forget(ctx, path);
        return;
      case 'push': {
        const bytes = await this.local.readBytes(path);
        if (!bytes) throw new Retry('local file vanished');
        const entry = await this.remote.write(path, bytes, remote ? remote.rev : null, { signal });
        ctx.remote.set(path, entry);
        await this.record(ctx, path, bytes, entry.rev, true);
        ctx.report.pushed.push(path);
        return;
      }
      case 'pull': {
        const rf = remoteFile ?? (await this.remote.read(path, { signal }));
        if (!rf) throw new Retry('remote file vanished');
        await this.writeLocalChecked(path, localHash, rf.bytes);
        ctx.remote.set(path, { path, rev: rf.rev, mtime: rf.mtime, size: rf.bytes.length });
        await this.record(ctx, path, rf.bytes, rf.rev, false);
        ctx.report.pulled.push(path);
        return;
      }
      case 'delete-remote':
        await this.remote.delete(path, remote!.rev, { signal });
        ctx.remote.delete(path);
        await this.forget(ctx, path);
        ctx.report.deleted.remote.push(path);
        return;
      case 'delete-local': {
        const cur = await this.local.readBytes(path);
        if (cur && (await sha256Hex(cur)) !== localHash) throw new Retry('local file edited');
        await this.local.delete(path);
        ctx.local.delete(path);
        ctx.touchedDirs.add(dirname(path));
        await this.forget(ctx, path);
        ctx.report.deleted.local.push(path);
        return;
      }
      case 'conflict':
        await this.resolveConflict(ctx, path, base, remote!, remoteFile, preferLocal);
        return;
    }
  }

  private async resolveConflict(ctx: RunCtx, path: string, base: FileSyncState | null, remote: RemoteEntry, remoteFile: RemoteFile | null | undefined, preferLocal: boolean): Promise<void> {
    const signal = ctx.signal;
    const rf = remoteFile ?? (await this.remote.read(path, { signal }));
    if (!rf) throw new Retry('remote file vanished');
    const lb = await this.local.readBytes(path);
    if (!lb) throw new Retry('local file vanished');
    const [lh, rh] = await Promise.all([sha256Hex(lb), sha256Hex(rf.bytes)]);
    ctx.remote.set(path, { path, rev: rf.rev, mtime: rf.mtime ?? remote.mtime, size: rf.bytes.length });

    if (lh === rh) {
      // Same content on both sides (first sync of a copied vault, or the same edit twice).
      await this.record(ctx, path, lb, rf.rev, true);
      ctx.report.unchanged++;
      return;
    }

    if (mergeKindOf(path) && !isDerivedPath(path)) {
      let baseBytes = base ? await this.store.getBase(path) : null;
      if (baseBytes && base && (await sha256Hex(baseBytes)) !== base.hash) baseBytes = null;
      const merged = mergeFileBytes(path, baseBytes, lb, rf.bytes, { prefer: 'local' });
      if (merged) {
        const mh = await sha256Hex(merged);
        let rev = rf.rev;
        if (mh !== rh) {
          const entry = await this.remote.write(path, merged, rf.rev, { signal });
          rev = entry.rev;
          ctx.remote.set(path, entry);
        }
        if (mh !== lh) await this.writeLocalChecked(path, lh, merged);
        await this.record(ctx, path, merged, rev, false);
        ctx.report.merged.push(path);
        const noteId = noteIdOf(path);
        if (noteId) ctx.mergedNotes.add(noteId);
        return;
      }
    }

    // Unmergeable (derived, binary, or undecodable): newest wins.
    const lm = ctx.local.get(path)?.mtime ?? 0;
    const rm = rf.mtime ?? remote.mtime ?? 0;
    if (isAssetPath(path)) {
      // Never drop a user's image/recording: keep the remote one in place, the local one as a copy.
      const copy = conflictCopyName(path, this.clock());
      await this.local.writeBytes(copy, lb);
      const entry = await this.remote.write(copy, lb, null, { signal });
      ctx.remote.set(copy, entry);
      await this.record(ctx, copy, lb, entry.rev, false);
      ctx.report.conflicts.push(copy);
      await this.writeLocalChecked(path, lh, rf.bytes);
      await this.record(ctx, path, rf.bytes, rf.rev, false);
      ctx.report.pulled.push(path);
      return;
    }
    if (preferLocal || lm >= rm) {
      const entry = await this.remote.write(path, lb, rf.rev, { signal });
      ctx.remote.set(path, entry);
      await this.record(ctx, path, lb, entry.rev, true);
      ctx.report.pushed.push(path);
    } else {
      await this.writeLocalChecked(path, lh, rf.bytes);
      await this.record(ctx, path, rf.bytes, rf.rev, false);
      ctx.report.pulled.push(path);
    }
  }

  /** Overwrites a local file only if it still has the content we planned against. */
  private async writeLocalChecked(path: string, expectedHash: string | null, bytes: Uint8Array): Promise<void> {
    const cur = await this.local.readBytes(path);
    const h = cur ? await sha256Hex(cur) : null;
    if (h !== expectedHash) throw new Retry('local file edited');
    await this.local.writeBytes(path, bytes);
  }

  private async record(ctx: RunCtx, path: string, bytes: Uint8Array, rev: string, localUntouched: boolean): Promise<void> {
    const hash = await sha256Hex(bytes);
    const li = ctx.local.get(path);
    const entry: FileSyncState = { path, hash, rev, syncedAt: this.clock(), size: bytes.length };
    // The listing's mtime is only valid if we didn't rewrite the local file.
    if (localUntouched && li && li.hash === hash && li.mtime !== undefined) entry.mtime = li.mtime;
    ctx.local.set(path, { hash, size: bytes.length, mtime: entry.mtime });
    ctx.state.set(path, entry);
    await this.store.put(entry, mergeKindOf(path) ? bytes : null);
  }

  private async forget(ctx: RunCtx, path: string): Promise<void> {
    ctx.state.delete(path);
    await this.store.remove(path);
  }

  /**
   * Removes directories emptied by local deletions (deepest first), so folders mirror notes.
   * Only inside a note/notebook folder (depth ≥ 2): `notes/` itself and the root are kept.
   */
  private async pruneEmptyDirs(dirs: Set<string>): Promise<void> {
    const sorted = [...dirs].sort((a, b) => b.split('/').length - a.split('/').length);
    const seen = new Set<string>();
    for (let d of sorted) {
      while (d.split('/').length >= 2 && !seen.has(d)) {
        seen.add(d);
        try {
          if ((await this.local.list(d)).length > 0) break;
          await this.local.deleteDir(d);
        } catch {
          break;
        }
        d = dirname(d);
      }
    }
  }
}
