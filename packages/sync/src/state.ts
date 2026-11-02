import type { VaultFS } from '@inkwright/core';
import { safePath } from './util.ts';

/** What both sides agreed on the last time a file synced. */
export interface FileSyncState {
  path: string;
  /** SHA-256 (hex) of the content at last sync — identical on both sides at that moment. */
  hash: string;
  /** Remote rev at last sync. */
  rev: string;
  /** Local size/mtime at last sync, for the optional mtime fast path. */
  size?: number;
  mtime?: number;
  syncedAt: number;
}

/**
 * Persistent per-(vault, remote) sync state. Lives OUTSIDE the vault (app storage), so it is
 * never synced itself. Besides one record per file it keeps the last-synced content of
 * mergeable files: the base for three-way merges.
 */
export interface SyncStateStore {
  load(): Promise<Map<string, FileSyncState>>;
  /**
   * Records a file. `base`: content kept for three-way merges; `null` drops a stored base;
   * `undefined` leaves it as is.
   */
  put(entry: FileSyncState, base?: Uint8Array | null): Promise<void>;
  remove(path: string): Promise<void>;
  getBase(path: string): Promise<Uint8Array | null>;
  clear(): Promise<void>;
}

export class MemoryStateStore implements SyncStateStore {
  private entries = new Map<string, FileSyncState>();
  private bases = new Map<string, Uint8Array>();
  /** Number of put/remove calls (tests check per-file persistence). */
  writes = 0;

  async load() {
    return new Map([...this.entries].map(([k, v]) => [k, { ...v }]));
  }
  async put(entry: FileSyncState, base?: Uint8Array | null) {
    this.writes++;
    this.entries.set(entry.path, { ...entry });
    if (base) this.bases.set(entry.path, base.slice());
    else if (base === null) this.bases.delete(entry.path);
  }
  async remove(path: string) {
    this.writes++;
    this.entries.delete(path);
    this.bases.delete(path);
  }
  async getBase(path: string) {
    return this.bases.get(path)?.slice() ?? null;
  }
  async clear() {
    this.entries.clear();
    this.bases.clear();
  }
  get size() {
    return this.entries.size;
  }
}

type JournalOp = { op: 'put'; entry: FileSyncState } | { op: 'remove'; path: string };

interface Snapshot {
  version: 1;
  seq: number;
  entries: FileSyncState[];
}

export interface FsStateStoreOptions {
  /** Folder inside the state FS; use one per (vault, remote) pair. Default "sync-state". */
  prefix?: string;
  /** Fold the journal into the snapshot after this many records (default 200). */
  compactEvery?: number;
}

/**
 * SyncStateStore on its own VaultFS (e.g. an IndexedDBFS named "inkwright-sync", or an app
 * data folder) — never the vault's FS. Each change is one small journal file, so persisting
 * after every synced file costs O(1); the journal is folded into `state.json` periodically.
 * Bases are stored as plain files under `base/`.
 *
 *     <prefix>/state.json              {version, seq, entries[]}
 *     <prefix>/journal/<seq>.json      one put/remove each, applied when seq > snapshot.seq
 *     <prefix>/base/<vault path>       last-synced content of mergeable files
 */
export class FsStateStore implements SyncStateStore {
  private entries: Map<string, FileSyncState> | null = null;
  private seq = 0;
  private snapshotSeq = 0;
  private pending = 0;
  private chain: Promise<unknown> = Promise.resolve();
  private readonly prefix: string;
  private readonly compactEvery: number;

  constructor(
    private readonly fs: VaultFS,
    opts: FsStateStoreOptions = {},
  ) {
    this.prefix = safePath(opts.prefix ?? 'sync-state');
    this.compactEvery = opts.compactEvery ?? 200;
  }

  private p(rel: string): string {
    return this.prefix ? `${this.prefix}/${rel}` : rel;
  }

