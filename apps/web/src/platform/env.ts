import { Capacitor } from '@capacitor/core';

declare const __APP_VERSION__: string;
declare const __BUILD_TARGET__: string;

export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : '1.0.0';
export const BUILD_TARGET = typeof __BUILD_TARGET__ === 'string' ? __BUILD_TARGET__ : 'web';

export const isNative = (() => {
  try { return Capacitor.isNativePlatform(); } catch { return false; }
})();

export const nativePlatform: 'android' | 'ios' | 'web' = (() => {
  try { return Capacitor.getPlatform() as 'android' | 'ios' | 'web'; } catch { return 'web'; }
})();

const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
export const isMac = /Macintosh|Mac OS X/.test(ua) && !/Mobile/.test(ua);
export const isAndroid = /Android/.test(ua);
export const isIOS = /iPhone|iPad|iPod/.test(ua) || (isMac && typeof navigator !== 'undefined' && navigator.maxTouchPoints > 1);
export const modKey = isMac || isIOS ? '⌘' : 'Ctrl';

/** Running inside a claude.ai artifact (live preview): window.claude.use exists. */
export function claudeRuntime(): { use: (name: string) => Promise<any> } | null {
  const c = (globalThis as any).claude;
  return c && typeof c.use === 'function' ? c : null;
}

export const isArtifact = BUILD_TARGET === 'single';

/** localStorage that never throws (private mode, sandboxed previews). */
export const safeStorage = {
  get(key: string): string | null {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key: string, value: string) {
    try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
  },
  remove(key: string) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
  },
};
