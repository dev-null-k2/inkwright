/**
 * Webhooks following the Standard Webhooks specification (https://www.standardwebhooks.com):
 *
 * - every message is a POST with a JSON body `{type, timestamp, data}` and three headers:
 *   `webhook-id` (the message id, the same on every retry, for de-duplication),
 *   `webhook-timestamp` (Unix seconds) and `webhook-signature` (`v1,<base64 HMAC-SHA256>` of
 *   `<id>.<timestamp>.<body>`, keyed with the base64 secret after `whsec_`);
 * - a 2xx answer is success; anything else (or no answer within 15 s) is retried on the spec's
 *   suggested schedule — 5 s, 5 min, 30 min, 2 h, 5 h, 10 h, 10 h — and then marked failed;
 * - `410 Gone` disables the endpoint (the receiver asked us to stop).
 *
 * Subscriptions, their secrets, pending retries and the delivery log live in the server's state
 * directory (outside the vault, so signing secrets never sync to a cloud drive). The queue is
 * persisted, so a restart continues where it left off.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import * as path from 'node:path';
import { newId } from '@inkstone/core';
import { WEBHOOK_EVENTS } from './schemas.ts';

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

export interface WebhookRecord {
  id: string;
  url: string;
  events: WebhookEvent[];
  description?: string;
  enabled: boolean;
  /** `whsec_<base64>`. */
  secret: string;
  createdAt: number;
  /** Why it was turned off (e.g. the receiver answered 410). */
  disabledReason?: string;
}

interface QueuedMessage {
  msgId: string;
  webhookId: string;
  event: WebhookEvent;
  body: string;
  /** Unix seconds when the message was created (signed into every attempt). */
  timestamp: number;
  attempt: number;
  nextAttemptAt: number;
}

export interface DeliveryLogEntry {
  id: string;
  webhookId: string;
  event: WebhookEvent;
  attempt: number;
  status: 'pending' | 'succeeded' | 'failed' | 'retrying';
  responseStatus: number | null;
  error: string | null;
  at: number;
  nextAttemptAt: number | null;
}

interface StateFile {
  webhooks: WebhookRecord[];
  queue: QueuedMessage[];
  log: DeliveryLogEntry[];
}

/** Delay before attempt n+1 (index 0 = the first try, made at once). */
export const RETRY_SCHEDULE_MS = [0, 5_000, 300_000, 1_800_000, 7_200_000, 18_000_000, 36_000_000, 36_000_000];
const TIMEOUT_MS = 15_000;
const LOG_PER_WEBHOOK = 200;

export function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64')}`;
}

/** The `webhook-signature` value for a message. */
export function signWebhook(secret: string, msgId: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${msgId}.${timestamp}.${body}`).digest('base64')}`;
}

/**
 * Verifies a received message (what a receiver does; used by tests and documented in API.md).
 * Rejects stale timestamps (default ±5 min) to stop replays.
 */
export function verifyWebhook(secret: string, headers: { id: string | null; timestamp: string | null; signature: string | null }, body: string, now = Date.now(), toleranceSec = 300): boolean {
  if (!headers.id || !headers.timestamp || !headers.signature) return false;
  const ts = Number(headers.timestamp);
  if (!Number.isInteger(ts) || Math.abs(now / 1000 - ts) > toleranceSec) return false;
  const want = Buffer.from(signWebhook(secret, headers.id, ts, body).slice(3), 'base64');
  return headers.signature.split(' ').some((s) => {
    const [v, sig] = s.split(',');
    if (v !== 'v1' || !sig) return false;
    const got = Buffer.from(sig, 'base64');
    return got.length === want.length && timingSafeEqual(got, want);
  });
}

export interface WebhookServiceOptions {
  /** Folder for webhooks.json (created when missing). */
  stateDir: string;
  clock?: () => number;
  fetch?: typeof globalThis.fetch;
  /** Timer hook (tests drive time by hand). */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
  log?: (msg: string) => void;
}

