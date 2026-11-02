/**
 * An optional signalling relay for the peer link (docs/COLLABORATION.md, "Signalling"):
 * `inkstone-mcp --http <port> --signal-token <secret>` adds it at `/signal/v1`.
 *
 * Devices that want to connect without exchanging QR codes in both directions leave their
 * (sealed) WebRTC offers and answers here and pick up the other side's. The relay is a dumb
 * mailbox and is built to know nothing:
 *
 * - room names are derived by the devices from secrets the relay never sees, so it can't tell
 *   who is talking to whom;
 * - every message is sealed by the devices (AES-GCM); the relay stores opaque bytes;
 * - it keeps at most a few messages per room for ten minutes, in memory only.
 *
 * Its own bearer token is separate from the MCP token on purpose: a token handed to a
 * collaborator's device opens the mailbox, never the vault.
 *
 *   POST /signal/v1/<room>                   body: ≤ 64 KiB of bytes → { seq }
 *   GET  /signal/v1/<room>?after=<seq>&wait=<s>   long-polls up to `wait` (≤ 30) seconds
 *                                            → { messages: [{ seq, data (base64url) }] }
 */
import { timingSafeEqual } from 'node:crypto';

export interface SignalRelayOptions {
  /** Bearer token clients must send. */
  token: string;
  /** How long a room lives after its last message (default 10 minutes). */
  ttlMs?: number;
  /** Messages kept per room (oldest dropped; default 16). */
  perRoom?: number;
  /** Rooms kept at once (default 1000; the stalest go first). */
  maxRooms?: number;
  clock?: () => number;
}

export const SIGNAL_MAX_BYTES = 64 * 1024;
const ROOM = /^[A-Za-z0-9_-]{16,128}$/;

interface Room {
  seq: number;
  touched: number;
  messages: { seq: number; data: string }[];
  waiters: Set<() => void>;
}

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type',
  'access-control-max-age': '600',
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...CORS } });
}

function b64url(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url');
}

export interface SignalRelay {
  handle(req: Request): Promise<Response>;
  /** Wakes every waiting poll and forgets all rooms. */
  close(): void;
  /** Rooms currently held (tests, health). */
  readonly size: number;
}

export function createSignalRelay(opts: SignalRelayOptions): SignalRelay {
  if (!opts.token || opts.token.length < 16) throw new Error('The signalling relay needs a token of at least 16 characters.');
  const clock = opts.clock ?? Date.now;
  const ttl = opts.ttlMs ?? 10 * 60_000;
  const perRoom = opts.perRoom ?? 16;
  const maxRooms = opts.maxRooms ?? 1000;
  const rooms = new Map<string, Room>();
  const expected = Buffer.from(`Bearer ${opts.token}`);

  const authorized = (req: Request) => {
    const got = Buffer.from(req.headers.get('authorization') ?? '');
    return got.length === expected.length && timingSafeEqual(got, expected);
  };

  const sweep = () => {
    const now = clock();
    for (const [id, r] of rooms) if (now - r.touched > ttl && r.waiters.size === 0) rooms.delete(id);
    while (rooms.size > maxRooms) {
      const stalest = [...rooms].sort((a, b) => a[1].touched - b[1].touched)[0]!;
      for (const w of stalest[1].waiters) w();
      rooms.delete(stalest[0]);
    }
  };

  const room = (id: string): Room => {
    let r = rooms.get(id);
    if (!r) {
      rooms.set(id, (r = { seq: 0, touched: clock(), messages: [], waiters: new Set() }));
      sweep();
    }
    return r;
  };

  return {
    get size() {
      return rooms.size;
    },
    close() {
      for (const r of rooms.values()) for (const w of r.waiters) w();
      rooms.clear();
    },
    async handle(req: Request): Promise<Response> {
      if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
      const url = new URL(req.url);
      const id = decodeURIComponent(url.pathname.replace(/^\/signal\/v1\//, ''));
      if (!ROOM.test(id)) return json(404, { error: 'Unknown room.' });
      if (!authorized(req)) return json(401, { error: 'A valid signalling token is required.' });
      sweep();
      if (req.method === 'POST') {
        const body = new Uint8Array(await req.arrayBuffer());
        if (!body.length || body.length > SIGNAL_MAX_BYTES) return json(413, { error: `Messages must be 1 to ${SIGNAL_MAX_BYTES} bytes.` });
        const r = room(id);
        const seq = ++r.seq;
        r.messages.push({ seq, data: b64url(body) });
        if (r.messages.length > perRoom) r.messages.splice(0, r.messages.length - perRoom);
        r.touched = clock();
        for (const w of [...r.waiters]) w();
        return json(200, { seq });
      }
      if (req.method !== 'GET') return json(405, { error: 'Use GET or POST.' });
      const after = Number(url.searchParams.get('after') ?? 0) || 0;
      const wait = Math.min(30, Math.max(0, Number(url.searchParams.get('wait') ?? 0) || 0));
      const pending = () => (rooms.get(id)?.messages ?? []).filter((m) => m.seq > after);
      if (!pending().length && wait > 0) {
        const r = room(id);
        await new Promise<void>((resolve) => {
          const done = () => {
            clearTimeout(timer);
            r.waiters.delete(done);
            resolve();
          };
          const timer = setTimeout(done, wait * 1000);
          r.waiters.add(done);
          req.signal?.addEventListener('abort', done, { once: true });
        });
      }
      return json(200, { messages: pending() });
    },
  };
}
