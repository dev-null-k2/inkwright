import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SyncSafetyError, SyncScheduler, type SyncSchedulerOptions, type SyncSchedulerStatus } from '../src/index.ts';

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SyncScheduler', () => {
  beforeEach(() => vi.useFakeTimers({ now: Date.UTC(2026, 10, 1) }));
  afterEach(() => vi.useRealTimers());

  function make(opts: Partial<SyncSchedulerOptions> = {}) {
    const run = vi.fn(async (_signal: AbortSignal) => {});
    const statuses: SyncSchedulerStatus[] = [];
    const s = new SyncScheduler({ run, onStatus: (x) => statuses.push(x), pollIntervalMs: 0, ...opts });
    return { s, run: (opts.run as typeof run) ?? run, statuses };
  }

  it('syncs once on start', async () => {
    const { s, run, statuses } = make();
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(statuses).toEqual(['idle', 'syncing', 'idle']);
    s.stop();
    expect(s.status).toBe('stopped');
  });

  it('debounces local changes (4 s of quiet)', async () => {
    const { s, run } = make();
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    run.mockClear();
    for (let i = 0; i < 5; i++) {
      s.notifyLocalChange();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3000);
    expect(run).toHaveBeenCalledTimes(1);
    s.stop();
  });

  it('caps the debounce so continuous writing still syncs every maxDelayMs', async () => {
    const { s, run } = make({ maxDelayMs: 10_000 });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    run.mockClear();
    for (let i = 0; i < 25; i++) {
      s.notifyLocalChange();
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(run).toHaveBeenCalledTimes(2); // at ~10 s and ~20 s
    s.stop();
  });

  it('polls periodically for remote changes', async () => {
    const { s, run } = make({ pollIntervalMs: 60_000 });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenCalledTimes(4);
    s.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('waits while offline and syncs as soon as connectivity returns', async () => {
    let online = false;
    let notify: (o: boolean) => void = () => {};
    const { s, run, statuses } = make({
      isOnline: () => online,
      subscribeOnline: (cb) => {
        notify = cb;
        return () => (notify = () => {});
      },
    });
    s.start();
    s.notifyLocalChange();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).not.toHaveBeenCalled();
    expect(s.status).toBe('offline');
    online = true;
    notify(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    expect(statuses).toContain('offline');
    expect(s.status).toBe('idle');
    s.stop();
  });

  it('backs off exponentially after errors and resets after a success', async () => {
    let fail = 3;
    const errors: (number | null)[] = [];
    const run = vi.fn(async () => {
      if (fail-- > 0) throw new Error('network');
    });
    const { s } = make({ run, backoff: { initialMs: 1000, factor: 2, maxMs: 60_000 }, onError: (_e, retry) => errors.push(retry) });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([1000]);
    expect(s.status).toBe('backoff');
    s.notifyLocalChange(); // ignored during backoff
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toEqual([1000, 2000]);
    await vi.advanceTimersByTimeAsync(2000);
    expect(errors).toEqual([1000, 2000, 4000]);
    expect(s.failureCount).toBe(3);
    await vi.advanceTimersByTimeAsync(4000);
    expect(run).toHaveBeenCalledTimes(4);
    expect(s.failureCount).toBe(0);
    expect(s.status).toBe('idle');
    s.stop();
  });

  it('pauses on safety errors until the user syncs manually', async () => {
    let calls = 0;
    const run = vi.fn(async () => {
      if (++calls === 1) throw new SyncSafetyError('remote-empty', 'empty', 10);
    });
    const errors: (number | null)[] = [];
    const { s } = make({ run, pollIntervalMs: 1000, onError: (_e, r) => errors.push(r) });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(errors).toEqual([null]);
    expect(s.status).toBe('paused');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(run).toHaveBeenCalledTimes(1);
    await s.syncNow();
    expect(run).toHaveBeenCalledTimes(2);
    expect(s.status).toBe('idle');
    s.stop();
  });

  it('never overlaps runs; triggers during a run cause exactly one follow-up', async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    const run = vi.fn(async () => {
      const d = deferred();
      gates.push(d);
      await d.promise;
    });
    const { s } = make({ run, debounceMs: 10 });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 3; i++) {
      s.notifyLocalChange();
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(run).toHaveBeenCalledTimes(1);
    gates[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    gates[1]!.resolve();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    s.stop();
  });

  it('syncNow waits for a run that starts after the call and reports its error', async () => {
    const gates: ReturnType<typeof deferred>[] = [];
    const run = vi.fn(async () => {
      const d = deferred();
      gates.push(d);
      await d.promise;
    });
    const { s } = make({ run });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    const now = s.syncNow();
    gates[0]!.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(run).toHaveBeenCalledTimes(2);
    gates[1]!.reject(new Error('server down'));
    await expect(now).rejects.toThrow('server down');
    s.stop();
  });

  it('stop() aborts the run in flight', async () => {
    let signal: AbortSignal | null = null;
    const run = vi.fn(
      (sig: AbortSignal) =>
        new Promise<void>((_res, rej) => {
          signal = sig;
          sig.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError')));
        }),
    );
    const errors: unknown[] = [];
    const { s } = make({ run, onError: (e) => errors.push(e) });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    s.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(signal!.aborted).toBe(true);
    expect(errors).toEqual([]);
    expect(s.status).toBe('stopped');
  });
});