export function webhookUrlAllowed(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.username || u.password) return false;
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);
  } catch {
    return false;
  }
}

export class WebhookService {
  private state: StateFile = { webhooks: [], queue: [], log: [] };
  private readonly file: string;
  private readonly clock: () => number;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly setTimer: NonNullable<WebhookServiceOptions['setTimer']>;
  private timer: { cancel(): void } | null = null;
  private saving: Promise<void> = Promise.resolve();
  private pumping: Promise<void> | null = null;
  private closed = false;

  constructor(private opts: WebhookServiceOptions) {
    this.file = path.join(opts.stateDir, 'webhooks.json');
    this.clock = opts.clock ?? Date.now;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.setTimer = opts.setTimer ?? ((fn, ms) => {
      const t = setTimeout(fn, ms);
      t.unref?.();
      return { cancel: () => clearTimeout(t) };
    });
  }

  async init(): Promise<void> {
    try {
      const s = JSON.parse(await readFile(this.file, 'utf8')) as Partial<StateFile>;
      this.state = { webhooks: s.webhooks ?? [], queue: s.queue ?? [], log: s.log ?? [] };
    } catch {
      /* first run */
    }
    this.schedule();
  }

  list(): WebhookRecord[] {
    return this.state.webhooks;
  }

  get(id: string): WebhookRecord | undefined {
    return this.state.webhooks.find((w) => w.id === id);
  }

  async create(o: { url: string; events: WebhookEvent[]; description?: string }): Promise<WebhookRecord> {
    if (!webhookUrlAllowed(o.url)) throw new Error('Webhook URLs must be https (http only for localhost) and carry no credentials.');
    const rec: WebhookRecord = { id: newId(this.clock()), url: o.url, events: [...new Set(o.events)], enabled: true, secret: newWebhookSecret(), createdAt: this.clock(), ...(o.description ? { description: o.description } : {}) };
    this.state.webhooks.push(rec);
    await this.save();
    return rec;
  }

  async remove(id: string): Promise<boolean> {
    const before = this.state.webhooks.length;
    this.state.webhooks = this.state.webhooks.filter((w) => w.id !== id);
    this.state.queue = this.state.queue.filter((m) => m.webhookId !== id);
    this.state.log = this.state.log.filter((l) => l.webhookId !== id);
    await this.save();
    return this.state.webhooks.length < before;
  }

  deliveries(webhookId: string): DeliveryLogEntry[] {
    return this.state.log.filter((l) => l.webhookId === webhookId).sort((a, b) => b.at - a.at);
  }

  /** Queues `event` for every enabled webhook subscribed to it. Returns the message ids. */
  emit(event: WebhookEvent, data: unknown, only?: string): string[] {
    const ids: string[] = [];
    const now = this.clock();
    for (const w of this.state.webhooks) {
      if (!w.enabled || !w.events.includes(event) || (only && w.id !== only)) continue;
      const msgId = `msg_${newId(now)}`;
      const body = JSON.stringify({ type: event, timestamp: new Date(now).toISOString(), data });
      this.state.queue.push({ msgId, webhookId: w.id, event, body, timestamp: Math.floor(now / 1000), attempt: 0, nextAttemptAt: now });
      this.logEntry({ id: msgId, webhookId: w.id, event, attempt: 0, status: 'pending', responseStatus: null, error: null, at: now, nextAttemptAt: now });
      ids.push(msgId);
    }
    if (ids.length) {
      void this.save();
      this.schedule(0);
    }
    return ids;
  }

  /** Sends due messages now (also what the timer calls). Resolves when this round is done. */
  pump(): Promise<void> {
    this.pumping ??= this.deliverDue().finally(() => {
      this.pumping = null;
      this.schedule();
    });
    return this.pumping;
  }

  private async deliverDue(): Promise<void> {
    const now = this.clock();
    const due = this.state.queue.filter((m) => m.nextAttemptAt <= now);
    await Promise.all(due.map((m) => this.attempt(m)));
    await this.save();
  }

