#!/usr/bin/env node
/**
 * `inkstone-agent` — the always-on side of Inkstone on a computer:
 *
 *   inkstone-agent run        run routines on schedule over the vault folder (optionally also
 *                             serve MCP and A2A with --http, same options as inkstone-mcp)
 *   inkstone-agent install    write a launchd / systemd / Task Scheduler service for `run`
 *   inkstone-agent uninstall  remove it
 *   inkstone-agent status     who runs routines, last runs, pending approvals
 *   inkstone-agent approvals  list, allow or decline actions waiting for your OK
 */
import { appendFileSync, chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RoutineStore, describeTrigger, exportAuditJsonl, readRoutineLease, verifyAudit } from '@inkstone/ai';
import { NodeFS } from './nodefs.ts';
import { ApprovalStore } from './approvals.ts';
import { executeApproval } from './agent/run.ts';
import { CliError, SHARED_OPTIONS, expandHome, resolveOptions, type CliOptions } from './cli.ts';
import { createContext } from './context.ts';
import { logPolicy, trustedAI } from './trust.ts';
import { RoutineRunner } from './runner/runner.ts';
import { currentPlatform, decodeServiceContent, serviceFile, type ServicePlatform } from './runner/services.ts';
import { aiFromOptions, serveHttp } from './serve.ts';
import { VERSION } from './version.ts';

export const AGENT_USAGE = `inkstone-agent — runs your Inkstone routines on this computer, even when the app is closed

Usage:
  inkstone-agent run --vault <dir> --ai-provider <id> [--ai-model <m>] [--http <port> [--a2a] …]
  inkstone-agent install --vault <dir> [--config <file>] [run options] [--platform macos|linux|windows] [--dry-run]
  inkstone-agent uninstall [--platform …]
  inkstone-agent status --vault <dir>
  inkstone-agent approvals --vault <dir> [--allow <id> | --decline <id>]
  inkstone-agent audit --vault <dir> [--export <file.jsonl>] [--expect-head <hash>]…
  inkstone-agent audit --verify <file.jsonl> [--expect-head <hash>]… [--trusted-key <fingerprint>]…

run options:
  --vault, --config, --read-only, --ai-provider, --ai-model, --ai-base-url, --ai-key-env,
  --http, --host, --public-url, --token, --oauth-*, --a2a   (as for inkstone-mcp --help)
  --tick <seconds>         How often to check time and date triggers (default 60).
  --log-file <path>        Append the log to a file as well as stderr.

The app and the runner never both run a trigger: the runner holds a lease in the vault
(ai/leases/routines.json) and the app leaves automatic routines to it while it is alive.
Moving notes to Trash always waits for your OK (inkstone-agent approvals, or the approval
card in Claude/ChatGPT via MCP). See docs/AGENTS.md.
`;

const AGENT_OPTIONS = {
  ...SHARED_OPTIONS,
  tick: { type: 'string' },
  'log-file': { type: 'string' },
  platform: { type: 'string' },
  'dry-run': { type: 'boolean', default: false },
  entry: { type: 'string' },
  allow: { type: 'string' },
  decline: { type: 'string' },
  all: { type: 'boolean', default: false },
  export: { type: 'string' },
  verify: { type: 'string' },
  'expect-head': { type: 'string', multiple: true },
  'trusted-key': { type: 'string', multiple: true },
} as const;

export interface AgentCommand {
  command: 'run' | 'install' | 'uninstall' | 'status' | 'approvals' | 'audit' | 'help' | 'version';
  options: CliOptions;
  tickMs: number;
  logFile?: string;
  platform: ServicePlatform;
  dryRun: boolean;
  entry?: string;
  allow?: string;
  decline?: string;
  all: boolean;
  /** audit: write the export here; verify this file instead of the vault; heads/keys to expect. */
  exportFile?: string;
  verifyFile?: string;
  expectHeads: string[];
  trustedKeys: string[];
  /** The flags to pass to `run` from a service (install). */
  runArgs: string[];
}

/** Flags that configure `run` and are copied into service files by `install`. */
const RUN_FLAGS = new Set(['vault', 'config', 'read-only', 'http', 'host', 'public-url', 'oauth-issuer', 'oauth-audience', 'oauth-jwks-url', 'oauth-read-scope', 'oauth-write-scope', 'a2a', 'ai-provider', 'ai-model', 'ai-base-url', 'ai-key-env', 'ai-on-premises', 'policy', 'audit-key', 'tick', 'no-watch']);

