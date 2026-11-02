import type { FsEntry, VaultFS } from '@inkwright/core';
import { safePath, utf8Decode, utf8Encode } from './util.ts';

/** Minimal slice of `IDBKeyRange` used here (injectable for tests / non-window runtimes). */
export interface KeyRangeFactory {
  bound(lower: unknown, upper: unknown, lowerOpen?: boolean, upperOpen?: boolean): IDBKeyRange;
}

export interface IndexedDBFSOptions {
  /** Database name; one database per vault. Default "inkwright-vault". */
  dbName?: string;
  /** Object store name. Default "files". */
  storeName?: string;
  /** IndexedDB factory. Default `globalThis.indexedDB` (tests pass `fake-indexeddb`). */
  indexedDB?: IDBFactory;
  /** `IDBKeyRange` implementation. Default `globalThis.IDBKeyRange`. */
  keyRange?: KeyRangeFactory;
  clock?: () => number;
}

interface StoredFile {
  bytes: Uint8Array;
  mtime: number;
}

/** Upper bound for every key starting with `prefix` (keys are compared code unit by code unit). */
const HIGH = '￿';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/**
 * VaultFS on raw IndexedDB (web app storage). One object store keyed by path holding
 * `{bytes, mtime}`; directories are implicit (as in MemoryFS). Listing walks a key range on the
 * directory prefix and skips over whole subtrees with `cursor.continue(...)`.
 */
export class IndexedDBFS implements VaultFS {
  private dbp: Promise<IDBDatabase> | null = null;
  private readonly dbName: string;
  private readonly storeName: string;
  private readonly factory: IDBFactory;
  private readonly keyRange: KeyRangeFactory;
  private readonly clock: () => number;

  constructor(opts: IndexedDBFSOptions = {}) {
    this.dbName = opts.dbName ?? 'inkwright-vault';
    this.storeName = opts.storeName ?? 'files';
    const g = globalThis as { indexedDB?: IDBFactory; IDBKeyRange?: KeyRangeFactory };
    const factory = opts.indexedDB ?? g.indexedDB;
    const keyRange = opts.keyRange ?? g.IDBKeyRange;
    if (!factory || !keyRange) throw new Error('IndexedDB is not available in this runtime');
    this.factory = factory;
    this.keyRange = keyRange;
    this.clock = opts.clock ?? Date.now;
  }

  private db(): Promise<IDBDatabase> {
    if (!this.dbp) {
      this.dbp = new Promise<IDBDatabase>((resolve, reject) => {
        const r = this.factory.open(this.dbName, 1);
        r.onupgradeneeded = () => {
          if (!r.result.objectStoreNames.contains(this.storeName)) r.result.createObjectStore(this.storeName);
        };
        r.onsuccess = () => {
          const db = r.result;
          // Another tab upgraded the schema: close so it can proceed; we reopen lazily.
          db.onversionchange = () => {
            db.close();
            this.dbp = null;
          };
          resolve(db);
        };
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('IndexedDB open blocked by another connection'));
      });
      this.dbp.catch(() => (this.dbp = null));
    }
    return this.dbp;
  }

  private async store(mode: IDBTransactionMode): Promise<{ tx: IDBTransaction; store: IDBObjectStore }> {
    const tx = (await this.db()).transaction(this.storeName, mode);
    return { tx, store: tx.objectStore(this.storeName) };
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const p = safePath(path);
    const { store } = await this.store('readonly');
    const v = (await req(store.get(p))) as StoredFile | undefined;
    return v ? new Uint8Array(v.bytes) : null;
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.readBytes(path);
    return b ? utf8Decode(b) : null;
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    const p = safePath(path);
    if (p === '') throw new Error('Cannot write to the vault root');
    const { tx, store } = await this.store('readwrite');
    // A transaction commits all-or-nothing: IndexedDB writes are atomic by construction.
    store.put({ bytes: bytes.slice(), mtime: this.clock() } satisfies StoredFile, p);
    await done(tx);
  }

  writeText(path: string, text: string): Promise<void> {
    return this.writeBytes(path, utf8Encode(text));
  }

  async delete(path: string): Promise<void> {
    const p = safePath(path);
    const { tx, store } = await this.store('readwrite');
    store.delete(p);
    await done(tx);
  }

  async deleteDir(path: string): Promise<void> {
    const p = safePath(path);
    const { tx, store } = await this.store('readwrite');
    if (p === '') store.clear();
    else store.delete(this.keyRange.bound(p + '/', p + '/' + HIGH));
    await done(tx);
  }

  async list(dir: string): Promise<FsEntry[]> {
    const p = safePath(dir);
    const prefix = p === '' ? '' : p + '/';
    const { store } = await this.store('readonly');
    const range = prefix === '' ? undefined : this.keyRange.bound(prefix, prefix + HIGH);
    const out: FsEntry[] = [];
    await new Promise<void>((resolve, reject) => {
      const r = store.openCursor(range);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const c = r.result;
        if (!c) return resolve();
        const key = String(c.key);
        const rest = key.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          const v = c.value as StoredFile;
          out.push({ name: rest, kind: 'file', size: v.bytes.byteLength, mtime: v.mtime });
          c.continue();
        } else {
          const name = rest.slice(0, slash);
          out.push({ name, kind: 'dir' });
          // Jump past the whole subtree: '0' sorts right after '/', so every "name/..." key is skipped.
          c.continue(prefix + name + '0');
        }
      };
    });
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Closes the connection (tests, sign-out). The instance reopens lazily if used again. */
  async close(): Promise<void> {
    const p = this.dbp;
    this.dbp = null;
    if (p) (await p).close();
  }

  /** Deletes the whole database (e.g. "remove this vault from this device"). */
  async destroy(): Promise<void> {
    await this.close();
    await new Promise<void>((resolve, reject) => {
      const r = this.factory.deleteDatabase(this.dbName);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  }
}
