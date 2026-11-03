/**
 * Routines: background agents the user sets up — a prompt, the AI to use, the tools it may use,
 * and triggers (a daily/weekly time, a note with a tag being saved, a recording ending, N days
 * before a date written in a note, or a manual run).
 *
 * Honest by design: routines run while Inkwright is open. On open, the scheduler catches up —
 * a routine whose time passed while the app was closed runs once (not once per missed slot).
 * Nothing runs when the app is closed, unless the user runs the always-on runner
 * (`inkwright-agent run`, apps/mcp-server) on a computer: it uses this same scheduler over the
 * vault folder and holds the routines lease (routine-lease.ts) so the two never both run a trigger.
 *
 * This module is pure scheduling logic with an injected clock and timers, so every rule is
 * unit-tested; the app supplies `run` (an agent run) and the note-scanning callbacks.
 * Routines are stored in the vault (`ai/routines/<id>.json`) with their run state, so a run on
 * one device isn't repeated on another once sync has carried the state over.
 */
import { isSafeId, newId, type VaultFS } from '@inkwright/core';

export type RoutineTrigger =
  /** Every day at local time `HH:MM`. */
  | { kind: 'daily'; time: string }
  /** Every week on `day` (0 = Sunday) at `HH:MM`. */
  | { kind: 'weekly'; day: number; time: string }
  /** A note with this tag is saved (debounced until the writer pauses). */
  | { kind: 'note-saved'; tag: string }
  /** An audio recording in a note ends. */
  | { kind: 'recording-ended' }
  /** `days` before a date written in a note next to `keyword` ("Exam: 3 Dec"). */
  | { kind: 'before-date'; days: number; keyword: string };

export type TriggerKind = RoutineTrigger['kind'] | 'manual';

export interface RoutineTools {
  /** Read only, or read and write notes. */
  notes: 'read' | 'write';
  /** Agent Skills (built-in and imported). */
  skills: boolean;
  /** Connected apps (MCP server ids) the routine may use. Writes always ask first. */
  mcpServers: string[];
}

export interface RoutineState {
  lastRunAt?: number;
  lastStatus?: 'done' | 'error' | 'cancelled';
  lastError?: string;
  /** Per time trigger (by index): the scheduled slot last run, so a slot runs once. */
  slots?: Record<string, number>;
  /** before-date: `noteId@YYYY-MM-DD` dates already handled. */
  firedDates?: string[];
}

export interface Routine {
  id: string;
  name: string;
  prompt: string;
  enabled: boolean;
  /** Provider config id, or null for the AI chosen in Settings (getActiveAI). */
  ai: string | null;
  tools: RoutineTools;
  triggers: RoutineTrigger[];
  /** Template it was made from, if any. */
  template?: string;
  createdAt: number;
  updatedAt: number;
  state: RoutineState;
}

/** Why a routine is running; also given to the agent as context. */
export interface TriggerEvent {
  kind: TriggerKind;
  /** Human-readable reason, e.g. "Daily at 18:00" or "Saved “Physics” (#exam)". */
  reason: string;
  noteId?: string;
  noteTitle?: string;
  /** before-date: the date found and how many days away it is. */
  date?: string;
  daysUntil?: number;
  /** The scheduled time slot (time triggers). */
  slot?: number;
  /** Index of the trigger in `routine.triggers`. */
  triggerIndex?: number;
  /** The slot was missed while the app was closed. */
  catchUp?: boolean;
  /** Time triggers this run covers (several can fall due together), recorded once it starts. */
  slots?: Array<{ triggerIndex: number; slot: number }>;
}

// ---- Time triggers ------------------------------------------------------------------------------

export function parseTime(t: string): { h: number; m: number } | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? { h, m: min } : null;
}

/** The most recent scheduled slot at or before `now` (local time), or null for event triggers. */
export function latestSlot(trigger: RoutineTrigger, now: number): number | null {
  if (trigger.kind !== 'daily' && trigger.kind !== 'weekly') return null;
  const t = parseTime(trigger.time);
  if (!t) return null;
  const d = new Date(now);
  const slot = new Date(d.getFullYear(), d.getMonth(), d.getDate(), t.h, t.m, 0, 0);
  if (trigger.kind === 'daily') {
    if (slot.getTime() > now) slot.setDate(slot.getDate() - 1);
    return slot.getTime();
  }
  const back = (slot.getDay() - (((trigger.day % 7) + 7) % 7) + 7) % 7;
  slot.setDate(slot.getDate() - back);
  if (slot.getTime() > now) slot.setDate(slot.getDate() - 7);
  return slot.getTime();
}

