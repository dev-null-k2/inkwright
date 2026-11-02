/**
 * Optional signalling through a relay you run yourself (apps/mcp-server's `/signal/v1`, see
 * docs/COLLABORATION.md "Signalling"). Without one, offers and answers travel as QR codes or
 * pasted text and nothing else is needed.
 *
 * The relay is a dumb mailbox: `POST /signal/v1/<room>` leaves a message, `GET` with `after=<seq>`
 * long-polls for newer ones. It never sees anything readable: room names are derived from secrets
 * only the two devices hold (`labelFrom`), and every message is sealed with a key from the same
 * secret (`sealWithSecret`). A relay can drop or delay messages — that only fails the connection —
 * but it cannot read, forge or redirect them: a forged offer or answer fails to open, and the
 * session keys need the devices' private keys anyway.
 */
import { fromBase64Url } from '@inkwright/core';
import { sleep, throwIfAborted, toBufferView } from '../util.ts';
import { labelFrom, openWithSecret, sealWithSecret } from './crypto.ts';

export interface RelayConfig {
  /** Base URL of the server, e.g. `https://notes.example.com` (the relay lives at `/signal/v1`). */
  url: string;
  /** Bearer token the relay was started with. */
  token?: string;
}

export interface RelayMessage {
  seq: number;
  data: Uint8Array;
}

/** Most bytes one relayed message may have (an offer with a long SDP fits easily). */
export const RELAY_MAX_BYTES = 64 * 1024;

export class RelayClient {
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(private readonly cfg: RelayConfig, fetchFn?: typeof fetch) {
    this.base = `${cfg.url.replace(/\/+$/, '')}/signal/v1`;
    this.fetchFn = fetchFn ?? ((...a) => globalThis.fetch(...a));
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { ...extra, ...(this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}) };
  }

  async post(room: string, data: Uint8Array, signal?: AbortSignal): Promise<number> {
    if (data.length > RELAY_MAX_BYTES) throw new Error('Message too large for the relay.');
    const res = await this.fetchFn(`${this.base}/${encodeURIComponent(room)}`, { method: 'POST', headers: this.headers({ 'content-type': 'application/octet-stream' }), body: toBufferView(data), signal });
    if (!res.ok) throw new Error(res.status === 401 ? 'The signalling server refused the token.' : `Signalling server error ${res.status}`);
    return ((await res.json()) as { seq: number }).seq;
  }

  /** One long poll: messages after `after` (waits up to `waitSec` for the first one). */
  async poll(room: string, after: number, opts: { waitSec?: number; signal?: AbortSignal } = {}): Promise<RelayMessage[]> {
    const res = await this.fetchFn(`${this.base}/${encodeURIComponent(room)}?after=${after}&wait=${opts.waitSec ?? 25}`, { headers: this.headers(), signal: opts.signal });
    if (!res.ok) throw new Error(res.status === 401 ? 'The signalling server refused the token.' : `Signalling server error ${res.status}`);
    const body = (await res.json()) as { messages?: { seq: number; data: string }[] };
    return (body.messages ?? []).map((m) => ({ seq: m.seq, data: fromBase64Url(m.data) }));
  }

  /** Waits for the next message in a room (polling until it comes or `signal` aborts). */
  async next(room: string, after: number, signal?: AbortSignal): Promise<RelayMessage> {
    for (;;) {
      throwIfAborted(signal);
      try {
        const msgs = await this.poll(room, after, { signal });
        if (msgs.length) return msgs[0]!;
      } catch (e) {
        if (signal?.aborted) throw e;
        await sleep(2000, signal);
      }
    }
  }
}

/** A sealed mailbox between two holders of one secret: room name and message key both derive from it. */
export class SealedMailbox {
  private constructor(readonly client: RelayClient, readonly room: string, private readonly secret: Uint8Array, private readonly label: string) {}

  static async open(client: RelayClient, secret: Uint8Array, label: string): Promise<SealedMailbox> {
    return new SealedMailbox(client, await labelFrom(secret, label), secret, label);
  }

  async send(text: string, signal?: AbortSignal): Promise<number> {
    return this.client.post(this.room, await sealWithSecret(this.secret, this.label, new TextEncoder().encode(text)), signal);
  }

  /** The next message that opens with the secret (anything else in the room is skipped). */
  async receive(after: number, signal?: AbortSignal): Promise<{ seq: number; text: string }> {
    let cursor = after;
    for (;;) {
      const m = await this.client.next(this.room, cursor, signal);
      cursor = m.seq;
      try {
        return { seq: m.seq, text: new TextDecoder().decode(await openWithSecret(this.secret, this.label, m.data)) };
      } catch {
        /* not for us (or forged): keep waiting */
      }
    }
  }
}
