/**
 * The always-on runner (`inkstone-agent run`): runs the user's routines on a computer even when
 * the Inkstone app isn't open, over the vault folder (a synced folder, Google Drive / iCloud /
 * Dropbox copy, or a WebDAV mount).
 *
 * Nothing is reimplemented: routine definitions, triggers, catch-up, run state and the scheduler
 * come from @inkstone/ai (`RoutineStore`, `RoutineScheduler`); each run is the same agent run as in
 * the app (agent/run.ts), logged in the vault's AI activity so the app lists it and can undo it.
 *
 * Coordination with the app (and with a second runner on another computer) uses the routines
 * lease in the vault (`ai/leases/routines.json`): only the lease holder acts on automatic
 * triggers; the app defers to a live runner; a runner that stops renewing (asleep, stopped) loses
 * the lease after its TTL and the app or another runner takes over. Slots and dates are still
 * marked in the routine's state before a run starts, so nothing runs twice even across a handover.
 *
 * Events: note saves and finished recordings are detected by comparing each note's `updatedAt`
 * and recording count with the last scan (the folder is watched where the OS allows, and scanned
 * every `scanMs` anyway — sync clients don't always produce file events). Changes the runner's own
 * routines make are absorbed, so a routine never triggers itself.
 *
 * Destructive actions (moving a note to Trash) are never taken unattended: they are saved as
 * pending approvals (approvals.ts) for the user to allow later.
 */
import { watch, type FSWatcher } from 'node:fs';
import { hostname } from 'node:os';
import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import { RoutineLeaseHolder, RoutineScheduler, RoutineStore, findDateMentions, type DatedNote, type Routine, type TriggerEvent } from '@inkstone/ai';
import { VaultLayout, pageText } from '@inkstone/core';
import type { ServerContext } from '../context.ts';
import { ApprovalStore, deferringApprover } from '../approvals.ts';
import type { AgentAI } from '../agent/ai.ts';
import { runRoutineOnServer } from '../agent/run.ts';
import { TEMP_PREFIX } from '../nodefs.ts';

export interface RunnerOptions {
  ctx: ServerContext;
  ai: AgentAI | null;
  /** Unique id for the lease (default: runner:<host>:<pid>:<random>). */
  holder?: string;
  /** What the app shows (default "The Inkstone agent on <host>"). */
  label?: string;
  log?: (msg: string) => void;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** Trigger check interval (default 60 s). */
  tickMs?: number;
  /** Note change scan interval (default 15 s). */
  scanMs?: number;
  /** Quiet period after a note save before a note-saved routine runs (default 20 s, like the app). */
  saveDebounceMs?: number;
  leaseTtlMs?: number;
  /** Watch the notes folder for changes (default true; scans run regardless). */
  watch?: boolean;
  /** Day-first numeric dates ("3/12") for before-date triggers (default: from the system locale). */
  dayFirst?: boolean;
}

interface NoteMark {
  updatedAt: number;
  recordings: number;
}

export class RoutineRunner {
  readonly scheduler: RoutineScheduler;
  readonly lease: RoutineLeaseHolder;
  readonly store: RoutineStore;
  readonly approvals: ApprovalStore;
  private log: (msg: string) => void;
  private clock: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (h: unknown) => void;
  private marks = new Map<string, NoteMark>();
  private scanTimer: unknown = null;
  private watchTimer: unknown = null;
  private watcher: FSWatcher | null = null;
  private running = new Map<string, AbortController>();
  private holding: boolean | null = null;
  private stopped = false;
  private scanning: Promise<void> | null = null;

