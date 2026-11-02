import { describe, expect, it } from 'vitest';
import { MemoryFS } from '@inkstone/core';
import {
  ROUTINE_TEMPLATES,
  RoutineScheduler,
  RoutineStore,
  daysUntil,
  describeTrigger,
  dueDateEvents,
  dueTimeTriggers,
  findDateMentions,
  latestSlot,
  newRoutine,
  nextSlot,
  routineRunContext,
  validateRoutine,
  type Routine,
  type TriggerEvent,
} from '../src/index.ts';

/** Local-time timestamps, so tests pass in any time zone. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

/** A controllable clock and timer queue. */
function fakeTime(start: number) {
  let now = start;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  let seq = 0;
  return {
    clock: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimer: (id: unknown) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    /** Advances time, firing due timers in order. */
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        t.fn();
        await new Promise((r) => setTimeout(r, 0));
        await new Promise((r) => setTimeout(r, 0));
      }
      now = end;
    },
    set(t: number) { now = t; },
  };
}

describe('time triggers', () => {
  it('finds the latest and next slot for daily and weekly triggers', () => {
    const now = at(2026, 11, 4, 9, 30); // Wednesday
    expect(latestSlot({ kind: 'daily', time: '08:00' }, now)).toBe(at(2026, 11, 4, 8, 0));
    expect(latestSlot({ kind: 'daily', time: '18:00' }, now)).toBe(at(2026, 11, 3, 18, 0));
    expect(nextSlot({ kind: 'daily', time: '18:00' }, now)).toBe(at(2026, 11, 4, 18, 0));
    expect(latestSlot({ kind: 'weekly', day: 1, time: '07:15' }, now)).toBe(at(2026, 11, 2, 7, 15)); // Monday
    expect(latestSlot({ kind: 'weekly', day: 3, time: '10:00' }, now)).toBe(at(2026, 10, 28, 10, 0)); // last Wednesday
    expect(latestSlot({ kind: 'note-saved', tag: 'x' }, now)).toBeNull();
  });

  it('a slot runs once; a new routine skips slots before it was made', () => {
    const r = newRoutine({ name: 'r', prompt: 'do the thing please', triggers: [{ kind: 'daily', time: '18:00' }] }, at(2026, 11, 4, 18, 30));
    expect(dueTimeTriggers(r, at(2026, 11, 4, 19, 0))).toEqual([]);
    const ev = dueTimeTriggers(r, at(2026, 11, 5, 18, 0, ));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.catchUp).toBe(false);
    r.state.slots = { '0': ev[0]!.slot! };
    expect(dueTimeTriggers(r, at(2026, 11, 5, 23, 0))).toEqual([]);
  });

  it('several missed days collapse into one catch-up run', () => {
    const r = newRoutine({ name: 'r', prompt: 'do the thing please', triggers: [{ kind: 'daily', time: '18:00' }, { kind: 'weekly', day: 5, time: '09:00' }] }, at(2026, 11, 1, 8));
    const ev = dueTimeTriggers(r, at(2026, 11, 9, 7, 0));
    expect(ev).toHaveLength(1);
    expect(ev[0]!.catchUp).toBe(true);
    expect(ev[0]!.reason).toMatch(/missed while Inkstone was closed/);
    expect(ev[0]!.slots).toEqual([{ triggerIndex: 0, slot: at(2026, 11, 8, 18) }, { triggerIndex: 1, slot: at(2026, 11, 6, 9) }]);
    expect(dueTimeTriggers({ ...r, enabled: false }, at(2026, 11, 9, 7, 0))).toEqual([]);
  });
});

