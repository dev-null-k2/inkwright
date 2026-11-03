/**
 * Wires options to running endpoints: the AI (optional), the auth gate, MCP over HTTP and the
 * A2A agent. Shared by `inkwright-mcp --http` and `inkwright-agent run --http`.
 */
import { createA2AApp } from './a2a.ts';
import { createApi } from './api/index.ts';
import { createAgentAI, type AgentAI } from './agent/ai.ts';
import type { AuthMode } from './auth.ts';
import type { CliOptions } from './cli.ts';
import type { ServerContext, ServerFeatures } from './context.ts';
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

/**
 * Like `aiFromOptions`, but also connects to the credential executor when the AI is configured
 * with `--ai-credential` (the key then stays in the executor's process; docs/CREDENTIALS.md).
 * Connected apps (connector credentials) become available to routines through the same client.
 */
export async function aiFromOptionsAsync(o: CliOptions, log: Log, env: NodeJS.ProcessEnv = process.env): Promise<AgentAI | null> {
  if (!o.ai?.credential) return aiFromOptions(o, log, env);
  try {
    const { agentAIViaExecutor, connectorToolsViaExecutor } = await import('./creds/agent.ts');
    const ai = await agentAIViaExecutor({ ...o.ai, credential: o.ai.credential }, { ...(o.credentialsDir ? { dir: o.credentialsDir } : {}) });
    log(`AI: ${ai.label} through the credential executor (credential ${o.ai.credential}; this process holds no key)`);
    const client = ai.executor;
    return { ...ai, connectorTools: (refs, actor) => connectorToolsViaExecutor(client, refs, actor), close: () => client.close() };
  } catch (e) {
    log(`AI not available: ${(e as Error).message}`);
    return null;
  }
}

/** Optional server features from options (team search, context tools). */
export async function featuresFromOptions(o: CliOptions, log: Log): Promise<ServerFeatures> {
  let team: ServerFeatures['team'] = null;
  if (o.team) {
    const { loadTeamConfig } = await import('./federation/team.ts');
    team = loadTeamConfig(o.team);
    log(`Team search on: sharing ${[...team.share.notebooks.map((n) => `notebook ${n}`), ...team.share.tags.map((t) => `#${t}`)].join(', ') || 'nothing'} with ${team.peers.length} peer(s)`);
  }
  return { contextTools: o.contextTools, ...(o.originalsDir ? { originalsDir: o.originalsDir } : {}), ...(o.credentialsDir ? { credentialsDir: o.credentialsDir } : {}), team };
}

export function authFromOptions(o: CliOptions): { auth: AuthMode; scopes: Scopes | null } {
  if (o.oauth) {
    const scopes = { read: o.oauth.readScope, write: o.oauth.writeScope };
    return { auth: { kind: 'oauth', settings: { issuer: o.oauth.issuer, ...(o.oauth.audience ? { audience: o.oauth.audience } : {}), ...(o.oauth.jwksUrl ? { jwksUrl: o.oauth.jwksUrl } : {}), scopes } }, scopes };
  }
  if (o.token) return { auth: { kind: 'token', token: o.token }, scopes: null };
  return { auth: { kind: 'loopback' }, scopes: null };
}

export async function serveHttp(ctx: ServerContext, o: CliOptions, ai: AgentAI | null, log: Log, extra: { fetch?: typeof fetch; eventIntervalMs?: number } = {}): Promise<{ http: RunningHttpServer; services: ServerServices }> {
  if (o.http === undefined) throw new Error('No HTTP port.');
  const { auth, scopes } = authFromOptions(o);
  if (auth.kind === 'oauth' && extra.fetch) auth.settings.fetch = extra.fetch;
  const services = createServices(ctx, { ai, transport: 'http', scopes });
  const http = await startHttpServer(services, {
    port: o.http,
    ...(o.host ? { host: o.host } : {}),
    ...(o.publicUrl ? { publicUrl: o.publicUrl } : {}),
    auth,
    ...(o.signalToken ? { signal: { token: o.signalToken } } : {}),
    ...(o.a2a
      ? {
          a2a: async (publicUrl, gate) => {
            const a2aAuth = auth.kind === 'oauth' ? { kind: 'oauth' as const, issuer: auth.settings.issuer, scopes: scopes!, discoveryUrl: await gate.discoveryUrl().catch(() => undefined) } : auth.kind === 'token' ? { kind: 'token' as const } : { kind: 'none' as const };
            return createA2AApp({ ctx, ai, publicUrl, auth: a2aAuth }, scopes).app;
          },
        }
      : {}),
    ...(o.api
      ? {
          api: async (publicUrl, gate) => {
            const api = await createApi({
              ctx,
              services,
              gate,
              publicUrl,
              oauthScopes: auth.kind === 'oauth' ? { read: scopes!.read, write: scopes!.write, issuer: auth.settings.issuer } : null,
              corsOrigins: o.corsOrigins,
              ...(o.rateLimit ? { rateLimit: o.rateLimit } : {}),
              ...(o.stateDir ? { stateDir: o.stateDir } : {}),
              embeddings: o.embeddings ?? null,
              ...(extra.fetch ? { fetch: extra.fetch } : {}),
              ...(extra.eventIntervalMs ? { eventIntervalMs: extra.eventIntervalMs } : {}),
              log,
            });
            return { handle: (req) => api.router.handle(req), close: () => api.close() };
          },
        }
      : {}),
  });
  const how = auth.kind === 'oauth' ? `OAuth (issuer ${auth.settings.issuer})` : auth.kind === 'token' ? 'bearer token required' : 'no token; loopback clients only';
  log(`MCP (Streamable HTTP, 2026-07-28 + 2025) on ${http.url} — ${how}`);
  if (o.signalToken) log(`Peer-link signalling relay at ${http.baseUrl}/signal/v1 (its own token; sealed messages only)`);
  if (o.api) log(`REST API at ${http.baseUrl}/api/v1 — reference at ${http.baseUrl}/api/v1/docs${o.embeddings ? ` (semantic search with ${o.embeddings.model})` : ''}`);
  if (o.a2a) log(`A2A agent card at ${http.baseUrl}/.well-known/agent-card.json, JSON-RPC at ${http.baseUrl}/a2a${ai ? '' : ' (no AI configured: only structured search works)'}`);
  return { http, services };
}