/** The next scheduled slot after `now`. */
export function nextSlot(trigger: RoutineTrigger, now: number): number | null {
  const last = latestSlot(trigger, now);
  if (last == null) return null;
  const d = new Date(last);
  d.setDate(d.getDate() + (trigger.kind === 'weekly' ? 7 : 1));
  return d.getTime();
}

/**
 * Time triggers due now. A slot is due when it is newer than both the last slot run for this
 * trigger and the routine's creation (a routine made at 18:30 doesn't run for 18:00 that day).
 * Missed slots collapse into one catch-up run.
 */
export function dueTimeTriggers(r: Routine, now: number, opts: { graceMs?: number } = {}): TriggerEvent[] {
  if (!r.enabled) return [];
  const out: TriggerEvent[] = [];
  const grace = opts.graceMs ?? 2 * 60_000;
  r.triggers.forEach((t, i) => {
    const slot = latestSlot(t, now);
    if (slot == null) return;
    const done = r.state.slots?.[String(i)] ?? 0;
    if (slot <= done || slot < r.createdAt) return;
    const catchUp = now - slot > grace;
    const label = t.kind === 'daily' ? `Daily at ${(t as { time: string }).time}` : `Weekly on ${DAY_NAMES[(t as { day: number }).day % 7]} at ${(t as { time: string }).time}`;
    out.push({ kind: t.kind, reason: catchUp ? `${label} (missed while Inkwright was closed)` : label, slot, triggerIndex: i, catchUp, slots: [{ triggerIndex: i, slot }] });
  });
  if (out.length <= 1) return out;
  // One run covers every time trigger that is due.
  return [{ ...out[0]!, reason: out.map((e) => e.reason).join('; '), catchUp: out.some((e) => e.catchUp), slots: out.flatMap((e) => e.slots ?? []) }];
}

export const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ---- Dates written in notes --------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?';

export interface DateMention {
  /** `YYYY-MM-DD`. */
  date: string;
  /** The line it was found on. */
  line: string;
}

const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;

function validDate(y: number, m: number, d: number): boolean {
  const t = new Date(y, m - 1, d);
  return t.getFullYear() === y && t.getMonth() === m - 1 && t.getDate() === d;
}

/** Year for a date written without one: this year, or next year once it is well past. */
function inferYear(m: number, d: number, now: number): number {
  const today = new Date(now);
  const y = today.getFullYear();
  const candidate = new Date(y, m - 1, d).getTime();
  return candidate < now - 60 * 86_400_000 ? y + 1 : y;
}

/**
 * Finds dates on lines that mention `keyword` (case-insensitive): `2026-12-03`, `3 Dec`,
 * `December 3rd, 2026`, `Dec 3`, and numeric `3/12/2026` / `12/3` (`dayFirst` decides the order;
 * it should follow the user's locale).
 */