describe('dates written in notes', () => {
  const now = at(2026, 11, 20, 10);
  it('reads common formats on lines with the keyword', () => {
    const text = 'Physics notes\nExam: 3 Dec\nexam retake on December 15th, 2026\nEE EXAM 2026-12-10\nParty on 4 Dec\nexam 12/11 and 1/2/2027';
    expect(findDateMentions(text, 'exam', now).map((m) => m.date)).toEqual(['2026-12-03', '2026-12-15', '2026-12-10', '2026-12-11', '2027-01-02']);
    expect(findDateMentions('exam 12/11', 'exam', now, { dayFirst: true }).map((m) => m.date)).toEqual(['2026-11-12']);
    expect(findDateMentions('Exam: Dec 3', 'exam', now)[0]!.date).toBe('2026-12-03');
    expect(findDateMentions('Exam: 30 Feb', 'exam', now)).toEqual([]);
    // A month long past means next year.
    expect(findDateMentions('exam 3 March', 'exam', now)[0]!.date).toBe('2027-03-03');
  });

  it('fires N days before, once per note and date, not after the date', () => {
    const r = newRoutine({ name: 'cards', prompt: 'make flashcards please', triggers: [{ kind: 'before-date', days: 3, keyword: 'exam' }] }, at(2026, 11, 1));
    const notes = [{ noteId: 'n1', title: 'Physics', mentions: [{ date: '2026-11-23', line: 'Exam: 23 Nov' }, { date: '2026-12-20', line: 'exam 20 Dec' }] }, { noteId: 'n2', title: 'Old', mentions: [{ date: '2026-11-19', line: 'exam 19 Nov' }] }];
    const ev = dueDateEvents(r, notes, now);
    expect(ev.map((e) => [e.noteId, e.date, e.daysUntil])).toEqual([['n1', '2026-11-23', 3]]);
    expect(ev[0]!.reason).toContain('in 3 days');
    r.state.firedDates = ['n1@2026-11-23'];
    expect(dueDateEvents(r, notes, now)).toEqual([]);
    expect(daysUntil('2026-11-20', now)).toBe(0);
  });
});

