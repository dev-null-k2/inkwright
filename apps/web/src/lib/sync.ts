import { create } from 'zustand';
import type { VaultFS } from '@inkwright/core';
import {
  FileSystemAccessFS,
  FolderRemote,
  FsStateStore,
  GoogleDriveRemote,
  IndexedDBFS,
  MemoryStateStore,
  SyncEngine,
  SyncSafetyError,
  WebDavRemote,
  hasLocalChanges,
  type Remote,
  type SyncReport,
} from '@inkwright/sync';
import { useApp } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';
import { getAccessToken } from './google.ts';
import { getSecret } from './secrets.ts';
import { activeSession } from './session.ts';

export interface SyncState {
  status: 'idle' | 'syncing' | 'error' | 'offline';
  lastSync: number | null;
  message: string | null;
  progress: { done: number; total: number } | null;
}

export const useSync = create<SyncState>(() => ({ status: 'idle', lastSync: null, message: null, progress: null }));

type Target = 'drive' | 'webdav' | 'folder';

const engines = new Map<string, SyncEngine>();
/** Whether the current sync run may show sign-in or permission prompts. */
let interactiveRun = false;

/** Stable short hash for keying sync state by *which* remote, not just its type. */
function hashId(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0).toString(36);
}

/** Identity of the remote a target points at; changing it starts a fresh sync state. */
function remoteIdentity(target: Target): string {
  const s = useSettings.getState().sync;
  if (target === 'drive') return `drive|${s.account?.email ?? ''}|${s.drive.folderName || 'Inkwright'}`;
  if (target === 'webdav') return `webdav|${s.webdav.url}|${s.webdav.username}`;
  return `folder|${s.folder.name ?? ''}|${(s.folder as { id?: string }).id ?? ''}`;
}
let stateFs: VaultFS | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let periodic: ReturnType<typeof setInterval> | null = null;

function stateStorage(): VaultFS | null {
  if (stateFs) return stateFs;
  try { stateFs = new IndexedDBFS({ dbName: 'inkwright-sync' }); } catch { stateFs = null; }
  return stateFs;
}

// ---- Folder handle (desktop "sync to a folder", e.g. Google Drive / iCloud folder on a Mac) -----

const HANDLE_DB = 'inkwright-handles';
function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(HANDLE_DB, 1);
    open.onupgradeneeded = () => open.result.createObjectStore('h');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const tx = open.result.transaction('h', mode);
      const r = fn(tx.objectStore('h'));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    };
  });
}

export const folderSyncSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

export async function chooseSyncFolder(): Promise<string | null> {
  const handle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({ id: 'inkwright-vault', mode: 'readwrite' });
  await idb('readwrite', (s) => s.put(handle, 'folder'));
  engines.clear();
  // A new id per chosen folder, so a different folder never reuses another folder's sync state.
  useSettings.getState().update((s) => ({ sync: { ...s.sync, folder: { enabled: true, name: handle.name, lastSync: null, id: Math.random().toString(36).slice(2) } as any } }));
  return handle.name;
}

async function folderHandle(interactive: boolean): Promise<FileSystemDirectoryHandle | null> {
  const h = (await idb<any>('readonly', (s) => s.get('folder')).catch(() => null)) as FileSystemDirectoryHandle | null;
  if (!h) return null;
  const opts = { mode: 'readwrite' } as const;
  if ((await (h as any).queryPermission?.(opts)) === 'granted') return h;
  if (interactive && (await (h as any).requestPermission?.(opts)) === 'granted') return h;
  return null;
}

// ---- Engines --------------------------------------------------------------------------------------

async function remoteFor(target: Target): Promise<Remote | null> {
  const s = useSettings.getState().sync;
  if (target === 'drive') {
    if (!s.drive.enabled || !s.account) return null;
    return new GoogleDriveRemote({
      getAccessToken: () => getAccessToken({ interactive: interactiveRun }),
      refreshAccessToken: () => getAccessToken({ interactive: interactiveRun, forceRefresh: true }),
      folderName: s.drive.folderName || 'Inkwright',
    });
  }
  if (target === 'webdav') {
    if (!s.webdav.enabled || !s.webdav.url) return null;
    const password = (await getSecret('webdav.password')) ?? '';
    return new WebDavRemote({ url: s.webdav.url, auth: s.webdav.username ? { type: 'basic', username: s.webdav.username, password } : undefined });
  }
  if (!s.folder.enabled || !folderSyncSupported) return null;
  const h = await folderHandle(interactiveRun);
  if (!h) return null;
  return new FolderRemote(new FileSystemAccessFS(h));
}

