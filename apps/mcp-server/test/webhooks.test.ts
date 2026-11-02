import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RETRY_SCHEDULE_MS, WebhookService, signWebhook, verifyWebhook } from '../src/api/webhooks.ts';
import { VaultEvents } from '../src/api/events.ts';
import { makeFixture } from './fixtures.ts';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** A webhook service on a hand-driven clock with a scripted receiver. */
async function harness(statuses: (number | 'error')[]) {
  const stateDir = await mkdtemp(path.join(tmpdir(), 'inkstone-wh-'));
  dirs.push(stateDir);
  let now = 1_700_000_000_000;
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  const timers: { at: number; fn: () => void; cancelled: boolean }[] = [];
  const fetchFn = (async (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, body: String(init.body) });
    const s = statuses.shift() ?? 200;
    if (s === 'error') throw new Error('connect ECONNREFUSED');
    return new Response(null, { status: s });
  }) as typeof fetch;
  const svc = new WebhookService({
    stateDir,
    clock: () => now,
    fetch: fetchFn,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, cancelled: false };
      timers.push(t);
      return { cancel: () => void (t.cancelled = true) };
    },
  });
  await svc.init();
  /** Moves the clock and fires due timers. */
  const advance = async (ms: number) => {
    now += ms;
    for (const t of timers.filter((x) => !x.cancelled && x.at <= now)) {
      t.cancelled = true;
      t.fn();
    }
    await svc.pump();
  };
  return { svc, calls, advance, stateDir, now: () => now };
}

describe('Standard Webhooks signatures', () => {
  it('signs id.timestamp.body and verifies with tolerance', () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    // Test vector from the Standard Webhooks reference implementations.
    const sig = signWebhook(secret, 'msg_p5jXN8AQM9LWM0D4loKWxJek', 1614265330, '{"test": 2432232314}');
    expect(sig).toBe('v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=');
    const headers = { id: 'msg_p5jXN8AQM9LWM0D4loKWxJek', timestamp: '1614265330', signature: `v1,bogus ${sig}` };
    expect(verifyWebhook(secret, headers, '{"test": 2432232314}', 1614265330_000)).toBe(true);
    expect(verifyWebhook(secret, headers, '{"test": 2432232314}', (1614265330 + 301) * 1000)).toBe(false);
    expect(verifyWebhook(secret, { ...headers, signature: 'v1,AAAA' }, '{"test": 2432232314}', 1614265330_000)).toBe(false);
  });
});