  /** Serializes all mutations (the engine calls put/remove concurrently). */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => {});
    return run;
  }

  private async ensureLoaded(): Promise<Map<string, FileSyncState>> {
    if (this.entries) return this.entries;
    const entries = new Map<string, FileSyncState>();
    let snapSeq = 0;
    const snapText = await this.fs.readText(this.p('state.json'));
    if (snapText) {
      try {
        const snap = JSON.parse(snapText) as Snapshot;
        snapSeq = snap.seq ?? 0;
        for (const e of snap.entries ?? []) entries.set(e.path, e);
      } catch {
        /* corrupt snapshot: journal (if any) still applies; worst case a full re-compare */
      }
    }
    let maxSeq = snapSeq;
    const journal = (await this.fs.list(this.p('journal')))
      .filter((e) => e.kind === 'file' && /^\d+\.json$/.test(e.name))
      .map((e) => ({ name: e.name, seq: Number(e.name.slice(0, -5)) }))
      .sort((a, b) => a.seq - b.seq);
    for (const j of journal) {
      if (j.seq <= snapSeq) continue;
      const t = await this.fs.readText(this.p(`journal/${j.name}`));
      if (!t) continue;
      try {
        const op = JSON.parse(t) as JournalOp;
        if (op.op === 'put') entries.set(op.entry.path, op.entry);
        else entries.delete(op.path);
      } catch {
        continue; // torn write of the newest record: ignore it
      }
      maxSeq = Math.max(maxSeq, j.seq);
      this.pending++;
    }
    this.seq = maxSeq;
    this.snapshotSeq = snapSeq;
    this.entries = entries;
    return entries;
  }

  private async append(op: JournalOp): Promise<void> {
    const seq = ++this.seq;
    await this.fs.writeText(this.p(`journal/${String(seq).padStart(12, '0')}.json`), JSON.stringify(op));
    if (++this.pending >= this.compactEvery) await this.compactNow();
  }

  private async compactNow(): Promise<void> {
    const entries = await this.ensureLoaded();
    const snap: Snapshot = { version: 1, seq: this.seq, entries: [...entries.values()] };
    await this.fs.writeText(this.p('state.json'), JSON.stringify(snap));
    this.snapshotSeq = this.seq;
    this.pending = 0;
    for (const e of await this.fs.list(this.p('journal'))) {
      if (e.kind === 'file' && /^\d+\.json$/.test(e.name) && Number(e.name.slice(0, -5)) <= this.snapshotSeq) {
        await this.fs.delete(this.p(`journal/${e.name}`));
      }
    }
  }

  /** Folds the journal into the snapshot now. */
  compact(): Promise<void> {
    return this.exclusive(() => this.compactNow());
  }

  async load(): Promise<Map<string, FileSyncState>> {
    return this.exclusive(async () => new Map([...(await this.ensureLoaded())].map(([k, v]) => [k, { ...v }])));
  }

  put(entry: FileSyncState, base?: Uint8Array | null): Promise<void> {
    return this.exclusive(async () => {
      const entries = await this.ensureLoaded();
      const bp = this.p(`base/${safePath(entry.path)}`);
      // Base first: a crash between the two leaves an unreferenced base, never a missing one.
      if (base) await this.fs.writeBytes(bp, base);
      else if (base === null) await this.fs.delete(bp);
      entries.set(entry.path, { ...entry });
      await this.append({ op: 'put', entry });
    });
  }

  remove(path: string): Promise<void> {
    return this.exclusive(async () => {
      const entries = await this.ensureLoaded();
      entries.delete(path);
      await this.append({ op: 'remove', path });
      await this.fs.delete(this.p(`base/${safePath(path)}`));
    });
  }

  async getBase(path: string): Promise<Uint8Array | null> {
    return this.fs.readBytes(this.p(`base/${safePath(path)}`));
  }

  clear(): Promise<void> {
    return this.exclusive(async () => {
      await this.fs.deleteDir(this.prefix);
      this.entries = new Map();
      this.seq = 0;
      this.snapshotSeq = 0;
      this.pending = 0;
    });
  }
}
