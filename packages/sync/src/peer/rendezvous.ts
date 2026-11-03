/**
 * Meeting by short code: the rendezvous protocol that turns an eight-character code into an
 * authenticated peer-link offer and answer, through a relay that learns nothing useful.
 *
 * ```
 *  guest                                 relay room = H(nameplate)                     host
 *    │                                                                     ◄── h  (claim: "in use")
 *    │── a  {sid, Ya}                    ─────────────────────────────────────────────►│ attempt n of 5
 *    │◄─ b  {sid, Yb, tagHost, seal(offer)} ───────────────────────────────────────────│
 *    │   check tagHost (wrong code → stop)                                             │
 *    │── c  {sid, tagGuest, seal(answer)} ─────────────────────────────────────────────►│ check tagGuest
 *    │                                                                                 │ code used up
 *    └──────────────── WebRTC, device to device, Noise-KK handshake with psk = K(ISK) ─┘
 * ```
 *
 * - `Ya`, `Yb` are CPace shares (cpace.ts): uniformly random group elements that reveal nothing
 *   about the code. The ISK both sides derive is the key for everything after.
 * - The offer and answer are the existing peer-link codes (pairing.ts) — identity keys, ephemeral
 *   keys, the WebRTC SDP with its DTLS fingerprints — **sealed** with AES-GCM under ISK-derived
 *   keys, so the relay sees ciphertext only. Their pairing secret is not sent at all: both derive
 *   it from the ISK (`auth: 'pake'`), so the Noise handshake, its transcript (both SDPs) and the
 *   PAKE are bound together, and a relay that swapped an SDP or a key gets different keys.
 * - The host counts every attempt it answers (that is what a guess costs) and locks the code
 *   after five; codes expire after ten minutes and work once (shortcode.ts).
 *
 * The relay is pluggable (`RendezvousTransport`): an ntfy server (the public ntfy.sh by default,
 * or your own) or the `inkwright-mcp --signal-token` mailbox you run yourself.
 */
import { fromBase64Url, toBase64Url } from '@inkwright/core';
import { sleep, utf8Decode, utf8Encode } from '../util.ts';
import { CpaceParty, PakeError, confirmationTag, iskKey, lvCat, newSessionId, verifyConfirmation } from './cpace.ts';
import { openWithSecret, randomBytes, sealWithSecret } from './crypto.ts';
import { CodeGuard, CODE_TTL_MS, generateShortCode, parseShortCode, rendezvousRoom, type CodeStatus, type ShortCode } from './shortcode.ts';
import type { RelayClient } from './signal.ts';

// ---- Transports ---------------------------------------------------------------------------------

/** A relay that can carry short text messages between two devices in a named room. */
export interface RendezvousTransport {
  /** What people see ("ntfy.sh", "notes.example.com"). */
  readonly label: string;
  post(room: string, text: string, signal?: AbortSignal): Promise<void>;
  /**
   * Delivers messages posted to `room` from now on (each at most once) until `signal` aborts.
   * Resolves once the subscription is live — a message posted after that is not missed — and
   * rejects if the relay can't be reached at all. Later drops reconnect without losing messages.
   */
  subscribe(room: string, onText: (text: string) => void, signal: AbortSignal): Promise<void>;
  /** Whether anything was posted to `room` in the last ten minutes (so a new code avoids it). */
  busy(room: string, signal?: AbortSignal): Promise<boolean>;
}

const relayError = (status: number, label: string) =>
  new Error(status === 429 ? `The relay (${label}) is busy right now; try again in a minute.` : status === 401 || status === 403 ? `The relay (${label}) refused the connection.` : `The relay (${label}) answered with error ${status}.`);