async function engineFor(target: Target): Promise<SyncEngine | null> {
  const vault = useApp.getState().vault;
  if (!vault) return null;
  const identity = remoteIdentity(target);
  const key = `${target}-${hashId(identity)}`;
  const cached = engines.get(key);
  if (cached) return cached;
  const remote = await remoteFor(target);
  if (!remote) return null;
  const sfs = stateStorage();
  const engine = new SyncEngine({
    local: vault.fs,
    remote,
    // State is per remote identity: switching account, folder or server never reuses old state.
    state: sfs ? new FsStateStore(sfs, { prefix: `state-${key}` }) : new MemoryStateStore(),
    onProgress: (p) => useSync.setState({ progress: p.total ? { done: p.done, total: p.total } : null }),
    // Pause rather than delete when a run would remove a large share of either side.
    massDelete: { fraction: 0.3, minFiles: 4 },
  });
  engines.set(key, engine);
  return engine;
}

export function resetSyncEngines() {
  engines.clear();
}

function enabledTargets(): Target[] {
  const s = useSettings.getState().sync;
  const out: Target[] = [];
  if (s.drive.enabled && s.account) out.push('drive');
  if (s.webdav.enabled && s.webdav.url) out.push('webdav');
  if (s.folder.enabled) out.push('folder');
  return out;
}

/** Syncs with every enabled target now. Interactive syncs may show a sign-in or permission prompt. */
export async function syncNow(opts: { interactive?: boolean; allowMassDelete?: boolean } = {}): Promise<void> {
  const targets = enabledTargets();
  if (!targets.length) return;
  const app = useApp.getState();
  // Looking at the past (time travel): nothing to sync until back to today.
  if (app.vault?.asOf != null) return;
  if (app.vault && !app.vault.persistent) {
    // Never sync a temporary in-memory vault: it would look like "everything was deleted".
    useSync.setState({ status: 'error', message: 'Sync is off because this browser is blocking storage for Inkwright.' });
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    useSync.setState({ status: 'offline', message: 'Offline — changes will sync when you reconnect.' });
    return;
  }
  if (running) return running;
  running = (async () => {
    interactiveRun = opts.interactive ?? true;
    useSync.setState({ status: 'syncing', message: null });
    // The open note is saved first, and reloaded afterwards if another device changed it.
    const session = activeSession();
    await session?.flush();
    const base = session ? new Map(session.doc.committedPages.map((p) => [p.id, p])) : null;
    const baseMeta = session?.doc.meta ?? null;
    const touched = new Set<string>();
    const errors: string[] = [];
    for (const t of targets) {
      try {
        const engine = await engineFor(t);
        if (!engine) continue;
        const report: SyncReport = await engine.sync({ allowMassDelete: opts.allowMassDelete });
        if (report.errors.length) console.warn(`sync ${t} errors`, report.errors);
        if (hasLocalChanges(report)) for (const p of [...report.pulled, ...report.merged, ...report.deleted.local]) touched.add(p);
        useSettings.getState().update((s) => ({ sync: { ...s.sync, [t]: { ...(s.sync as any)[t], lastSync: Date.now() } } }));
      } catch (e) {
        const msg = e instanceof SyncSafetyError ? `Sync paused to protect your notes: ${e.message}` : `${t === 'drive' ? 'Google Drive' : t === 'webdav' ? 'WebDAV' : 'Folder'}: ${(e as Error).message || 'sync failed'}`;
        errors.push(msg);
        if (e instanceof SyncSafetyError) app.toast({ text: msg, tone: 'error' });
      }
    }
    if (touched.size && app.vault) {
      app.vault.vault.invalidate();
      await app.vault.buildIndex();
      await app.refresh();
      const open = activeSession();
      if (open && open === session && [...touched].some((p) => p.startsWith(`notes/${open.doc.meta.id}/`))) {
        await open.reloadAfterSync(base!, baseMeta!);
      }
      (await import('./vaultChanges.ts')).vaultChanged([...touched]);
    }
    useSync.setState(errors.length ? { status: 'error', message: errors.join(' · '), progress: null } : { status: 'idle', lastSync: Date.now(), progress: null, message: null });
  })().finally(() => { running = null; interactiveRun = false; });
  return running;
}

let running: Promise<void> | null = null;

/** Debounced sync after local edits. */
export function scheduleSync(delay = 4000) {
  if (!enabledTargets().length) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void syncNow({ interactive: false }); }, delay);
}

/** Periodic pull + reconnect handling. */
export function startSyncLoop() {
  if (periodic) return;
  periodic = setInterval(() => void syncNow({ interactive: false }), 90_000);
  window.addEventListener('online', () => void syncNow({ interactive: false }));
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void syncNow({ interactive: false }); });
  setTimeout(() => void syncNow({ interactive: false }), 1500);
}
