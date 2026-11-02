/**
 * Serves `/api/v1/*` as web `Request` → `Response`:
 *
 * 1. CORS (only for origins the operator allowed with `--cors-origin`), including preflight;
 * 2. public documents: `/api/v1/openapi.json` and the docs page `/api/v1/docs`;
 * 3. routing (404 / 405 with `Allow`);
 * 4. authentication — an API key, the server token, an OAuth JWT, or (loopback mode only) a
 *    request from this computer — and the operation's scope (403 `insufficient_scope`);
 * 5. rate limiting per caller; 6. validation of path, query and JSON body (400 with every
 *    problem listed); 7. `Idempotency-Key`; 8. the handler, ETags and `If-None-Match`;
 * 9. errors as RFC 9457 problem details.
 */
import { looksLikeApiKey, type ApiScope } from '@inkwright/core';
import type { AuthGate } from '../auth.ts';
import { API_PREFIX, ApiError, etagMatches, parseEtags, problemBody, zodErrors, type ApiRequest, type ApiResult, type HttpMethod, type Principal, type RouteDef } from './core.ts';
import { IdempotencyStore, RateLimiter } from './limits.ts';
import { buildOpenApi, type OpenApiOptions } from './openapi.ts';
import { docsPage } from './docs-page.ts';
import type { KeyStore } from './keys.ts';

export interface ApiRouterOptions {
  routes: RouteDef[];
  keys: KeyStore;
  gate: AuthGate;
  /** Public base URL of the server (no path). */
  publicUrl: string;
  /** OAuth scope names, in OAuth mode. */
  oauthScopes?: { read: string; write: string; issuer: string } | null;
  /** Origins allowed to call the API from browsers (`*` for any). Default: none. */
  corsOrigins?: string[];
  /** Requests per minute per caller (default 600). */
  rateLimit?: number;
  clock?: () => number;
  maxBodyBytes?: number;
  log?: (msg: string) => void;
}

export interface ApiRouter {
  handle(req: Request): Promise<Response>;
  /** The OpenAPI document (what /api/v1/openapi.json serves). */
  openapi(): Record<string, unknown>;
}

const ALL_SCOPES: ApiScope[] = ['notes:read', 'notes:write', 'routines:run', 'webhooks', 'admin', 'federation:search'];

interface Compiled {
  route: RouteDef;
  re: RegExp;
  names: string[];
}

function compile(route: RouteDef): Compiled {
  const names: string[] = [];
  const pattern = route.path
    .split(/(\{\w+\})/)
    .map((part) => {
      const m = /^\{(\w+)\}$/.exec(part);
      if (!m) return part.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
      names.push(m[1]!);
      return '([^/]+)';
    })
    .join('');
  return { route, re: new RegExp(`^${pattern}$`), names };
}