const hostLabel = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * An ntfy server (https://ntfy.sh, or a self-hosted one: it is open source) as a relay. Topics
 * are public to anyone who knows their name, which is fine here: room names are hashes, the
 * messages are sealed, and the PAKE is built for an attacker who reads and writes the room.
 *
 * - publish: `POST /<topic>` with the text as body (a CORS "simple request", no preflight);
 * - subscribe: one long-lived `GET /<topic>/json` stream (newline-delimited JSON). One request
 *   per subscription keeps well inside ntfy.sh's per-visitor request limits, unlike polling;
 * - after a drop it reconnects with `since=<last message id>` (or the server time of the
 *   `open` event), so nothing posted meanwhile is lost; ids already seen are skipped.
 */
export class NtfyTransport implements RendezvousTransport {
  readonly label: string;
  private readonly base: string;
  private readonly fetchFn: typeof fetch;

  constructor(url: string, fetchFn?: typeof fetch) {
    this.base = url.replace(/\/+$/, '');
    this.label = hostLabel(this.base);
    this.fetchFn = fetchFn ?? ((...a) => globalThis.fetch(...a));
  }

  async post(room: string, text: string, signal?: AbortSignal): Promise<void> {
    const res = await this.fetchFn(`${this.base}/${room}`, { method: 'POST', body: text, ...(signal ? { signal } : {}) });
    if (!res.ok) throw relayError(res.status, this.label);
    await res.body?.cancel().catch(() => {});
  }

  async busy(room: string, signal?: AbortSignal): Promise<boolean> {
    const res = await this.fetchFn(`${this.base}/${room}/json?poll=1&since=10m`, signal ? { signal } : {});
    if (!res.ok) throw relayError(res.status, this.label);
    return (await res.text()).split('\n').some((l) => l.includes('"event":"message"'));
  }

  subscribe(room: string, onText: (text: string) => void, signal: AbortSignal): Promise<void> {
    const seen = new Set<string>();
    let since: string | null = null;
    return new Promise<void>((ready, failed) => {
      let first = true;
      const run = async () => {
        let backoff = 1000;
        while (!signal.aborted) {
          try {
            const res = await this.fetchFn(`${this.base}/${room}/json${since ? `?since=${encodeURIComponent(since)}` : ''}`, { signal });
            if (!res.ok || !res.body) throw relayError(res.status, this.label);
            const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
            let buf = '';
            for (;;) {
              const { value, done } = await reader.read();
              if (done) break;
              buf += value;
              let nl: number;
              while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let ev: { id?: string; time?: number; event?: string; message?: string };
                try {
                  ev = JSON.parse(line);
                } catch {
                  continue;
                }
                if (ev.event === 'open') {
                  // Resume point if the stream drops before any message arrives.
                  if (!since && typeof ev.time === 'number') since = String(ev.time);
                  if (first) {
                    first = false;
                    ready();
                  }
                  backoff = 1000;
                } else if (ev.event === 'message' && typeof ev.id === 'string' && typeof ev.message === 'string') {
                  since = ev.id;
                  if (seen.has(ev.id)) continue;
                  seen.add(ev.id);
                  onText(ev.message);
                }
              }
            }
          } catch (e) {
            if (signal.aborted) return;
            if (first) {
              first = false;
              failed(e instanceof Error && !/^The relay/.test(e.message) ? new Error(`Couldn’t reach the relay (${this.label}). Check the connection.`) : e);
              return;
            }
          }
          if (signal.aborted) return;
          await sleep(backoff, signal).catch(() => {});
          backoff = Math.min(backoff * 2, 15_000);
        }
      };
      void run();
    });
  }
}

/**
 * The self-hosted mailbox (`inkwright-mcp --http <port> --signal-token <secret>`, signal.ts) as a
 * relay: long polls with a sequence-number cursor.
 */
export class MailboxTransport implements RendezvousTransport {
  readonly label: string;
  constructor(private readonly client: RelayClient, url: string) {
    this.label = hostLabel(url);
  }

  async post(room: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.client.post(room, utf8Encode(text), signal);
  }

  async busy(room: string): Promise<boolean> {
    return (await this.client.poll(room, 0, { waitSec: 0 })).length > 0;
  }