export function findDateMentions(text: string, keyword: string, now: number, opts: { dayFirst?: boolean } = {}): DateMention[] {
  const kw = keyword.trim().toLowerCase();
  const out: DateMention[] = [];
  const seen = new Set<string>();
  const add = (y: number, m: number, d: number, line: string) => {
    if (!validDate(y, m, d)) return;
    const date = iso(y, m, d);
    if (!seen.has(date)) {
      seen.add(date);
      out.push({ date, line: line.trim().slice(0, 160) });
    }
  };
  for (const line of text.split(/\n/)) {
    if (kw && !line.toLowerCase().includes(kw)) continue;
    for (const m of line.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) add(Number(m[1]), Number(m[2]), Number(m[3]), line);
    for (const m of line.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}(?:,?\\s+(\\d{4}))?`, 'gi'))) {
      const mon = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1;
      const d = Number(m[1]);
      add(m[3] ? Number(m[3]) : inferYear(mon, d, now), mon, d, line);
    }
    for (const m of line.matchAll(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'gi'))) {
      const mon = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1;
      const d = Number(m[2]);
      add(m[3] ? Number(m[3]) : inferYear(mon, d, now), mon, d, line);
    }
    for (const m of line.matchAll(/\b(\d{1,2})[/.](\d{1,2})(?:[/.](\d{2,4}))?\b/g)) {
      if (/^\d{4}-/.test(m[0])) continue;
      const a = Number(m[1]);
      const b = Number(m[2]);
      const [d, mon] = opts.dayFirst ? [a, b] : [b, a];
      if (mon < 1 || mon > 12) continue;
      let y = m[3] ? Number(m[3]) : inferYear(mon, d, now);
      if (y < 100) y += 2000;
      add(y, mon, d, line);
    }
  }
  return out;
}

/** Whole days from `now`'s local date to `date` (YYYY-MM-DD). */
export function daysUntil(date: string, now: number): number {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const n = new Date(now);
  const a = Date.UTC(n.getFullYear(), n.getMonth(), n.getDate());
  return Math.round((Date.UTC(y, m - 1, d) - a) / 86_400_000);
}

export interface DatedNote {
  noteId: string;
  title: string;
  mentions: DateMention[];
}

/** before-date events due now: within `days` days (and not past), not handled before. */
export function dueDateEvents(r: Routine, notes: readonly DatedNote[], now: number): TriggerEvent[] {
  if (!r.enabled) return [];
  const fired = new Set(r.state.firedDates ?? []);
  const out: TriggerEvent[] = [];
  r.triggers.forEach((t, i) => {
    if (t.kind !== 'before-date') return;
    for (const n of notes) {
      for (const m of n.mentions) {
        const left = daysUntil(m.date, now);
        if (left < 0 || left > t.days || fired.has(`${n.noteId}@${m.date}`)) continue;
        out.push({ kind: 'before-date', reason: `“${n.title || 'Untitled'}” mentions ${t.keyword} on ${m.date} (${left === 0 ? 'today' : left === 1 ? 'tomorrow' : `in ${left} days`}): ${m.line}`, noteId: n.noteId, noteTitle: n.title, date: m.date, daysUntil: left, triggerIndex: i });
      }
    }
  });
  return out;
}

// ---- Storage -----------------------------------------------------------------------------------

export const ROUTINES_DIR = 'ai/routines';

export class RoutineStore {
  private listeners = new Set<() => void>();
  constructor(private fs: VaultFS) {}

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async list(): Promise<Routine[]> {
    const out: Routine[] = [];
    for (const e of await this.fs.list(ROUTINES_DIR)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      const r = await this.get(e.name.slice(0, -5));
      if (r) out.push(r);
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  async get(id: string): Promise<Routine | null> {
    if (!isSafeId(id)) return null;
    const t = await this.fs.readText(`${ROUTINES_DIR}/${id}.json`);
    if (!t) return null;
    try {
      const r = JSON.parse(t) as Routine;
      if (r.id !== id || typeof r.prompt !== 'string' || !Array.isArray(r.triggers)) return null;
      const defaults: RoutineTools = { notes: 'write', skills: true, mcpServers: [] };
      return { ...r, state: r.state ?? {}, tools: Object.assign(defaults, r.tools) };
    } catch {
      return null;
    }
  }

  async save(r: Routine): Promise<void> {
    if (!isSafeId(r.id)) throw new Error('Bad routine id');
    await this.fs.writeText(`${ROUTINES_DIR}/${r.id}.json`, JSON.stringify(r, null, 2));
    for (const l of [...this.listeners]) l();
  }

  async remove(id: string): Promise<void> {
    if (!isSafeId(id)) return;
    await this.fs.delete(`${ROUTINES_DIR}/${id}.json`);
    for (const l of [...this.listeners]) l();
  }

  /** Read-modify-write of one routine's run state. */
  async updateState(id: string, fn: (s: RoutineState) => RoutineState): Promise<Routine | null> {
    const r = await this.get(id);
    if (!r) return null;
    const next = { ...r, state: fn({ ...r.state }) };
    await this.save(next);
    return next;
  }
}

export function newRoutine(init: Partial<Omit<Routine, 'id' | 'createdAt' | 'updatedAt' | 'state'>> & Pick<Routine, 'name' | 'prompt'>, now = Date.now()): Routine {
  return {
    id: newId(now),
    enabled: true,
    ai: null,
    tools: { notes: 'write', skills: true, mcpServers: [] },
    triggers: [],
    createdAt: now,
    updatedAt: now,
    state: {},
    ...init,
  };
}

/** Validation for the routine editor. */
export function validateRoutine(r: Pick<Routine, 'name' | 'prompt' | 'triggers'>): string[] {
  const errs: string[] = [];
  if (!r.name.trim()) errs.push('Give the routine a name.');
  if (r.prompt.trim().length < 10) errs.push('Tell the routine what to do (at least a sentence).');
  for (const t of r.triggers) {
    if ((t.kind === 'daily' || t.kind === 'weekly') && !parseTime(t.time)) errs.push('Times look like 18:30.');
    if (t.kind === 'weekly' && !(t.day >= 0 && t.day <= 6)) errs.push('Pick a day of the week.');
    if (t.kind === 'note-saved' && !t.tag.trim()) errs.push('Pick the tag that starts the routine.');
    if (t.kind === 'before-date' && (!t.keyword.trim() || !(t.days >= 0 && t.days <= 60))) errs.push('“Days before a date” needs a word to look for and 0–60 days.');
  }
  return errs;
}

export function describeTrigger(t: RoutineTrigger): string {
  switch (t.kind) {
    case 'daily': return `Every day at ${t.time}`;
    case 'weekly': return `Every ${DAY_NAMES[t.day % 7]} at ${t.time}`;
    case 'note-saved': return `When a note tagged #${t.tag.replace(/^#/, '')} is saved`;
    case 'recording-ended': return 'When a recording ends';
    case 'before-date': return `${t.days} ${t.days === 1 ? 'day' : 'days'} before a “${t.keyword}” date in a note`;
  }
}

