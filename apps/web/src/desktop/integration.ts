/**
 * What the desktop shell hands the app while it runs: `inkwright://` links (deep-link plugin),
 * files opened with Inkwright ("Open with" a PDF, a file dropped on the dock icon, a second
 * launch with a file), tray commands, and updates. Started by the `desktop` module
 * (modules/builtin.ts); does nothing outside the desktop app.
 */
import { useApp } from '../state/app.ts';
import { vaultChanged } from '../lib/vaultChanges.ts';
import { bytesOf, desktopInfo, invoke, isDesktop, listen } from './bridge.ts';

type Stop = () => void;

async function openUrl(url: string): Promise<void> {
  const { parseDeepLink, runDeepLink } = await import('../developer/deeplinks.ts');
  const a = parseDeepLink(url);
  if (a) await runDeepLink(a);
}

/** Files the shell queued for us: read each (the shell only reads paths the OS gave it) and import them. */
async function takeOpenedFiles(): Promise<void> {
  const list = await invoke<Array<{ path: string; name: string }>>('opened_files_take');
  if (!list.length) return;
  const files: File[] = [];
  for (const f of list) {
    try {
      const bytes = bytesOf(await invoke<ArrayBuffer>('opened_file_read', { path: f.path }));
      const type = /\.pdf$/i.test(f.name) ? 'application/pdf' : /\.(md|markdown)$/i.test(f.name) ? 'text/markdown' : /\.txt$/i.test(f.name) ? 'text/plain' : '';
      files.push(new File([bytes as BlobPart], f.name, { type }));
    } catch (e) {
      useApp.getState().fail(`Couldn't open ${f.name}: ${(e as Error).message ?? e}`);
    }
  }
  const { openIncoming } = await import('../lib/openFiles.ts');
  await openIncoming(files);
}

/** Note ids under `notes/<id>/…` among changed vault paths. */
export function changedNoteIds(paths: readonly string[]): string[] {
  const ids = new Set<string>();
  for (const p of paths) {
    const m = /^notes\/([0-9A-Za-z_-]{1,64})(?:\/|$)/.exec(p);
    if (m) ids.add(m[1]!);
  }
  return [...ids];
}

/**
 * The watcher may report only a folder (`notes`, or the vault itself) when many files land at
 * once; then everything is re-read.
 */
export const needsFullRescan = (paths: readonly string[]) => paths.some((p) => p === 'notes' || p === 'notebooks' || p === '');

/**
 * Brings the app up to date with files others changed: caches dropped, changed notes re-indexed,
 * the library refreshed. The open note keeps what is on screen — the editor saves only the pages
 * it changed, but its note.json goes with every save — so the user is told and can reopen it to
 * see the other changes before writing on.
 */
async function vaultChangedOutside(paths: string[]): Promise<void> {
  const app = useApp.getState();
  const v = app.vault;
  if (!v || !paths.length) return;
  v.vault.invalidate();
  if (needsFullRescan(paths)) await v.buildIndex();
  else for (const id of changedNoteIds(paths)) {
    const meta = await v.vault.readNote(id).catch(() => null);
    if (!meta) { v.search.remove(id); continue; }
    if (!meta.lock) v.indexNote(meta, await v.vault.readPages(meta).catch(() => []));
  }
  await app.refresh();
  vaultChanged(paths);
  const route = useApp.getState().route;
  if (route.name === 'editor' && changedNoteIds(paths).includes(route.noteId)) {
    const noteId = route.noteId;
    app.toast({ text: 'This note was changed outside Inkwright.', action: { label: 'Reopen', run: () => { useApp.getState().navigate({ name: 'library' }); setTimeout(() => useApp.getState().navigate({ name: 'editor', noteId }), 0); } } });
  }
}

const DAY = 86_400_000;

/** Checks for an update; when one is ready, offers to restart into it (never restarts on its own). */
async function checkForUpdate(): Promise<void> {
  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();
  if (!update) return;
  await update.download();
  useApp.getState().toast({
    text: `Inkwright ${update.version} is ready.`,
    action: {
      label: 'Restart to update',
      run: () => void (async () => {
        await update.install();
        const { relaunch } = await import('@tauri-apps/plugin-process');
        await relaunch();
      })().catch((e) => useApp.getState().fail(`The update could not be installed: ${(e as Error).message ?? e}`)),
    },
  });
}

export function startDesktop(): Stop {
  if (!isDesktop) return () => {};
  const stops: Stop[] = [];
  let alive = true;
  const fail = (what: string) => (e: unknown) => console.warn(`Desktop: ${what}`, e);

  // Links: the one that launched the app, and later ones (a second launch forwards its link here).
  void (async () => {
    const dl = await import('@tauri-apps/plugin-deep-link');
    const first = await dl.getCurrent().catch(() => null);
    for (const u of first ?? []) await openUrl(u);
    const un = await dl.onOpenUrl((urls) => { for (const u of urls) void openUrl(u).catch(fail('link')); });
    if (alive) stops.push(un); else un();
  })().catch(fail('links'));

  void takeOpenedFiles().catch(fail('opened files'));
  void listen<null>('desktop://open-files', () => void takeOpenedFiles().catch(fail('opened files'))).then((un) => (alive ? stops.push(un) : un()));

  // Files changed by others in the vault folder (the MCP sidecar, Obsidian, folder sync).
  let pending = new Set<string>();
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  void listen<string[]>('desktop://vault-changed', (paths) => {
    for (const p of paths) pending.add(p);
    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(() => { const batch = pending; pending = new Set(); void vaultChangedOutside([...batch]).catch(fail('external changes')); }, 400);
  }).then((un) => (alive ? stops.push(un) : un()));
  stops.push(() => { if (flushTimer) clearTimeout(flushTimer); });

  // Tray commands for the memory timeline (recall/service.ts listens for these too when it is on).
  void listen<string>('desktop://tray', (cmd) => {
    window.dispatchEvent(new CustomEvent('inkwright:tray', { detail: cmd }));
  }).then((un) => (alive ? stops.push(un) : un()));

  // Updates: shortly after start, then daily — only when the build carries a real updater key.
  void desktopInfo().then((info) => {
    if (!info.updatesConfigured || !alive) return;
    const run = () => void checkForUpdate().catch(fail('update check'));
    const first = setTimeout(run, 30_000);
    const daily = setInterval(run, DAY);
    stops.push(() => { clearTimeout(first); clearInterval(daily); });
  }).catch(fail('info'));

  return () => {
    alive = false;
    for (const s of stops.splice(0)) s();
  };
}

/** Launch at login (opt-in; starts hidden in the tray). */
export async function autostartEnabled(): Promise<boolean> {
  const { isEnabled } = await import('@tauri-apps/plugin-autostart');
  return isEnabled();
}

export async function setAutostart(on: boolean): Promise<void> {
  const m = await import('@tauri-apps/plugin-autostart');
  if (on) await m.enable();
  else await m.disable();
}
