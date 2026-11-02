/**
 * Command-line and config-file options shared by `inkstone-mcp` (the MCP/A2A server) and
 * `inkstone-agent` (the always-on runner, which can serve the same endpoints). Precedence:
 * command line, then environment, then the JSON config file (`--config`), then defaults.
 * Secrets (the bearer token, AI keys) are best kept in the environment or the 0600 config file —
 * never in service files or shell history.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import type { AgentAIConfig } from './agent/ai.ts';

export interface CliOptions {
  vault?: string;
  readOnly: boolean;
  /** Port for Streamable HTTP; undefined = stdio. */
  http?: number;
  host?: string;
  publicUrl?: string;
  token?: string;
  oauth?: { issuer: string; audience?: string[]; jwksUrl?: string; readScope: string; writeScope: string };
  /** Serve the A2A agent on the HTTP port. */
  a2a: boolean;
  ai?: AgentAIConfig;
  watch: boolean;
  config?: string;
  /** Managed AI policy file (enterprise): users can tighten it but not loosen it. */
  policyFile?: string;
  /** P-256 private JWK that signs the audit trail. */
  auditKey?: string;
  help: boolean;
  version: boolean;
}

/** The config file (`--config`), JSON. */
export interface ConfigFile {
  vault?: string;
  readOnly?: boolean;
  http?: { port?: number; host?: string; publicUrl?: string; a2a?: boolean };
  auth?: { token?: string; oauth?: { issuer: string; audience?: string[]; jwksUrl?: string; readScope?: string; writeScope?: string } };
  ai?: AgentAIConfig;
  runner?: { tickSeconds?: number; serve?: boolean };
  /** Managed AI policy file and audit signing key (docs/ENTERPRISE.md). */
  trust?: { policyFile?: string; auditKey?: string };
}

export const DEFAULT_READ_SCOPE = 'notes:read';
export const DEFAULT_WRITE_SCOPE = 'notes:write';

export const USAGE = `inkstone-mcp — MCP (and A2A) server for an Inkstone notes vault

Usage:
  inkstone-mcp --vault <dir> [--read-only]                      stdio (Claude Desktop, Claude Code, Cursor…)
  inkstone-mcp --vault <dir> --http <port> [auth] [--a2a] [ai]  Streamable HTTP at /mcp (and A2A at /a2a)

Vault:
  --vault <dir>            Folder with inkstone.json and notes/ (default $INKSTONE_VAULT; "~" expands).
  --read-only              Only read tools; never write to the vault.
  --no-watch               Don't watch the folder; re-check file times on every call.

HTTP:
  --http <port>            Serve http://127.0.0.1:<port>/mcp instead of stdio.
  --host <address>         Listen on another interface (needs --token or --oauth-issuer).
  --public-url <url>       The URL clients use (tunnel / reverse proxy), e.g. https://notes.example.com.
  --a2a                    Also serve the A2A agent: /.well-known/agent-card.json and /a2a (needs an AI).

Sign-in (HTTP):
  (none)                   Only loopback clients on this computer.
  --token <secret>         Require "Authorization: Bearer <secret>" (default $INKSTONE_MCP_TOKEN).
  --oauth-issuer <url>     OAuth 2.1: accept JWT access tokens from your identity provider.
  --oauth-audience <aud>   Accepted audience (repeat or comma-separate; default: this server's URLs).
  --oauth-jwks-url <url>   Signing keys (default: discovered from the issuer).
  --oauth-read-scope <s>   Scope for reading (default ${DEFAULT_READ_SCOPE}).
  --oauth-write-scope <s>  Scope for writing (default ${DEFAULT_WRITE_SCOPE}).

AI for the server's own agent (A2A, run_routine, summarize/transcribe tasks):
  --ai-provider <id>       openai, anthropic, gemini, ollama, lmstudio, openrouter, groq, mistral, custom, …
  --ai-model <model>       Model id (default: the provider's default).
  --ai-base-url <url>      Custom endpoint (Ollama, LM Studio, a proxy, custom).
  --ai-key-env <NAME>      Environment variable with the API key (default: the provider's usual one).
  --ai-on-premises         The AI runs inside this deployment (e.g. an Ollama container): it counts as
                           "this device" for the AI policy and requests to it are not redacted.

Trust (docs/TRUST.md, docs/ENTERPRISE.md):
  --policy <file>          Managed AI policy (same format as ai/policy.json); users can only tighten it.
  --audit-key <file>       P-256 private key (JWK) that signs the audit trail (default: a key per process).

Every option also reads an environment variable: INKSTONE_VAULT, INKSTONE_HTTP_PORT, INKSTONE_HOST,
INKSTONE_PUBLIC_URL, INKSTONE_A2A=1, INKSTONE_MCP_TOKEN, INKSTONE_OAUTH_ISSUER, INKSTONE_OAUTH_AUDIENCE,
INKSTONE_OAUTH_JWKS_URL, INKSTONE_AI_PROVIDER, INKSTONE_AI_MODEL, INKSTONE_AI_BASE_URL,
INKSTONE_AI_ON_PREMISES=1, INKSTONE_POLICY_FILE, INKSTONE_AUDIT_KEY.

  --config <file>          JSON config file with any of the above (see docs/AGENTS.md).
  -h, --help               Show this help.
  -v, --version            Print the version.

Examples:
  inkstone-mcp --vault "~/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkstone"
  inkstone-mcp --vault ~/Inkstone --http 8765 --token "$(openssl rand -hex 24)"
  inkstone-mcp --vault ~/Inkstone --http 8765 --public-url https://notes.example.com \\
               --oauth-issuer https://auth.example.com/realms/home --a2a --ai-provider anthropic
`;