export function parseAgentCli(argv: string[], env: NodeJS.ProcessEnv = process.env): AgentCommand {
  const [first, ...rest] = argv;
  const command = (!first || first.startsWith('-') ? (argv.includes('-v') || argv.includes('--version') ? 'version' : 'help') : first) as AgentCommand['command'];
  if (!['run', 'install', 'uninstall', 'status', 'approvals', 'audit', 'help', 'version'].includes(command)) throw new CliError(`Unknown command: ${first}`);
  let values: Record<string, unknown>;
  let tokens: Array<{ kind: string; name?: string; rawName?: string; value?: string }>;
  try {
    ({ values, tokens } = parseArgs({ args: first?.startsWith('-') ? argv : rest, options: AGENT_OPTIONS, strict: true, allowPositionals: false, tokens: true }) as never);
  } catch (e) {
    throw new CliError((e as Error).message);
  }
  if (command === 'install' && values.token) throw new CliError('Don’t put the token in a service file: put it in the config file (auth.token) or ~/.config/inkstone/agent.env as INKSTONE_MCP_TOKEN.');
  const options = resolveOptions(values, env);
  const tick = values.tick !== undefined ? Number(values.tick) : 60;
  if (!Number.isFinite(tick) || tick < 5) throw new CliError('--tick must be at least 5 seconds.');
  const runArgs: string[] = [];
  for (const t of tokens) {
    if (t.kind !== 'option' || !t.name || !RUN_FLAGS.has(t.name)) continue;
    runArgs.push(`--${t.name}`);
    if (t.value !== undefined) runArgs.push(['vault', 'config', 'policy', 'audit-key'].includes(t.name) ? path.resolve(expandHome(t.value)) : t.value);
  }
  const platform = (values.platform as string | undefined) ?? currentPlatform();
  if (!['macos', 'linux', 'windows'].includes(platform)) throw new CliError('--platform is macos, linux or windows.');
  return {
    command: values.help ? 'help' : command,
    options,
    tickMs: tick * 1000,
    ...(values['log-file'] ? { logFile: path.resolve(expandHome(String(values['log-file']))) } : {}),
    platform: platform as ServicePlatform,
    dryRun: Boolean(values['dry-run']),
    ...(values.entry ? { entry: path.resolve(String(values.entry)) } : {}),
    ...(values.allow ? { allow: String(values.allow) } : {}),
    ...(values.decline ? { decline: String(values.decline) } : {}),
    all: Boolean(values.all),
    ...(values.export ? { exportFile: path.resolve(expandHome(String(values.export))) } : {}),
    ...(values.verify ? { verifyFile: path.resolve(expandHome(String(values.verify))) } : {}),
    expectHeads: (values['expect-head'] as string[] | undefined) ?? [],
    trustedKeys: (values['trusted-key'] as string[] | undefined) ?? [],
    runArgs,
  };
}

function makeLog(file?: string) {
  return (msg: string) => {
    const line = `${new Date().toISOString()} ${msg}\n`;
    process.stderr.write(`[inkstone-agent] ${msg}\n`);
    if (file) {
      try {
        mkdirSync(path.dirname(file), { recursive: true });
        appendFileSync(file, line);
      } catch {
        /* logging must not stop the runner */
      }
    }
  };
}

function needVault(o: CliOptions): string {
  if (!o.vault) throw new CliError('No vault folder given. Pass --vault <dir> or set INKSTONE_VAULT.');
  return o.vault;
}

