import { SyncSafetyError } from './engine.ts';

export type SyncSchedulerStatus = 'idle' | 'syncing' | 'offline' | 'backoff' | 'paused' | 'stopped';

export interface SyncSchedulerOptions {
  /** One sync run (typically `(signal) => engine.sync({ signal })`). */
  run: (signal: AbortSignal) => Promise<unknown>;
  /** Quiet period after the last local change before syncing (default 4 s). */
  debounceMs?: number;
  /** Longest a stream of edits can postpone a sync (default 30 s). */
  maxDelayMs?: number;
  /** Periodic pull interval (default 60 s; 0 disables). */
  pollIntervalMs?: number;
  /** Current connectivity (default: `navigator.onLine` when available, else true). */
  isOnline?: () => boolean;
  /** Subscribes to connectivity changes; returns an unsubscribe function. */
  subscribeOnline?: (cb: (online: boolean) => void) => () => void;
  /** Exponential backoff after failures (default 5 s doubling to 5 min). */
  backoff?: { initialMs?: number; maxMs?: number; factor?: number };
  /** Errors that need the user (default: SyncSafetyError): auto-sync pauses until `syncNow()`. */
  isFatal?: (e: unknown) => boolean;
  onError?: (error: unknown, retryInMs: number | null) => void;
  onStatus?: (status: SyncSchedulerStatus) => void;
  /** Called after each successful run with its result. */
  onSynced?: (result: unknown) => void;
  clock?: () => number;
}

type Timer = ReturnType<typeof setTimeout>;

/**
 * Decides *when* to sync: debounced after local edits, periodically for remote changes, right
 * away when connectivity returns, never while offline, with exponential backoff after errors.
 * Runs never overlap; a trigger during a run schedules exactly one follow-up run.
 */
export class SyncScheduler {
  private debounceTimer: Timer | null = null;
  private pollTimer: Timer | null = null;
  private retryTimer: Timer | null = null;
  private firstChangeAt: number | null = null;
  private current: Promise<void> | null = null;
  private controller: AbortController | null = null;
  private rerun = false;
  private started = false;
  private paused = false;
  private online = true;
  private failures = 0;
  private backoffUntil = 0;
  private unsubscribe: (() => void) | null = null;
  private _status: SyncSchedulerStatus = 'stopped';

  constructor(private readonly opts: SyncSchedulerOptions) {}

  get status(): SyncSchedulerStatus {
    return this._status;
  }

  /** Consecutive failed runs (0 after a success). */
  get failureCount(): number {
    return this.failures;
  }

  private now(): number {
    return (this.opts.clock ?? Date.now)();
  }

  private setStatus(s: SyncSchedulerStatus): void {
    if (s === this._status) return;
    this._status = s;
    try {
      this.opts.onStatus?.(s);
    } catch {
      /* UI callback */
    }
  }

  private idleStatus(): SyncSchedulerStatus {
    if (!this.started) return 'stopped';
    if (this.paused) return 'paused';
    if (!this.online) return 'offline';
    if (this.backoffUntil > this.now()) return 'backoff';
    return 'idle';
  }

  private readOnline(): boolean {
    if (this.opts.isOnline) return this.opts.isOnline();
    const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
    return typeof nav?.onLine === 'boolean' ? nav.onLine : true;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.online = this.readOnline();
    this.unsubscribe =
      this.opts.subscribeOnline?.((online) => {
        const was = this.online;
        this.online = online;
        if (online && !was) {
          // Connectivity is back: the previous failures were probably the network.
          this.backoffUntil = 0;
          this.clear('retry');
          this.trigger();
        } else this.setStatus(this.current ? 'syncing' : this.idleStatus());
      }) ?? null;
    this.setStatus(this.idleStatus());
    this.schedulePoll();
    this.trigger(); // initial sync
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.clear('debounce');
    this.clear('poll');
    this.clear('retry');
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.controller?.abort();
    this.rerun = false;
    this.firstChangeAt = null;
    this.setStatus('stopped');
  }

  /** Call after every local save. Debounced; bounded by `maxDelayMs`. */
  notifyLocalChange(): void {
    if (!this.started) return;
    const now = this.now();
    this.firstChangeAt ??= now;
    const delay = Math.max(0, Math.min(this.opts.debounceMs ?? 4000, this.firstChangeAt + (this.opts.maxDelayMs ?? 30_000) - now));
    this.clear('debounce');
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = null;
      this.trigger();
    }, delay);
  }

  /**
   * Syncs now (user tapped "Sync"): clears a pause or backoff and resolves when a run that
   * started after this call finishes; rejects with that run's error.
   */
  async syncNow(): Promise<void> {
    this.paused = false;
    this.backoffUntil = 0;
    this.clear('retry');
    if (this.current) await this.current.catch(() => {});
    if (this.current) return this.current;
    return this.runOnce();
  }

  private clear(which: 'debounce' | 'poll' | 'retry'): void {
    const key = `${which}Timer` as const;
    const t = this[key];
    if (t !== null) clearTimeout(t);
    this[key] = null;
  }

  private schedulePoll(): void {
    const every = this.opts.pollIntervalMs ?? 60_000;
    if (!every || !this.started) return;
    this.clear('poll');
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.trigger();
      this.schedulePoll();
    }, every);
  }

  private trigger(): void {
    if (!this.started || this.paused) return;
    if (!this.online) {
      this.setStatus('offline');
      return; // the online callback triggers when connectivity returns
    }
    if (this.backoffUntil > this.now()) return; // the retry timer will fire
    if (this.current) {
      this.rerun = true;
      return;
    }
    this.runOnce().catch(() => {});
  }

  private runOnce(): Promise<void> {
    const p = this.execute().finally(() => {
      this.current = null;
      this.controller = null;
      if (this.rerun && this.started) {
        this.rerun = false;
        this.trigger();
      } else this.setStatus(this.idleStatus());
    });
    this.current = p;
    return p;
  }

  private async execute(): Promise<void> {
    this.firstChangeAt = null; // edits after this point need another run
    this.clear('debounce');
    const controller = new AbortController();
    this.controller = controller;
    this.setStatus('syncing');
    try {
      const result = await this.opts.run(controller.signal);
      this.failures = 0;
      this.backoffUntil = 0;
      this.opts.onSynced?.(result);
    } catch (e) {
      if (controller.signal.aborted && !this.started) return; // stopped mid-run
      this.failures++;
      const fatal = (this.opts.isFatal ?? ((x: unknown) => x instanceof SyncSafetyError))(e);
      if (fatal) {
        this.paused = true;
        this.opts.onError?.(e, null);
      } else {
        const b = this.opts.backoff ?? {};
        const delay = Math.min(b.maxMs ?? 300_000, (b.initialMs ?? 5_000) * (b.factor ?? 2) ** (this.failures - 1));
        this.backoffUntil = this.now() + delay;
        this.clear('retry');
        if (this.started) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            this.backoffUntil = 0;
            this.trigger();
          }, delay);
        }
        this.opts.onError?.(e, delay);
      }
      throw e;
    }
  }
}
