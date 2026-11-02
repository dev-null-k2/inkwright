/**
 * Turns changes in the vault folder into API events (`note.created`, `note.updated`,
 * `note.trashed`, `note.restored`, `recording.ended`, `routine.finished`).
 *
 * The vault is plain files written by many hands — the app on another device (via sync), this
 * server's MCP and REST writes, the always-on runner — so events come from one place that sees
 * all of them: a scan comparing each note's `updatedAt`, trash state and recordings, and the
 * Activity log's routine runs, with the previous scan. The first scan is the baseline (no
 * events). Scans run every `intervalMs`, and sooner after a write through this server (`poke`).
 */
import { ActivityStore } from '@inkwright/ai';
import type { ServerContext } from '../context.ts';
import type { WebhookEvent } from './webhooks.ts';

export interface VaultEvent {
  type: WebhookEvent;
  data: Record<string, unknown>;
}

interface NoteState {
  updatedAt: number;
  trashed: boolean;
  clips: Set<string>;
  title: string;
}

export class VaultEvents {
  private notes: Map<string, NoteState> | null = null;
  private routineRuns = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private scanning: Promise<VaultEvent[]> | null = null;
  private pokeTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<(e: VaultEvent) => void>();

  constructor(private ctx: ServerContext, private opts: { intervalMs?: number } = {}) {}

  on(listener: (e: VaultEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Starts periodic scans (the first establishes the baseline). */
  start(): void {
    if (this.timer) return;
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.opts.intervalMs ?? 5000);
    this.timer.unref?.();
  }

  /** Schedules a scan shortly (after a write made through this server). */
  poke(): void {
    if (this.pokeTimer) return;
    this.pokeTimer = setTimeout(() => {
      this.pokeTimer = null;
      void this.scan();
    }, 150);
    this.pokeTimer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.pokeTimer) clearTimeout(this.pokeTimer);
    this.timer = null;
    this.pokeTimer = null;
  }

  /** Compares the vault with the last scan and emits what changed. Concurrent calls share a scan. */
  scan(): Promise<VaultEvent[]> {
    this.scanning ??= this.diff().finally(() => {
      this.scanning = null;
    });
    return this.scanning;
  }

  private async diff(): Promise<VaultEvent[]> {
    this.ctx.vault.invalidate();
    const baseline = this.notes == null;
    const next = new Map<string, NoteState>();
    const events: VaultEvent[] = [];
    for (const n of await this.ctx.vault.listNotes({ includeTrashed: true })) {
      const s: NoteState = { updatedAt: n.updatedAt, trashed: n.trashedAt != null, clips: new Set((n.recordings ?? []).map((c) => c.id)), title: n.title };
      next.set(n.id, s);
      if (baseline) continue;
      const before = this.notes!.get(n.id);
      const base = { id: n.id, title: n.title, updatedAt: new Date(n.updatedAt).toISOString() };
      if (!before) {
        if (!s.trashed) events.push({ type: 'note.created', data: base });
      } else {
        if (!before.trashed && s.trashed) events.push({ type: 'note.trashed', data: base });
        else if (before.trashed && !s.trashed) events.push({ type: 'note.restored', data: base });
        else if (s.updatedAt !== before.updatedAt && !s.trashed) events.push({ type: 'note.updated', data: base });
      }
      for (const clip of n.recordings ?? []) {
        // A recording that arrives with a newly synced note counts as ended too.
        if (before?.clips.has(clip.id)) continue;
        events.push({ type: 'recording.ended', data: { noteId: n.id, title: n.title, clipId: clip.id, durationMs: clip.durationMs, startedAt: new Date(clip.startedAt).toISOString() } });
      }
    }
    // Routine runs that finished since the last scan (from the app, the runner or this server).
    const runs = await new ActivityStore(this.ctx.fs).list().catch(() => []);
    for (const r of runs) {
      if (r.source !== 'routine' || r.status === 'running' || this.routineRuns.has(r.id)) continue;
      this.routineRuns.add(r.id);
      if (!baseline) events.push({ type: 'routine.finished', data: { runId: r.id, routineId: r.routineId ?? null, name: r.label, status: r.status, changes: r.ops.length, ...(r.error ? { error: r.error } : {}) } });
    }
    this.notes = next;
    for (const e of events) for (const l of [...this.listeners]) l(e);
    return events;
  }
}
