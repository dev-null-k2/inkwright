/**
 * Device-to-device sync over a peer link: the ordinary SyncEngine with the other device's vault
 * as its Remote (packages/sync/src/peer/remote.ts), so the same three-way merge, conflict copies
 * and safety stops as Drive or WebDAV sync apply.
 *
 * The device where "Sync now" was pressed drives the run; the other one serves its vault. Each
 * side flushes its open note first and reloads it afterwards if the other side changed it.
 */
import { create } from 'zustand';
import type { NoteMeta, PageInk } from '@inkwright/core';
import { FolderRemote, FsStateStore, IndexedDBFS, MemoryStateStore, PeerRemote, SyncEngine, SyncSafetyError, hasLocalChanges, servePeerVault, type PeerLink, type SyncReport, type SyncStateStore } from '@inkwright/sync';
import { useApp } from '../state/app.ts';
import { activeSession, type EditorSession } from '../lib/session.ts';
import { markSynced, pairedByKey } from './identity.ts';
import type { Connected } from './connect.ts';

export interface PeerSyncState {
  status: 'idle' | 'syncing' | 'done' | 'error';
  message: string | null;
  /** Key of the device being synced with. */
  device: string | null;
}

export const usePeerSync = create<PeerSyncState>(() => ({ status: 'idle', message: null, device: null }));

let stateFs: IndexedDBFS | null = null;
function stateStore(deviceKey: string): SyncStateStore {
  try {
    stateFs ??= new IndexedDBFS({ dbName: 'inkwright-peer-sync' });
    // One state per paired device, keyed by its key's hash-free short form.
    return new FsStateStore(stateFs, { prefix: `peer-${deviceKey.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 43)}` });
  } catch {
    return new MemoryStateStore();
  }
}

/** The open note before a sync, to reload it afterwards without losing what is on screen. */
interface OpenNote {
  session: EditorSession;
  base: Map<string, PageInk>;
  meta: NoteMeta;
}

async function holdOpenNote(): Promise<OpenNote | null> {
  const session = activeSession();
  if (!session) return null;
  await session.flush();
  return { session, base: new Map(session.doc.committedPages.map((p) => [p.id, p])), meta: session.doc.meta };
}

/** Reloads the library (and the open note, if it changed) after files changed under it. */
async function reloadAfter(paths: readonly string[], open: OpenNote | null): Promise<void> {
  if (!paths.length) return;
  const app = useApp.getState();
  if (!app.vault) return;
  app.vault.vault.invalidate();
  await app.vault.buildIndex();
  await app.refresh();
  const now = activeSession();
  if (open && now === open.session && paths.some((p) => p.startsWith(`notes/${now.doc.meta.id}/`))) await now.reloadAfterSync(open.base, open.meta);
}

/**
 * The serving side's handlers (pass as `setup` when answering a `sync` connection): its vault
 * as a remote, and the begin/done notifications that bracket a run.
 */
export function serveVaultSetup(link: PeerLink): void {
  const vault = useApp.getState().vault;
  if (!vault || !vault.persistent) {
    link.rpc.handle('sync.begin', () => {
      throw new Error('Sync is off on the other device because its browser is blocking storage.');
    });
    return;
  }
  const changed = new Set<string>();
  let open: OpenNote | null = null;
  const stop = servePeerVault(link.rpc, new FolderRemote(vault.fs), { onChange: (p) => changed.add(p) });
  link.rpc.handle('sync.begin', async () => {
    open = await holdOpenNote();
    usePeerSync.setState({ status: 'syncing', message: `Syncing with “${link.peer.device.name}”…`, device: link.peer.device.key });
    return { result: { ok: true } };
  });
  const finish = async () => {
    const paths = [...changed];
    changed.clear();
    await reloadAfter(paths, open);
    if (pairedByKey(link.peer.device.key)) markSynced(link.peer.device.key);
    usePeerSync.setState({ status: 'done', message: paths.length ? `Synced with “${link.peer.device.name}”` : `Up to date with “${link.peer.device.name}”`, device: link.peer.device.key });
  };
  link.rpc.on('sync.done', () => void finish());
  link.onClose(() => {
    stop();
    if (changed.size) void finish();
  });
}

/** Runs one sync with the device on the other end of `c` (this device drives it), then closes the link. */
export async function syncOverLink(c: Connected, opts: { allowMassDelete?: boolean } = {}): Promise<SyncReport> {
  const app = useApp.getState();
  if (!app.vault) throw new Error('No vault is open.');
  if (!app.vault.persistent) throw new Error('Sync is off because this browser is blocking storage for Inkwright.');
  const name = c.peer.name;
  usePeerSync.setState({ status: 'syncing', message: `Syncing with “${name}”…`, device: c.peer.key });
  const open = await holdOpenNote();
  try {
    await c.link.rpc.call('sync.begin');
    const engine = new SyncEngine({
      local: app.vault.fs,
      remote: new PeerRemote(c.link.rpc),
      state: stateStore(c.peer.key),
      // Same thresholds as cloud sync: pause rather than delete much of either side.
      massDelete: { fraction: 0.3, minFiles: 4 },
    });
    const report = await engine.sync({ allowMassDelete: opts.allowMassDelete });
    await c.link.rpc.emit('sync.done', { pushed: report.pushed.length, pulled: report.pulled.length, merged: report.merged.length });
    if (hasLocalChanges(report)) await reloadAfter([...report.pulled, ...report.merged, ...report.deleted.local, ...report.conflicts], open);
    markSynced(c.peer.key);
    const n = report.pushed.length + report.pulled.length + report.merged.length;
    usePeerSync.setState({ status: report.errors.length ? 'error' : 'done', message: report.errors.length ? `${report.errors.length} files could not sync: ${report.errors[0]!.message}` : n ? `Synced with “${name}”: ${n} ${n === 1 ? 'file' : 'files'}` : `Up to date with “${name}”`, device: c.peer.key });
    return report;
  } catch (e) {
    const msg = e instanceof SyncSafetyError ? `Sync paused to protect your notes: ${e.message}` : (e as Error).message;
    usePeerSync.setState({ status: 'error', message: msg, device: c.peer.key });
    throw e;
  } finally {
    // Let the last messages go out before closing.
    setTimeout(() => c.link.close('Sync finished.'), 300);
  }
}
