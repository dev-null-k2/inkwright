/**
 * Folder handles of code sources, kept per device in IndexedDB (handles are structured-cloneable
 * but never leave the device: another device re-adds its own copy of the repository). Missing
 * IndexedDB just means re-adding the folder to re-scan it.
 */
const DB = 'inkwright-dev';
const STORE = 'folders';

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  const db = await open();
  if (!db) return null;
  return new Promise((resolve) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE));
    req.onsuccess = () => { resolve(req.result); db.close(); };
    req.onerror = () => { resolve(null); db.close(); };
  });
}

export const saveFolderHandle = (id: string, h: FileSystemDirectoryHandle) => tx('readwrite', (s) => s.put(h, id)).then(() => undefined);
export const loadFolderHandle = (id: string) => tx<FileSystemDirectoryHandle | undefined>('readonly', (s) => s.get(id)).then((h) => h ?? null);
export const forgetFolderHandle = (id: string) => tx('readwrite', (s) => s.delete(id)).then(() => undefined);