  constructor(private o: RunnerOptions) {
    const { ctx } = o;
    this.log = o.log ?? (() => {});
    this.clock = o.clock ?? ctx.clock;
    this.setTimer = o.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; });
    this.clearTimer = o.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
    this.store = new RoutineStore(ctx.fs);
    this.approvals = new ApprovalStore(ctx.fs, this.clock);
    const host = hostname().replace(/\.local$/, '');
    this.lease = new RoutineLeaseHolder(ctx.fs, {
      holder: o.holder ?? `runner:${host}:${process.pid}:${randomBytes(3).toString('hex')}`,
      label: o.label ?? `The Inkstone agent on ${host}`,
      kind: 'runner',
      clock: this.clock,
      ...(o.leaseTtlMs ? { ttlMs: o.leaseTtlMs } : {}),
    });
    this.scheduler = new RoutineScheduler({
      store: this.store,
      run: (r, ev) => this.runRoutine(r, ev),
      findDatedNotes: (kw) => this.findDatedNotes(kw),
      clock: this.clock,
      setTimer: this.setTimer,
      clearTimer: this.clearTimer,
      tickMs: o.tickMs ?? 60_000,
      saveDebounceMs: o.saveDebounceMs ?? 20_000,
      onError: (e) => this.log(`Routine check failed: ${(e as Error)?.message ?? e}`),
      deferAutomatic: () => this.deferred(),
    });
  }

  /** Whether this runner currently holds the routines lease. */
  get holdsLease(): boolean {
    return this.lease.held;
  }

  /** Renews the lease; reports changes of who runs routines. */
  private async deferred(): Promise<boolean> {
    if (this.stopped) return true;
    const held = await this.lease.acquire();
    if (held !== this.holding) {
      this.holding = held;
      if (held) this.log('Running routines on this computer (holding the routines lease).');
      else this.log('Another runner holds the routines lease; standing by.');
    }
    return !held;
  }

  /** Takes a first look at the notes, then starts checking triggers (with catch-up). */
  async start(): Promise<void> {
    this.stopped = false;
    await this.snapshot();
    if (this.o.watch ?? true) this.startWatching();
    this.scheduleScan();
    await this.scheduler.start();
  }

  /** Stops scheduling, cancels running routines and gives the lease back. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.scheduler.stop();
    if (this.scanTimer) this.clearTimer(this.scanTimer);
    if (this.watchTimer) this.clearTimer(this.watchTimer);
    this.scanTimer = this.watchTimer = null;
    this.watcher?.close();
    this.watcher = null;
    for (const ac of this.running.values()) ac.abort();
    await this.scanning?.catch(() => {});
    await this.lease.release().catch(() => {});
  }

  private async runRoutine(r: Routine, ev: TriggerEvent): Promise<{ status: 'done' | 'error' | 'cancelled'; error?: string }> {
    const ac = new AbortController();
    this.running.set(r.id, ac);
    this.log(`Running “${r.name}” — ${ev.reason}`);
    try {
      const approver = deferringApprover(this.approvals, (a) => this.log(`“${r.name}” wants to: ${a.title}. Waiting for your OK (inkstone-agent approvals).`));
      const res = await runRoutineOnServer(this.o.ctx, this.o.ai, r, ev, approver, { signal: ac.signal });
      // The routine's own changes must not look like the user saving notes.
      await this.absorb(res.run.ops.map((op) => ('noteId' in op ? op.noteId : null)).filter((x): x is string => !!x));
      this.log(res.status === 'done' ? `“${r.name}” finished${res.run.ops.length ? ` with ${res.run.ops.length} change(s)` : ''}.` : `“${r.name}” ${res.status}: ${res.error ?? ''}`);
      return res.error ? { status: res.status, error: res.error } : { status: res.status };
    } finally {
      this.running.delete(r.id);
    }
  }

  private async findDatedNotes(keyword: string): Promise<DatedNote[]> {
    const { ctx } = this.o;
    await ctx.refresh();
    const now = this.clock();
    const dayFirst = this.o.dayFirst ?? !/^en-(US|PH|CA)$/i.test(Intl.DateTimeFormat().resolvedOptions().locale);
    const out: DatedNote[] = [];
    for (const h of (await ctx.searchIndex()).search(keyword, { limit: 40 })) {
      const n = await ctx.vault.readNote(h.noteId);
      if (!n || n.trashedAt != null) continue;
      const text = [n.title, ...(await ctx.vault.readPages(n)).map((p) => pageText(p))].join('\n');
      const mentions = findDateMentions(text, keyword, now, { dayFirst });
      if (mentions.length) out.push({ noteId: n.id, title: n.title, mentions });
    }
    return out;
  }

  // ---- Note change detection ----------------------------------------------------------------

  private async readMarks(): Promise<Map<string, NoteMark & { title: string; tags: string[]; trashed: boolean }>> {
    const { ctx } = this.o;
    ctx.vault.invalidate();
    const out = new Map<string, NoteMark & { title: string; tags: string[]; trashed: boolean }>();
    for (const n of await ctx.vault.listNotes({ includeTrashed: true })) {
      out.set(n.id, { updatedAt: n.updatedAt, recordings: n.recordings?.length ?? 0, title: n.title, tags: [...n.tags], trashed: n.trashedAt != null });
    }
    return out;
  }

  private async snapshot() {
    this.marks.clear();
    for (const [id, m] of await this.readMarks()) this.marks.set(id, { updatedAt: m.updatedAt, recordings: m.recordings });
  }

  /** Takes the current state of these notes as the baseline (changes the runner made itself). */
  private async absorb(ids: string[]) {
    if (!ids.length) return;
    const now = await this.readMarks();
    for (const id of ids) {
      const m = now.get(id);
      if (m) this.marks.set(id, { updatedAt: m.updatedAt, recordings: m.recordings });
    }
  }

  /**
   * Compares notes with the last scan and reports saves and new recordings to the scheduler
   * (which debounces saves and checks the lease). Paused while a routine runs; its changes are
   * absorbed afterwards.
   */
  scan(): Promise<void> {
    if (this.scanning || this.running.size || this.stopped) return this.scanning ?? Promise.resolve();
    this.scanning = (async () => {
      try {
        const now = await this.readMarks();
        for (const [id, m] of now) {
          const before = this.marks.get(id);
          this.marks.set(id, { updatedAt: m.updatedAt, recordings: m.recordings });
          if (!before || m.trashed) continue; // new notes count from their next save
          if (m.recordings > before.recordings) void this.scheduler.recordingEnded({ id, title: m.title });
          if (m.updatedAt > before.updatedAt) this.scheduler.noteSaved({ id, title: m.title, tags: m.tags });
        }
      } catch (e) {
        this.log(`Couldn’t scan the notes: ${(e as Error).message}`);
      } finally {
        this.scanning = null;
      }
    })();
    return this.scanning;
  }

  private scheduleScan() {
    if (this.stopped) return;
    this.scanTimer = this.setTimer(() => {
      void this.scan().finally(() => this.scheduleScan());
    }, this.o.scanMs ?? 15_000);
  }

  private startWatching() {
    try {
      const dir = path.join(this.o.ctx.root, VaultLayout.NOTES_DIR);
      this.watcher = watch(dir, { recursive: true, persistent: false }, (_e, file) => {
        if (typeof file === 'string' && (file.includes(TEMP_PREFIX) || !file.endsWith('note.json'))) return;
        if (this.watchTimer) this.clearTimer(this.watchTimer);
        // Let a sync burst settle before looking.
        this.watchTimer = this.setTimer(() => void this.scan(), 1500);
      });
      this.watcher.on('error', () => {
        this.watcher?.close();
        this.watcher = null;
      });
    } catch {
      this.watcher = null; // Some network/cloud mounts can't be watched; the periodic scan covers it.
    }
  }
}