export class CliError extends Error {}

/** "1", "true", "yes" → true; "0", "false", "no" → false; unset → undefined. */
function truthy(v: string | undefined): boolean | undefined {
  if (v == null || v === '') return undefined;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2));
  return p;
}

/** Options both binaries accept (node:util parseArgs format). */
export const SHARED_OPTIONS = {
  vault: { type: 'string' },
  'read-only': { type: 'boolean' },
  http: { type: 'string' },
  host: { type: 'string' },
  'public-url': { type: 'string' },
  token: { type: 'string' },
  'oauth-issuer': { type: 'string' },
  'oauth-audience': { type: 'string', multiple: true },
  'oauth-jwks-url': { type: 'string' },
  'oauth-read-scope': { type: 'string' },
  'oauth-write-scope': { type: 'string' },
  a2a: { type: 'boolean' },
  'ai-provider': { type: 'string' },
  'ai-model': { type: 'string' },
  'ai-base-url': { type: 'string' },
  'ai-key-env': { type: 'string' },
  'ai-on-premises': { type: 'boolean' },
  policy: { type: 'string' },
  'audit-key': { type: 'string' },
  config: { type: 'string' },
  'no-watch': { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
} as const;

export function readConfigFile(file: string): ConfigFile {
  let text: string;
  try {
    text = readFileSync(expandHome(file), 'utf8');
  } catch (e) {
    throw new CliError(`Can't read the config file ${file}: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(text) as ConfigFile;
  } catch (e) {
    throw new CliError(`The config file ${file} is not valid JSON: ${(e as Error).message}`);
  }
}

function port(v: unknown, what: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new CliError(`Invalid ${what} port: ${v}`);
  return n;
}

/** Turns parsed flag values (+ env + config file) into options. */
export function resolveOptions(values: Record<string, unknown>, env: NodeJS.ProcessEnv): CliOptions {
  const cfg: ConfigFile = values.config ? readConfigFile(String(values.config)) : {};
  const rawVault = (values.vault as string | undefined) ?? env.INKSTONE_VAULT ?? cfg.vault;
  const httpRaw = values.http ?? env.INKSTONE_HTTP_PORT ?? cfg.http?.port;
  const http = httpRaw !== undefined ? port(httpRaw, '--http') : undefined;
  const token = (values.token as string | undefined) ?? env.INKSTONE_MCP_TOKEN ?? cfg.auth?.token ?? undefined;
  if (values.token !== undefined && http === undefined) throw new CliError('--token only applies with --http <port>.');
  const issuer = (values['oauth-issuer'] as string | undefined) ?? env.INKSTONE_OAUTH_ISSUER ?? cfg.auth?.oauth?.issuer;
  if (issuer && http === undefined) throw new CliError('--oauth-issuer only applies with --http <port>.');
  if (issuer && !/^https:\/\//.test(issuer) && !/^http:\/\/(localhost|127\.)/.test(issuer)) throw new CliError('--oauth-issuer must be an https:// URL.');
  const audience = ((values['oauth-audience'] as string[] | undefined) ?? (env.INKSTONE_OAUTH_AUDIENCE ? [env.INKSTONE_OAUTH_AUDIENCE] : undefined) ?? cfg.auth?.oauth?.audience ?? []).flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
  const provider = (values['ai-provider'] as string | undefined) ?? env.INKSTONE_AI_PROVIDER ?? cfg.ai?.provider;
  const ai: AgentAIConfig | undefined = provider
    ? {
        ...cfg.ai,
        provider,
        model: (values['ai-model'] as string | undefined) ?? env.INKSTONE_AI_MODEL ?? cfg.ai?.model,
        baseUrl: (values['ai-base-url'] as string | undefined) ?? env.INKSTONE_AI_BASE_URL ?? cfg.ai?.baseUrl,
        apiKeyEnv: (values['ai-key-env'] as string | undefined) ?? cfg.ai?.apiKeyEnv,
        onPremises: Boolean(values['ai-on-premises'] ?? truthy(env.INKSTONE_AI_ON_PREMISES) ?? cfg.ai?.onPremises ?? false),
      }
    : undefined;
  const publicUrl = (values['public-url'] as string | undefined) ?? env.INKSTONE_PUBLIC_URL ?? cfg.http?.publicUrl;
  if (publicUrl && !/^https?:\/\/[^/]+/.test(publicUrl)) throw new CliError(`--public-url must be a full URL like https://notes.example.com (got ${publicUrl}).`);
  return {
    vault: rawVault ? path.resolve(expandHome(rawVault)) : undefined,
    readOnly: Boolean(values['read-only'] ?? cfg.readOnly ?? false),
    http,
    host: (values.host as string | undefined) ?? env.INKSTONE_HOST ?? cfg.http?.host,
    publicUrl: publicUrl?.replace(/\/+$/, ''),
    token: issuer ? undefined : token || undefined,
    oauth: issuer
      ? {
          issuer,
          ...(audience.length ? { audience } : {}),
          jwksUrl: (values['oauth-jwks-url'] as string | undefined) ?? env.INKSTONE_OAUTH_JWKS_URL ?? cfg.auth?.oauth?.jwksUrl,
          readScope: (values['oauth-read-scope'] as string | undefined) ?? cfg.auth?.oauth?.readScope ?? DEFAULT_READ_SCOPE,
          writeScope: (values['oauth-write-scope'] as string | undefined) ?? cfg.auth?.oauth?.writeScope ?? DEFAULT_WRITE_SCOPE,
        }
      : undefined,
    a2a: Boolean(values.a2a ?? truthy(env.INKSTONE_A2A) ?? cfg.http?.a2a ?? false),
    ai,
    watch: !values['no-watch'],
    config: values.config as string | undefined,
    ...(() => {
      const policyFile = (values.policy as string | undefined) ?? env.INKSTONE_POLICY_FILE ?? cfg.trust?.policyFile;
      const auditKey = (values['audit-key'] as string | undefined) ?? env.INKSTONE_AUDIT_KEY ?? cfg.trust?.auditKey;
      return { ...(policyFile ? { policyFile: path.resolve(expandHome(policyFile)) } : {}), ...(auditKey ? { auditKey: path.resolve(expandHome(auditKey)) } : {}) };
    })(),
    help: Boolean(values.help),
    version: Boolean(values.version),
  };
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({ args: argv, options: SHARED_OPTIONS, strict: true, allowPositionals: false }));
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  const o = resolveOptions(values, env);
  if (o.a2a && o.http === undefined) throw new CliError('--a2a needs --http <port>.');
  return o;
}