  async subscribe(room: string, onText: (text: string) => void, signal: AbortSignal): Promise<void> {
    let cursor = (await this.client.poll(room, 0, { waitSec: 0, signal })).reduce((m, x) => Math.max(m, x.seq), 0);
    void (async () => {
      let backoff = 1000;
      while (!signal.aborted) {
        try {
          for (const m of await this.client.poll(room, cursor, { waitSec: 25, signal })) {
            cursor = Math.max(cursor, m.seq);
            onText(utf8Decode(m.data));
          }
          backoff = 1000;
        } catch {
          if (signal.aborted) return;
          await sleep(backoff, signal).catch(() => {});
          backoff = Math.min(backoff * 2, 15_000);
        }
      }
    })();
  }
}

// ---- Framing: typed, fragmented messages in a room ------------------------------------------------

/** Characters per posted message: well under ntfy.sh's 4096-byte message limit. */
export const FRAGMENT_CHARS = 3000;
const MAX_FRAGMENTS = 16;

type Kind = 'h' | 'a' | 'b' | 'c';
interface Envelope { v: 1; k: Kind; s: string; i: number; n: number; d: string }

/**
 * A room with typed messages: each is split into fragments small enough for any relay and put
 * back together on arrival. Anything malformed is ignored — the room is open to anyone.
 */
export class RendezvousRoom {
  private partial = new Map<string, string[]>();
  constructor(readonly transport: RendezvousTransport, readonly id: string) {}

  async send(k: Kind, s: string, payload: string, signal?: AbortSignal): Promise<void> {
    const n = Math.max(1, Math.ceil(payload.length / FRAGMENT_CHARS));
    if (n > MAX_FRAGMENTS) throw new Error('Message too large for the relay.');
    for (let i = 0; i < n; i++) {
      const env: Envelope = { v: 1, k, s, i, n, d: payload.slice(i * FRAGMENT_CHARS, (i + 1) * FRAGMENT_CHARS) };
      await this.transport.post(this.id, JSON.stringify(env), signal);
    }
  }

  listen(on: (k: Kind, s: string, payload: string) => void, signal: AbortSignal): Promise<void> {
    return this.transport.subscribe(this.id, (text) => {
      let e: Envelope;
      try {
        e = JSON.parse(text);
      } catch {
        return;
      }
      if (!e || e.v !== 1 || !['h', 'a', 'b', 'c'].includes(e.k) || typeof e.s !== 'string' || e.s.length > 32 || typeof e.d !== 'string' || e.d.length > FRAGMENT_CHARS) return;
      if (!Number.isInteger(e.n) || !Number.isInteger(e.i) || e.n < 1 || e.n > MAX_FRAGMENTS || e.i < 0 || e.i >= e.n) return;
      if (e.n === 1) return on(e.k, e.s, e.d);
      const key = `${e.k}:${e.s}:${e.n}`;
      if (!this.partial.has(key) && this.partial.size > 64) return;
      const parts = this.partial.get(key) ?? new Array<string>(e.n);
      parts[e.i] = e.d;
      this.partial.set(key, parts);
      if (parts.filter((x) => x !== undefined).length === e.n) {
        this.partial.delete(key);
        on(e.k, e.s, parts.join(''));
      }
    }, signal);
  }
}

// ---- The protocol ----------------------------------------------------------------------------------

const CI_LABEL = utf8Encode('inkwright.shortcode.v1');
const AD_GUEST = utf8Encode('inkwright guest');
const AD_HOST = utf8Encode('inkwright host');
const SEAL_TO_GUEST = 'shortcode host->guest';
const SEAL_TO_HOST = 'shortcode guest->host';

/** How long the host waits for a guest to confirm after answering its attempt (time to read a prompt). */
export const CONFIRM_WINDOW_MS = 3 * 60_000;
/** How long a guest waits for the host to answer before saying nobody is there. */
export const GUEST_WAIT_MS = 25_000;

