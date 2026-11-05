/**
 * The in-app updater's state (docs/UPDATES.md): what is installed, what was found, where an update
 * is in its download → verify → install journey, and the person's choices (beta channel, "Later").
 *
 * Small and free of the checking code on purpose: the library imports it to decide whether to show
 * the banner, and that must not pull the updater into the startup bundle (service.ts is loaded
 * lazily by the Updates module).
 */
import { create } from 'zustand';
import { safeStorage } from '../platform/env.ts';
import type { ReleasesCache } from './github.ts';

/** An update found for this phone. */
export interface UpdateOffer {
  version: string;
  versionCode: number;
  channel: 'stable' | 'beta';
  published: string;
  /** Markdown from the CHANGELOG section of the release. */
  notes: string;
  /** The APK for this phone's ABI. */
  url: string;
  size: number;
  abi: string;
  /** The release page on GitHub. */
  pageUrl: string;
}

export type UpdatePhase =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'up-to-date' }
  | { kind: 'available' }
  | { kind: 'downloading'; loaded: number; total: number }
  | { kind: 'verifying' }
  /** Verified and waiting to be installed (the person cancelled Android's confirmation, say). */
  | { kind: 'ready'; path: string }
  /** Verified; Android needs "Install unknown apps" allowed for Inkwright first. */
  | { kind: 'permission'; path: string }
  | { kind: 'installing'; path: string }
  | { kind: 'failed'; reason: string; retry: 'download' | 'install'; path?: string };

/** Why the last check found nothing to offer, when it isn't simply "up to date". Shown in Settings only. */
export type CheckNote = 'offline' | 'rate-limited' | 'error' | 'no-apk' | null;

interface Persisted {
  /** Offer pre-releases ("Beta updates"). On by default while Inkwright ships only betas. */
  beta: boolean;
  /** When releases were last fetched successfully (ms). */
  lastChecked: number | null;
  /** GitHub's rate limit: no automatic check before this (ms). */
  retryAt: number | null;
  /** ETag and the release list it belongs to (github.ts). */
  cache: ReleasesCache | null;
  /** "Later": the banner for this version (and older) stays hidden until `until`. */
  snooze: { versionCode: number; until: number } | null;
}

export interface UpdatesState extends Persisted {
  /** The running app, from App.getInfo(). */
  current: { version: string; versionCode: number } | null;
  offer: UpdateOffer | null;
  phase: UpdatePhase;
  note: CheckNote;
  /** Android 12+ will update without asking (Inkwright installed itself before). */
  silentInstall: boolean;
  /** Android's API level (updates install without asking only from 31, Android 12). */
  sdk: number | null;
}

const KEY = 'inkwright.updates.v1';
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

const DEFAULTS: Persisted = { beta: true, lastChecked: null, retryAt: null, cache: null, snooze: null };

function load(): Persisted {
  try {
    const raw = safeStorage.get(KEY);
    const v = raw ? (JSON.parse(raw) as Partial<Persisted>) : {};
    return {
      beta: typeof v.beta === 'boolean' ? v.beta : DEFAULTS.beta,
      lastChecked: typeof v.lastChecked === 'number' ? v.lastChecked : null,
      retryAt: typeof v.retryAt === 'number' ? v.retryAt : null,
      cache: v.cache && typeof v.cache.etag === 'string' && Array.isArray(v.cache.releases) ? v.cache : null,
      snooze: v.snooze && typeof v.snooze.versionCode === 'number' && typeof v.snooze.until === 'number' ? v.snooze : null,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export const useUpdates = create<UpdatesState>(() => ({
  ...load(),
  current: null,
  offer: null,
  phase: { kind: 'idle' },
  note: null,
  silentInstall: false,
  sdk: null,
}));

useUpdates.subscribe((s, prev) => {
  if (s.beta === prev.beta && s.lastChecked === prev.lastChecked && s.retryAt === prev.retryAt && s.cache === prev.cache && s.snooze === prev.snooze) return;
  const { beta, lastChecked, retryAt, cache, snooze } = s;
  safeStorage.set(KEY, JSON.stringify({ beta, lastChecked, retryAt, cache, snooze }));
});

/** Whether "Later" still hides the banner for `offer`. A newer version than the snoozed one shows at once. */
export function isSnoozed(s: Pick<UpdatesState, 'snooze'>, offer: UpdateOffer, now = Date.now()): boolean {
  return !!s.snooze && s.snooze.versionCode >= offer.versionCode && now < s.snooze.until;
}

/** Whether the library shows the update banner. Once an update is under way it stays until it ends. */
export function bannerVisible(s: Pick<UpdatesState, 'offer' | 'phase' | 'snooze'>, now = Date.now()): boolean {
  if (!s.offer) return false;
  switch (s.phase.kind) {
    case 'available': case 'failed': return !isSnoozed(s, s.offer, now);
    case 'downloading': case 'verifying': case 'ready': case 'permission': case 'installing': return true;
    default: return false;
  }
}

/** "Later": hide the banner for this version for 24 hours. */
export function snoozeOffer(now = Date.now()): void {
  const offer = useUpdates.getState().offer;
  if (offer) useUpdates.setState({ snooze: { versionCode: offer.versionCode, until: now + SNOOZE_MS } });
}

/** Tests only. */
export function resetUpdatesForTests(): void {
  useUpdates.setState({ ...DEFAULTS, current: null, offer: null, phase: { kind: 'idle' }, note: null, silentInstall: false, sdk: null });
}
