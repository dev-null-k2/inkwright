/**
 * MCP clients for tests, all in-process (no sockets): the server's real HTTP handler
 * (`createMcpHandler`, both eras) behind a `fetch` function, reached by
 * - the 2026-07-28 SDK client (`@modelcontextprotocol/client`, negotiating via server/discover),
 * - the 2025-era SDK client (`@modelcontextprotocol/sdk` v1, `initialize` handshake),
 * - the Inkstone app's own connection class (`McpConnection` from @inkstone/ai), which also
 *   speaks the Tasks extension.
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import { McpConnection, type ElicitHandler } from '@inkstone/ai';
import { createMcpServer, type ServerServices } from '../src/server.ts';

export const MCP_URL = 'http://localhost/mcp';

/** A fetch function serving the MCP endpoint in-process (optionally as an authenticated caller). */
export function mcpFetch(services: ServerServices, authInfo?: AuthInfo) {
  const handler = createMcpHandler((rc) => createMcpServer(services, rc));
  const fetchFn = (input: string | URL | Request, init?: RequestInit) => handler.fetch(input instanceof Request ? input : new Request(input, init), authInfo ? { authInfo } : undefined);
  return Object.assign(fetchFn, { handler });
}

export async function modernClient(services: ServerServices, info: { name: string; version: string; title?: string } = { name: 'test-2026', version: '1.0.0' }, opts: { tasks?: boolean; authInfo?: AuthInfo } = {}): Promise<Client> {
  const client = new Client(info, { versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: { form: {} }, ...(opts.tasks ? { extensions: { 'io.modelcontextprotocol/tasks': {} } } : {}) } as never });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { fetch: mcpFetch(services, opts.authInfo) as never }));
  return client;
}

export async function legacyClient(services: ServerServices, info: { name: string; version: string; title?: string } = { name: 'test-2025', version: '1.0.0' }): Promise<LegacyClient> {
  const client = new LegacyClient(info);
  await client.connect(new LegacyTransport(new URL(MCP_URL), { fetch: mcpFetch(services) as never }));
  return client;
}

/** The app's MCP client (tasks-aware) pointed at the in-process server. */
export async function appConnection(services: ServerServices, onElicit?: ElicitHandler): Promise<McpConnection> {
  const conn = new McpConnection({ id: 'local', name: 'Inkstone', url: MCP_URL, auth: 'none', enabled: true, tools: {}, addedAt: 0 }, { fetch: mcpFetch(services) as never, clientInfo: { name: 'inkstone-app', version: '1.0.0', title: 'Inkstone' }, ...(onElicit ? { onElicit } : {}) });
  await conn.connect();
  return conn;
}

/** JSON in a tool result's first text block. */
export function resultJson(r: { content?: unknown }): any {
  const c = (r.content as Array<{ type: string; text?: string }> | undefined)?.find((x) => x.type === 'text');
  return JSON.parse(c?.text ?? 'null');
}

export function resultText(r: { content?: unknown }): string {
  return ((r.content as Array<{ type: string; text?: string }> | undefined) ?? []).filter((x) => x.type === 'text').map((x) => x.text).join('\n');
}

/** Polls until `fn` returns a truthy value (or throws after `ms`). */
export async function waitFor<T>(fn: () => Promise<T> | T, ms = 5000): Promise<NonNullable<T>> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((r) => setTimeout(r, 15));
  }
}
