/**
 * The in-app updater's native half (android/app/src/github/java/app/inkwright/updates/UpdaterPlugin.kt),
 * present only in Android builds distributed from GitHub (Google Play builds leave it out; see
 * docs/UPDATES.md). The running app's own version comes from Capacitor's App.getInfo().
 *
 * E2E builds also accept a scripted stand-in set before the app loads
 * (`window.__inkwrightFakeUpdater`), so the whole flow is exercised in a desktop browser.
 */
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

export interface UpdaterInfo {
  /** Build.SUPPORTED_ABIS, best first. */
  abis: string[];
  sdk: number;
  /** "owner/name" whose releases this build follows. */
  repo: string;
  distribution: 'github' | 'play';
  /** "Install unknown apps" is allowed for Inkwright. */
  canInstall: boolean;
  /** Inkwright installed the running copy itself: Android 12+ updates without asking. */
  installerOfRecord: boolean;
  installer: string | null;
}

/** android-update.json as the plugin checked it (UpdateManifest.kt). */
export interface NativeManifest {
  version: string;
  versionCode: number;
  channel: 'stable' | 'beta';
  published: string;
  minSdk: number;
  notes: string;
}

export interface NativeApk { abi: string; url: string; size: number; sha256: string }

export interface ProgressEvent { phase: 'download' | 'verify'; loaded: number; total: number }
export interface InstallEvent { status: 'pending-user-action' | 'success' | 'failure'; reason?: string | null }

export interface UpdaterPlugin {
  /** The running app: versionName and versionCode (App.getInfo() in the real app). */
  appInfo(): Promise<{ version: string; build: string }>;
  info(): Promise<UpdaterInfo>;
  fetchManifest(opts: { url: string }): Promise<{ manifest: NativeManifest; apk: NativeApk | null }>;
  download(opts: { url: string }): Promise<{ path: string }>;
  cancel(): Promise<void>;
  install(opts: { path: string }): Promise<{ status: 'started' | 'needs-permission' }>;
  openInstallSettings(): Promise<void>;
  cleanup(): Promise<{ removed: number }>;
  addListener(event: 'progress', cb: (e: ProgressEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'install', cb: (e: InstallEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'installPermission', cb: (e: { granted: boolean }) => void): Promise<PluginListenerHandle>;
}

declare const __E2E__: boolean;
const E2E_BUILD = typeof __E2E__ !== 'undefined' && __E2E__;

type NativePart = Omit<UpdaterPlugin, 'appInfo'>;

function realPlugin(): UpdaterPlugin | null {
  try {
    if (!Capacitor.isNativePlatform() || Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('InkwrightUpdater')) return null;
  } catch {
    return null;
  }
  const native = registerPlugin<NativePart>('InkwrightUpdater');
  // A Proxy (Capacitor's plugin object) can't be spread; forward what is used.
  return {
    appInfo: async () => {
      const { App } = await import('@capacitor/app');
      const i = await App.getInfo();
      return { version: i.version, build: i.build };
    },
    info: () => native.info(),
    fetchManifest: (o) => native.fetchManifest(o),
    download: (o) => native.download(o),
    cancel: () => native.cancel(),
    install: (o) => native.install(o),
    openInstallSettings: () => native.openInstallSettings(),
    cleanup: () => native.cleanup(),
    addListener: ((event: 'progress', cb: (e: ProgressEvent) => void) => native.addListener(event, cb)) as UpdaterPlugin['addListener'],
  };
}

let plugin: UpdaterPlugin | null | undefined;

/** The updater plugin, or null where there is none (web, desktop, iOS, Google Play builds). */
export function updaterPlugin(): UpdaterPlugin | null {
  if (plugin === undefined) {
    plugin = realPlugin() ?? (E2E_BUILD ? ((globalThis as { __inkwrightFakeUpdater?: UpdaterPlugin }).__inkwrightFakeUpdater ?? null) : null);
  }
  return plugin;
}

/** Tests only. */
export function setUpdaterPluginForTests(p: UpdaterPlugin | null | undefined): void {
  plugin = p;
}

/** A rejected plugin call's code (`call.reject(message, code)` in Kotlin). */
export function errorCode(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  return typeof code === 'string' && code ? code : 'unknown';
}
