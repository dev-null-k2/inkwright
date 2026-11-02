import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { SIGNAL_MAX_BYTES, createSignalRelay, type SignalRelay } from './signal.ts';
import type { AddressInfo } from 'node:net';
import { createMcpHandler, type McpHttpHandler } from '@modelcontextprotocol/server';
import type express from 'express';
import { createAuthGate, isLoopbackHost, type AuthGate, type AuthMode } from './auth.ts';
import { createMcpServer, type ServerServices } from './server.ts';

export interface HttpOptions {
  /** TCP port; 0 picks a free one. */
  port: number;
  /** Interface to listen on (default 127.0.0.1). Anything else requires a token or OAuth. */
  host?: string;
  /** When set, every request must carry `Authorization: Bearer <token>` (shorthand for auth token mode). */
  token?: string;
  /** Full auth mode (overrides `token`). */
  auth?: AuthMode;
  /**
   * The URL clients use to reach this server (behind a tunnel or reverse proxy), e.g.
   * https://notes.example.com. Used for OAuth resource identifiers and the Agent Card.
   * Default: http://<host>:<port>.
   */
  publicUrl?: string;
  /** The A2A app (agent card + JSON-RPC), when A2A is on. Built once the public URL is known. */
  a2a?: (publicUrl: string, gate: AuthGate) => Promise<express.Express> | express.Express;
  /** Largest request body read for MCP (default 4 MiB). */
  maxBodyBytes?: number;
  /** The REST API at /api/v1 (api/index.ts). Built once the public URL and auth gate are known. */
  api?: (publicUrl: string, gate: AuthGate) => Promise<{ handle(req: Request): Promise<Response>; close?(): Promise<void> }>;
  /** The peer-link signalling relay at /signal/v1 (signal.ts), with its own token. */
  signal?: { token: string };
}

export interface RunningHttpServer {
  server: Server;
  /** The MCP endpoint, e.g. http://127.0.0.1:8765/mcp */
  url: string;
  /** Base URL (no path). */
  baseUrl: string;
  port: number;
  gate: AuthGate;
  close(): Promise<void>;
}

/** Default interface: loopback. Exposing a vault to a network takes a token or OAuth. */
export const HTTP_HOST = '127.0.0.1';

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (message: string) => ({ jsonrpc: '2.0', error: { code: -32000, message }, id: null });

function headersOf(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (Array.isArray(v)) for (const x of v) headers.append(k, x);
    else if (v != null) headers.set(k, v);
  }
  return headers;
}

/** The request without its body: enough to authenticate it before reading anything (SR-07). */
function headRequest(req: IncomingMessage): Request {
  return new Request(`http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`, { headers: headersOf(req) });
}

/** Node request → web Request (body read up to `max` bytes; aborts when the client goes away). */
async function toWebRequest(req: IncomingMessage, res: ServerResponse, max: number): Promise<Request> {
  const url = `http://${req.headers.host ?? 'localhost'}${req.url ?? '/'}`;
  const headers = headersOf(req);
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  let body: Buffer | undefined;
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > max) throw Object.assign(new Error('Request body too large'), { status: 413 });
      chunks.push(c as Buffer);
    }
    body = Buffer.concat(chunks);
  }
  return new Request(url, { method: req.method, headers, body: body as BodyInit | undefined, signal: ac.signal });
}

/** Web Response → Node response, streaming SSE bodies as they come. */
async function sendWebResponse(res: ServerResponse, r: Response): Promise<void> {
  const headers: Record<string, string | string[]> = {};
  r.headers.forEach((v, k) => {
    if (k === 'set-cookie') headers[k] = [...((headers[k] as string[]) ?? []), v];
    else headers[k] = v;
  });
  res.writeHead(r.status, headers);
  if (!r.body) return void res.end();
  const reader = r.body.getReader();
  res.on('close', () => void reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  } finally {
    res.end();
  }
}

/**
 * The HTTP face of the server, on one port:
 *
 * - `/mcp` — MCP Streamable HTTP via the SDK's `createMcpHandler`: protocol 2026-07-28
 *   (stateless, per-request `_meta` envelope, `server/discover`) and, for 2025-era clients, the
 *   SDK's stateless legacy fallback — one MCP server per request either way.
 * - `/a2a` and `/.well-known/agent-card.json` — the A2A agent (when enabled).
 * - `/.well-known/oauth-protected-resource[/mcp|/a2a]` — RFC 9728 metadata (OAuth mode).
 * - `/api/v1/*` — the REST API (api/), with its own problem+json errors, keys and scopes.
 *
 * Auth is checked here, before any MCP or A2A code runs (see auth.ts for the three modes).
 */
