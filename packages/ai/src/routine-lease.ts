/**
 * Who runs routines automatically: a lease file in the vault (`ai/leases/routines.json`).
 *
 * Routines can be run by the Inkstone app (while it is open) and by the always-on runner
 * (`inkstone-agent run` on a computer). Without coordination both would fire the same daily
 * routine, and a note saved in the app would trigger the routine once in the app and again when
 * sync carries the save to the runner's copy of the vault. The rule is simple:
 *
 * - The runner holds the lease while it is alive, renewing it well before it expires.
 * - While someone else holds a live lease, a scheduler defers every automatic trigger (times,
 *   dates, note saves, recordings) to the holder. "Run now" always runs where it was pressed.
 * - A lease that is not renewed expires, so if the runner's computer sleeps or the service stops,
 *   the app takes over again once it sees the lease has lapsed.
 *
 * The routine run state (`state.slots`, `state.firedDates`, marked before a run starts) stays the
 * second line of defence: a slot already run is never run again, wherever it ran. Lease writes are
 * atomic (temp + rename) and verified by reading back, so two runners starting at the same moment
 * settle on one holder. Expiry is generous (default 10 minutes) because the file travels through
 * the user's sync service and device clocks may disagree by a little.
 */
import type { VaultFS } from '@inkstone/core';

/** Vault path of the routines lease (documented in docs/VAULT_FORMAT.md). */
export const ROUTINE_LEASE_PATH = 'ai/leases/routines.json';

export interface RoutineLease {
  /** Unique per process, e.g. `runner:macbook:4242:k3j2`. */
  holder: string;
  /** What the app shows: "Inkstone agent on Karthik's MacBook". */
  label: string;
  kind: 'runner' | 'app';
  acquiredAt: number;
  renewedAt: number;
  expiresAt: number;
}

export interface RoutineLeaseOptions {
  holder: string;
  label: string;
  kind?: RoutineLease['kind'];
  /** How long a lease lasts without renewal (default 10 minutes). */
  ttlMs?: number;
  clock?: () => number;
}

export const DEFAULT_LEASE_TTL_MS = 10 * 60_000;

function parseLease(text: string | null): RoutineLease | null {
  if (!text) return null;
  try {
    const l = JSON.parse(text) as RoutineLease;
    return typeof l?.holder === 'string' && Number.isFinite(l.expiresAt) ? l : null;
  } catch {
    return null; // half-synced or hand-edited: treat as no lease
  }
}

/** The current lease, if any (expired or not). */
export async function readRoutineLease(fs: VaultFS): Promise<RoutineLease | null> {
  return parseLease(await fs.readText(ROUTINE_LEASE_PATH));
}

/**
 * A live lease held by someone other than `self` (null when automatic routines may run here).
 * The app calls this before each automatic run.
 */
export async function routineLeaseHeldByOther(fs: VaultFS, now: number, self?: string): Promise<RoutineLease | null> {
  const l = await readRoutineLease(fs);
  return l && l.holder !== self && l.expiresAt > now ? l : null;
}

/** A lease this process tries to hold (the runner). */
export class RoutineLeaseHolder {
  private clock: () => number;
  private ttl: number;
  private acquiredAt: number | null = null;

  constructor(private fs: VaultFS, private opts: RoutineLeaseOptions) {
    this.clock = opts.clock ?? Date.now;
    this.ttl = opts.ttlMs ?? DEFAULT_LEASE_TTL_MS;
  }

  get holder(): string {
    return this.opts.holder;
  }

  /** Whether this process held the lease at the last `acquire()`. */
  get held(): boolean {
    return this.acquiredAt != null;
  }

  /**
   * Takes or renews the lease. Returns false while another live holder has it. Safe to call
   * often (every scheduler tick): it writes only when the lease is ours or free.
   */
  async acquire(): Promise<boolean> {
    const now = this.clock();
    const cur = await readRoutineLease(this.fs);
    if (cur && cur.holder !== this.opts.holder && cur.expiresAt > now) {
      this.acquiredAt = null;
      return false;
    }
    const mine = cur?.holder === this.opts.holder;
    const lease: RoutineLease = {
      holder: this.opts.holder,
      label: this.opts.label,
      kind: this.opts.kind ?? 'runner',
      acquiredAt: mine && cur ? cur.acquiredAt : now,
      renewedAt: now,
      expiresAt: now + this.ttl,
    };
    await this.fs.writeText(ROUTINE_LEASE_PATH, JSON.stringify(lease, null, 1));
    // Read back: if another holder wrote at the same moment, the last rename wins for both of us.
    const back = await readRoutineLease(this.fs);
    if (back?.holder !== this.opts.holder) {
      this.acquiredAt = null;
      return false;
    }
    this.acquiredAt = lease.acquiredAt;
    return true;
  }

  /** Gives the lease up (on shutdown) so the app takes over at once instead of after expiry. */
  async release(): Promise<void> {
    const cur = await readRoutineLease(this.fs);
    if (cur?.holder === this.opts.holder) await this.fs.delete(ROUTINE_LEASE_PATH);
    this.acquiredAt = null;
  }
}
