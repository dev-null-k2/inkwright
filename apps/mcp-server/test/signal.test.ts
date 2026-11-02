import { describe, expect, it } from 'vitest';
import { RelayClient, SealedMailbox, randomBytes } from '@inkstone/sync';
import { createSignalRelay } from '../src/signal.ts';
import { parseCli } from '../src/cli.ts';

const TOKEN = 'relay-token-0123456789';

/** A fetch that goes straight to the relay's handler (no sockets). */
function clientFor(relay: ReturnType<typeof createSignalRelay>, token = TOKEN) {
  const fetchFn = ((input: RequestInfo | URL, init?: RequestInit) => relay.handle(new Request(input, init))) as typeof fetch;
  return new RelayClient({ url: 'https://notes.example.com', token }, fetchFn);
}

describe('signalling relay', () => {
  it('relays sealed messages between two holders of a secret, and nobody else can read them', async () => {
    const relay = createSignalRelay({ token: TOKEN });
    const secret = randomBytes(32);
    const a = await SealedMailbox.open(clientFor(relay), secret, 'answer');
    const b = await SealedMailbox.open(clientFor(relay), secret, 'answer');
    expect(a.room).toBe(b.room);
    // The room name says nothing about the secret.
    expect(a.room).toMatch(/^[0-9a-f]{32}$/);
    const waiting = b.receive(0);
    await a.send('{"t":"answer"}');
    expect((await waiting).text).toBe('{"t":"answer"}');
    // What the relay holds is opaque.
    const raw = await clientFor(relay).poll(a.room, 0);
    expect(new TextDecoder().decode(raw[0]!.data)).not.toContain('answer');
    // Another secret gives another room: holders of different secrets never meet.
    const other = await SealedMailbox.open(clientFor(relay), randomBytes(32), 'answer');
    expect(other.room).not.toBe(a.room);
    relay.close();
  });

  it('long-polls until a message arrives', async () => {
    const relay = createSignalRelay({ token: TOKEN });
    const c = clientFor(relay);
    const room = 'r'.repeat(32);
    const started = Date.now();
    const poll = c.poll(room, 0, { waitSec: 5 });
    setTimeout(() => void c.post(room, new Uint8Array([1, 2, 3])), 50);
    const msgs = await poll;
    expect(msgs.map((m) => [...m.data])).toEqual([[1, 2, 3]]);
    expect(Date.now() - started).toBeLessThan(4000);
    relay.close();
  });

  it('refuses wrong tokens, bad rooms and oversized messages, and answers CORS preflights', async () => {
    const relay = createSignalRelay({ token: TOKEN });
    await expect(clientFor(relay, 'wrong-token-0000000000').post('r'.repeat(32), new Uint8Array([1]))).rejects.toThrow(/refused the token/);
    expect((await relay.handle(new Request('https://x/signal/v1/short', { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: new Uint8Array([1]) }))).status).toBe(404);
    expect((await relay.handle(new Request(`https://x/signal/v1/${'r'.repeat(32)}`, { method: 'POST', headers: { authorization: `Bearer ${TOKEN}` }, body: new Uint8Array(70_000) }))).status).toBe(413);
    const pre = await relay.handle(new Request(`https://x/signal/v1/${'r'.repeat(32)}`, { method: 'OPTIONS' }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(() => createSignalRelay({ token: 'short' })).toThrow(/16 characters/);
  });

  it('forgets rooms after their time and keeps a bounded number', async () => {
    let now = 0;
    const relay = createSignalRelay({ token: TOKEN, clock: () => now, ttlMs: 1000, maxRooms: 3 });
    const c = clientFor(relay);
    for (let i = 0; i < 5; i++) await c.post(`room${i}`.padEnd(20, 'x'), new Uint8Array([i]));
    expect(relay.size).toBe(3);
    now = 5000;
    await c.post('fresh'.padEnd(20, 'x'), new Uint8Array([9]));
    expect(relay.size).toBe(1);
  });

  it('is configured with its own token and only over HTTP', () => {
    expect(parseCli(['--vault', '/tmp/v', '--http', '8765', '--signal-token', TOKEN], {}).signalToken).toBe(TOKEN);
    expect(() => parseCli(['--vault', '/tmp/v', '--signal-token', TOKEN], {})).toThrow(/only applies with --http/);
    expect(() => parseCli(['--vault', '/tmp/v', '--http', '1', '--signal-token', 'x'], {})).toThrow(/at least 16/);
  });
});
