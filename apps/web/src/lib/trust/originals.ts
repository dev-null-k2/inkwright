/**
 * Where the app keeps originals of blocks the context budgeter shortened: IndexedDB on this
 * device only (never the vault — originals are copies of note text and tool output, and they
 * must not sync or fill the user's cloud drive). Entries older than two weeks are dropped when
 * the store opens; a conversation that needs one after that gets "no original stored", which the
 * model is told to handle. Falls back to memory when IndexedDB is unavailable (private windows).
 */
import { MemoryContentStore, contentRef, type ContentStore } from '@inkstone/ai';

const DB = 'inkstone-originals';
const STORE = 'originals';
const MAX_AGE_MS = 14 * 86_400_000;

interface Row {
  text: string;
  at: number;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function run<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r ? r.result : undefined);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export class IdbContentStore implements ContentStore {
  private memory = new MemoryContentStore(2_000_000);
  private db: Promise<IDBDatabase | null>;

  constructor() {
    this.db = (typeof indexedDB === 'undefined' ? Promise.resolve(null) : open().catch(() => null)).then(async (db) => {
      if (db) await this.prune(db).catch(() => {});
      return db;
    });
  }

  private async prune(db: IDBDatabase): Promise<void> {
    const cutoff = Date.now() - MAX_AGE_MS;
    await run(db, 'readwrite', (s) => {
      const req = s.openCursor();
      req.onsuccess = () => {
        const c = req.result;
        if (!c) return;
        if ((c.value as Row).at < cutoff) c.delete();
        c.continue();
      };
    });
  }

  async put(text: string): Promise<string> {
    const ref = contentRef(text);
    await this.memory.put(text);
    const db = await this.db;
    if (db) await run(db, 'readwrite', (s) => s.put({ text, at: Date.now() } satisfies Row, ref)).catch(() => {});
    return ref;
  }

  async get(ref: string): Promise<string | null> {
    const hit = await this.memory.get(ref);
    if (hit != null) return hit;
    const db = await this.db;
    if (!db) return null;
    const row = (await run<Row>(db, 'readonly', (s) => s.get(ref)).catch(() => undefined)) as Row | undefined;
    return row?.text ?? null;
  }
}
