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
  const httpRaw = values.http ?? cfg.http?.port;
  const http = httpRaw !== undefined ? port(httpRaw, '--http') : undefined;
  const token = (values.token as string | undefined) ?? env.INKSTONE_MCP_TOKEN ?? cfg.auth?.token ?? undefined;
  if (values.token !== undefined && http === undefined) throw new CliError('--token only applies with --http <port>.');
  const issuer = (values['oauth-issuer'] as string | undefined) ?? env.INKSTONE_OAUTH_ISSUER ?? cfg.auth?.oauth?.issuer;
  if (issuer && http === undefined) throw new CliError('--oauth-issuer only applies with --http <port>.');
  if (issuer && !/^https:\/\//.test(issuer) && !/^http:\/\/(localhost|127\.)/.test(issuer)) throw new CliError('--oauth-issuer must be an https:// URL.');
  const audience = ((values['oauth-audience'] as string[] | undefined) ?? cfg.auth?.oauth?.audience ?? []).flatMap((a) => a.split(',')).map((a) => a.trim()).filter(Boolean);
  const provider = (values['ai-provider'] as string | undefined) ?? env.INKSTONE_AI_PROVIDER ?? cfg.ai?.provider;
  const ai: AgentAIConfig | undefined = provider
    ? {
        ...cfg.ai,
        provider,
        model: (values['ai-model'] as string | undefined) ?? env.INKSTONE_AI_MODEL ?? cfg.ai?.model,
        baseUrl: (values['ai-base-url'] as string | undefined) ?? cfg.ai?.baseUrl,
        apiKeyEnv: (values['ai-key-env'] as string | undefined) ?? cfg.ai?.apiKeyEnv,
      }
    : undefined;
  const publicUrl = (values['public-url'] as string | undefined) ?? cfg.http?.publicUrl;
  if (publicUrl && !/^https?:\/\/[^/]+/.test(publicUrl)) throw new CliError(`--public-url must be a full URL like https://notes.example.com (got ${publicUrl}).`);
  return {
    vault: rawVault ? path.resolve(expandHome(rawVault)) : undefined,
    readOnly: Boolean(values['read-only'] ?? cfg.readOnly ?? false),
    http,
    host: (values.host as string | undefined) ?? cfg.http?.host,
    publicUrl: publicUrl?.replace(/\/+$/, ''),
    token: issuer ? undefined : token || undefined,
    oauth: issuer
      ? {
          issuer,
          ...(audience.length ? { audience } : {}),
          jwksUrl: (values['oauth-jwks-url'] as string | undefined) ?? cfg.auth?.oauth?.jwksUrl,
          readScope: (values['oauth-read-scope'] as string | undefined) ?? cfg.auth?.oauth?.readScope ?? DEFAULT_READ_SCOPE,
          writeScope: (values['oauth-write-scope'] as string | undefined) ?? cfg.auth?.oauth?.writeScope ?? DEFAULT_WRITE_SCOPE,
        }
      : undefined,
    a2a: Boolean(values.a2a ?? cfg.http?.a2a ?? false),
    ai,
    watch: !values['no-watch'],
    config: values.config as string | undefined,
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
