import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityStore, ROUTINE_LEASE_PATH, RoutineStore, createScriptedProvider, newRoutine, readRoutineLease, routineLeaseHeldByOther, type ScriptStep } from '@inkwright/ai';
import type { AgentAI } from '../src/agent/ai.ts';
import { ApprovalStore } from '../src/approvals.ts';
import type { ServerContext } from '../src/context.ts';
import { RoutineRunner } from '../src/runner/runner.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

/** A controllable clock and timer queue (real I/O still happens between timers). */
function fakeTime(start: number) {
  let now = start;
  let seq = 0;
  const timers: Array<{ at: number; fn: () => void; id: number }> = [];
  return {
    clock: () => now,
    setTimer: (fn: () => void, ms: number) => { const id = ++seq; timers.push({ at: now + ms, fn, id }); return id; },
    clearTimer: (id: unknown) => { const i = timers.findIndex((t) => t.id === id); if (i >= 0) timers.splice(i, 1); },
    /** Timers set so far (a fired timer that re-arms itself raises it). */
    get armed() { return seq; },
    async advance(ms: number, settle: (armedBefore: number) => Promise<void>) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        const t = timers[0];
        if (!t || t.at > end) break;
        timers.shift();
        now = t.at;
        const before = seq;
        t.fn();
        await settle(before);
      }
      now = end;
    },
  };
}

let fx: Fixture;
let ctx: ServerContext;
const runners: RoutineRunner[] = [];

function scripted(script: ScriptStep[] | ((c: never) => never)): AgentAI {
  return { provider: createScriptedProvider(script as never), model: 'scripted', label: 'Scripted', vision: true };
}

// Coarse ticks keep fake-time tests fast; the lease outlives a tick as it does in production (60 s tick, 10 min lease).
function runner(time: ReturnType<typeof fakeTime>, ai: AgentAI | null, holder: string, scanMs = 60 * 60_000) {
  clockFor = time;
  const r = new RoutineRunner({ ctx, ai, holder, label: `Runner ${holder}`, clock: time.clock, setTimer: time.setTimer, clearTimer: time.clearTimer, tickMs: 5 * 60_000, scanMs, saveDebounceMs: 20_000, leaseTtlMs: 12 * 60_000, watch: false, log: (m) => process.env.DEBUG_RUNNER && console.error(holder, new Date(time.clock()).toTimeString().slice(0, 8), m) });
  runners.push(r);
  return r;
}

/** Waits (real time) for a fired timer's file I/O: until nothing is running or queued and the runner
 *  has armed its next timer. A tick reads routines from disk before it re-arms; moving the clock on
 *  before that (a busy machine) would skip the next slot. Timers that don't re-arm wait out the cap. */
let clockFor: ReturnType<typeof fakeTime> | null = null;
const idle = (r: RoutineRunner) => async (armedBefore?: number) => {
  await new Promise((res) => setTimeout(res, 25));
  for (let i = 0; i < 400; i++) {
    const rearmed = armedBefore === undefined || !clockFor || clockFor.armed > armedBefore;
    if (!r.scheduler.runningId && !r.scheduler.queued.length && rearmed) return;
    await new Promise((res) => setTimeout(res, 5));
  }
};

/** Polls the activity log until it has n runs (a run's log entry is written just after it ends). */
async function runsWhen(n: number, store: ActivityStore) {
  let runs = await store.list();
  for (let i = 0; i < 100 && runs.length < n; i++) { await new Promise((res) => setTimeout(res, 20)); runs = await store.list(); }
  return runs;
}

beforeEach(async () => {
  fx = await makeFixture();
  ctx = await fx.ctx();
});
afterEach(async () => {
  for (const r of runners.splice(0)) await r.stop();
  await fx.cleanup();
});

