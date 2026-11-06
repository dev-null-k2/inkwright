/**
 * Updates for the web app, including Home Screen apps on iPhone and iPad (docs/UPDATES.md, "Web
 * app"). Every deployment publishes version.json (its version and the CHANGELOG notes, see
 * vite.config.ts). A running copy asks for it after launch, when it comes back to the foreground
 * and every 30 minutes; when the deployment is newer it offers the same banner as the Android app
 * ("Inkwright 0.9.1 is ready · What's new · Update"). Update fetches the new service worker and
 * reloads. After an update the library says so once, with the notes.
 *
 * Without a click nothing is lost either: the next launch opens the new version (the service
 * worker asks the network first for the page), so the banner only saves people who keep the app
 * open for days from running an old copy.
 */
import { create } from 'zustand';
import { APP_VERSION, BUILD_TARGET, isNative, safeStorage } from '../platform/env.ts';

export interface WebRelease {
  version: string;
  notes: string;
  built?: string;
}

interface WebUpdateState {
  /** A newer deployment, found by the last check. */
  available: WebRelease | null;
  /** Set once after the app was updated: the version it came from. */
  updatedFrom: string | null;
  checking: boolean;
  lastChecked: number | null;
  /** The last check couldn't reach the server (offline). */
  offline: boolean;
  applying: boolean;
}

export const useWebUpdates = create<WebUpdateState>(() => ({ available: null, updatedFrom: null, checking: false, lastChecked: null, offline: false, applying: false }));

const LAST_VERSION = 'inkwright.web.version';
const EVERY = 30 * 60_000;
const ON_FOCUS_AFTER = 5 * 60_000;

/** Whether this build updates through its service worker (hosted web app, Home Screen apps). */
export function webUpdatesApply(): boolean {
  return BUILD_TARGET === 'web' && !isNative && typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    && typeof location !== 'undefined' && (location.protocol === 'https:' || location.hostname === 'localhost');
}

/** Whether `remote` is a different build from the one running (any difference counts: rollbacks too). */
export function isNewer(remote: string | undefined, running: string): boolean {
  return !!remote && remote.trim() !== '' && remote.trim() !== running.trim();
}

/** The version the app ran last time, and records this one. Returns the old one when it changed. */
export function noteRunningVersion(running = APP_VERSION): string | null {
  const last = safeStorage.get(LAST_VERSION);
  safeStorage.set(LAST_VERSION, running);
  return last && last !== running ? last : null;
}

/** version.json as the server has it now (never a cached copy), or null offline. */
export async function fetchRelease(base = './'): Promise<WebRelease | null> {
  try {
    const r = await fetch(`${base}version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) return null;
    const j = (await r.json()) as Partial<WebRelease>;
    return typeof j.version === 'string' ? { version: j.version, notes: typeof j.notes === 'string' ? j.notes : '', built: j.built } : null;
  } catch {
    return null;
  }
}

/** Asks the server for its version now. */
export async function checkWebUpdate(): Promise<WebRelease | null> {
  if (useWebUpdates.getState().checking) return useWebUpdates.getState().available;
  useWebUpdates.setState({ checking: true });
  const rel = await fetchRelease();
  useWebUpdates.setState({
    checking: false,
    offline: rel == null,
    ...(rel ? { lastChecked: Date.now(), available: isNewer(rel.version, APP_VERSION) ? rel : null } : {}),
  });
  return rel && isNewer(rel.version, APP_VERSION) ? rel : null;
}

/** Installs the new version: fetches the new service worker, lets it take over, reloads. */
export async function applyWebUpdate(): Promise<void> {
  useWebUpdates.setState({ applying: true });
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    await reg?.update().catch(() => {});
    const sw = reg?.installing ?? reg?.waiting;
    if (sw) {
      // The worker skips waiting and claims the page itself; wait for that (or give up after 15 s:
      // the reload still gets the new page, which the worker fetches from the network first).
      await new Promise<void>((done) => {
        const t = setTimeout(done, 15_000);
        const check = () => { if (sw.state === 'activated' || sw.state === 'redundant') { clearTimeout(t); done(); } };
        sw.addEventListener('statechange', check);
        check();
      });
    }
  } finally {
    location.reload();
  }
}

/** Starts the checks (the Updates module). Returns a stop function. */
export function startWebUpdateChecks(): () => void {
  const from = noteRunningVersion();
  if (from) useWebUpdates.setState({ updatedFrom: from });
  let last = 0;
  const run = () => { last = Date.now(); void checkWebUpdate(); };
  const first = setTimeout(run, 8_000);
  const timer = setInterval(run, EVERY);
  const onVisible = () => { if (document.visibilityState === 'visible' && Date.now() - last > ON_FOCUS_AFTER) run(); };
  document.addEventListener('visibilitychange', onVisible);
  window.addEventListener('online', run);
  return () => {
    clearTimeout(first);
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    window.removeEventListener('online', run);
  };
}

/** "Updated" notice dismissed. */
export function dismissUpdated(): void {
  useWebUpdates.setState({ updatedFrom: null });
}