async function run(c: AgentCommand): Promise<void> {
  const log = makeLog(c.logFile);
  const ctx = await createContext({ root: needVault(c.options), readOnly: c.options.readOnly, watch: c.options.watch, ...(c.options.policyFile ? { managedPolicyFile: c.options.policyFile } : {}), ...(c.options.auditKey ? { auditKeyFile: c.options.auditKey } : {}) });
  logPolicy(ctx, log);
  // The runner's AI goes through the trust layer (routing, privacy firewall, meter, audit).
  const ai = trustedAI(aiFromOptions(c.options, log), ctx.trust);
  if (!ai) log('No AI configured: routines will be logged as failed until you add --ai-provider (see docs/AGENTS.md).');
  const runner = new RoutineRunner({ ctx, ai, log, tickMs: c.tickMs, watch: c.options.watch });
  let http: Awaited<ReturnType<typeof serveHttp>> | null = null;
  if (c.options.http !== undefined) http = await serveHttp(ctx, c.options, ai, log);
  await runner.start();
  log(`Watching ${ctx.root} — routines run here while this keeps running.`);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    log('Stopping; handing routines back to the app.');
    await runner.stop();
    if (http) {
      http.services.tasks.close();
      await http.services.activity.flush();
      await http.http.close();
    }
    await Promise.all([ctx.trust.audit.flush(), ctx.trust.usage.flush()]).catch(() => {});
    ctx.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  // Keep the process alive (the runner's timers don't hold it open on their own).
  setInterval(() => {}, 1 << 30);
}

function install(c: AgentCommand, uninstall = false): void {
  const script = c.entry ?? (process.argv[1] ? path.resolve(process.argv[1]) : fileURLToPath(import.meta.url));
  if (!uninstall) needVault(c.options);
  if (!uninstall && /\.ts$/.test(script)) throw new CliError('Install from the built agent (npm run build -w @inkstone/mcp-server, then node apps/mcp-server/dist/agent.js install …) or pass --entry <dist/agent.js>.');
  const home = homedir();
  const spec = { node: process.execPath, script, args: c.runArgs, home, ...(c.platform === 'windows' ? { user: `${process.env.USERDOMAIN ?? ''}${process.env.USERDOMAIN ? '\\' : ''}${userInfo().username}`, localAppData: process.env.LOCALAPPDATA } : {}) };
  const f = serviceFile(c.platform, spec);
  if (uninstall) {
    process.stdout.write(`To stop and remove the Inkstone agent service:\n\n${f.uninstall.map((x) => `  ${x}`).join('\n')}\n`);
    if (!c.dryRun) {
      rmSync(f.path, { force: true });
      process.stdout.write(`\nRemoved ${f.path} (run the commands above to unload it if it is running).\n`);
    }
    return;
  }
  if (c.dryRun) {
    process.stdout.write(`# ${f.path}\n${decodeServiceContent(f.content)}\n# Then run:\n${f.install.map((x) => `  ${x}`).join('\n')}\n`);
    return;
  }
  mkdirSync(path.dirname(f.path), { recursive: true });
  writeFileSync(f.path, f.content);
  if (c.options.config) {
    try {
      chmodSync(expandHome(c.options.config), 0o600); // it may hold the AI key and token
    } catch {
      /* not fatal (e.g. Windows) */
    }
  }
  process.stdout.write(`Wrote ${f.path}\n\nStart it now (and at every login) with:\n${f.install.map((x) => `  ${x}`).join('\n')}\n\nLogs: ${f.logs}\nRemove it with: inkstone-agent uninstall\n`);
  if (c.platform === 'macos' && /CloudStorage|Mobile Documents/.test(c.options.vault ?? '')) {
    process.stdout.write('\nYour vault is in cloud storage: the first time the agent starts, macOS asks whether node may access it. If you miss that, allow node under System Settings › Privacy & Security › Files and Folders.\n');
  }
}

async function status(c: AgentCommand): Promise<void> {
  const fs = new NodeFS(needVault(c.options));
  const lease = await readRoutineLease(fs);
  const now = Date.now();
  const out: string[] = [];
  out.push(lease && lease.expiresAt > now ? `Routines run on: ${lease.label} (renewed ${Math.round((now - lease.renewedAt) / 1000)} s ago)` : 'Routines run in: the Inkstone app, while it is open (no runner holds the lease).');
  const routines = await new RoutineStore(fs).list();
  out.push('', routines.length ? 'Routines:' : 'No routines yet. Create them in Inkstone › AI › Routines.');
  for (const r of routines) {
    const last = r.state.lastRunAt ? `last ran ${new Date(r.state.lastRunAt).toLocaleString()} (${r.state.lastStatus})` : 'not run yet';
    out.push(`  ${r.enabled ? '●' : '○'} ${r.name} — ${r.triggers.map(describeTrigger).join('; ') || 'only when run by hand'} — ${last}${r.state.lastError ? `: ${r.state.lastError}` : ''}`);
  }
  const pending = await new ApprovalStore(fs).list();
  out.push('', pending.length ? `${pending.length} action(s) waiting for your OK — see inkstone-agent approvals.` : 'Nothing is waiting for your OK.');
  process.stdout.write(`${out.join('\n')}\n`);
}