// ---- Scheduler ----------------------------------------------------------------------------------

export interface SchedulerHooks {
  store: RoutineStore;
  /** Runs the routine (an agent run); resolves when it finished. Errors are recorded in state. */
  run: (r: Routine, ev: TriggerEvent) => Promise<{ status: 'done' | 'error' | 'cancelled'; error?: string }>;
  /** Notes mentioning `keyword` with the dates found next to it (before-date triggers). */
  findDatedNotes?: (keyword: string) => Promise<DatedNote[]>;
  clock?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (h: unknown) => void;
  /** How often to check time and date triggers (default 60 s). */
  tickMs?: number;
  /** Quiet period after the last save before a note-saved routine runs (default 20 s). */
  saveDebounceMs?: number;
  onError?: (e: unknown) => void;
  /**
   * Asked before automatic triggers (times, dates, note saves, recordings) are acted on. Return
   * true to leave them to someone else — the always-on runner holding the routines lease (see
   * routine-lease.ts). "Run now" is never deferred.
   */
  deferAutomatic?: () => Promise<boolean> | boolean;
}

/**
 * Decides when routines run, one at a time. `start()` performs the catch-up check immediately,
 * then ticks. Event triggers come in through `noteSaved` and `recordingEnded`.
 */
export class RoutineScheduler {
  private timer: unknown = null;
  private queue: Array<{ id: string; ev: TriggerEvent }> = [];
  private running: string | null = null;
  private pumping = false;
  private saveTimers = new Map<string, unknown>();
  /** The periodic check is running (start() … stop()). */
  private ticking = false;
  /** stop() was called: queued runs are dropped. */
  private stopped = false;
  private clock: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (h: unknown) => void;
  /** Called when the queue or running routine changes (UI). */
  onStatus?: () => void;