export async function startHttpServer(services: ServerServices, opts: HttpOptions): Promise<RunningHttpServer> {
  const host = opts.host ?? HTTP_HOST;
  const auth: AuthMode = opts.auth ?? (opts.token ? { kind: 'token', token: opts.token } : { kind: 'loopback' });
  if (auth.kind === 'loopback' && !isLoopbackHost(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host)) {
    throw new Error(`Listening on ${host} exposes your notes to the network: set a token (--token) or OAuth (--oauth-issuer) first.`);
  }
  const max = opts.maxBodyBytes ?? 4 * 1024 * 1024;
  let port = opts.port;
  let publicUrl = opts.publicUrl?.replace(/\/+$/, '') ?? '';
  let gate: AuthGate = createAuthGate(auth, { publicUrl: publicUrl || `http://${HTTP_HOST}:${port || 1}`, port: () => port });
  let a2a: express.Express | null = null;
  let api: { handle(req: Request): Promise<Response>; close?(): Promise<void> } | null = null;
  const signal: SignalRelay | null = opts.signal ? createSignalRelay({ token: opts.signal.token }) : null;

  const mcp: McpHttpHandler = createMcpHandler((rc) => createMcpServer(services, rc), { legacy: 'stateless', maxRequestBodySize: max, onerror: (e) => { if (process.env.INKWRIGHT_DEBUG) process.stderr.write(`[inkwright-mcp] ${e.message}\n`); } });

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname;
    // Liveness for containers and load balancers: no auth, and nothing about the vault.
    if (path === '/healthz') return sendJson(res, 200, { ok: true }, { 'cache-control': 'no-store' });
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      const doc = await gate.resourceMetadata(path);
      return doc ? sendJson(res, 200, doc, { 'access-control-allow-origin': '*', 'cache-control': 'public, max-age=300' }) : sendJson(res, 404, { error: 'not_found', error_description: 'This server does not use OAuth.' });
    }
    if (path === '/.well-known/agent-card.json' || path === '/a2a') {
      if (!a2a) return sendJson(res, 404, rpcError('A2A is not enabled on this server (start it with --a2a).'));
      if (path === '/a2a') {
        const check = await gate.check(new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { headers: req.headers as Record<string, string> }), '/a2a');
        if (!check.ok) return sendWebResponse(res, check.response);
        (req as IncomingMessage & { inkwrightAuth?: unknown }).inkwrightAuth = check.auth;
      } else if (gate.mode === 'loopback') {
        const check = await gate.check(new Request(`http://${req.headers.host ?? 'localhost'}${req.url}`, { headers: req.headers as Record<string, string> }), '/a2a');
        if (!check.ok) return sendWebResponse(res, check.response);
      }
      if (path.startsWith('/.well-known/')) res.setHeader('access-control-allow-origin', '*');
      return void a2a(req as never, res as never);
    }
    if (path.startsWith('/signal/v1/')) {
      // Separate token, no vault access: see signal.ts.
      if (!signal) return sendJson(res, 404, { error: 'Signalling is off on this server (start it with --signal-token).' });
      let request: Request;
      try {
        request = await toWebRequest(req, res, SIGNAL_MAX_BYTES);
      } catch (e) {
        return sendJson(res, (e as { status?: number }).status ?? 400, { error: (e as Error).message });
      }
      return sendWebResponse(res, await signal.handle(request));
    }
    if (path === '/api/v1' || path.startsWith('/api/v1/')) {
      if (!api) return sendJson(res, 404, { type: 'about:blank', title: 'Not found', status: 404, detail: 'The REST API is off on this server.' }, { 'content-type': 'application/problem+json' });
      let request: Request;
      try {
        request = await toWebRequest(req, res, max);
      } catch (e) {
        return sendJson(res, (e as { status?: number }).status ?? 400, { title: 'Bad request', status: 400, detail: (e as Error).message }, { 'content-type': 'application/problem+json' });
      }
      return sendWebResponse(res, await api.handle(request));
    }
    if (path !== '/mcp') return sendJson(res, 404, rpcError('Not found. The MCP endpoint is /mcp.'));
    // Who is asking is decided by headers alone, so check it before buffering a body: anonymous
    // requests cost the server nothing (security review SR-07).
    const check = await gate.check(headRequest(req), '/mcp');
    if (!check.ok) return sendWebResponse(res, check.response);
    let request: Request;
    try {
      request = await toWebRequest(req, res, max);
    } catch (e) {
      return sendJson(res, (e as { status?: number }).status ?? 400, rpcError((e as Error).message));
    }
    const response = await mcp.fetch(request, check.auth ? { authInfo: check.auth } : undefined);
    await sendWebResponse(res, response);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => sendJson(res, 500, rpcError(`Internal error: ${(e as Error).message}`)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, host, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  const shownHost = host.includes(':') ? `[${host}]` : host === '0.0.0.0' ? HTTP_HOST : host;
  const baseUrl = `http://${shownHost}:${port}`;
  publicUrl ||= baseUrl;
  gate = createAuthGate(auth, { publicUrl, port: () => port });
  if (opts.a2a) a2a = await opts.a2a(publicUrl, gate);
  if (opts.api) api = await opts.api(publicUrl, gate);
  return {
    server,
    port,
    baseUrl,
    url: `${baseUrl}/mcp`,
    gate,
    close: async () => {
      await mcp.close().catch(() => {});
      await api?.close?.().catch(() => {});
      signal?.close();
      await new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      });
    },
  };
}
