import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { ServerContext } from './context.ts';
import { createMcpServer } from './server.ts';

export interface HttpOptions {
  /** TCP port; 0 picks a free one. */
  port: number;
  /** When set, every request must carry `Authorization: Bearer <token>`. */
  token?: string;
  /** Endpoint path (default `/mcp`). */
  path?: string;
}

export interface RunningHttpServer {
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

/** Always loopback: exposing a vault to the network is the job of an explicit tunnel + token. */
export const HTTP_HOST = '127.0.0.1';

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

function sendJson(res: ServerResponse, status: number, message: string, headers: Record<string, string> = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message }, id: null }));
}

/**
 * Streamable HTTP transport (stateless: one MCP server per request; the vault context and its
 * caches are shared). Bound to 127.0.0.1 only. Without a token, Host/Origin headers must be
 * loopback to block DNS-rebinding attacks from web pages; with a token (e.g. behind a tunnel for
 * ChatGPT) the bearer check is what guards access.
 */
export async function startHttpServer(ctx: ServerContext, opts: HttpOptions): Promise<RunningHttpServer> {
  const endpoint = opts.path ?? '/mcp';
  const tokenDigest = opts.token ? digest(opts.token) : null;
  let port = opts.port;

  const loopbackHost = (host: string | undefined) => {
    if (!host) return false;
    const h = host.toLowerCase();
    return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`].includes(h);
  };
  const loopbackOrigin = (origin: string) => /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin);

  const handle = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== endpoint) return sendJson(res, 404, `Not found. The MCP endpoint is ${endpoint}.`);
    if (!tokenDigest) {
      if (!loopbackHost(req.headers.host)) return sendJson(res, 403, 'Forbidden host.');
      const origin = req.headers.origin;
      if (origin && !loopbackOrigin(origin)) return sendJson(res, 403, 'Forbidden origin.');
    } else {
      // Header preferred; `?token=` is for clients that cannot set headers (e.g. ChatGPT connectors).
      const m = /^Bearer\s+(.+)$/i.exec((req.headers.authorization ?? '').trim());
      const given = m?.[1]?.trim() ?? url.searchParams.get('token') ?? '';
      if (!given || !timingSafeEqual(digest(given), tokenDigest)) {
        return sendJson(res, 401, 'Unauthorized: missing or wrong bearer token.', { 'www-authenticate': 'Bearer realm="inkstone"' });
      }
    }
    if (req.method !== 'POST') return sendJson(res, 405, 'Method not allowed. This server is stateless: send JSON-RPC with POST.', { allow: 'POST' });

    const server = createMcpServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  };

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => sendJson(res, 500, `Internal error: ${(e as Error).message}`));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, HTTP_HOST, () => {
      server.off('error', reject);
      resolve();
    });
  });
  port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    url: `http://${HTTP_HOST}:${port}${endpoint}`,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
