/**
 * Wires options to running endpoints: the AI (optional), the auth gate, MCP over HTTP and the
 * A2A agent. Shared by `inkstone-mcp --http` and `inkstone-agent run --http`.
 */
import { createA2AApp } from './a2a.ts';
import { createAgentAI, type AgentAI } from './agent/ai.ts';
import type { AuthMode } from './auth.ts';
import type { CliOptions } from './cli.ts';
import type { ServerContext } from './context.ts';
import { startHttpServer, type RunningHttpServer } from './http.ts';
import { createServices, type Scopes, type ServerServices } from './server.ts';

export type Log = (msg: string) => void;

/** Builds the AI from options; logs and returns null when it can't (features that need it say so). */
export function aiFromOptions(o: CliOptions, log: Log, env: NodeJS.ProcessEnv = process.env): AgentAI | null {
  if (!o.ai) return null;
  try {
    const ai = createAgentAI(o.ai, env);
    log(`AI: ${ai.label}${ai.vision ? '' : ' (no vision: handwriting transcription is off)'}`);
    return ai;
  } catch (e) {
    log(`AI not available: ${(e as Error).message}`);
    return null;
  }
}

export function authFromOptions(o: CliOptions): { auth: AuthMode; scopes: Scopes | null } {
  if (o.oauth) {
    const scopes = { read: o.oauth.readScope, write: o.oauth.writeScope };
    return { auth: { kind: 'oauth', settings: { issuer: o.oauth.issuer, ...(o.oauth.audience ? { audience: o.oauth.audience } : {}), ...(o.oauth.jwksUrl ? { jwksUrl: o.oauth.jwksUrl } : {}), scopes } }, scopes };
  }
  if (o.token) return { auth: { kind: 'token', token: o.token }, scopes: null };
  return { auth: { kind: 'loopback' }, scopes: null };
}

export async function serveHttp(ctx: ServerContext, o: CliOptions, ai: AgentAI | null, log: Log, extra: { fetch?: typeof fetch } = {}): Promise<{ http: RunningHttpServer; services: ServerServices }> {
  if (o.http === undefined) throw new Error('No HTTP port.');
  const { auth, scopes } = authFromOptions(o);
  if (auth.kind === 'oauth' && extra.fetch) auth.settings.fetch = extra.fetch;
  const services = createServices(ctx, { ai, transport: 'http', scopes });
  const http = await startHttpServer(services, {
    port: o.http,
    ...(o.host ? { host: o.host } : {}),
    ...(o.publicUrl ? { publicUrl: o.publicUrl } : {}),
    auth,
    ...(o.a2a
      ? {
          a2a: async (publicUrl, gate) => {
            const a2aAuth = auth.kind === 'oauth' ? { kind: 'oauth' as const, issuer: auth.settings.issuer, scopes: scopes!, discoveryUrl: await gate.discoveryUrl().catch(() => undefined) } : auth.kind === 'token' ? { kind: 'token' as const } : { kind: 'none' as const };
            return createA2AApp({ ctx, ai, publicUrl, auth: a2aAuth }, scopes).app;
          },
        }
      : {}),
  });
  const how = auth.kind === 'oauth' ? `OAuth (issuer ${auth.settings.issuer})` : auth.kind === 'token' ? 'bearer token required' : 'no token; loopback clients only';
  log(`MCP (Streamable HTTP, 2026-07-28 + 2025) on ${http.url} — ${how}`);
  if (o.a2a) log(`A2A agent card at ${http.baseUrl}/.well-known/agent-card.json, JSON-RPC at ${http.baseUrl}/a2a${ai ? '' : ' (no AI configured: only structured search works)'}`);
  return { http, services };
}
