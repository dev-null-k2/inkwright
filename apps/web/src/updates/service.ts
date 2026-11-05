/**
 * The in-app updater's logic (docs/UPDATES.md). Loaded lazily by the Updates module once the app
 * has started, never at startup.
 *
 * Checking: shortly after launch, then whenever the app is open or comes back to the front and
 * the last check is more than six hours old. One GitHub API request lists recent releases (with
 * ETag, see github.ts); the newest release for the person's channel is compared with the running
 * app by versionCode, and only a newer one has its android-update.json read (by the native
 * plugin, which validates it and picks the APK for this phone's ABI).
 *
 * Updating: download (progress, cancellable) → native checks of SHA-256, package, version and
 * signing key → PackageInstaller session. Android's "Install unknown apps" switch is handled on the
 * way; every failure ends in a plain sentence and a retry.
 */
import type { PluginListenerHandle } from '@capacitor/core';
import { fetchReleases, pickRelease, type FetchDeps } from './github.ts';
import { reasonFor } from './messages.ts';
import { errorCode, updaterPlugin, type UpdaterPlugin } from './plugin.ts';
import { useUpdates, type UpdateOffer, type UpdatePhase } from './store.ts';

export const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
/** A launch soon after the previous check (reopening the app) doesn't ask GitHub again. */
export const LAUNCH_MIN_GAP_MS = 15 * 60 * 1000;
/** After startup, so the first check never competes with opening the library. */
const FIRST_CHECK_DELAY_MS = 3000;
const TICK_MS = 15 * 60 * 1000;

const set = (p: Partial<ReturnType<typeof useUpdates.getState>>) => useUpdates.setState(p);
const phase = () => useUpdates.getState().phase;
const setPhase = (p: UpdatePhase) => set({ phase: p });

/** Phases in which a check may run (not while an update is downloading or installing). */
const settled = (p: UpdatePhase) => p.kind === 'idle' || p.kind === 'up-to-date' || p.kind === 'available' || p.kind === 'checking' || p.kind === 'failed';

let checking: Promise<void> | null = null;
let listeners: PluginListenerHandle[] = [];
let fetchDeps: FetchDeps | undefined;

/** The phase to return to after a check that couldn't finish. */
const restingPhase = (): UpdatePhase => (useUpdates.getState().offer ? { kind: 'available' } : useUpdates.getState().lastChecked ? { kind: 'up-to-date' } : { kind: 'idle' });

async function readCurrent(p: UpdaterPlugin) {
  const info = await p.appInfo();
  const current = { version: info.version, versionCode: Number(info.build) || 0 };
  set({ current });
  return current;
}

/**
 * Looks for an update. `manual` (Check now) ignores the rate-limit back-off and the launch gap.
 * Concurrent calls share one check; nothing happens while an update is under way.
 */
export function checkForUpdates(opts: { manual?: boolean } = {}): Promise<void> {
  if (checking) return checking;
  checking = runCheck(!!opts.manual).finally(() => { checking = null; });
  return checking;
}

async function runCheck(manual: boolean): Promise<void> {
  const p = updaterPlugin();
  if (!p || !settled(phase())) return;
  const now = Date.now();
  const s = useUpdates.getState();
  if (!manual && s.retryAt && now < s.retryAt) return;
  const before = phase();
  setPhase({ kind: 'checking' });
  try {
    const current = await readCurrent(p);
    const info = await p.info();
    set({ silentInstall: info.installerOfRecord && info.sdk >= 31, sdk: info.sdk });
    const res = await fetchReleases(info.repo, s.cache, fetchDeps);
    if (res.kind !== 'ok') {
      set({ note: res.kind === 'offline' ? 'offline' : res.kind === 'rate-limited' ? 'rate-limited' : 'error', ...(res.kind === 'rate-limited' ? { retryAt: res.retryAt } : {}) });
      setPhase(before.kind === 'checking' ? restingPhase() : before);
      return;
    }
    set({ cache: res.cache ?? s.cache, retryAt: null });
    const pick = pickRelease(res.releases, useUpdates.getState().beta ? 'beta' : 'stable');
    if (!pick || pick.versionCode <= current.versionCode) {
      set({ offer: null, note: null, lastChecked: Date.now() });
      setPhase({ kind: 'up-to-date' });
      return;
    }
    const known = useUpdates.getState().offer;
    if (known?.versionCode === pick.versionCode) {
      set({ note: null, lastChecked: Date.now() });
      setPhase({ kind: 'available' });
      return;
    }
    const { manifest, apk } = await p.fetchManifest({ url: pick.manifestUrl });
    if (manifest.versionCode !== pick.versionCode || manifest.versionCode <= current.versionCode) {
      set({ note: 'error', lastChecked: Date.now() });
      setPhase(restingPhase());
      return;
    }
    if (!apk) {
      // A release without a build for this phone's ABI (or Android version).
      set({ offer: null, note: 'no-apk', lastChecked: Date.now() });
      setPhase({ kind: 'up-to-date' });
      return;
    }
    const offer: UpdateOffer = {
      version: manifest.version,
      versionCode: manifest.versionCode,
      channel: manifest.channel,
      published: manifest.published || pick.published,
      notes: manifest.notes,
      url: apk.url,
      size: apk.size,
      abi: apk.abi,
      pageUrl: pick.pageUrl,
    };
    set({ offer, note: null, lastChecked: Date.now() });
    setPhase({ kind: 'available' });
  } catch (e) {
    console.warn('Update check failed', e);
    set({ note: errorCode(e) === 'network' ? 'offline' : 'error' });
    setPhase(restingPhase());
  }
}