async function approvals(c: AgentCommand): Promise<void> {
  const vault = needVault(c.options);
  const id = c.allow ?? c.decline;
  if (id) {
    const ctx = await createContext({ root: vault, watch: false });
    try {
      const a = await new ApprovalStore(ctx.fs).decide(id, !!c.allow, 'inkstone-agent approvals', (x) => executeApproval(ctx, x));
      process.stdout.write(a.status === 'approved' ? `Done: ${a.title}. Undo it in Inkstone › Activity if needed.\n` : a.status === 'denied' ? `Declined: ${a.title}.\n` : `Couldn’t do it: ${a.outcome}\n`);
    } finally {
      ctx.close();
    }
    return;
  }
  const list = await new ApprovalStore(new NodeFS(vault)).list({ all: c.all });
  if (!list.length) return void process.stdout.write('Nothing is waiting for your OK.\n');
  for (const a of list) process.stdout.write(`${a.id}  ${a.status.padEnd(8)} ${a.title} — asked by ${a.source}, ${new Date(a.createdAt).toLocaleString()}${a.outcome ? ` — ${a.outcome}` : ''}\n`);
  process.stdout.write('\nAllow one with: inkstone-agent approvals --vault <dir> --allow <id>   (or --decline <id>)\n');
}

/**
 * `inkstone-agent audit`: verifies the vault's audit trail (every device's chain), or an exported
 * JSONL file with `--verify`, and optionally writes an export. Exit code 1 when it doesn't verify,
 * so it can run in a compliance job. `--expect-head` checks that heads recorded earlier are still
 * there (the record was not cut short); `--trusted-key` pins the signing keys.
 */
export async function audit(c: AgentCommand, out: (s: string) => void = (s) => process.stdout.write(s)): Promise<boolean> {
  let text: string;
  if (c.verifyFile) text = readFileSync(c.verifyFile, 'utf8');
  else text = await exportAuditJsonl(new NodeFS(needVault(c.options)));
  if (c.exportFile) {
    writeFileSync(c.exportFile, text);
    out(`Wrote ${c.exportFile}\n`);
  }
  const r = await verifyAudit(text, { expectHeads: c.expectHeads, ...(c.trustedKeys.length ? { trustedKeys: c.trustedKeys.map((k) => k.replace(/\s/g, '').toLowerCase()) } : {}) });
  for (const ch of r.chains) out(`${ch.dev}: ${ch.events} events, ${ch.signed} signed${ch.startsAfterPruning ? ', older events removed by retention' : ''}; head ${ch.head ?? '(none)'}\n`);
  if (!r.chains.length) out('No audit events yet.\n');
  out(r.ok ? 'OK: every chain is intact and every signature verifies.\n' : `NOT OK:\n${r.problems.map((p) => `  - ${p}`).join('\n')}\n`);
  return r.ok;
}

async function main(): Promise<void> {
  let c: AgentCommand;
  try {
    c = parseAgentCli(process.argv.slice(2));
  } catch (e) {
    if (e instanceof CliError) {
      process.stderr.write(`${e.message}\n\n${AGENT_USAGE}`);
      process.exit(2);
    }
    throw e;
  }
  switch (c.command) {
    case 'help': return void process.stdout.write(AGENT_USAGE);
    case 'version': return void process.stdout.write(`${VERSION}\n`);
    case 'run': return run(c);
    case 'install': return install(c);
    case 'uninstall': return install(c, true);
    case 'status': return status(c);
    case 'approvals': return approvals(c);
    case 'audit': if (!(await audit(c))) process.exit(1); return;
  }
}

// Only when run as a program (tests import the parser).
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invoked && (invoked === fileURLToPath(import.meta.url) || /(^|[\\/])(agent|agent-cli)\.(js|ts)$/.test(invoked) || /inkstone-agent$/.test(invoked))) {
  main().catch((e) => {
    process.stderr.write(`[inkstone-agent] error: ${e instanceof CliError ? e.message : process.env.INKSTONE_DEBUG ? ((e as Error).stack ?? e) : ((e as Error).message ?? e)}\n`);
    process.exit(1);
  });
}
