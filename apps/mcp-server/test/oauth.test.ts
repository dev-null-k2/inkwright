import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair, type JWK } from 'jose';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { Client as LegacyClient } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport as LegacyTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { discoveryUrls, scopesOf } from '../src/auth.ts';
import { parseCli } from '../src/cli.ts';
import { serveHttp } from '../src/serve.ts';
import type { RunningHttpServer } from '../src/http.ts';
import { resultJson } from './clients.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

/**
 * A local authorization server stand-in: an issuer with OIDC discovery and a JWKS, and a way to
 * mint signed access tokens — what the user's own IdP (Keycloak, Authentik, …) provides.
 */
async function testIssuer(issuer = 'https://auth.example.test/realms/home') {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const requests: string[] = [];
  const fetch = async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    requests.push(url);
    if (url === `${issuer}/.well-known/openid-configuration`) return Response.json({ issuer, jwks_uri: `${issuer}/protocol/openid-connect/certs`, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token` });
    if (url === `${issuer}/protocol/openid-connect/certs`) return Response.json({ keys: [jwk] });
    return new Response('not found', { status: 404 });
  };
  const token = (claims: Record<string, unknown>, opts: { key?: CryptoKey; exp?: string | number; iss?: string } = {}) =>
    new SignJWT({ scope: 'notes:read notes:write', azp: 'claude', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
      .setIssuer(opts.iss ?? issuer)
      .setSubject('karthik')
      .setIssuedAt()
      .setExpirationTime(opts.exp ?? '10m')
      .sign(opts.key ?? privateKey);
  return { issuer, fetch, token, otherKey: other.privateKey, requests };
}

let fx: Fixture;
let http: RunningHttpServer;
let idp: Awaited<ReturnType<typeof testIssuer>>;
let base: string;
const log: string[] = [];

beforeAll(async () => {
  fx = await makeFixture();
  idp = await testIssuer();
  const opts = parseCli(['--vault', fx.dir, '--http', '0', '--oauth-issuer', idp.issuer, '--a2a'], {});
  const ctx = await fx.ctx();
  ({ http } = await serveHttp(ctx, opts, null, (m) => log.push(m), { fetch: idp.fetch as typeof fetch }));
  base = http.baseUrl;
});
afterAll(async () => {
  await http?.close();
  await fx?.cleanup();
});

const mcpResource = () => `${base}/mcp`;

async function client(token: string): Promise<Client> {
  const c = new Client({ name: 'oauth-test', version: '1' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(mcpResource()), { fetch: ((u: string | URL, init?: RequestInit) => fetch(u, { ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), authorization: `Bearer ${token}` } })) as never }));
  return c;
}

const rpc = (token: string | null, body: unknown, extra: Record<string, string> = {}) =>
  fetch(mcpResource(), { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra }, body: JSON.stringify(body) });

const modernCall = (name: string, args: Record<string, unknown>) => ({
  jsonrpc: '2.0', id: 1, method: 'tools/call',
  params: { name, arguments: args, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'raw', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } },
});
const modernHeaders = (name: string) => ({ 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': name });

describe('OAuth 2.1 resource server', () => {
  it('publishes Protected Resource Metadata pointing at the configured issuer (RFC 9728)', async () => {
    const res = await fetch(`${base}/.well-known/oauth-protected-resource/mcp`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ resource: mcpResource(), authorization_servers: [idp.issuer], scopes_supported: ['notes:read', 'notes:write'], bearer_methods_supported: ['header'], resource_name: 'Inkstone notes' });
    const root = await (await fetch(`${base}/.well-known/oauth-protected-resource`)).json() as { resource: string };
    expect(root.resource).toBe(new URL(base).origin);
  });

  it('answers 401 with a challenge naming the metadata', async () => {
    const res = await rpc(null, modernCall('list_notes', {}), modernHeaders('list_notes'));
    expect(res.status).toBe(401);
    const h = res.headers.get('www-authenticate') ?? '';
    expect(h).toMatch(/^Bearer /);
    expect(h).toContain(`resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('accepts a valid token from the issuer, for 2026 and 2025 clients', async () => {
    const t = await idp.token({ aud: mcpResource() });
    const c = await client(t);
    expect(c.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const created = resultJson(await c.callTool({ name: 'create_note', arguments: { title: 'Signed in', text: 'via OAuth' } }));
    expect(created.created).toBe(true);
    await c.close();
    const old = new LegacyClient({ name: 'old', version: '1' });
    await old.connect(new LegacyTransport(new URL(mcpResource()), { requestInit: { headers: { authorization: `Bearer ${t}` } } }));
    expect((await old.listTools()).tools.length).toBeGreaterThan(5);
    await old.close();
    expect(idp.requests.filter((u) => u.endsWith('/certs'))).toHaveLength(1); // keys fetched once, cached
  });

  it('rejects tokens for another audience, expired, from another issuer or with a forged signature', async () => {
    const bad = [
      await idp.token({ aud: 'https://someone-else.example/mcp' }),
      await idp.token({ aud: mcpResource() }, { exp: Math.floor(Date.now() / 1000) - 3600 }),
      await idp.token({ aud: mcpResource() }, { iss: 'https://evil.example' }),
      await idp.token({ aud: mcpResource() }, { key: idp.otherKey }),
      'not-a-jwt',
    ];
    for (const t of bad) {
      const res = await rpc(t, modernCall('list_notes', {}), modernHeaders('list_notes'));
      expect(res.status, t.slice(0, 20)).toBe(401);
      expect(res.headers.get('www-authenticate')).toContain('invalid_token');
    }
  });

  it('a read-only token reads; writing answers a step-up insufficient_scope challenge', async () => {
    const t = await idp.token({ aud: mcpResource(), scope: 'notes:read' });
    const read = await rpc(t, modernCall('list_notes', {}), modernHeaders('list_notes'));
    expect(read.status).toBe(200);
    const write = await rpc(t, modernCall('create_note', { title: 'nope' }), modernHeaders('create_note'));
    expect(write.status).toBe(403);
    const h = write.headers.get('www-authenticate') ?? '';
    expect(h).toContain('insufficient_scope');
    expect(h).toContain('scope="notes:read notes:write"');
    const none = await rpc(await idp.token({ aud: mcpResource(), scope: 'profile' }), modernCall('list_notes', {}), modernHeaders('list_notes'));
    expect(none.status).toBe(403);
  });

  it('protects A2A the same way and advertises the issuer in the Agent Card', async () => {
    const card = await (await fetch(`${base}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } })).json() as { securitySchemes: Record<string, unknown>; securityRequirements: unknown[]; skills: Array<{ id: string; securityRequirements?: unknown[] }> };
    expect(card.securitySchemes.oauth).toEqual({ openIdConnectSecurityScheme: { description: 'Sign in with your identity provider.', openIdConnectUrl: `${idp.issuer}/.well-known/openid-configuration` } });
    expect(card.securityRequirements).toEqual([{ schemes: { oauth: { list: ['notes:read'] } } }]);
    expect(card.skills.find((s) => s.id === 'write_notes')?.securityRequirements).toEqual([{ schemes: { oauth: { list: ['notes:read', 'notes:write'] } } }]);
    const anon = await fetch(`${base}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'GetTask', params: { id: 'x' } }) });
    expect(anon.status).toBe(401);
    expect(anon.headers.get('www-authenticate')).toContain('/.well-known/oauth-protected-resource/a2a');
  });

  it('helpers: discovery URLs for path issuers, and scopes from scope/scp/permissions', () => {
    expect(discoveryUrls('https://idp.example/realms/home')).toEqual([
      'https://idp.example/.well-known/oauth-authorization-server/realms/home',
      'https://idp.example/.well-known/openid-configuration/realms/home',
      'https://idp.example/realms/home/.well-known/openid-configuration',
    ]);
    expect(scopesOf({ scope: 'a b', scp: ['c'], permissions: ['d'] } as never).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});

describe('listening beyond loopback', () => {
  it('refuses to expose the vault to a network without a token or OAuth', async () => {
    const ctx = await fx.ctx();
    await expect(serveHttp(ctx, parseCli(['--vault', fx.dir, '--http', '0', '--host', '0.0.0.0'], {}), null, () => {})).rejects.toThrow(/set a token/);
  });
});
