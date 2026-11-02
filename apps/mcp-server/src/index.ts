#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { CliError, USAGE, parseCli } from './cli.ts';
import { createContext } from './context.ts';
import { aiFromOptions, serveHttp } from './serve.ts';
import { createMcpServer, createServices } from './server.ts';
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
  const ai = aiFromOptions(opts, log);
  let shuttingDown = false;
  let closeAll: () => Promise<void> = async () => {};
  const shutdown = (code = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    void closeAll().finally(() => {
      ctx.close();
      process.exit(code);
    });
  };
  process.on('SIGINT', () => shutdown(0));
  process.on('SIGTERM', () => shutdown(0));

  if (opts.http !== undefined) {
    const { http, services } = await serveHttp(ctx, opts, ai, log);
    log(`Vault ${ctx.root}${ctx.readOnly ? ' (read-only)' : ''}`);
    closeAll = async () => {
      services.tasks.close();
      await services.activity.flush();
      await http.close();
    };
    return;
  }

  // stdio: one connection, either protocol era (2026-07-28 opening or a 2025 `initialize`).
  const services = createServices(ctx, { ai, transport: 'stdio' });
  const handle = serveStdio(() => createMcpServer(services), { onerror: (e) => { if (process.env.INKSTONE_DEBUG) log(e.message); } });
  closeAll = async () => {
    services.tasks.close();
    await services.activity.flush();
    await handle.close();
  };
  process.stdin.on('end', () => shutdown(0));
  process.stdin.on('close', () => shutdown(0));
  log(`Serving ${ctx.root}${ctx.readOnly ? ' (read-only)' : ''} over stdio`);
}

main().catch((e) => {
  log(`error: ${process.env.INKSTONE_DEBUG ? ((e as Error).stack ?? e) : ((e as Error).message ?? e)}`);
  process.exit(1);
});