export function createApiRouter(o: ApiRouterOptions): ApiRouter {
  const clock = o.clock ?? Date.now;
  const compiled = o.routes.map(compile);
  const limiter = new RateLimiter(o.rateLimit ?? 600, 60_000, clock);
  const idempotency = new IdempotencyStore(clock);
  const baseUrl = `${o.publicUrl.replace(/\/+$/, '')}${API_PREFIX}`;
  const openApiOpts: OpenApiOptions = { serverUrl: baseUrl, oauth: o.oauthScopes ? { issuer: o.oauthScopes.issuer, readScope: o.oauthScopes.read, writeScope: o.oauthScopes.write } : null };
  let doc: Record<string, unknown> | null = null;
  const openapi = () => (doc ??= buildOpenApi(o.routes, openApiOpts));
  const maxBody = o.maxBodyBytes ?? 4 * 1024 * 1024;
  const cors = o.corsOrigins ?? [];

  const corsHeaders = (req: Request): Record<string, string> => {
    const origin = req.headers.get('origin');
    if (!origin || !cors.length) return {};
    const allowed = cors.includes('*') ? '*' : cors.includes(origin) ? origin : null;
    if (!allowed) return {};
    return {
      'access-control-allow-origin': allowed,
      'access-control-expose-headers': 'etag, location, ratelimit, ratelimit-policy, retry-after, idempotent-replayed',
      ...(allowed === '*' ? {} : { vary: 'origin' }),
    };
  };

  const problem = (req: Request, e: ApiError, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(problemBody(e, new URL(req.url).pathname)), { status: e.status, headers: { 'content-type': 'application/problem+json', ...corsHeaders(req), ...e.headers, ...extra } });

  async function authenticate(req: Request): Promise<Principal> {
    const m = /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim());
    const bearer = m?.[1]?.trim();
    if (bearer && looksLikeApiKey(bearer)) {
      const v = await o.keys.verify(bearer);
      if (!v.ok) throw new ApiError('unauthorized', v.reason === 'revoked' ? 'This API key was revoked.' : v.reason === 'expired' ? 'This API key has expired.' : 'Unknown API key.', { headers: { 'www-authenticate': 'Bearer realm="inkwright", error="invalid_token"' } });
      return { id: `key:${v.record.id}`, label: `${v.record.name} (API)`, scopes: new Set(v.record.scopes) };
    }
    if (o.gate.mode === 'loopback') {
      if (bearer) throw new ApiError('unauthorized', 'Unknown API key.', { headers: { 'www-authenticate': 'Bearer realm="inkwright", error="invalid_token"' } });
      const check = await o.gate.check(req, '/mcp');
      if (!check.ok) throw new ApiError('forbidden', 'Without an API key, only programs on this computer may call the API (the Host and Origin must be loopback).');
      return { id: 'loopback', label: 'This computer (API)', scopes: new Set(ALL_SCOPES) };
    }
    if (!bearer) throw new ApiError('unauthorized', 'Send an API key as "Authorization: Bearer ink_…".', { headers: { 'www-authenticate': 'Bearer realm="inkwright"' } });
    const check = await o.gate.check(req, '/mcp');
    if (!check.ok) {
      const challenge = check.response.headers.get('www-authenticate');
      throw new ApiError(check.response.status === 403 ? 'insufficient_scope' : 'unauthorized', o.gate.mode === 'oauth' ? 'The access token was not accepted.' : 'Wrong API key or token.', { status: check.response.status === 403 ? 403 : 401, headers: challenge ? { 'www-authenticate': challenge } : {} });
    }
    if (o.gate.mode === 'token') return { id: 'token', label: 'Server token (API)', scopes: new Set(ALL_SCOPES) };
    const s = o.oauthScopes!;
    const granted = new Set<ApiScope>();
    if (check.auth?.scopes.includes(s.read)) granted.add('notes:read');
    if (check.auth?.scopes.includes(s.write)) for (const x of ['notes:write', 'routines:run', 'webhooks'] as const) granted.add(x);
    const sub = (check.auth?.extra as { sub?: string } | undefined)?.sub ?? check.auth?.clientId ?? 'oauth';
    return { id: `oauth:${sub}`, label: `${check.auth?.clientId ?? 'OAuth client'} (API)`, scopes: granted };
  }

  async function readBody(req: Request): Promise<unknown> {
    const type = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > maxBody) throw new ApiError('payload_too_large', `Request bodies may be at most ${maxBody} bytes.`);
    const text = await req.text();
    if (text.length > maxBody) throw new ApiError('payload_too_large', `Request bodies may be at most ${maxBody} bytes.`);
    if (!text.trim()) return undefined;
    if (type !== 'application/json' && !type.endsWith('+json')) throw new ApiError('unsupported_media_type', 'Send the body as JSON with "Content-Type: application/json".');
    try {
      return JSON.parse(text);
    } catch (e) {
      throw new ApiError('invalid_request', `The body is not valid JSON: ${(e as Error).message}`);
    }
  }

  function toResponse(req: Request, r: ApiResult, extra: Record<string, string>): Response {
    const headers: Record<string, string> = { ...corsHeaders(req), ...extra, ...(r.headers ?? {}) };
    if (r.etag) headers.etag = r.etag;
    if (r.etag && req.method === 'GET') {
      const inm = parseEtags(req.headers.get('if-none-match'));
      if (inm && etagMatches(inm, r.etag)) return new Response(null, { status: 304, headers });
    }
    if (r.status === 204 || (r.body === undefined && r.raw === undefined)) return new Response(null, { status: r.status, headers });
    if (r.raw !== undefined) {
      headers['content-type'] = r.contentType ?? 'application/octet-stream';
      return new Response(r.raw as BodyInit, { status: r.status, headers });
    }
    headers['content-type'] = 'application/json';
    return new Response(JSON.stringify(r.body), { status: r.status, headers });
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const sub = url.pathname.slice(API_PREFIX.length) || '/';
    if (req.method === 'OPTIONS') {
      const h = corsHeaders(req);
      if (!h['access-control-allow-origin']) return new Response(null, { status: 204 });
      return new Response(null, { status: 204, headers: { ...h, 'access-control-allow-methods': 'GET, POST, PATCH, DELETE, OPTIONS', 'access-control-allow-headers': 'authorization, content-type, idempotency-key, if-match, if-none-match', 'access-control-max-age': '600' } });
    }
    try {
      if (req.method === 'GET' && sub === '/openapi.json') return new Response(JSON.stringify(openapi(), null, 1), { headers: { 'content-type': 'application/json', 'cache-control': 'no-cache', ...corsHeaders(req) } });
      if (req.method === 'GET' && (sub === '/docs' || sub === '/docs/')) return new Response(docsPage(`${API_PREFIX}/openapi.json`), { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:", 'x-content-type-options': 'nosniff' } });
      if (req.method === 'GET' && sub === '/') return new Response(JSON.stringify({ name: 'Inkwright API', version: 'v1', openapi: `${baseUrl}/openapi.json`, docs: `${baseUrl}/docs` }), { headers: { 'content-type': 'application/json', ...corsHeaders(req) } });

      const matches = compiled.map((c) => ({ c, m: c.re.exec(sub) })).filter((x) => x.m);
      if (!matches.length) throw new ApiError('not_found', `No API operation at ${url.pathname}. See ${baseUrl}/docs.`);
      const hit = matches.find((x) => x.c.route.method === req.method);
      if (!hit) throw new ApiError('method_not_allowed', `${req.method} is not supported here.`, { headers: { allow: [...new Set(matches.map((x) => x.c.route.method))].join(', ') } });
      const { route, names } = hit.c;

      const principal = await authenticate(req);
      const rl = limiter.take(principal.id);
      const rlHeaders = limiter.headers(rl);
      if (!rl.allowed) throw new ApiError('rate_limited', `Too many requests: at most ${rl.limit} a minute. Retry in ${rl.resetSec} s.`, { headers: { ...rlHeaders, 'retry-after': String(rl.resetSec) } });
      if (route.scope && !principal.scopes.has(route.scope)) {
        throw new ApiError('insufficient_scope', `This operation needs the "${route.scope}" scope; this key has ${[...principal.scopes].map((s) => `"${s}"`).join(', ') || 'none'}.`, { headers: { ...rlHeaders, 'www-authenticate': `Bearer realm="inkwright", error="insufficient_scope", scope="${route.scope}"` } });
      }

      const rawParams = Object.fromEntries(names.map((n, i) => [n, decodeURIComponent(hit.m![i + 1]!)]));
      const errors: { path: string; message: string }[] = [];
      let params: unknown = rawParams;
      if (route.params) {
        const p = route.params.safeParse(rawParams);
        if (p.success) params = p.data;
        else errors.push(...zodErrors('path', p.error));
      }
      let query: unknown = Object.fromEntries(url.searchParams);
      if (route.query) {
        const q = route.query.safeParse(query);
        if (q.success) query = q.data;
        else errors.push(...zodErrors('query', q.error));
      }
      let body: unknown;
      if (route.body) {
        const raw = await readBody(req);
        const b = route.body.safeParse(raw ?? {});
        if (b.success) body = b.data;
        else errors.push(...zodErrors('body', b.error));
      }
      if (errors.length) throw new ApiError('invalid_request', errors.length === 1 ? `${errors[0]!.path}: ${errors[0]!.message}` : `${errors.length} problems with the request.`, { errors, headers: rlHeaders });

      const apiReq: ApiRequest = { method: req.method as HttpMethod, url, params: params as Record<string, string>, query: query as Record<string, unknown>, body, headers: req.headers, principal, ifMatch: route.conditional ? parseEtags(req.headers.get('if-match')) : null, baseUrl };
      const key = route.idempotent ? req.headers.get('idempotency-key') : null;
      let result: ApiResult;
      let replayed = false;
      try {
        if (key) {
          ({ result, replayed } = await idempotency.run(principal.id, key, IdempotencyStore.fingerprint(req.method, url.pathname + url.search, body), () => route.handler(apiReq)));
        } else result = await route.handler(apiReq);
      } catch (e) {
        if (e instanceof ApiError) Object.assign(e.headers, rlHeaders);
        throw e;
      }
      return toResponse(req, result, { ...rlHeaders, ...(replayed ? { 'idempotent-replayed': 'true' } : {}) });
    } catch (e) {
      if (e instanceof ApiError) return problem(req, e);
      o.log?.(`API error on ${req.method} ${url.pathname}: ${(e as Error).stack ?? e}`);
      return problem(req, new ApiError('internal', 'Something went wrong on the server. Its log has the details.'));
    }
  }

  return { handle, openapi };
}