const cpaceParams = (code: ShortCode, room: string, sid: Uint8Array) => ({ prs: utf8Encode(code.password), ci: lvCat(CI_LABEL, utf8Encode(room)), sid });
const b64 = toBase64Url;
const unb64 = (s: unknown, len?: number): Uint8Array => {
  if (typeof s !== 'string' || s.length > 200_000) throw new PakeError('Malformed message.');
  const b = fromBase64Url(s);
  if (len !== undefined && b.length !== len) throw new PakeError('Malformed message.');
  return b;
};

/** What the host prepares for each attempt: the offer to seal, and how to drop it. */
export interface HostAttempt {
  /** The peer-link offer code (pairing.ts `encodeCode`), made with the attempt's psk. */
  code: string;
  cancel(): void;
}

export type HostState =
  | { phase: 'waiting'; attempts: number }
  | { phase: 'connecting' }
  | { phase: 'done' }
  | { phase: 'ended'; status: Exclude<CodeStatus, 'open'> | 'cancelled' }
  | { phase: 'failed'; error: string };

export interface HostOptions<A extends HostAttempt> {
  transport: RendezvousTransport;
  /** Makes the offer for one attempt; `psk` is the attempt's key for the peer-link handshake. */
  makeOffer(psk: Uint8Array): Promise<A>;
  /** The guest proved the code and answered: complete the connection (throwing marks it failed). */
  accept(answerCode: string, attempt: A): Promise<void>;
  onState?(s: HostState): void;
  /** For tests. */
  code?: ShortCode;
  now?: () => number;
  ttlMs?: number;
}

export interface ShortCodeHost {
  code: ShortCode;
  expiresAt: number;
  readonly state: HostState;
  cancel(): void;
}


/**
 * Starts listening for a guest with a fresh short code. Resolves once the relay is listening (so
 * the code can be shown); progress goes to `onState`. Picks a nameplate nobody used in the last
 * ten minutes, so two hosts rarely share a room (and if they do, each still only accepts its own
 * code).
 */
