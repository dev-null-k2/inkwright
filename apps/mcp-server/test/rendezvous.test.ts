import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { newId, toBase64Url } from '@inkwright/core';
import {
  MailboxTransport,
  NtfyTransport,
  RelayClient,
  answerOffer,
  completeOffer,
  createOffer,
  decodeCode,
  encodeCode,
  formatShortCode,
  generateKeyPair,
  hostShortCode,
  joinShortCode,
  type HostState,
  type PeerOffer,
  type RendezvousTransport,
} from '@inkwright/sync';
import { createSignalRelay } from '../src/signal.ts';

/**
 * The short-code rendezvous against real relays running locally: the `--signal-token` mailbox
 * this package serves, and an ntfy-compatible server speaking the subset of ntfy's HTTP API the
 * app uses (publish, the `/json` stream with `since`, `poll=1`) over a real socket.
 */

const TOKEN = 'relay-token-0123456789';
const TITLE = 'Board notes, do not forward';

async function runShare(transport: () => RendezvousTransport) {
  const id = async (name: string) => {
    const identity = await generateKeyPair();
    return { identity, info: { id: newId(), name, key: toBase64Url(identity.publicRaw) } };
  };
  const host = await id('Ada');
  const guest = await id('Grace');
  const states: HostState[] = [];
  let hostSas = '';
  const h = await hostShortCode({
    transport: transport(),
    makeOffer: async (psk) => {
      const started = await createOffer({ device: host.info, purpose: 'collab', sdp: 'v=0 host-sdp a=fingerprint:sha-256 11:22', invite: { noteId: 'n', title: TITLE, permission: 'write' }, pakePsk: psk });
      return { code: await encodeCode(started.offer), started, cancel: () => {} };
    },
    accept: async (answerCode, a) => {
      const answer = await decodeCode(answerCode);
      if (answer.t !== 'answer') throw new Error('expected an answer');
      hostSas = (await completeOffer({ started: a.started, answer, identity: host.identity })).sas;
    },
    onState: (s) => states.push(s),
  });
  const j = await joinShortCode({ transport: transport(), code: formatShortCode(h.code) });
  const offer = (await decodeCode(j.offerCode)) as PeerOffer;
  const { answer, keys } = await answerOffer({ offer, identity: guest.identity, device: guest.info, sdp: 'v=0 guest-sdp', pakePsk: j.psk });
  await j.reply(await encodeCode(answer));
  for (let i = 0; i < 200 && !states.some((s) => s.phase === 'done'); i++) await new Promise((r) => setTimeout(r, 10));
  return { h, offer, hostSas, guestSas: keys.sas, states };
}

const PLAINTEXT = [TITLE, 'Ada', 'Grace', 'host-sdp', 'fingerprint', 'ink1:'];

describe('short-code rendezvous through the inkwright-mcp mailbox relay', () => {
  it('connects with one code and the relay stores no plaintext', async () => {
    const relay = createSignalRelay({ token: TOKEN });
    const stored: string[] = [];
    const fetchFn = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      if (req.method === 'POST') stored.push(new TextDecoder().decode(new Uint8Array(await req.clone().arrayBuffer())));
      return relay.handle(req);
    }) as typeof fetch;
    const transport = () => new MailboxTransport(new RelayClient({ url: 'https://relay.example', token: TOKEN }, fetchFn), 'https://relay.example');
    const r = await runShare(transport);
    expect(r.offer.invite?.title).toBe(TITLE);
    expect(r.states.at(-1)).toEqual({ phase: 'done' });
    expect(r.hostSas).toBe(r.guestSas);
    expect(stored.length).toBeGreaterThanOrEqual(4);
    for (const s of stored) for (const p of [...PLAINTEXT, r.h.code.value, r.h.code.password]) expect(s).not.toContain(p);
    relay.close();
  });
});

// ---- A local ntfy-compatible server ---------------------------------------------------------------

interface Msg { id: string; time: number; event: 'message'; topic: string; message: string }

