import { homedir } from 'node:os';
import * as path from 'node:path';
import { parseArgs } from 'node:util';

export interface CliOptions {
  vault?: string;
  readOnly: boolean;
  /** Port for Streamable HTTP; undefined = stdio. */
  http?: number;
  token?: string;
  watch: boolean;
  help: boolean;
  version: boolean;
}

export const USAGE = `inkstone-mcp — MCP server for an Inkstone notes vault

Usage:
  inkstone-mcp --vault <dir> [--read-only] [--http <port> [--token <secret>]]

Options:
  --vault <dir>      Vault folder (the one containing inkstone.json and notes/).
                     Default: $INKSTONE_VAULT. "~" is expanded.
  --read-only        Expose only read tools; never write to the vault.
  --http <port>      Serve Streamable HTTP at http://127.0.0.1:<port>/mcp instead of stdio.
  --token <secret>   Require "Authorization: Bearer <secret>" (HTTP only).
                     Default: $INKSTONE_MCP_TOKEN. Use one whenever the port is tunnelled.
  --no-watch         Do not watch the folder; re-check file times on every call instead.
  -h, --help         Show this help.
  -v, --version      Print the version.

Examples:
  inkstone-mcp --vault "~/Library/CloudStorage/GoogleDrive-me@example.com/My Drive/Inkstone"
  inkstone-mcp --vault ~/Inkstone --http 8765 --token "$(openssl rand -hex 24)"
`;

export class CliError extends Error {}

export function expandHome(p: string): string {
  if (p === '~') return homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(homedir(), p.slice(2));
  return p;
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        vault: { type: 'string' },
        'read-only': { type: 'boolean', default: false },
        http: { type: 'string' },
        token: { type: 'string' },
        'no-watch': { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  const rawVault = (values.vault as string | undefined) ?? env.INKSTONE_VAULT;
  let http: number | undefined;
  if (values.http !== undefined) {
    http = Number(values.http);
    if (!Number.isInteger(http) || http < 0 || http > 65535) throw new CliError(`Invalid --http port: ${values.http}`);
  }
  const token = (values.token as string | undefined) ?? env.INKSTONE_MCP_TOKEN ?? undefined;
  if (values.token !== undefined && http === undefined) throw new CliError('--token only applies with --http <port>.');
  return {
    vault: rawVault ? path.resolve(expandHome(rawVault)) : undefined,
    readOnly: Boolean(values['read-only']),
    http,
    token: token || undefined,
    watch: !values['no-watch'],
    help: Boolean(values.help),
    version: Boolean(values.version),
  };
}
