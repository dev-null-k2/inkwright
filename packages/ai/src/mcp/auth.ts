/**
 * OAuth for remote MCP servers, as the MCP authorization spec (2026-07-28) asks of a public
 * browser client: OAuth 2.1 authorization code + PKCE, protected-resource and authorization-server
 * discovery, RFC 8707 resource indicators, step-up for missing scopes and issuer validation — all
 * run by the SDK's `auth()`; this file is the `OAuthClientProvider` it drives.
 *
 * Everything sensitive (tokens, client registrations, PKCE verifier, discovery state) is kept in
 * a `SecretStore` (WebCrypto-encrypted in the app), keyed per server and — as SEP-2352 requires —
 * per authorization-server issuer, so credentials are never reused with another issuer. The
 * client registers itself with Client ID Metadata Documents when the app is hosted with one, and
 * falls back to Dynamic Client Registration (`application_type: "web"`, SEP-837) otherwise.
 */
import type {
  OAuthClientInformationContext,
  OAuthClientMetadata,
  OAuthClientProvider,
  OAuthDiscoveryState,
  StoredOAuthClientInformation,
  StoredOAuthTokens,
} from '@modelcontextprotocol/client';
import type { SecretStore } from '../secrets.ts';

export interface McpOAuthOptions {
  /** The connection this provider signs in for (secrets are namespaced by it). */
  serverId: string;
  secrets: SecretStore;
  /** Where the authorization server sends the browser back (registered with the server). */
  redirectUrl: string;
  clientName: string;
  clientUri?: string;
  logoUri?: string;
  /** HTTPS URL of this app's Client ID Metadata Document, when it is hosted with one. */
  clientMetadataUrl?: string;
  /** Called with the authorization URL: open it (popup, tab or system browser). */
  onRedirect: (url: URL) => void | Promise<void>;
  /** Random source (tests). */
  random?: () => string;
}

const randomState = () => {
  const b = new Uint8Array(16);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};

/** Secret names used for one MCP server (all start with `mcp:<serverId>:`). */
export const mcpSecretPrefix = (serverId: string) => `mcp:${serverId}:`;

export class McpOAuthProvider implements OAuthClientProvider {
  readonly clientMetadataUrl?: string;
  constructor(private o: McpOAuthOptions) {
    if (o.clientMetadataUrl) this.clientMetadataUrl = o.clientMetadataUrl;
  }

  private key(name: string) { return `${mcpSecretPrefix(this.o.serverId)}${name}`; }

  private async getJson<T>(name: string): Promise<T | undefined> {
    const v = await this.o.secrets.get(this.key(name));
    if (!v) return undefined;
    try {
      return JSON.parse(v) as T;
    } catch {
      return undefined;
    }
  }

  private setJson(name: string, value: unknown) { return this.o.secrets.set(this.key(name), JSON.stringify(value)); }

  get redirectUrl(): string { return this.o.redirectUrl; }