function fakeNtfy(opts: { dropFirstStreamAfter?: number } = {}) {
  const topics = new Map<string, Msg[]>();
  const streams = new Map<string, Set<(m: Msg) => void>>();
  let n = 0;
  let streamsOpened = 0;
  const posted: string[] = [];
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    res.setHeader('access-control-allow-origin', '*');
    if (req.method === 'POST' && parts.length === 1) {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        if (Buffer.byteLength(body) > 4096) return void res.writeHead(413).end();
        const m: Msg = { id: `m${++n}`, time: Math.floor(Date.now() / 1000), event: 'message', topic: parts[0]!, message: body };
        posted.push(body);
        (topics.get(m.topic) ?? topics.set(m.topic, []).get(m.topic)!).push(m);
        for (const s of streams.get(m.topic) ?? []) s(m);
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(m));
      });
      return;
    }
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'json') {
      const topic = parts[0]!;
      const since = url.searchParams.get('since');
      const all = topics.get(topic) ?? [];
      let backlog: Msg[] = [];
      if (since === '10m' || since === 'all') backlog = all;
      else if (since && /^m\d+$/.test(since)) backlog = all.slice(all.findIndex((m) => m.id === since) + 1);
      else if (since && /^\d+$/.test(since)) backlog = all.filter((m) => m.time >= Number(since));
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      if (url.searchParams.get('poll') === '1') return void res.end(backlog.map((m) => JSON.stringify(m) + '\n').join(''));
      const which = ++streamsOpened;
      res.write(JSON.stringify({ id: 'o', time: Math.floor(Date.now() / 1000), event: 'open', topic }) + '\n');
      let sent = 0;
      const push = (m: Msg) => {
        res.write(JSON.stringify(m) + '\n');
        // Simulate a dropped connection (mobile network switch) on the first stream.
        if (which === 1 && opts.dropFirstStreamAfter !== undefined && ++sent >= opts.dropFirstStreamAfter) res.destroy();
      };
      for (const m of backlog) push(m);
      const set = streams.get(topic) ?? streams.set(topic, new Set()).get(topic)!;
      set.add(push);
      req.on('close', () => set.delete(push));
      return;
    }
    res.writeHead(404).end();
  });
  return {
    posted,
    get streamsOpened() {
      return streamsOpened;
    },
    async start(): Promise<string> {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => new Promise<void>((r) => {
      server.closeAllConnections();
      server.close(() => r());
    }),
  };
}

describe('ntfy as the relay', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => {
    await stop?.();
    stop = null;
  });

  it('streams messages, reconnects after a drop without losing or repeating any, and reports busy rooms', async () => {
    const ntfy = fakeNtfy({ dropFirstStreamAfter: 1 });
    const url = await ntfy.start();
    stop = ntfy.close;
    const t = new NtfyTransport(url);
    const ac = new AbortController();
    const got: string[] = [];
    expect(await t.busy('iw1room')).toBe(false);
    await t.subscribe('iw1room', (m) => got.push(m), ac.signal);
    await t.post('iw1room', 'one');
    // The stream drops after "one"; "two" is posted while it reconnects.
    await new Promise((r) => setTimeout(r, 50));
    await t.post('iw1room', 'two');
    await t.post('iw1room', 'three');
    for (let i = 0; i < 300 && got.length < 3; i++) await new Promise((r) => setTimeout(r, 10));
    expect(got).toEqual(['one', 'two', 'three']);
    expect(ntfy.streamsOpened).toBeGreaterThanOrEqual(2);
    expect(await t.busy('iw1room')).toBe(true);
    ac.abort();
  });

  it('fails clearly when the relay can’t be reached', async () => {
    const t = new NtfyTransport('http://127.0.0.1:9');
    await expect(t.subscribe('iw1room', () => {}, new AbortController().signal)).rejects.toThrow(/Couldn’t reach the relay/);
  });

  it('carries a whole short-code share within ntfy’s message limit, with no plaintext', async () => {
    const ntfy = fakeNtfy();
    const url = await ntfy.start();
    stop = ntfy.close;
    const r = await runShare(() => new NtfyTransport(url));
    expect(r.states.at(-1)).toEqual({ phase: 'done' });
    expect(r.hostSas).toBe(r.guestSas);
    for (const s of ntfy.posted) {
      expect(Buffer.byteLength(s)).toBeLessThanOrEqual(4096);
      for (const p of [...PLAINTEXT, r.h.code.value, r.h.code.password]) expect(s).not.toContain(p);
    }
  });
});
