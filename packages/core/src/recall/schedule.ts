/**
 * When the memory timeline may look at the screen, and when it should look again.
 *
 * The rules are deliberately conservative and live here, as pure functions, so every one of them
 * is unit-tested and the desktop shell only reports facts (which window is in front, whether a
 * password field has focus, how long the user has been idle):
 *
 * - Never while paused, while the screen is locked, or while the user is away (idle).
 * - Never password managers and other excluded applications, never windows whose titles say they
 *   are private or incognito, never windows whose titles the user excluded.
 * - Never while the OS says secure text entry is on (a password field has focus — macOS reports
 *   this for every app, Windows through UI Automation; see docs/MEMORY_TIMELINE.md).
 * - Never Inkwright itself: notes are already in the vault, and capturing them would echo them.
 *
 * Between captures it backs off while nothing changes (a static screen costs nothing), and looks
 * again soon after the user switches to another window.
 */
import type { RecallConfig } from './format.ts';

/** What the desktop shell reports about the window in front. */
export interface ForegroundWindow {
  /** Application name as the OS shows it ("Google Chrome", "Terminal", "Code"). */
  app: string;
  title: string;
  /** macOS bundle id or Windows/Linux executable name, when known ("com.apple.Terminal", "code.exe"). */
  bundleId?: string;
  /** The shell knows this window is private/incognito (beyond what the title says). */
  private?: boolean;
}

export interface CaptureContext {
  now: number;
  window: ForegroundWindow | null;
  /** Seconds since the last keyboard or pointer input. */
  idleSec: number;
  /** The screen is locked or the screensaver is on. */
  locked: boolean;
  /** A password (secure text) field has focus, as far as the OS can tell. */
  secureInput: boolean;
  /** Capture is paused until this time (epoch ms), or null. */
  pausedUntil: number | null;
  config: Pick<RecallConfig, 'excludedApps' | 'excludedTitles'>;
}

export type SkipReason = 'paused' | 'locked' | 'idle' | 'no-window' | 'own-app' | 'excluded-app' | 'excluded-title' | 'private-window' | 'password-field';

export type CaptureDecision = { capture: true } | { capture: false; reason: SkipReason };

/** After this many seconds without input the user counts as away. */
export const IDLE_AFTER_SEC = 120;

/**
 * Password managers and system credential UIs, excluded whatever the settings say. Matched
 * case-insensitively as substrings of the app name or bundle id.
 */
export const ALWAYS_EXCLUDED_APPS: readonly string[] = [
  '1password', 'bitwarden', 'keepass', 'lastpass', 'dashlane', 'enpass', 'proton pass', 'nordpass', 'roboform', 'keeper',
  'keychain access', 'com.apple.keychainaccess', 'passwords', 'com.apple.passwords', 'securityagent', 'credential manager',
  'seahorse', 'kwalletmanager', 'gnome-keyring', 'authy', 'google authenticator', 'microsoft authenticator', 'yubico',
];

/** Inkwright's own windows (any build). */
const OWN_APP = /^(?:inkwright|app\.inkwright)\b/i;

/**
 * Title markers browsers put on private windows. Firefox ("— Private Browsing"), Chrome on Windows
 * and Linux ("(Incognito)"), Edge ("[InPrivate]", "InPrivate"), Brave ("Private"), Opera and
 * Vivaldi ("Private"). Safari and Chrome on macOS do not mark the title; the shell reports those
 * through `private` where it can, and docs/MEMORY_TIMELINE.md says so.
 */
const PRIVATE_TITLE = /(?:private browsing|\bincognito\b|\binprivate\b|\(private\)|— private\b|- private\b|private window|tor browser)/i;

export function isPrivateWindow(w: ForegroundWindow): boolean {
  return !!w.private || PRIVATE_TITLE.test(w.title) || /tor browser/i.test(w.app);
}

const lc = (s: string | undefined) => (s ?? '').toLowerCase();

/** The app is excluded, by the built-in list or the user's. */
export function isExcludedApp(w: ForegroundWindow, excluded: readonly string[]): boolean {
  const names = [lc(w.app), lc(w.bundleId)].filter(Boolean);
  const hit = (pattern: string) => {
    const p = pattern.trim().toLowerCase();
    return !!p && names.some((n) => n.includes(p));
  };
  return ALWAYS_EXCLUDED_APPS.some(hit) || excluded.some(hit);
}