describe('WebhookService', () => {
  it('retries on the documented schedule and then gives up', async () => {
    const h = await harness([500, 'error', 503, 500, 500, 500, 500, 500, 500]);
    const w = await h.svc.create({ url: 'https://hooks.example.com/x', events: ['note.created'] });
    const [id] = h.svc.emit('note.created', { id: 'N1' });
    await h.svc.pump();
    expect(h.calls).toHaveLength(1);
    for (let i = 1; i < RETRY_SCHEDULE_MS.length; i++) {
      await h.advance(RETRY_SCHEDULE_MS[i]! - 1);
      expect(h.calls).toHaveLength(i); // not yet
      await h.advance(1);
      expect(h.calls).toHaveLength(i + 1);
    }
    const log = h.svc.deliveries(w.id);
    expect(log).toEqual([expect.objectContaining({ id, status: 'failed', attempt: RETRY_SCHEDULE_MS.length, nextAttemptAt: null })]);
    // Every attempt carries the same message id and timestamp, re-signed.
    expect(new Set(h.calls.map((c) => c.headers['webhook-id'])).size).toBe(1);
    expect(verifyWebhook(w.secret, { id: h.calls[3]!.headers['webhook-id']!, timestamp: h.calls[3]!.headers['webhook-timestamp']!, signature: h.calls[3]!.headers['webhook-signature']! }, h.calls[3]!.body, h.now(), 1e9)).toBe(true);
  });

  it('stops after a success and only sends subscribed events', async () => {
    const h = await harness([500, 204]);
    const w = await h.svc.create({ url: 'https://hooks.example.com/x', events: ['recording.ended'] });
    expect(h.svc.emit('note.created', {})).toEqual([]);
    h.svc.emit('recording.ended', { noteId: 'N' });
    await h.svc.pump();
    await h.advance(5_000);
    expect(h.svc.deliveries(w.id)[0]).toMatchObject({ status: 'succeeded', attempt: 2, responseStatus: 204 });
    await h.advance(10 * 3600_000);
    expect(h.calls).toHaveLength(2);
    expect(JSON.parse(h.calls[1]!.body)).toMatchObject({ type: 'recording.ended', data: { noteId: 'N' } });
  });

  it('turns an endpoint off when it answers 410 Gone', async () => {
    const h = await harness([410]);
    const w = await h.svc.create({ url: 'https://hooks.example.com/x', events: ['note.updated'] });
    h.svc.emit('note.updated', {});
    await h.svc.pump();
    expect(h.svc.get(w.id)).toMatchObject({ enabled: false, disabledReason: expect.stringMatching(/410/) });
    expect(h.svc.emit('note.updated', {})).toEqual([]);
  });

  it('persists subscriptions and pending retries across restarts', async () => {
    const h = await harness([500]);
    const w = await h.svc.create({ url: 'https://hooks.example.com/x', events: ['note.created'] });
    h.svc.emit('note.created', { id: 'N' });
    await h.svc.pump();
    await h.svc.close();
    const saved = JSON.parse(await readFile(path.join(h.stateDir, 'webhooks.json'), 'utf8'));
    expect(saved.webhooks[0].id).toBe(w.id);
    expect(saved.queue).toHaveLength(1);
    const again = new WebhookService({ stateDir: h.stateDir, fetch: (async () => new Response(null, { status: 200 })) as typeof fetch, clock: () => h.now() + 10_000 });
    await again.init();
    await again.pump();
    expect(again.deliveries(w.id)[0]).toMatchObject({ status: 'succeeded', attempt: 2 });
    await again.close();
  });

  it('refuses plain-http URLs except loopback', async () => {
    const h = await harness([]);
    await expect(h.svc.create({ url: 'http://hooks.example.com/x', events: ['note.created'] })).rejects.toThrow(/https/);
    await expect(h.svc.create({ url: 'https://u:p@hooks.example.com/x', events: ['note.created'] })).rejects.toThrow();
    await expect(h.svc.create({ url: 'http://127.0.0.1:9000/x', events: ['note.created'] })).resolves.toBeTruthy();
  });
});

describe('VaultEvents', () => {
  it('reports created, updated, trashed, restored, recordings and finished routines', async () => {
    const fx = await makeFixture();
    try {
      const ctx = await fx.ctx();
      const ev = new VaultEvents(ctx);
      expect(await ev.scan()).toEqual([]); // baseline
      const { note } = await fx.external.createNote({ title: 'New' });
      expect((await ev.scan()).map((e) => [e.type, e.data.title])).toEqual([['note.created', 'New']]);
      await fx.external.updateNote(note.id, (n) => ({ ...n, title: 'Renamed', recordings: [{ id: 'CLIP1', asset: 'a.webm', startedAt: 1, durationMs: 4000, mimeType: 'audio/webm' }] }));
      expect((await ev.scan()).map((e) => e.type)).toEqual(['note.updated', 'recording.ended']);
      await fx.external.trashNote(note.id);
      await fx.external.restoreNote('TRASHED');
      expect((await ev.scan()).map((e) => [e.type, e.data.id]).sort()).toEqual([['note.restored', 'TRASHED'], ['note.trashed', note.id]]);
      await ctx.fs.writeText('ai/activity/RUN1.json', JSON.stringify({ id: 'RUN1', source: 'routine', label: 'Nightly tidy', routineId: 'R1', startedAt: 1, endedAt: 2, status: 'done', ops: [] }));
      expect(await ev.scan()).toEqual([{ type: 'routine.finished', data: { runId: 'RUN1', routineId: 'R1', name: 'Nightly tidy', status: 'done', changes: 0 } }]);
      expect(await ev.scan()).toEqual([]);
    } finally {
      await fx.cleanup();
    }
  });
});