export async function hostShortCode<A extends HostAttempt>(o: HostOptions<A>): Promise<ShortCodeHost> {
  const now = o.now ?? Date.now;
  let code = o.code ?? generateShortCode();
  let roomId = await rendezvousRoom(code.nameplate);
  if (!o.code) {
    for (let i = 0; i < 4 && (await o.transport.busy(roomId)); i++) {
      code = generateShortCode();
      roomId = await rendezvousRoom(code.nameplate);
    }
  }
  const room = new RendezvousRoom(o.transport, roomId);
  const guard = new CodeGuard(now(), o.ttlMs ?? CODE_TTL_MS);
  const ac = new AbortController();
  const attempts = new Map<string, { isk: Uint8Array; attempt: A | null; timer: ReturnType<typeof setTimeout> | null }>();
  let state: HostState = { phase: 'waiting', attempts: 0 };
  let finished = false;
  const set = (s: HostState) => {
    state = s;
    o.onState?.(s);
  };
  const release = () => {
    for (const a of attempts.values()) {
      if (a.timer) clearTimeout(a.timer);
      a.attempt?.cancel();
    }
    attempts.clear();
  };
  const stop = (s: HostState) => {
    if (finished) return;
    finished = true;
    ac.abort();
    clearTimeout(expiry);
    release();
    set(s);
  };
  /** An attempt ended without the guest proving the code. */
  const fail = (sid: string) => {
    const a = attempts.get(sid);
    if (a) {
      if (a.timer) clearTimeout(a.timer);
      a.attempt?.cancel();
      attempts.delete(sid);
    }
    guard.fail();
    const st = guard.status(now());
    if (st === 'locked' || st === 'expired') stop({ phase: 'ended', status: st });
  };

  const onAttempt = async (sid: string, payload: string) => {
    if (attempts.has(sid) || finished) return;
    // Every answered attempt costs one guess, whatever happens next.
    if (!guard.begin(now())) return;
    attempts.set(sid, { isk: new Uint8Array(0), attempt: null, timer: null });
    set({ phase: 'waiting', attempts: guard.attemptsUsed });
    try {
      const { Y } = JSON.parse(payload) as { Y?: unknown };
      const party = new CpaceParty('responder', cpaceParams(code, roomId, unb64(sid, 16)), AD_HOST);
      const isk = party.finish(unb64(Y, 32), AD_GUEST);
      const attempt = await o.makeOffer(iskKey(isk, 'psk'));
      const slot = attempts.get(sid);
      if (!slot || finished) return attempt.cancel();
      slot.isk = isk;
      slot.attempt = attempt;
      slot.timer = setTimeout(() => fail(sid), CONFIRM_WINDOW_MS);
      const sealed = await sealWithSecret(iskKey(isk, 'seal'), SEAL_TO_GUEST, utf8Encode(attempt.code));
      await room.send('b', sid, JSON.stringify({ Y: b64(party.share), t: b64(confirmationTag(isk, 'host')), x: b64(sealed) }), ac.signal);
    } catch (e) {
      if (!finished) fail(sid);
      if (!(e instanceof PakeError) && !ac.signal.aborted) console.warn('shortcode: attempt failed', e);
    }
  };

  const onConfirm = async (sid: string, payload: string) => {
    const slot = attempts.get(sid);
    if (!slot?.attempt || finished) return;
    let answer: string;
    try {
      // `{ no: 1 }`: the guest's code didn't match ours (anyone could send it; it only ends an attempt sooner).
      const { t, x } = JSON.parse(payload) as { t?: unknown; x?: unknown };
      if (!verifyConfirmation(slot.isk, 'guest', unb64(t, 32))) throw new PakeError('Wrong code.');
      answer = utf8Decode(await openWithSecret(iskKey(slot.isk, 'seal'), SEAL_TO_HOST, unb64(x)));
    } catch {
      return fail(sid);
    }
    // The code is proven and used up: stop listening, drop every other attempt.
    guard.succeed();
    if (slot.timer) clearTimeout(slot.timer);
    attempts.delete(sid);
    finished = true;
    ac.abort();
    clearTimeout(expiry);
    release();
    set({ phase: 'connecting' });
    try {
      await o.accept(answer, slot.attempt);
      set({ phase: 'done' });
    } catch (e) {
      slot.attempt.cancel();
      set({ phase: 'failed', error: (e as Error)?.message ?? String(e) });
    }
  };

  const expiry = setTimeout(() => stop({ phase: 'ended', status: 'expired' }), Math.max(0, guard.expiresAt - now()));
  try {
    await room.listen((k, s, payload) => {
      if (k === 'a') void onAttempt(s, payload);
      else if (k === 'c') void onConfirm(s, payload);
    }, ac.signal);
    // Mark the room as taken for other hosts choosing a code (an opaque, random claim).
    await room.send('h', '', b64(randomBytes(16)), ac.signal);
  } catch (e) {
    stop({ phase: 'failed', error: (e as Error)?.message ?? String(e) });
    throw e;
  }
  set(state);
  return {
    code,
    expiresAt: guard.expiresAt,
    get state() {
      return state;
    },
    cancel: () => stop({ phase: 'ended', status: 'cancelled' }),
  };
}

export class ShortCodeError extends Error {
  override name = 'ShortCodeError';
  constructor(message: string, readonly reason: 'invalid' | 'wrong' | 'nobody' | 'relay') {
    super(message);
  }
}

/** The guest after the code was proven: the host's offer, and how to send the answer back. */
export interface GuestJoin {
  /** The host's peer-link offer code (pairing.ts `decodeCode`). */
  offerCode: string;
  /** Key for the peer-link handshake (`answerOffer`'s psk). */
  psk: Uint8Array;
  /** Seals and sends the answer; the code is used up on the host when it arrives. */
  reply(answerCode: string): Promise<void>;
  /** Stops listening (after replying, or to give up). */
  close(): void;
}