export function isExcludedTitle(w: ForegroundWindow, excluded: readonly string[]): boolean {
  const t = lc(w.title);
  return excluded.some((p) => { const q = p.trim().toLowerCase(); return !!q && t.includes(q); });
}

/** Whether to capture the window in front now, and if not, why not (shown as the status line). */
export function shouldCapture(ctx: CaptureContext): CaptureDecision {
  const no = (reason: SkipReason): CaptureDecision => ({ capture: false, reason });
  if (ctx.pausedUntil != null && ctx.now < ctx.pausedUntil) return no('paused');
  if (ctx.locked) return no('locked');
  if (ctx.idleSec >= IDLE_AFTER_SEC) return no('idle');
  const w = ctx.window;
  if (!w || (!w.app && !w.title)) return no('no-window');
  if (OWN_APP.test(w.app) || OWN_APP.test(w.bundleId ?? '')) return no('own-app');
  if (ctx.secureInput) return no('password-field');
  if (isExcludedApp(w, ctx.config.excludedApps)) return no('excluded-app');
  if (isPrivateWindow(w)) return no('private-window');
  if (isExcludedTitle(w, ctx.config.excludedTitles)) return no('excluded-title');
  return { capture: true };
}

export const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  paused: 'Paused',
  locked: 'Not capturing while the screen is locked',
  idle: 'Not capturing while you are away',
  'no-window': 'No window in front',
  'own-app': 'Inkwright itself is never captured',
  'excluded-app': 'This app is excluded',
  'excluded-title': 'This window is excluded',
  'private-window': 'Private windows are never captured',
  'password-field': 'Not capturing while a password field has focus',
};

// ---- Change detection ------------------------------------------------------------------------------

/**
 * A frame's signature: the window downscaled to a small grid of luminance cells (the shell sends
 * 64 × 40 bytes). Comparing cells, not exact pixels, ignores a blinking cursor or a clock while
 * still noticing a new line of text.
 */
export interface FrameSignature {
  width: number;
  height: number;
  /** Row-major luminance 0–255, `width * height` values. */
  cells: Uint8Array;
}

/** Cells whose luminance moved more than this count as changed. */
const CELL_DELTA = 12;
/** A frame is new when more than this fraction of cells changed. */
export const CHANGE_FRACTION = 0.004;

/** Fraction of cells that changed between two signatures (1 when they can't be compared). */
export function frameDifference(a: FrameSignature | null, b: FrameSignature): number {
  if (!a || a.width !== b.width || a.height !== b.height || a.cells.length !== b.cells.length || !b.cells.length) return 1;
  let changed = 0;
  for (let i = 0; i < b.cells.length; i++) if (Math.abs(a.cells[i]! - b.cells[i]!) > CELL_DELTA) changed++;
  return changed / b.cells.length;
}

// ---- Pace ------------------------------------------------------------------------------------------

export interface PaceState {
  /** Consecutive looks that found nothing new. */
  unchanged: number;
  /** The window that was in front at the last look (app + title). */
  lastWindow: string | null;
}

export const initialPace = (): PaceState => ({ unchanged: 0, lastWindow: null });

const windowKey = (w: ForegroundWindow | null) => (w ? `${w.app}\u0000${w.title}` : null);

/**
 * Delay until the next look, in ms. The base interval while the screen keeps changing; doubling
 * (up to 8×) while it doesn't; a quick look (3 s, to let the window settle) after a switch.
 */
export function nextDelayMs(pace: PaceState, intervalSec: number, current: ForegroundWindow | null): number {
  const base = Math.max(5, intervalSec) * 1000;
  if (current && pace.lastWindow !== null && windowKey(current) !== pace.lastWindow) return Math.min(base, 3000);
  const factor = Math.min(8, 2 ** Math.floor(pace.unchanged / 3));
  return base * factor;
}

/** Records the outcome of a look. */
export function recordLook(pace: PaceState, w: ForegroundWindow | null, changed: boolean): PaceState {
  const key = windowKey(w);
  return { unchanged: changed || key !== pace.lastWindow ? 0 : pace.unchanged + 1, lastWindow: key };
}

/** How often the window in front is checked for a switch while the pace is slow (ms). */
export const SWITCH_POLL_MS = 3000;

/** True when the window in front differs from the last look (so a slow pace should look now). */
export function switchedWindow(pace: PaceState, w: ForegroundWindow | null): boolean {
  return pace.lastWindow !== null && windowKey(w) !== null && windowKey(w) !== pace.lastWindow;
}
