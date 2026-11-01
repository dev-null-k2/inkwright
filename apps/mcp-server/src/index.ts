#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CliError, USAGE, parseCli } from './cli.ts';
import { createContext } from './context.ts';
import { startHttpServer } from './http.ts';
import { createMcpServer } from './server.ts';
import { VERSION } from './version.ts';

// stdout carries the MCP protocol in stdio mode: everything human-readable goes to stderr.
const log = (msg: string) => process.stderr.write(`[inkstone-mcp] ${msg}\n`);

async function main(): Promise<void> {
  let opts;
  try {
    opts = parseCli(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`${e.message}\n\n${USAGE}`);
      process.exit(2);
    }
    throw e;
  }
  if (opts.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (opts.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!opts.vault) {
    process.stderr.write(`No vault folder given. Pass --vault <dir> or set INKSTONE_VAULT.\n\n${USAGE}`);
    process.exit(2);
  }

  const ctx = await createContext({ root: opts.vault, readOnly: opts.readOnly, watch: opts.watch });
  if (ctx.createdVault) log(`No inkstone.json found; initialized a new vault at ${ctx.root}`);
  let shuttingDown = false;
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    ctx.close();
    process.exit(code);
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  if (opts.http !== undefined) {
    const http = await startHttpServer(ctx, { port: opts.http, token: opts.token });
    log(`Vault ${ctx.root}${ctx.readOnly ? ' (read-only)' : ''}`);
    log(`Streamable HTTP on ${http.url}${opts.token ? ' (bearer token required)' : ' (no token; loopback clients only)'}`);
    return;
  }

  const server = createMcpServer(ctx);
  const transport = new StdioServerTransport();
  transport.onclose = () => shutdown(0);
  process.stdin.on('end', () => shutdown(0));
  process.stdin.on('close', () => shutdown(0));
  await server.connect(transport);
  log(`Serving ${ctx.root}${ctx.readOnly ? ' (read-only)' : ''} over stdio`);
}

main().catch((e) => {
  log(`error: ${process.env.INKSTONE_DEBUG ? ((e as Error).stack ?? e) : ((e as Error).message ?? e)}`);
  process.exit(1);
});
