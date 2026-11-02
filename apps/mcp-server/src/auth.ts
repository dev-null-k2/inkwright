/**
 * Who may use the HTTP endpoints (MCP at /mcp, A2A at /a2a). Three modes, none of which needs a
 * hosted service of ours:
 *
 * - **loopback** (no token, no OAuth): only this computer — requests whose Host and Origin are
 *   loopback addresses. Blocks web pages that try to reach the port through DNS rebinding.
 * - **token**: a shared secret (`--token` / INKWRIGHT_MCP_TOKEN) as `Authorization: Bearer …`
 *   (or `?token=` for connectors that can't set headers). For tunnels and simple setups.
 * - **oauth**: an OAuth 2.1 resource server. Access tokens are JWTs (RFC 9068) from an
 *   authorization server *the user runs or chooses* — their own IdP (Keycloak, Authentik, Auth0,
 *   Okta, Entra ID, Zitadel, …). The server publishes Protected Resource Metadata (RFC 9728) at
 *   `/.well-known/oauth-protected-resource/mcp` pointing clients at that issuer, answers 401
 *   with a `WWW-Authenticate` challenge naming it, validates signature (the issuer's JWKS),
 *   issuer, audience (RFC 8707 resource = this server's URL), expiry and scopes. Reading needs
 *   the read scope; write tools answer a step-up `insufficient_scope` challenge without the
 *   write scope.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, customFetch, jwtVerify, type JWTPayload } from 'jose';
import { OAuthError, OAuthErrorCode, bearerAuthChallengeResponse, verifyBearerToken, type AuthInfo, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import type { Scopes } from './server.ts';

export interface OAuthSettings {
  /** The authorization server's issuer URL (exactly as in its tokens' `iss`). */
  issuer: string;
  /** Accepted token audiences; default: the public MCP and A2A URLs and the public origin. */
  audience?: string[];
  /** JWKS URL; default: discovered from the issuer's metadata. */
  jwksUrl?: string;
  scopes: Scopes;
  /** Fetch used for discovery and JWKS (tests). */
  fetch?: typeof globalThis.fetch;
}

export type AuthMode = { kind: 'loopback' } | { kind: 'token'; token: string } | { kind: 'oauth'; settings: OAuthSettings };

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function digest(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}

