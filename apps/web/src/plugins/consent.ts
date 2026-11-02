/**
 * Device-local consent for plugins (security review SR-01).
 *
 * Installed plugins, and the permissions granted to them, live in the vault (`plugins/`), so they
 * sync to every device. That makes the vault the authority on what code runs with which
 * permissions — and the vault is written by more than the person at this device: a sync remote
 * (a shared or compromised Drive folder, a WebDAV server), a paired device, or a backup ZIP
 * someone sent. Any of them could otherwise drop in a plugin granted `network` and `notes:read`
 * and have it run here on the next start.
 *
 * So every device keeps its own record of what the person *on this device* approved: for each
 * plugin, a fingerprint of the code that runs (manifest + entry script) and the permissions they
 * allowed. A plugin runs only while the vault's copy matches that record — same code, and no
 * permission beyond the approved ones. Anything else (installed, updated or granted more
 * elsewhere) waits in Settings › Plugins for a review on this device. Revoking elsewhere needs no
 * review: fewer permissions are always fine.
 *
 * The record is per device on purpose and lives in this browser's storage, outside the vault, so
 * nothing that writes the vault can write it. Clearing site data only means plugins ask again.
 */
import { safeStorage } from '../platform/env.ts';

const KEY = 'inkwright.plugins.consent.v1';

export interface PluginConsent {
  /** SHA-256 (hex) of the manifest and entry script approved on this device. */
  fp: string;
  /** Permissions approved on this device. */
  granted: string[];
  at: number;
}

/** Fingerprint of what runs: the manifest's exact text and the entry script's exact text. */
export async function pluginFingerprint(manifestText: string, entryCode: string): Promise<string> {
  const bytes = new TextEncoder().encode(`inkwright.plugin.v1\0${manifestText}\0${entryCode}`);
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function readAll(): Record<string, PluginConsent> {
  try {
    const v = JSON.parse(safeStorage.get(KEY) ?? '{}') as unknown;
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, PluginConsent>) : {};
  } catch {
    return {};
  }
}

export function consentFor(id: string): PluginConsent | null {
  const c = readAll()[id];
  return c && typeof c.fp === 'string' && Array.isArray(c.granted) ? c : null;
}

export function recordConsent(id: string, fp: string, granted: readonly string[]): void {
  safeStorage.set(KEY, JSON.stringify({ ...readAll(), [id]: { fp, granted: [...new Set(granted)].sort(), at: Date.now() } satisfies PluginConsent }));
}

export function forgetConsent(id: string): void {
  const { [id]: _gone, ...rest } = readAll();
  safeStorage.set(KEY, JSON.stringify(rest));
}

/**
 * True when this device approved exactly this code and at least these permissions. Pure, so the
 * rule is unit-tested on its own (consent.test.ts).
 */
export function consentCovers(c: PluginConsent | null, fp: string, granted: readonly string[]): boolean {
  if (!c || c.fp !== fp) return false;
  return granted.every((g) => c.granted.includes(g));
}

/** Shown on the plugin's card while it waits for a review on this device. */
export const NEEDS_REVIEW = 'Added, updated or given more permissions outside this device (another device, a sync or a backup). Review it to run it here.';