/**
 * Joins with a code someone gave you: runs CPace with the host through the relay and returns the
 * host's offer once the host proved it holds the same code. Fails with a plain reason: the code
 * is malformed, wrong, or nobody is sharing with it (expired, used, locked, or never existed).
 */
export async function joinShortCode(o: { transport: RendezvousTransport; code: string; signal?: AbortSignal; waitMs?: number }): Promise<GuestJoin> {
  const code = parseShortCode(o.code);
  if (!code) throw new ShortCodeError('A code has eight letters and digits, like K7PM-2Q9X.', 'invalid');
  const roomId = await rendezvousRoom(code.nameplate);
  const room = new RendezvousRoom(o.transport, roomId);
  const sidBytes = newSessionId();
  const sid = b64(sidBytes);
  const party = new CpaceParty('initiator', cpaceParams(code, roomId, sidBytes), AD_GUEST);
  const ac = new AbortController();
  const onOuter = () => ac.abort();
  o.signal?.addEventListener('abort', onOuter, { once: true });
  const close = () => {
    ac.abort();
    o.signal?.removeEventListener('abort', onOuter);
  };
  let wrong = false;
  /** After a reply that doesn't confirm, wait briefly for another host in the room, then give up. */
  const WRONG_GRACE_MS = 1500;
  try {
    const proven = await new Promise<{ isk: Uint8Array; offer: string }>((resolve, reject) => {
      const wrongCode = () => new ShortCodeError('That code didn’t work. Check it with the person who shared it, or ask for a new one.', 'wrong');
      let timer = setTimeout(() => reject(wrong ? wrongCode() : new ShortCodeError('Nobody is sharing with that code right now. It may have expired or been used; ask for a new one.', 'nobody')), o.waitMs ?? GUEST_WAIT_MS);
      const mismatch = () => {
        // Tell that host at once (so its attempt ends now, not after its confirm window), then stop soon.
        void room.send('c', sid, JSON.stringify({ no: 1 }), ac.signal).catch(() => {});
        if (wrong) return;
        wrong = true;
        clearTimeout(timer);
        timer = setTimeout(() => reject(wrongCode()), WRONG_GRACE_MS);
      };
      ac.signal.addEventListener('abort', () => {
        clearTimeout(timer);
        reject(new ShortCodeError('Cancelled.', 'nobody'));
      }, { once: true });
      room.listen((k, s, payload) => {
        if (k !== 'b' || s !== sid) return;
        void (async () => {
          try {
            const { Y, t, x } = JSON.parse(payload) as { Y?: unknown; t?: unknown; x?: unknown };
            const isk = party.finish(unb64(Y, 32), AD_HOST);
            if (!verifyConfirmation(isk, 'host', unb64(t, 32))) return mismatch();
            const offer = utf8Decode(await openWithSecret(iskKey(isk, 'seal'), SEAL_TO_GUEST, unb64(x)));
            clearTimeout(timer);
            resolve({ isk, offer });
          } catch {
            mismatch();
          }
        })();
      }, ac.signal)
        .then(() => room.send('a', sid, JSON.stringify({ Y: b64(party.share) }), ac.signal))
        .catch((e) => {
          clearTimeout(timer);
          reject(e instanceof ShortCodeError ? e : new ShortCodeError((e as Error)?.message ?? String(e), 'relay'));
        });
    });
    return {
      offerCode: proven.offer,
      psk: iskKey(proven.isk, 'psk'),
      async reply(answerCode: string) {
        const sealed = await sealWithSecret(iskKey(proven.isk, 'seal'), SEAL_TO_HOST, utf8Encode(answerCode));
        await room.send('c', sid, JSON.stringify({ t: b64(confirmationTag(proven.isk, 'guest')), x: b64(sealed) }));
        close();
      },
      close,
    };
  } catch (e) {
    close();
    throw e;
  }
}