/** True for 127.0.0.0/8, localhost and ::1 host names (with or without a port). */
export function isLoopbackHost(host: string | null | undefined): boolean {
  if (!host) return false;
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return h === 'localhost' || h === '[::1]' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

const loopbackOrigin = (origin: string) => /^https?:\/\/(127\.\d+\.\d+\.\d+|localhost|\[::1\])(:\d+)?$/i.test(origin);

// ---- Issuer discovery & JWT verification ---------------------------------------------------------

export interface IssuerMetadata {
  issuer: string;
  jwks_uri?: string;
  /** Where the metadata was found (an OIDC discovery or RFC 8414 document). */
  discoveryUrl: string;
  [k: string]: unknown;
}

/** RFC 8414 / OIDC discovery URLs for an issuer, in the order clients try them. */
export function discoveryUrls(issuer: string): string[] {
  const u = new URL(issuer);
  const path = u.pathname.replace(/\/+$/, '');
  return [
    `${u.origin}/.well-known/oauth-authorization-server${path}`,
    `${u.origin}/.well-known/openid-configuration${path}`,
    `${u.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** Fetches the issuer's metadata and checks it names the same issuer. */
export async function discoverIssuer(issuer: string, fetchFn: typeof globalThis.fetch = globalThis.fetch): Promise<IssuerMetadata> {
  const want = issuer.replace(/\/+$/, '');
  const errors: string[] = [];
  for (const url of [...new Set(discoveryUrls(issuer))]) {
    try {
      const res = await fetchFn(url, { headers: { accept: 'application/json' } });
      if (!res.ok) {
        errors.push(`${url}: ${res.status}`);
        continue;
      }
      const m = (await res.json()) as IssuerMetadata;
      if (String(m.issuer ?? '').replace(/\/+$/, '') !== want) {
        errors.push(`${url}: issuer is ${m.issuer}, expected ${issuer}`);
        continue;
      }
      return { ...m, discoveryUrl: url };
    } catch (e) {
      errors.push(`${url}: ${(e as Error).message}`);
    }
  }
  throw new Error(`Could not read the authorization server metadata for ${issuer} (${errors.join('; ')}).`);
}

/** Scopes from the usual claims: `scope` (space-separated), `scp` (array or string), Auth0 `permissions`. */
export function scopesOf(p: JWTPayload): string[] {
  const out = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === 'string') {
      for (const s of v.split(/\s+/)) if (s) out.add(s);
    } else if (Array.isArray(v)) {
      for (const s of v) if (typeof s === 'string' && s) out.add(s);
    }
  };
  add(p.scope);
  add((p as Record<string, unknown>).scp);
  add((p as Record<string, unknown>).permissions);
  return [...out];
}

/**
 * Verifies JWT access tokens against the issuer's keys. The JWKS is fetched lazily and cached by
 * jose (re-fetched when a token names an unknown key, so key rotation just works).
 */
export function createJwtVerifier(s: OAuthSettings & { audience: string[]; resource: URL }): OAuthTokenVerifier & { metadata(): Promise<IssuerMetadata | null> } {
  let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  let meta: IssuerMetadata | null = null;
  const fetchFn = s.fetch ?? globalThis.fetch;
  const keys = async () => {
    if (jwks) return jwks;
    let url = s.jwksUrl;
    if (!url) {
      meta = await discoverIssuer(s.issuer, fetchFn);
      url = meta.jwks_uri;
      if (!url) throw new Error(`${s.issuer} does not publish a jwks_uri; pass --oauth-jwks-url.`);
    }
    jwks = createRemoteJWKSet(new URL(url), { [customFetch]: (u: string, init: RequestInit) => fetchFn(u, init) } as never);
    return jwks;
  };
  return {
    async metadata() {
      if (!meta && !s.jwksUrl) await keys().catch(() => null);
      return meta;
    },
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, await keys(), { issuer: s.issuer, audience: s.audience, requiredClaims: ['exp'], clockTolerance: 60 }));
      } catch (e) {
        const msg = (e as { code?: string; message?: string }).code === 'ERR_JWT_EXPIRED' ? 'The access token has expired.' : `Invalid access token: ${(e as Error).message}`;
        throw new OAuthError(OAuthErrorCode.InvalidToken, msg);
      }
      const p = payload as JWTPayload & { azp?: string; client_id?: string; cid?: string };
      return {
        token,
        clientId: p.azp ?? p.client_id ?? p.cid ?? 'unknown-client',
        scopes: scopesOf(payload),
        expiresAt: payload.exp,
        resource: s.resource,
        extra: { sub: payload.sub, iss: payload.iss },
      };
    },
  };
}

// ---- The gate --------------------------------------------------------------------------------------

export interface AuthGate {
  readonly mode: AuthMode['kind'];
  /** The verified caller (undefined in loopback/token mode), or the error response to send. */
  check(req: Request, resourcePath: '/mcp' | '/a2a'): Promise<{ ok: true; auth?: AuthInfo } | { ok: false; response: Response }>;
  /** Protected Resource Metadata (RFC 9728) for the given request path, or null when not OAuth. */
  resourceMetadata(pathname: string): Promise<Record<string, unknown> | null>;
  /** The issuer's discovery URL (agent card), once known. */
  discoveryUrl(): Promise<string | undefined>;
}

/** Public URL of a resource path, e.g. https://notes.example.com/mcp. */
export const resourceUrl = (publicUrl: string, path: string) => `${publicUrl.replace(/\/+$/, '')}${path}`;

/** RFC 9728 metadata URL for a resource URL: /.well-known/oauth-protected-resource inserted before the path. */
export function metadataUrlFor(resource: string): string {
  const u = new URL(resource);
  return `${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`;
}

export function createAuthGate(mode: AuthMode, opts: { publicUrl: string; port: () => number }): AuthGate {
  if (mode.kind === 'loopback') {
    return {
      mode: 'loopback',
      async check(req) {
        if (!isLoopbackHost(req.headers.get('host'))) return { ok: false, response: json(403, { jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden host.' }, id: null }) };
        const origin = req.headers.get('origin');
        if (origin && !loopbackOrigin(origin)) return { ok: false, response: json(403, { jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden origin.' }, id: null }) };
        return { ok: true };
      },
      async resourceMetadata() { return null; },
      async discoveryUrl() { return undefined; },
    };
  }
  if (mode.kind === 'token') {
    const want = digest(mode.token);
    return {
      mode: 'token',
      async check(req) {
        // Header preferred; `?token=` is for clients that cannot set headers (e.g. some connectors).
        const m = /^Bearer\s+(.+)$/i.exec((req.headers.get('authorization') ?? '').trim());
        const given = m?.[1]?.trim() ?? new URL(req.url).searchParams.get('token') ?? '';
        if (!given || !timingSafeEqual(digest(given), want)) {
          return { ok: false, response: json(401, { jsonrpc: '2.0', error: { code: -32000, message: 'Unauthorized: missing or wrong bearer token.' }, id: null }, { 'www-authenticate': 'Bearer realm="inkwright"' }) };
        }
        return { ok: true };
      },
      async resourceMetadata() { return null; },
      async discoveryUrl() { return undefined; },
    };
  }
  const s = mode.settings;
  const mcpResource = resourceUrl(opts.publicUrl, '/mcp');
  const a2aResource = resourceUrl(opts.publicUrl, '/a2a');
  const origin = new URL(opts.publicUrl).origin;
  const audience = s.audience?.length ? s.audience : [mcpResource, a2aResource, origin, `${origin}/`];
  const verifier = createJwtVerifier({ ...s, audience, resource: new URL(mcpResource) });
  const prm = (resource: string) => ({
    resource,
    authorization_servers: [s.issuer],
    scopes_supported: [s.scopes.read, s.scopes.write],
    bearer_methods_supported: ['header'],
    resource_name: 'Inkwright notes',
  });
  return {
    mode: 'oauth',
    async check(req, path) {
      const resource = path === '/a2a' ? a2aResource : mcpResource;
      const resourceMetadataUrl = metadataUrlFor(resource);
      try {
        const auth = await verifyBearerToken(req.headers.get('authorization'), { verifier, requiredScopes: [s.scopes.read], resourceMetadataUrl });
        return { ok: true, auth };
      } catch (e) {
        return { ok: false, response: bearerAuthChallengeResponse(e, { requiredScopes: [s.scopes.read], resourceMetadataUrl }) };
      }
    },
    async resourceMetadata(pathname) {
      if (pathname === '/.well-known/oauth-protected-resource/mcp') return prm(mcpResource);
      if (pathname === '/.well-known/oauth-protected-resource/a2a') return prm(a2aResource);
      // RFC 9728 §3.3: the root document describes the origin itself.
      if (pathname === '/.well-known/oauth-protected-resource') return prm(origin);
      return null;
    },
    async discoveryUrl() {
      return (await verifier.metadata())?.discoveryUrl;
    },
  };
}