  constructor(private h: SchedulerHooks) {
    this.clock = h.clock ?? Date.now;
    this.setTimer = h.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = h.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>));
  }

  get runningId() { return this.running; }
  get queued() { return this.queue.map((q) => q.id); }

  async start(): Promise<void> {
    this.stopped = false;
    this.ticking = true;
    await this.tick();
  }

  stop(): void {
    this.stopped = true;
    this.ticking = false;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = null;
    for (const t of this.saveTimers.values()) this.clearTimer(t);
    this.saveTimers.clear();
  }

  private schedule() {
    if (!this.ticking) return;
    if (this.timer) this.clearTimer(this.timer);
    this.timer = this.setTimer(() => void this.tick(), this.h.tickMs ?? 60_000);
  }

  /** Checks time and date triggers now. */
  async tick(): Promise<void> {
    try {
      if (await this.deferred()) {
        this.schedule();
        await this.pump();
        return;
      }
      const now = this.clock();
      const routines = (await this.h.store.list()).filter((r) => r.enabled);
      for (const r of routines) for (const ev of dueTimeTriggers(r, now)) this.enqueue(r.id, ev);
      const keywords = [...new Set(routines.flatMap((r) => r.triggers.filter((t) => t.kind === 'before-date').map((t) => (t as { keyword: string }).keyword.toLowerCase())))];
      if (keywords.length && this.h.findDatedNotes) {
        const byKw = new Map<string, DatedNote[]>();
        for (const kw of keywords) byKw.set(kw, await this.h.findDatedNotes(kw));
        for (const r of routines) {
          const notes = r.triggers.flatMap((t) => (t.kind === 'before-date' ? byKw.get(t.keyword.toLowerCase()) ?? [] : []));
          for (const ev of dueDateEvents(r, notes, now)) this.enqueue(r.id, ev);
        }
      }
    } catch (e) {
      this.h.onError?.(e);
    }
    this.schedule();
    await this.pump();
  }

  /** A note was saved by the user (not by a routine or the assistant). */
  noteSaved(note: { id: string; title: string; tags: readonly string[] }): void {
    const prev = this.saveTimers.get(note.id);
    if (prev) this.clearTimer(prev);
    this.saveTimers.set(note.id, this.setTimer(() => {
      this.saveTimers.delete(note.id);
      void this.fireNoteSaved(note);
    }, this.h.saveDebounceMs ?? 20_000));
  }

  /** Automatic triggers belong to someone else right now (errors count as "not deferred"). */
  private async deferred(): Promise<boolean> {
    try {
      return !!(await this.h.deferAutomatic?.());
    } catch (e) {
      this.h.onError?.(e);
      return false;
    }
  }

  private async fireNoteSaved(note: { id: string; title: string; tags: readonly string[] }) {
    if (await this.deferred()) return;
    const tags = new Set(note.tags.map((t) => t.toLowerCase().replace(/^#/, '')));
    for (const r of await this.h.store.list()) {
      if (!r.enabled) continue;
      const i = r.triggers.findIndex((t) => t.kind === 'note-saved' && tags.has(t.tag.toLowerCase().replace(/^#/, '')));
      if (i < 0) continue;
      const tag = (r.triggers[i] as { tag: string }).tag.replace(/^#/, '').toLowerCase();
      this.enqueue(r.id, { kind: 'note-saved', reason: `Saved “${note.title || 'Untitled'}” (#${tag})`, noteId: note.id, noteTitle: note.title, triggerIndex: i });
    }
    await this.pump();
  }

  /** A recording in a note ended. */
  async recordingEnded(note: { id: string; title: string }): Promise<void> {
    if (await this.deferred()) return;
    for (const r of await this.h.store.list()) {
      if (!r.enabled) continue;
      const i = r.triggers.findIndex((t) => t.kind === 'recording-ended');
      if (i >= 0) this.enqueue(r.id, { kind: 'recording-ended', reason: `A recording ended in “${note.title || 'Untitled'}”`, noteId: note.id, noteTitle: note.title, triggerIndex: i });
    }
    await this.pump();
  }

  /** Runs a routine now (the Run button). Works even when the routine is switched off. */
  async runNow(id: string): Promise<void> {
    this.enqueue(id, { kind: 'manual', reason: 'Run by you' });
    await this.pump();
  }

  private enqueue(id: string, ev: TriggerEvent) {
    const dup = this.queue.some((q) => q.id === id && q.ev.kind === ev.kind && q.ev.noteId === ev.noteId && q.ev.date === ev.date) || (this.running === id && ev.kind !== 'manual' && ev.kind !== 'note-saved' && ev.kind !== 'recording-ended' && ev.kind !== 'before-date');
    if (dup) return;
    this.queue.push({ id, ev });
    this.onStatus?.();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length && !this.stopped) {
        const { id, ev } = this.queue.shift()!;
        const r = await this.h.store.get(id);
        if (!r) continue;
        // Mark slots/dates first so a crash mid-run doesn't repeat the run on next open.
        await this.h.store.updateState(id, (s) => {
          const next = { ...s };
          if (ev.slots?.length) next.slots = { ...s.slots, ...Object.fromEntries(ev.slots.map((x) => [String(x.triggerIndex), x.slot])) };
          if (ev.kind === 'before-date' && ev.noteId && ev.date) next.firedDates = [...(s.firedDates ?? []), `${ev.noteId}@${ev.date}`].slice(-500);
          return next;
        });
        this.running = id;
        this.onStatus?.();
        let res: { status: 'done' | 'error' | 'cancelled'; error?: string };
        try {
          res = await this.h.run(r, ev);
        } catch (e) {
          res = { status: 'error', error: (e as Error)?.message ?? String(e) };
        }
        await this.h.store.updateState(id, (s) => {
          const next: RoutineState = { ...s, lastRunAt: this.clock(), lastStatus: res.status };
          if (res.error) next.lastError = res.error;
          else delete next.lastError;
          return next;
        });
        this.running = null;
        this.onStatus?.();
      }
    } finally {
      this.pumping = false;
    }
  }
}

// ---- Templates -----------------------------------------------------------------------------------

export interface RoutineTemplate {
  id: string;
  name: string;
  blurb: string;
  build: (now?: number) => Routine;
}

export const ROUTINE_TEMPLATES: readonly RoutineTemplate[] = [
  {
    id: 'file-notes',
    name: 'File my notes',
    blurb: 'Every evening, gives unfiled notes a title, tags and a notebook.',
    build: (now) => newRoutine({
      name: 'File my notes',
      template: 'file-notes',
      triggers: [{ kind: 'daily', time: '18:00' }],
      prompt: [
        'Tidy up my notes that are not filed yet.',
        '1. list_notes and pick the notes with no notebook, or titled "Untitled" / "Untitled note", edited since the last run.',
        '2. For each: read it (use get_page_image for handwriting that is not recognized). Give an "Untitled" note a short specific title. Add 1–3 topical tags, reusing tags I already use. Move it into the existing notebook that fits best; only create a notebook when several notes clearly belong together and none fits.',
        '3. Never change what a note says. Skip notes you can\'t understand.',
        'End with a short list of what you changed.',
      ].join('\n'),
    }, now),
  },
  {
    id: 'todos-to-tasks',
    name: 'To-dos to tasks',
    blurb: 'Collects new checkboxes and to-dos into one Tasks note (and a task app, if connected).',
    build: (now) => newRoutine({
      name: 'To-dos to tasks',
      template: 'todos-to-tasks',
      triggers: [{ kind: 'daily', time: '17:30' }],
      prompt: [
        'Collect my open to-dos into one place.',
        '1. Find notes edited since the last run that contain to-dos: checkboxes ("- [ ]", ☐), "TODO", "to do", "need to" (search_notes, then read_note).',
        '2. Use the extract-todos skill to turn them into short imperative tasks with due dates where given.',
        '3. Add the ones not already listed to my note titled "Tasks" (append_to_note; create it if it doesn\'t exist), each as "- [ ] task (from [Note title])".',
        '4. If a connected task app (for example Notion, Linear or Todoist) is available to this routine, also create the new tasks there. Ask before creating them.',
        'Reply with how many tasks you added and where.',
      ].join('\n'),
    }, now),
  },
  {
    id: 'exam-flashcards',
    name: 'Flashcards before exams',
    blurb: 'Three days before an exam date written in a note, makes flashcards from that subject.',
    build: (now) => newRoutine({
      name: 'Flashcards before exams',
      template: 'exam-flashcards',
      triggers: [{ kind: 'before-date', days: 3, keyword: 'exam' }],
      prompt: [
        'An exam is coming up (see why this run started).',
        '1. Work out the subject from the note that mentions the exam, then search_notes for my notes on that subject (titles, tags and notebook).',
        '2. Use the make-flashcards skill: make up to 20 cards covering the most important material.',
        '3. Save them as one note titled "Flashcards — <subject>" tagged flashcards (append only new cards if it exists).',
        'Reply with the subject, the exam date and how many cards you made.',
      ].join('\n'),
    }, now),
  },
  {
    id: 'email-draft',
    name: 'Draft the email I scribbled',
    blurb: 'Turns handwriting tagged #email into a typed email draft; sends only through a connected app, with your approval.',
    build: (now) => newRoutine({
      name: 'Draft the email I scribbled',
      template: 'email-draft',
      triggers: [{ kind: 'note-saved', tag: 'email' }],
      prompt: [
        'I wrote an email by hand. Turn it into a clean draft.',
        '1. Read the note that started this run (or search for notes tagged email). Read the handwriting with get_page_image if it is not recognized yet.',
        '2. Write the email: recipient (if written), a subject line, and the body in my words — fix spelling and structure, don\'t add content.',
        '3. Create a note titled "Email draft — <subject>" with "To:", "Subject:" and the body, tagged email-draft.',
        '4. Only if a connected email app is available to this routine: offer to send it with that app\'s tool. Sending always waits for my approval. Never send without it.',
        'Reply with the subject and where the draft is.',
      ].join('\n'),
    }, now),
  },
  {
    id: 'compile-wiki',
    name: 'Compile my wiki',
    blurb: 'Every night, re-compiles the pages whose sources changed; you review the changes in Compiled wiki.',
    build: (now) => newRoutine({
      name: 'Compile my wiki',
      template: 'compile-wiki',
      triggers: [{ kind: 'daily', time: '02:40' }],
      tools: { notes: 'read', skills: false, mcpServers: [] },
      prompt: [
        'Keep my compiled wiki up to date.',
        '1. Call compile_wiki with reason "Nightly". It only drafts changes; I review them.',
        '2. Call list_conflicts and mention any new disagreement between my notes in one line each.',
        'If compile_wiki is not available here, say that the compiled wiki is compiled in the app and stop.',
        'Reply with what changed (pages proposed, conflicts) in two or three lines.',
      ].join('\n'),
    }, now),
  },
  {
    id: 'meeting-followups',
    name: 'Follow-ups from today\'s meetings',
    blurb: 'Every evening, collects action items and follow-ups from today\'s meeting notes into one note.',
    build: (now) => newRoutine({
      name: 'Follow-ups from today\'s meetings',
      template: 'meeting-followups',
      triggers: [{ kind: 'daily', time: '17:40' }, { kind: 'recording-ended' }],
      prompt: [
        'Collect the follow-ups from my meetings today.',
        '1. Call list_followups (since the start of today). If it is not available, search_notes for today\'s meeting notes and read them.',
        '2. Keep open items only. Group them by person; write each as "- [ ] <task> (<person or owner>, due <date> if given) — from [Note title](link)".',
        '3. Append them to my note titled "Follow-ups" (create it if it doesn\'t exist) under a heading with today\'s date. Skip items already listed there.',
        'Reply with how many follow-ups you added and for whom.',
      ].join('\n'),
    }, now),
  },
  {
    // The journal that writes itself (docs/MEMORY_TIMELINE.md § Journal). Its tools come from the
    // journal module, which runs in the app (the desktop app keeps it running from the tray).
    id: 'daily-journal',
    name: 'Journal that writes itself',
    blurb: 'Every evening, drafts the day\'s journal from your notes, recordings, calendar and memory timeline, with sources; you correct it with the pen.',
    build: (now) => newRoutine({
      name: 'Journal that writes itself',
      template: 'daily-journal',
      triggers: [{ kind: 'daily', time: '21:30' }],
      tools: { notes: 'read', skills: false, mcpServers: [] },
      prompt: [
        'Draft my journal entry for today.',
        '1. Call journal_sources (no date: today). If it says nothing happened today, reply that and stop.',
        '2. Follow the instructions it returns, then call write_journal_draft once.',
        'If journal_sources is not available here, say that the journal is drafted by the Inkwright app and stop.',
      ].join('\n'),
    }, now),
  },
];

/** Context the agent gets about why and when a routine is running. */
export function routineRunContext(r: Routine, ev: TriggerEvent, now: number): string {
  const lines = [
    `You are running the user's routine "${r.name}" in the background. The user is not watching: do the work, then reply with a short summary of what you did. Don't ask questions; if something is unclear, skip it and say so.`,
    `Why this run started: ${ev.reason}.`,
    `Now: ${new Date(now).toISOString().slice(0, 16).replace('T', ' ')} UTC.`,
    r.state.lastRunAt ? `Last run: ${new Date(r.state.lastRunAt).toISOString().slice(0, 16).replace('T', ' ')} UTC ("since the last run" means after this).` : 'This is the first run.',
  ];
  if (ev.noteId) lines.push(`The note involved: "${ev.noteTitle ?? ''}" (id ${ev.noteId}).`);
  if (r.tools.notes === 'read') lines.push('This routine may only read notes, not change them.');
  return lines.join('\n');
}