describe('routine scheduler', () => {
  async function setup(start: number, routines: Routine[], opts: { findDatedNotes?: (kw: string) => Promise<any[]> } = {}) {
    const time = fakeTime(start);
    const store = new RoutineStore(new MemoryFS());
    for (const r of routines) await store.save(r);
    const runs: Array<{ id: string; ev: TriggerEvent; at: number }> = [];
    const sched = new RoutineScheduler({
      store,
      clock: time.clock,
      setTimer: time.setTimer,
      clearTimer: time.clearTimer,
      run: async (r, ev) => { runs.push({ id: r.id, ev, at: time.clock() }); return r.name === 'fails' ? { status: 'error', error: 'model offline' } : { status: 'done' }; },
      findDatedNotes: opts.findDatedNotes,
      tickMs: 10 * 60_000,
    });
    return { time, store, runs, sched };
  }

  it('catches up once on open, then runs at the next slot while open', async () => {
    const r = newRoutine({ name: 'File my notes', prompt: 'file my notes please', triggers: [{ kind: 'daily', time: '18:00' }] }, at(2026, 11, 1, 9));
    // The app opens three days later at 08:00: one catch-up run.
    const { time, runs, sched, store } = await setup(at(2026, 11, 4, 8), [r]);
    await sched.start();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ev.catchUp).toBe(true);
    expect((await store.get(r.id))!.state.lastRunAt).toBe(at(2026, 11, 4, 8));
    // Nothing more until 18:00, then one run.
    await time.advance(9 * 3600_000);
    expect(runs).toHaveLength(1);
    await time.advance(1 * 3600_000 + 60_000);
    expect(runs).toHaveLength(2);
    expect(runs[1]!.ev.catchUp).toBe(false);
    // Reopening the app the same evening doesn't repeat it.
    sched.stop();
    const again = new RoutineScheduler({ store, clock: time.clock, setTimer: time.setTimer, clearTimer: time.clearTimer, run: async (x, ev) => { runs.push({ id: x.id, ev, at: time.clock() }); return { status: 'done' }; } });
    await again.start();
    expect(runs).toHaveLength(2);
    again.stop();
  });

  it('records failures in the routine state', async () => {
    const r = newRoutine({ name: 'fails', prompt: 'this one always fails', triggers: [] }, at(2026, 11, 1));
    const { sched, store } = await setup(at(2026, 11, 2), [r]);
    await sched.runNow(r.id);
    expect((await store.get(r.id))!.state).toMatchObject({ lastStatus: 'error', lastError: 'model offline' });
  });

  it('manual runs work even when the routine is off; disabled routines never run on schedule', async () => {
    const r = newRoutine({ name: 'off', prompt: 'only when I ask', enabled: false, triggers: [{ kind: 'daily', time: '00:01' }] }, at(2026, 11, 1));
    const { sched, runs } = await setup(at(2026, 11, 3), [r]);
    await sched.start();
    expect(runs).toHaveLength(0);
    await sched.runNow(r.id);
    expect(runs.map((x) => x.ev.kind)).toEqual(['manual']);
    sched.stop();
  });

  it('note saved with a tag: debounced, matched case-insensitively', async () => {
    const r = newRoutine({ name: 'email', prompt: 'draft my email please', triggers: [{ kind: 'note-saved', tag: '#Email' }] }, at(2026, 11, 1));
    const other = newRoutine({ name: 'other', prompt: 'other routine here', triggers: [{ kind: 'note-saved', tag: 'exam' }] }, at(2026, 11, 1));
    const { sched, runs, time } = await setup(at(2026, 11, 2, 10), [r, other]);
    sched.noteSaved({ id: 'n1', title: 'To Sam', tags: ['email'] });
    await time.advance(5_000);
    sched.noteSaved({ id: 'n1', title: 'To Sam', tags: ['email'] }); // still writing
    await time.advance(10_000);
    expect(runs).toHaveLength(0);
    await time.advance(25_000);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ev).toMatchObject({ kind: 'note-saved', noteId: 'n1', reason: 'Saved “To Sam” (#email)' });
    sched.noteSaved({ id: 'n2', title: 'Untagged', tags: [] });
    await time.advance(60_000);
    expect(runs).toHaveLength(1);
    sched.stop();
  });

  it('recording ended', async () => {
    const r = newRoutine({ name: 'rec', prompt: 'summarize the lecture', triggers: [{ kind: 'recording-ended' }] }, at(2026, 11, 1));
    const { sched, runs } = await setup(at(2026, 11, 2), [r]);
    await sched.recordingEnded({ id: 'n9', title: 'Lecture' });
    expect(runs[0]!.ev).toMatchObject({ kind: 'recording-ended', noteId: 'n9' });
  });

  it('days before a date written in a note, once per date', async () => {
    const r = newRoutine({ name: 'cards', prompt: 'flashcards before exams', triggers: [{ kind: 'before-date', days: 2, keyword: 'exam' }] }, at(2026, 11, 1));
    const asked: string[] = [];
    const notes = [{ noteId: 'n1', title: 'Physics', mentions: [{ date: '2026-11-12', line: 'Exam 12 Nov' }] }];
    const { sched, runs, time } = await setup(at(2026, 11, 9, 9), [r], { findDatedNotes: async (kw) => { asked.push(kw); return notes; } });
    await sched.start();
    expect(runs).toHaveLength(0);
    await time.advance(24 * 3600_000);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.ev).toMatchObject({ kind: 'before-date', date: '2026-11-12', daysUntil: 2 });
    await time.advance(24 * 3600_000);
    expect(runs).toHaveLength(1);
    expect(asked[0]).toBe('exam');
    sched.stop();
  });

  it('runs one routine at a time, in order', async () => {
    const a = newRoutine({ name: 'a', prompt: 'first routine to run', triggers: [] }, 0);
    const b = newRoutine({ name: 'b', prompt: 'second routine to run', triggers: [] }, 0);
    const { sched, runs } = await setup(at(2026, 11, 2), [a, b]);
    await Promise.all([sched.runNow(a.id), sched.runNow(b.id)]);
    expect(runs.map((x) => x.id)).toEqual([a.id, b.id]);
  });
});

describe('templates and validation', () => {
  it('ships four templates that validate', () => {
    expect(ROUTINE_TEMPLATES.map((t) => t.name)).toEqual(['File my notes', 'To-dos to tasks', 'Flashcards before exams', 'Draft the email I scribbled']);
    for (const t of ROUTINE_TEMPLATES) expect(validateRoutine(t.build(0))).toEqual([]);
    expect(validateRoutine({ name: '', prompt: 'short', triggers: [{ kind: 'daily', time: '25:00' }] })).toHaveLength(3);
  });

  it('describes triggers and gives the agent context', () => {
    expect(describeTrigger({ kind: 'weekly', day: 1, time: '08:00' })).toBe('Every Monday at 08:00');
    expect(describeTrigger({ kind: 'before-date', days: 3, keyword: 'exam' })).toBe('3 days before a “exam” date in a note');
    const r = ROUTINE_TEMPLATES[0]!.build(0);
    const ctx = routineRunContext(r, { kind: 'manual', reason: 'Run by you' }, at(2026, 11, 2));
    expect(ctx).toContain('Why this run started: Run by you.');
    expect(ctx).toContain('first run');
  });
});