  get clientMetadata(): OAuthClientMetadata {
    const m: Record<string, unknown> = {
      client_name: this.o.clientName,
      redirect_uris: [this.o.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      // A public client: PKCE instead of a secret.
      token_endpoint_auth_method: 'none',
      // SEP-837: a browser app, so OIDC servers apply web redirect-URI rules.
      application_type: 'web',
    };
    if (this.o.clientUri) m.client_uri = this.o.clientUri;
    if (this.o.logoUri) m.logo_uri = this.o.logoUri;
    return m as OAuthClientMetadata;
  }

  /** The OAuth `state`: random, remembered so the callback can be matched to this server. */
  async state(): Promise<string> {
    const s = `${this.o.serverId}.${(this.o.random ?? randomState)()}`;
    await this.o.secrets.set(this.key('state'), s);
    return s;
  }

  /** The state we sent, to check the callback against (CSRF / mix-up protection). */
  async expectedState(): Promise<string | null> { return this.o.secrets.get(this.key('state')); }

  async clientInformation(ctx?: OAuthClientInformationContext): Promise<StoredOAuthClientInformation | undefined> {
    const issuer = ctx?.issuer ?? (await this.o.secrets.get(this.key('issuer'))) ?? 'default';
    return this.getJson<StoredOAuthClientInformation>(`client:${issuer}`);
  }

  async saveClientInformation(info: StoredOAuthClientInformation, ctx?: OAuthClientInformationContext): Promise<void> {
    await this.setJson(`client:${ctx?.issuer ?? (info as { issuer?: string }).issuer ?? 'default'}`, info);
  }

  /** With no ctx (the per-request bearer read) the most recently saved tokens are returned. */
  async tokens(ctx?: OAuthClientInformationContext): Promise<StoredOAuthTokens | undefined> {
    const issuer = ctx?.issuer ?? (await this.o.secrets.get(this.key('issuer')));
    if (!issuer) return undefined;
    return this.getJson<StoredOAuthTokens>(`tokens:${issuer}`);
  }

  async saveTokens(tokens: StoredOAuthTokens, ctx?: OAuthClientInformationContext): Promise<void> {
    const issuer = ctx?.issuer ?? (tokens as { issuer?: string }).issuer ?? 'default';
    await this.setJson(`tokens:${issuer}`, { ...tokens, savedAt: Date.now() });
    await this.o.secrets.set(this.key('issuer'), issuer);
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    await this.o.onRedirect(url);
  }

  async saveCodeVerifier(v: string): Promise<void> { await this.o.secrets.set(this.key('verifier'), v); }

  async codeVerifier(): Promise<string> {
    const v = await this.o.secrets.get(this.key('verifier'));
    if (!v) throw new Error('The sign-in was started on another device or expired. Start it again.');
    return v;
  }

  async saveDiscoveryState(s: OAuthDiscoveryState): Promise<void> { await this.setJson('discovery', s); }
  async discoveryState(): Promise<OAuthDiscoveryState | undefined> { return this.getJson<OAuthDiscoveryState>('discovery'); }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    const names = (await this.o.secrets.list?.()) ?? [];
    const mine = names.filter((n) => n.startsWith(mcpSecretPrefix(this.o.serverId)));
    const drop = (pred: (rest: string) => boolean) => Promise.all(mine.filter((n) => pred(n.slice(mcpSecretPrefix(this.o.serverId).length))).map((n) => this.o.secrets.delete(n)));
    if (scope === 'all') await drop((r) => r !== 'bearer');
    else if (scope === 'client') await drop((r) => r.startsWith('client:'));
    else if (scope === 'tokens') await drop((r) => r.startsWith('tokens:') || r === 'issuer');
    else if (scope === 'verifier') await drop((r) => r === 'verifier' || r === 'state');
    else await drop((r) => r === 'discovery');
  }

  /** True once a sign-in has produced tokens (they may still need a refresh). */
  async hasTokens(): Promise<boolean> { return !!(await this.tokens()); }
}

/** Deletes every secret belonging to one MCP connection (tokens, registrations, bearer token). */
export async function forgetMcpSecrets(secrets: SecretStore, serverId: string): Promise<void> {
  const names = (await secrets.list?.()) ?? [];
  await Promise.all(names.filter((n) => n.startsWith(mcpSecretPrefix(serverId))).map((n) => secrets.delete(n)));
}

/** Secret name for a server's static bearer token / API key. */
export const mcpBearerSecret = (serverId: string) => `${mcpSecretPrefix(serverId)}bearer`;

/**
 * Parses an OAuth redirect back to the app. Returns null when the URL is not an MCP sign-in
 * callback (its `state` starts with a server id we issued).
 */
export function parseOAuthCallback(search: string | URLSearchParams): { serverId: string; params: URLSearchParams; error?: string } | null {
  const params = typeof search === 'string' ? new URLSearchParams(search.startsWith('?') ? search.slice(1) : search) : search;
  const state = params.get('state');
  if (!state || !/^[0-9A-Za-z_-]{1,64}\.[0-9a-f]{8,}$/.test(state)) return null;
  if (!params.get('code') && !params.get('error')) return null;
  const serverId = state.slice(0, state.indexOf('.'));
  const err = params.get('error');
  return err ? { serverId, params, error: params.get('error_description') || err } : { serverId, params };
}