  private async attempt(m: QueuedMessage): Promise<void> {
    const w = this.get(m.webhookId);
    if (!w || !w.enabled) {
      this.state.queue = this.state.queue.filter((q) => q !== m);
      return;
    }
    m.attempt += 1;
    let status: number | null = null;
    let error: string | null = null;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), TIMEOUT_MS);
    try {
      const res = await this.fetchFn(w.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'Inkstone-Webhooks/1',
          'webhook-id': m.msgId,
          'webhook-timestamp': String(m.timestamp),
          'webhook-signature': signWebhook(w.secret, m.msgId, m.timestamp, m.body),
        },
        body: m.body,
        signal: ac.signal,
        redirect: 'manual',
      });
      status = res.status;
      await res.body?.cancel().catch(() => {});
    } catch (e) {
      error = ac.signal.aborted ? `No answer within ${TIMEOUT_MS / 1000} s` : (e as Error).message;
    } finally {
      clearTimeout(t);
    }
    const now = this.clock();
    const ok = status != null && status >= 200 && status < 300;
    if (ok || status === 410) {
      this.state.queue = this.state.queue.filter((q) => q !== m);
      if (status === 410) {
        w.enabled = false;
        w.disabledReason = 'The receiver answered 410 Gone.';
        this.opts.log?.(`Webhook ${w.url} answered 410 Gone; it is now off.`);
      }
      this.logEntry({ id: m.msgId, webhookId: w.id, event: m.event, attempt: m.attempt, status: ok ? 'succeeded' : 'failed', responseStatus: status, error: ok ? null : 'Gone', at: now, nextAttemptAt: null });
      return;
    }
    if (status != null && !error) error = `HTTP ${status}`;
    const delay = RETRY_SCHEDULE_MS[m.attempt];
    if (delay === undefined) {
      this.state.queue = this.state.queue.filter((q) => q !== m);
      this.logEntry({ id: m.msgId, webhookId: w.id, event: m.event, attempt: m.attempt, status: 'failed', responseStatus: status, error, at: now, nextAttemptAt: null });
      return;
    }
    m.nextAttemptAt = now + delay;
    this.logEntry({ id: m.msgId, webhookId: w.id, event: m.event, attempt: m.attempt, status: 'retrying', responseStatus: status, error, at: now, nextAttemptAt: m.nextAttemptAt });
  }

  /** One log row per message: the latest attempt replaces the earlier ones. */
  private logEntry(e: DeliveryLogEntry): void {
    this.state.log = this.state.log.filter((l) => l.id !== e.id);
    this.state.log.push(e);
    const mine = this.state.log.filter((l) => l.webhookId === e.webhookId);
    if (mine.length > LOG_PER_WEBHOOK) {
      const drop = new Set(mine.sort((a, b) => a.at - b.at).slice(0, mine.length - LOG_PER_WEBHOOK));
      this.state.log = this.state.log.filter((l) => !drop.has(l));
    }
  }

  private schedule(inMs?: number): void {
    if (this.closed) return;
    this.timer?.cancel();
    this.timer = null;
    if (!this.state.queue.length) return;
    const next = inMs ?? Math.max(0, Math.min(...this.state.queue.map((m) => m.nextAttemptAt)) - this.clock());
    this.timer = this.setTimer(() => void this.pump(), next);
  }

  private save(): Promise<void> {
    const snapshot = JSON.stringify(this.state, null, 1);
    this.saving = this.saving.then(async () => {
      await mkdir(this.opts.stateDir, { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.${process.pid}.tmp`;
      await writeFile(tmp, snapshot, { mode: 0o600 });
      await rename(tmp, this.file);
    }).catch((e) => this.opts.log?.(`Could not save webhooks: ${(e as Error).message}`));
    return this.saving;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.timer?.cancel();
    await this.pumping;
    await this.saving;
  }
}