/** Download, verify and install the offered update. */
export async function startUpdate(): Promise<void> {
  const p = updaterPlugin();
  const offer = useUpdates.getState().offer;
  const ph = phase();
  if (!p || !offer || !(ph.kind === 'available' || ph.kind === 'failed' || ph.kind === 'ready' || ph.kind === 'permission')) return;
  // A verified file is already there: straight to installing.
  if (ph.kind === 'ready' || ph.kind === 'permission') return installUpdate(ph.path);
  if (ph.kind === 'failed' && ph.retry === 'install' && ph.path) return installUpdate(ph.path);
  await ensureListeners(p);
  setPhase({ kind: 'downloading', loaded: 0, total: offer.size });
  let path: string;
  try {
    ({ path } = await p.download({ url: offer.url }));
  } catch (e) {
    const code = errorCode(e);
    if (code === 'cancelled') setPhase({ kind: 'available' });
    else setPhase({ kind: 'failed', reason: reasonFor(code), retry: 'download' });
    return;
  }
  setPhase({ kind: 'ready', path });
  await installUpdate(path);
}

export async function cancelUpdate(): Promise<void> {
  const k = phase().kind;
  if (k !== 'downloading' && k !== 'verifying') return;
  await updaterPlugin()?.cancel();
}

/** Hands the verified APK at `path` to Android. */
export async function installUpdate(path: string): Promise<void> {
  const p = updaterPlugin();
  if (!p) return;
  await ensureListeners(p);
  setPhase({ kind: 'installing', path });
  try {
    const { status } = await p.install({ path });
    if (status === 'needs-permission') setPhase({ kind: 'permission', path });
    // 'started': the outcome arrives as an install event (onInstall).
  } catch (e) {
    const code = errorCode(e);
    // The file changed or vanished since it was verified: download it again.
    setPhase({ kind: 'failed', reason: reasonFor(code, 'install'), retry: code === 'invalid' || code === 'checksum' || code === 'signature' ? 'download' : 'install', path });
  }
}

/** Opens Android's "Install unknown apps" page for Inkwright; the install resumes when it is allowed. */
export async function allowInstalls(): Promise<void> {
  const p = updaterPlugin();
  if (!p) return;
  await ensureListeners(p);
  try {
    await p.openInstallSettings();
  } catch (e) {
    const ph = phase();
    setPhase({ kind: 'failed', reason: reasonFor(errorCode(e), 'install'), retry: 'install', path: ph.kind === 'permission' ? ph.path : undefined });
  }
}

function onInstall(e: { status: string; reason?: string | null }) {
  const ph = phase();
  const path = 'path' in ph ? ph.path : undefined;
  if (e.status === 'pending-user-action') return; // Android's confirmation is showing.
  if (e.status === 'success') {
    // Android replaces the app and usually stops this process before this arrives.
    setPhase({ kind: 'up-to-date' });
    set({ offer: null });
    return;
  }
  // Cancelling Android's confirmation is a choice, not a failure: back to "ready to install".
  if (e.reason === 'aborted' && path) setPhase({ kind: 'ready', path });
  else setPhase({ kind: 'failed', reason: reasonFor(e.reason ?? 'failure', 'install'), retry: 'install', path });
}

async function ensureListeners(p: UpdaterPlugin) {
  if (listeners.length) return;
  listeners = await Promise.all([
    p.addListener('progress', (e) => {
      const k = phase().kind;
      if (k !== 'downloading' && k !== 'verifying') return;
      setPhase(e.phase === 'verify' ? { kind: 'verifying' } : { kind: 'downloading', loaded: e.loaded, total: e.total });
    }),
    p.addListener('install', onInstall),
    p.addListener('installPermission', ({ granted }) => {
      const ph = phase();
      if (granted && ph.kind === 'permission') void installUpdate(ph.path);
    }),
  ]);
}

const due = (now: number, gap: number) => {
  const last = useUpdates.getState().lastChecked;
  return !last || now - last >= gap;
};

/**
 * Starts checking: once after startup (unless the last check was minutes ago), then every six
 * hours while the app is open — also right away when it comes back to the front and a check is
 * overdue. Returns a function that stops it (the module being switched off).
 */
export function startUpdateChecks(opts: { firstDelayMs?: number } = {}): () => void {
  const p = updaterPlugin();
  if (!p) return () => {};
  let stopped = false;
  void readCurrent(p).catch(() => {});
  const first = setTimeout(() => {
    if (stopped) return;
    const go = () => { if (!stopped && due(Date.now(), LAUNCH_MIN_GAP_MS)) void checkForUpdates(); };
    // After the first idle moment, so the check never delays a frame the person is waiting for.
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
    if (ric) ric(go, { timeout: 5000 }); else go();
  }, opts.firstDelayMs ?? FIRST_CHECK_DELAY_MS);
  const tick = () => { if (!stopped && due(Date.now(), CHECK_EVERY_MS)) void checkForUpdates(); };
  const timer = setInterval(tick, TICK_MS);
  const onVisible = () => { if (document.visibilityState === 'visible') tick(); };
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    stopped = true;
    clearTimeout(first);
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onVisible);
    for (const l of listeners) void l.remove();
    listeners = [];
  };
}

/** Switching "Beta updates" re-checks at once, so the offer matches the channel. */
export function setBetaUpdates(beta: boolean): Promise<void> {
  const s = useUpdates.getState();
  if (s.beta === beta) return Promise.resolve();
  set({ beta, offer: settled(s.phase) ? null : s.offer });
  return checkForUpdates({ manual: true });
}

/** Tests only: inject fetch/clock for github.ts and forget listeners. */
export function __setUpdateDepsForTests(deps: FetchDeps | undefined): void {
  fetchDeps = deps;
  listeners = [];
  checking = null;
}
