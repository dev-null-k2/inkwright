import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSignalRelay } from '../../mcp-server/src/signal.ts';

/**
 * Relays for the short-code specs, run by the test itself on 127.0.0.1 so no spec contacts a
 * public service. Each records every message posted to it — exactly what an operator would see.
 */
export interface LocalRelay {
  url: string;
  /** Bodies of every message posted, as the relay stored them. */
  posted: string[];
  close(): Promise<void>;
}

const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const stop = (server: Server) => () => new Promise<void>((r) => {
  server.closeAllConnections();
  server.close(() => r());
});

/**
 * The subset of ntfy's HTTP API the app uses (as on ntfy.sh): `POST /<topic>`, the
 * `GET /<topic>/json` stream with an `open` event and `since=`, and `poll=1`. Messages over
 * 4096 bytes are refused, as ntfy.sh would turn them into attachments.
 */
export async function startNtfy(): Promise<LocalRelay> {
  interface Msg { id: string; time: number; event: 'message'; topic: string; message: string }
  const topics = new Map<string, Msg[]>();
  const streams = new Map<string, Set<(m: Msg) => void>>();
  const posted: string[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const parts = url.pathname.split('/').filter(Boolean);
    if (req.method === 'OPTIONS') return void res.writeHead(204, CORS).end();
    if (req.method === 'POST' && parts.length === 1) {
      let body = '';
      req.setEncoding('utf8');
      req.on('data', (c: string) => (body += c));
      req.on('end', () => {
        if (Buffer.byteLength(body) > 4096) return void res.writeHead(413, CORS).end();
        const m: Msg = { id: `m${++n}`, time: Math.floor(Date.now() / 1000), event: 'message', topic: parts[0]!, message: body };
        posted.push(body);
        (topics.get(m.topic) ?? topics.set(m.topic, []).get(m.topic)!).push(m);
        for (const s of streams.get(m.topic) ?? []) s(m);
        res.writeHead(200, { ...CORS, 'content-type': 'application/json' }).end(JSON.stringify(m));
      });
      return;
    }
    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'json') {
      const topic = parts[0]!;
      const since = url.searchParams.get('since');
      const all = topics.get(topic) ?? [];
      const backlog = since === '10m' ? all.filter((m) => Date.now() / 1000 - m.time < 600) : since && /^m\d+$/.test(since) ? all.slice(all.findIndex((m) => m.id === since) + 1) : since && /^\d+$/.test(since) ? all.filter((m) => m.time >= Number(since)) : [];
      res.writeHead(200, { ...CORS, 'content-type': 'application/x-ndjson', 'cache-control': 'no-store' });
      if (url.searchParams.get('poll') === '1') return void res.end(backlog.map((m) => `${JSON.stringify(m)}\n`).join(''));
      res.write(`${JSON.stringify({ id: 'open', time: Math.floor(Date.now() / 1000), event: 'open', topic })}\n`);
      const push = (m: Msg) => res.write(`${JSON.stringify(m)}\n`);
      backlog.forEach(push);
      const set = streams.get(topic) ?? streams.set(topic, new Set()).get(topic)!;
      set.add(push);
      req.on('close', () => set.delete(push));
      return;
    }
    res.writeHead(404, CORS).end();
  });
  return { url: await listen(server), posted, close: stop(server) };
}

async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** The real `inkwright-mcp --signal-token` mailbox (apps/mcp-server/src/signal.ts) on a socket. */
export async function startMailbox(token: string): Promise<LocalRelay> {
  const relay = createSignalRelay({ token });
  const posted: string[] = [];
  const server = createServer(async (req, res) => {
    const b = req.method === 'POST' ? await body(req) : undefined;
    if (b) posted.push(b.toString('utf8'));
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v);
    const ac = new AbortController();
    res.on('close', () => ac.abort());
    const out = await relay.handle(new Request(`http://127.0.0.1${req.url}`, { method: req.method, headers, ...(b ? { body: new Uint8Array(b) } : {}), signal: ac.signal }));
    res.writeHead(out.status, Object.fromEntries(out.headers));
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  const url = await listen(server);
  return { url, posted, close: async () => { relay.close(); await stop(server)(); } };
}