// Fake time with real file I/O between timers: hours of ticks take a few real seconds.
describe('always-on runner', { timeout: 30_000 }, () => {
  it('catches up once, then runs at the next slot; runs are logged like the app’s', async () => {
    const store = new RoutineStore(ctx.fs);
    const routine = newRoutine({ name: 'Evening tidy', prompt: 'Append a line to my launch plan please.', triggers: [{ kind: 'daily', time: '18:00' }] }, at(2026, 11, 1, 9));
    await store.save(routine);
    const time = fakeTime(at(2026, 11, 4, 8));
    const ai = scripted(Array.from({ length: 4 }, (_, i) => (i % 2 === 0 ? { toolCalls: [{ name: 'append_to_note', arguments: { note_id: 'LAUNCH', text: `Checked ${i}` } }] } : { text: 'Added a line.' })));
    const r = runner(time, ai, 'runner:a');
    await r.start();
    await idle(r)();
    expect((await store.get(routine.id))!.state).toMatchObject({ lastStatus: 'done', lastRunAt: at(2026, 11, 4, 8) });
    const lease = await readRoutineLease(ctx.fs);
    expect(lease).toMatchObject({ holder: 'runner:a', label: 'Runner runner:a', kind: 'runner' });
    // The app now defers to it.
    expect(await routineLeaseHeldByOther(ctx.fs, time.clock())).not.toBeNull();
    let runs = await runsWhen(1, new ActivityStore(ctx.fs));
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: 'routine', label: 'Evening tidy', routineId: routine.id, status: 'done', reply: 'Added a line.' });
    expect(runs[0]!.prompt).toMatch(/missed while Inkwright was closed/);
    expect(runs[0]!.ops[0]).toMatchObject({ kind: 'text_appended', noteId: 'LAUNCH' });
    // Nothing more until 18:00, then exactly one run.
    await time.advance(9 * 3600_000, idle(r));
    expect(await new ActivityStore(ctx.fs).list()).toHaveLength(1);
    await time.advance(3600_000 + 60_000, idle(r));
    runs = await runsWhen(2, new ActivityStore(ctx.fs));
    expect(runs).toHaveLength(2);
    expect(runs[0]!.prompt).toBe('Daily at 18:00');
    // Its own append didn't count as "the user saved a note".
    await r.scan();
    await time.advance(60_000, idle(r));
    expect(await new ActivityStore(ctx.fs).list()).toHaveLength(2);
  });

  it('a second runner stands by while the first holds the lease, and takes over when it stops', async () => {
    const store = new RoutineStore(ctx.fs);
    const routine = newRoutine({ name: 'Morning', prompt: 'Say good morning to me.', triggers: [{ kind: 'daily', time: '07:00' }] }, at(2026, 11, 4, 6));
    await store.save(routine);
    const time = fakeTime(at(2026, 11, 4, 6, 50));
    const a = runner(time, scripted([{ text: 'Morning from A' }]), 'runner:a');
    const b = runner(time, scripted([{ text: 'Morning from B' }]), 'runner:b');
    await a.start();
    await b.start();
    expect(a.holdsLease).toBe(true);
    expect(b.holdsLease).toBe(false);
    await a.stop(); // releases the lease
    expect(await ctx.fs.readText(ROUTINE_LEASE_PATH)).toBeNull();
    await time.advance(15 * 60_000, idle(b));
    expect(b.holdsLease).toBe(true);
    const runs = await runsWhen(1, new ActivityStore(ctx.fs));
    expect(runs.map((x) => x.reply)).toEqual(['Morning from B']);
  });

  it('a lapsed lease (runner asleep) is taken over after it expires, without repeating the slot', async () => {
    const store = new RoutineStore(ctx.fs);
    const routine = newRoutine({ name: 'Hourly-ish', prompt: 'Do the daily thing now.', triggers: [{ kind: 'daily', time: '09:00' }] }, at(2026, 11, 1));
    await store.save(routine);
    const time = fakeTime(at(2026, 11, 4, 9, 1));
    const a = runner(time, scripted([{ text: 'A ran' }]), 'runner:a');
    await a.start();
    await idle(a)();
    a.scheduler.stop(); // "asleep": stops renewing without releasing
    const b = runner(time, scripted([{ text: 'B ran' }]), 'runner:b');
    await b.start();
    expect(b.holdsLease).toBe(false);
    await time.advance(15 * 60_000, idle(b));
    expect(b.holdsLease).toBe(true);
    const runs = await runsWhen(1, new ActivityStore(ctx.fs));
    expect(runs.map((x) => x.reply)).toEqual(['A ran']); // 09:00 already ran on A; B doesn't repeat it
  });

  it('a note saved with the routine’s tag triggers it (debounced)', async () => {
    const store = new RoutineStore(ctx.fs);
    const routine = newRoutine({ name: 'Email draft', prompt: 'Draft the email I wrote.', triggers: [{ kind: 'note-saved', tag: 'email' }] }, at(2026, 11, 1));
    await store.save(routine);
    const time = fakeTime(at(2026, 11, 4, 10));
    const r = runner(time, scripted([{ text: 'Drafted.' }]), 'runner:a', 15_000);
    await r.start();
    // The user saves a note on another device; sync brings it into the folder.
    const n = (await fx.external.readNote('GROCERIES'))!;
    await fx.external.saveNote({ ...n, tags: ['email'], updatedAt: n.updatedAt + 60_000 }, await fx.external.readPages(n));
    await time.advance(15_000, idle(r)); // scan
    expect(await new ActivityStore(ctx.fs).list()).toHaveLength(0); // still debouncing
    await time.advance(25_000, idle(r));
    const runs = await runsWhen(1, new ActivityStore(ctx.fs));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.prompt).toBe('Saved “Grocery list” (#email)');
  });

  it('trashing is never done unattended: it becomes a pending approval', async () => {
    const store = new RoutineStore(ctx.fs);
    await store.save(newRoutine({ name: 'Clean up', prompt: 'Trash old reading notes.' }, at(2026, 11, 1)));
    const time = fakeTime(at(2026, 11, 4, 10));
    const r = runner(time, scripted([{ toolCalls: [{ name: 'trash_note', arguments: { note_id: 'OLDNOTE' } }] }, { text: 'Asked for your OK.' }]), 'runner:a');
    await r.start();
    await r.scheduler.runNow((await store.list())[0]!.id);
    ctx.vault.invalidate();
    expect((await ctx.vault.readNote('OLDNOTE'))!.trashedAt).toBeUndefined();
    const pending = await new ApprovalStore(ctx.fs).list();
    expect(pending).toEqual([expect.objectContaining({ tool: 'trash_note', args: { note_id: 'OLDNOTE' }, title: 'Move “Reading notes” to Trash', source: 'Clean up', status: 'pending' })]);
  });

  it('without an AI, runs are logged as failed with a way to fix it', async () => {
    const store = new RoutineStore(ctx.fs);
    await store.save(newRoutine({ name: 'No AI', prompt: 'Do something useful.' }, at(2026, 11, 1)));
    const r = runner(fakeTime(at(2026, 11, 4)), null, 'runner:a');
    await r.start();
    await r.scheduler.runNow((await store.list())[0]!.id);
    const [run] = await runsWhen(1, new ActivityStore(ctx.fs));
    expect(run).toMatchObject({ source: 'routine', status: 'error' });
    expect(run!.error).toMatch(/--ai-provider/);
  });
});
