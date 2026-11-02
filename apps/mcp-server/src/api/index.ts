/**
 * The REST API (`/api/v1`): assembles routes, keys, webhooks, vault events and search into a
 * router that `http.ts` mounts next to MCP and A2A. See docs/API.md.
 */
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { AuthGate } from '../auth.ts';
import type { ServerContext } from '../context.ts';
import type { ServerServices } from '../server.ts';
import { VaultEvents } from './events.ts';
import { KeyStore } from './keys.ts';
import { createApiRouter, type ApiRouter } from './router.ts';
import { createRoutes, type ApiDeps } from './routes.ts';
import { SemanticSearch, type EmbeddingSettings } from './semantic.ts';
import { WebhookService } from './webhooks.ts';

export { API_PREFIX } from './core.ts';
export { buildOpenApi } from './openapi.ts';
export { createRoutes } from './routes.ts';
export { signWebhook, verifyWebhook, RETRY_SCHEDULE_MS } from './webhooks.ts';
export { KeyStore } from './keys.ts';

export interface ApiOptions {
  ctx: ServerContext;
  services: ServerServices;
  gate: AuthGate;
  publicUrl: string;
  oauthScopes?: { read: string; write: string; issuer: string } | null;
  corsOrigins?: string[];
  rateLimit?: number;
  /** Where webhook subscriptions and their delivery log live (default: per vault under ~/.config/inkstone/api). */
  stateDir?: string;
  embeddings?: EmbeddingSettings | null;
  /** Vault scan interval for events (default 5 s). */
  eventIntervalMs?: number;
  fetch?: typeof globalThis.fetch;
  log?: (msg: string) => void;
}

export interface RunningApi {
  router: ApiRouter;
  deps: ApiDeps;
  close(): Promise<void>;
}

/** Default state folder: one per vault, outside the vault (signing secrets must not sync). */
export function defaultStateDir(vaultRoot: string): string {
  const id = createHash('sha256').update(path.resolve(vaultRoot)).digest('hex').slice(0, 12);
  return path.join(homedir(), '.config', 'inkstone', 'api', id);
}

export async function createApi(o: ApiOptions): Promise<RunningApi> {
  const keys = new KeyStore(o.ctx);
  const webhooks = new WebhookService({ stateDir: o.stateDir ?? defaultStateDir(o.ctx.root), clock: o.ctx.clock, ...(o.fetch ? { fetch: o.fetch } : {}), ...(o.log ? { log: o.log } : {}) });
  await webhooks.init();
  const events = new VaultEvents(o.ctx, { intervalMs: o.eventIntervalMs });
  events.on((e) => webhooks.emit(e.type, e.data));
  if (webhooks.list().length) events.start();
  const semantic = o.embeddings ? SemanticSearch.fromSettings(o.ctx, o.embeddings, process.env, o.fetch) : null;
  const deps: ApiDeps = { ctx: o.ctx, services: o.services, keys, webhooks, events, semantic };
  const router = createApiRouter({ routes: createRoutes(deps), keys, gate: o.gate, publicUrl: o.publicUrl, oauthScopes: o.oauthScopes ?? null, corsOrigins: o.corsOrigins ?? [], rateLimit: o.rateLimit, clock: o.ctx.clock, ...(o.log ? { log: o.log } : {}) });
  return {
    router,
    deps,
    async close() {
      events.stop();
      await webhooks.close();
    },
  };
}
