import { describe, expect, it } from 'vitest';
import { MemoryFS, Vault, newNote, newPage } from '@inkstone/core';
import {
  ROUTINE_LEASE_PATH,
  RoutineLeaseHolder,
  RoutineScheduler,
  RoutineStore,
  VaultUndoTarget,
  newRoutine,
  readRoutineLease,
  routineLeaseHeldByOther,
  undoOp,
  type ActivityOp,
} from '../src/index.ts';

const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

describe('routines lease', () => {
  it('one holder at a time; renewals keep it; expiry hands it over', async () => {
    const fs = new MemoryFS();
    let now = at(2026, 11, 1, 9);
    const clock = () => now;
    const a = new RoutineLeaseHolder(fs, { holder: 'runner:a', label: 'Inkstone agent on A', clock, ttlMs: 600_000 });
    const b = new RoutineLeaseHolder(fs, { holder: 'runner:b', label: 'Inkstone agent on B', clock, ttlMs: 600_000 });
    expect(await a.acquire()).toBe(true);
    expect(await b.acquire()).toBe(false);
    expect(b.held).toBe(false);
    now += 300_000;
    expect(await a.acquire()).toBe(true); // renew
    const lease = await readRoutineLease(fs);
    expect(lease).toMatchObject({ holder: 'runner:a', kind: 'runner', acquiredAt: at(2026, 11, 1, 9), renewedAt: now, expiresAt: now + 600_000 });
    // The app sees a live lease held by someone else.
    expect((await routineLeaseHeldByOther(fs, now))?.label).toBe('Inkstone agent on A');
    expect(await routineLeaseHeldByOther(fs, now, 'runner:a')).toBeNull();
    // A stops renewing (computer asleep): after expiry B takes over.
    now += 600_001;
    expect(await routineLeaseHeldByOther(fs, now)).toBeNull();
    expect(await b.acquire()).toBe(true);
    expect(await a.acquire()).toBe(false);
    // Release on shutdown removes the file so the app takes over at once.
    await b.release();
    expect(await fs.readText(ROUTINE_LEASE_PATH)).toBeNull();
  });

  it('a corrupt (half-synced) lease file counts as no lease', async () => {
    const fs = new MemoryFS();
    await fs.writeText(ROUTINE_LEASE_PATH, '{"holder": "runner:x", "expi');
    expect(await routineLeaseHeldByOther(fs, Date.now())).toBeNull();
    const h = new RoutineLeaseHolder(fs, { holder: 'runner:y', label: 'y' });
    expect(await h.acquire()).toBe(true);
  });

  it('the scheduler defers automatic triggers to the lease holder but still runs "Run now"', async () => {
    const fs = new MemoryFS();
    const store = new RoutineStore(fs);
    const r = newRoutine({ name: 'Daily', prompt: 'do the daily thing', triggers: [{ kind: 'daily', time: '08:00' }, { kind: 'note-saved', tag: 'email' }] }, at(2026, 11, 1));
    await store.save(r);
    let now = at(2026, 11, 3, 9);
    const timers: Array<() => void> = [];
    const runs: string[] = [];
    let deferred = true;
    const sched = new RoutineScheduler({
      store,
      clock: () => now,
      setTimer: (fn) => { timers.push(fn); return timers.length; },
      clearTimer: () => {},
      saveDebounceMs: 0,
      run: async (_x, ev) => { runs.push(ev.kind); return { status: 'done' }; },
      deferAutomatic: () => deferred,
    });
    await sched.start();
    expect(runs).toEqual([]);
    expect((await store.get(r.id))!.state.slots).toBeUndefined(); // slot left for the holder to run
    sched.noteSaved({ id: 'n1', title: 'To Sam', tags: ['email'] });
    timers.at(-1)!();
    await new Promise((res) => setTimeout(res, 0));
    await sched.recordingEnded({ id: 'n1', title: 'x' });
    expect(runs).toEqual([]);
    await sched.runNow(r.id);
    expect(runs).toEqual(['manual']);
    // The holder's lease lapses: the app catches up itself.
    deferred = false;
    now += 60_000;
    await sched.tick();
    expect(runs).toEqual(['manual', 'daily']);
    sched.stop();
  });
});

describe('undo of recognized handwriting', () => {
  async function setup() {
    const fs = new MemoryFS();
    const vault = new Vault(fs);
    await vault.init();
    const page = { ...newPage('P1'), recognizedText: 'Call Maria', recognizedAt: 1, recognizedBy: 'agent' };
    const note = newNote({ id: 'N1', title: 'Calls', pageId: 'P1', now: 1 });
    await vault.saveNote(note, [page]);
    const op: ActivityOp = { id: 'o1', at: 1, tool: 'transcribe_pages', summary: 'Recognized handwriting', kind: 'handwriting_recognized', noteId: 'N1', title: 'Calls', pageId: 'P1', text: 'Call Maria' };
    return { vault, op, target: new VaultUndoTarget(vault) };
  }

  it('clears the text the agent wrote', async () => {
    const { vault, op, target } = await setup();
    expect(await undoOp(op, target)).toEqual({ ok: true });
    expect((await vault.readPage('N1', 'P1')).recognizedText).toBeUndefined();
  });

  it('keeps a later correction by the user', async () => {
    const { vault, op, target } = await setup();
    const n = (await vault.readNote('N1'))!;
    await vault.saveNote(n, [{ ...(await vault.readPage('N1', 'P1')), recognizedText: 'Call Maria at 5' }]);
    const r = await undoOp(op, target);
    expect(r.ok).toBe(false);
    expect((await vault.readPage('N1', 'P1')).recognizedText).toBe('Call Maria at 5');
  });

  it('says so when the host cannot undo it', async () => {
    const { op, target } = await setup();
    const { clearRecognizedText: _c, ...older } = Object.assign(Object.create(Object.getPrototypeOf(target)), target);
    const r = await undoOp(op, { ...older, clearRecognizedText: undefined } as never);
    expect(r).toEqual({ ok: false, message: 'Update Inkstone to undo this.' });
  });
});
