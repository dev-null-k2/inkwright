/**
 * Runbook ```sh blocks on this computer (packages/core/src/dev/shellrun.ts has the protocol and
 * why the vault alone is never enough). Off unless the runner is started with at least one
 * `--shell-allow <folder>`; requests are accepted only from devices named with `--shell-trust
 * <fingerprint>` on this computer.
 *
 * Each run: verify the signed request; resolve the folder (`~`, relative to the first allowed
 * folder, symlinks followed) and require it inside an allowed folder; write a `running` result
 * (so it can never run twice); run the command with the chosen shell, no stdin, an environment
 * without secrets (variables named like keys, tokens, passwords, and every INKWRIGHT_* one), in
 * its own process group so a timeout kills everything it started; keep at most `maxOutputBytes`
 * of output; shorten long output like a log (errors kept), keeping the full output on this
 * computer with a content ref; write the result; record the run in the signed audit trail.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { realpathSync, statSync, existsSync } from 'node:fs';
import { homedir, hostname } from 'node:os';
import * as path from 'node:path';
import { compressContent, estimateTokens, shortenLossless, type ContentStore } from '@inkwright/ai';
import { SHELL_DIR, shellResultPath, shellRunnerPath, verifyShellRequest, type ShellDialect, type ShellRunRequest, type ShellRunResult, type ShellRunnerInfo } from '@inkwright/core';
import type { ServerContext } from '../context.ts';

export interface ShellOptions {
  ctx: ServerContext;
  /** Folders commands may run in (absolute; `~` expanded by the caller). */
  allow: string[];
  /** Fingerprints of devices whose approvals are accepted. */
  trusted: string[];
  /** Kill after this long (default 120 s). */
  timeoutSeconds?: number;
  /** Output kept per run (default 1 MiB). */
  maxOutputBytes?: number;
  /** Where full outputs are kept (the proxy's store of originals). */
  originals?: ContentStore;
  /** Runner id in the vault (default: from this computer and vault). */
  id?: string;
  label?: string;
  pollMs?: number;
  log?: (m: string) => void;
  clock?: () => number;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSPHRASE|CREDENTIAL|AUTH)/i;

/** The environment a command gets: the runner's, minus anything that looks like a secret. */
export function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(env)) if (!SECRET_ENV.test(k) && !/^INKWRIGHT_/.test(k)) out[k] = v;
  return out;
}

/** Program and arguments for a dialect. */
export function shellCommand(dialect: ShellDialect, command: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  switch (dialect) {
    case 'pwsh': return ['pwsh', ['-NoProfile', '-NonInteractive', '-Command', command]];
    case 'bash': return ['bash', ['-c', command]];
    case 'zsh': return ['zsh', ['-c', command]];
    default: return platform === 'win32' ? ['sh', ['-c', command]] : ['/bin/sh', ['-c', command]];
  }
}

/**
 * The folder a request may run in, or why not. Relative folders are taken from the first allowed
 * folder; the real path (symlinks followed) must be an allowed folder or inside one.
 */
export function resolveRunFolder(cwd: string | undefined, allow: readonly string[], home = homedir()): { ok: true; dir: string } | { ok: false; reason: string } {
  if (!allow.length) return { ok: false, reason: 'No folders are allowed on this computer.' };
  const raw = !cwd ? allow[0]! : cwd === '~' ? home : cwd.startsWith('~/') ? path.join(home, cwd.slice(2)) : path.isAbsolute(cwd) ? cwd : path.join(allow[0]!, cwd);
  let real: string;
  try {
    real = realpathSync(raw);
    if (!statSync(real).isDirectory()) return { ok: false, reason: `${cwd} is not a folder.` };
  } catch {
    return { ok: false, reason: `The folder ${cwd ?? raw} doesn't exist on this computer.` };
  }
  for (const a of allow) {
    let base: string;
    try { base = realpathSync(a); } catch { continue; }
    const rel = path.relative(base, real);
    if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) return { ok: true, dir: real };
  }
  return { ok: false, reason: `${cwd ?? raw} is not inside a folder this computer allows commands in (${allow.join(', ')}).` };
}

/** Shortens long command output like a log: errors and the end are kept. */
export function shapeOutput(out: string, maxTokens = 1500): { text: string; shortened: boolean } {
  const lossless = shortenLossless(out);
  if (estimateTokens(lossless) <= maxTokens) return { text: lossless, shortened: lossless !== out };
  const r = compressContent(lossless, { targetTokens: maxTokens });
  const text = r && estimateTokens(r.text) <= maxTokens * 1.5 ? r.text : `${lossless.slice(0, maxTokens * 2)}\n… ${lossless.length - maxTokens * 4} characters …\n${lossless.slice(-maxTokens * 2)}`;
  return { text, shortened: true };
}

export class ShellService {
  readonly id: string;
  private timer: ReturnType<typeof setInterval> | null = null;
  private beat: ReturnType<typeof setInterval> | null = null;
  private handled = new Set<string>();
  private busy = false;
  private stopped = false;
  private clock: () => number;
  private log: (m: string) => void;
  /** Runs in flight (for stop and tests). */
  readonly running = new Map<string, Promise<void>>();

  constructor(private o: ShellOptions) {
    this.clock = o.clock ?? o.ctx.clock;
    this.log = o.log ?? (() => {});
    this.id = o.id ?? `sh-${createHash('sha256').update(`${hostname()}\n${o.ctx.root}`).digest('hex').slice(0, 10)}`;
  }

  get info(): ShellRunnerInfo {
    const platform = this.o.platform ?? process.platform;
    const shells: ShellDialect[] = ['sh', ...(['bash', 'zsh', 'pwsh'] as const).filter((s) => onPath(s, this.o.env ?? process.env))];
    return { v: 1, id: this.id, label: this.o.label ?? hostname().replace(/\.local$/, ''), platform, allow: this.o.allow, shells, timeoutSeconds: this.o.timeoutSeconds ?? 120, trusted: this.o.trusted, heartbeatAt: this.clock() };
  }

  async start(): Promise<void> {
    if (this.o.ctx.readOnly) throw new Error('Runbook shell blocks need a writable vault (results are written there).');
    // Requests already answered (by an earlier run of this runner) are never run again.
    for (const e of await this.o.ctx.fs.list(`${SHELL_DIR}/results`)) if (e.name.endsWith('.json')) this.handled.add(e.name.slice(0, -5));
    await this.announce();
    this.beat = setInterval(() => void this.announce().catch(() => {}), 60_000);
    this.beat.unref?.();
    this.timer = setInterval(() => void this.poll(), this.o.pollMs ?? 2000);
    this.timer.unref?.();
    this.log(`Runbook shell blocks: on, in ${this.o.allow.join(', ')}; approvals accepted from ${this.o.trusted.length} device(s).`);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.beat) clearInterval(this.beat);
    await Promise.allSettled([...this.running.values()]);
    await this.o.ctx.fs.delete(shellRunnerPath(this.id)).catch(() => {});
  }

  private async announce(): Promise<void> {
    await this.o.ctx.fs.writeText(shellRunnerPath(this.id), `${JSON.stringify(this.info, null, 1)}\n`);
  }

  /** Looks for new requests addressed to this runner. Public for tests. */
  async poll(): Promise<void> {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      for (const e of await this.o.ctx.fs.list(`${SHELL_DIR}/requests`)) {
        if (!e.name.endsWith('.json')) continue;
        const id = e.name.slice(0, -5);
        if (this.handled.has(id) || this.running.has(id)) continue;
        const raw = await this.o.ctx.fs.readText(`${SHELL_DIR}/requests/${e.name}`).catch(() => null);
        let req: ShellRunRequest | null = null;
        try { req = raw ? (JSON.parse(raw) as ShellRunRequest) : null; } catch { /* half-synced */ }
        if (!req || req.runner !== this.id) continue;
        if (req.id !== id) { this.handled.add(id); continue; }
        const p = this.handle(req).finally(() => this.running.delete(id));
        this.running.set(id, p);
      }
    } finally {
      this.busy = false;
    }
  }

  private async write(r: ShellRunResult): Promise<void> {
    await this.o.ctx.fs.writeText(shellResultPath(r.id), `${JSON.stringify(r, null, 1)}\n`);
  }

  private audit(req: ShellRunRequest, outcome: 'ok' | 'error' | 'blocked', summary: string, data: Record<string, unknown>): void {
    this.o.ctx.trust.audit.record({ kind: outcome === 'blocked' ? 'blocked' : 'exec', actor: { source: 'runner', label: `Runbook “${req.note?.title ?? ''}” approved on ${req.device?.name ?? req.device?.fingerprint ?? 'a device'}` }, summary, outcome, notes: req.note?.id ? [{ id: req.note.id, title: req.note.title }] : [], data: { request: req.id, command: String(req.command ?? '').slice(0, 2000), dialect: req.dialect, device: req.device?.fingerprint, ...data } });
  }

  private async handle(req: ShellRunRequest): Promise<void> {
    this.handled.add(req.id);
    const v = await verifyShellRequest(req, { runner: this.id, trusted: this.o.trusted, now: this.clock(), seen: () => false, dialects: this.info.shells });
    if (!v.ok) {
      await this.write({ v: 1, id: req.id, runner: this.id, status: 'refused', reason: v.reason, finishedAt: this.clock() });
      this.audit(req, 'blocked', `Refused a runbook command: ${v.reason}`, {});
      this.log(`Refused shell request ${req.id}: ${v.reason}`);
      return;
    }
    const where = resolveRunFolder(req.cwd, this.o.allow);
    if (!where.ok) {
      await this.write({ v: 1, id: req.id, runner: this.id, status: 'refused', reason: where.reason, finishedAt: this.clock() });
      this.audit(req, 'blocked', `Refused a runbook command: ${where.reason}`, { cwd: req.cwd ?? null });
      return;
    }
    const startedAt = this.clock();
    await this.write({ v: 1, id: req.id, runner: this.id, status: 'running', startedAt, cwd: where.dir });
    const r = await this.exec(req, where.dir);
    const full = r.output;
    const shaped = shapeOutput(full);
    const originalRef = shaped.shortened && this.o.originals ? await this.o.originals.put(full) : undefined;
    const result: ShellRunResult = {
      v: 1, id: req.id, runner: this.id, status: r.timedOut ? 'timeout' : r.error ? 'failed' : r.code === 0 ? 'done' : 'failed',
      ...(r.error ? { reason: r.error } : {}), exitCode: r.code, signal: r.signal, startedAt, finishedAt: this.clock(),
      output: shaped.text, outputBytes: r.bytes, shortened: shaped.shortened || r.capped, ...(originalRef ? { originalRef } : {}), cwd: where.dir,
    };
    await this.write(result);
    this.audit(req, result.status === 'done' ? 'ok' : 'error', `Ran a runbook command in ${where.dir}: exit ${r.code ?? r.signal ?? 'none'}${r.timedOut ? ' (timed out)' : ''}`, { cwd: where.dir, exitCode: r.code, outputBytes: r.bytes, ms: (result.finishedAt ?? startedAt) - startedAt });
    this.log(`Ran shell request ${req.id} in ${where.dir}: ${result.status}`);
  }

  private exec(req: ShellRunRequest, cwd: string): Promise<{ code: number | null; signal: string | null; output: string; bytes: number; capped: boolean; timedOut: boolean; error?: string }> {
    const max = this.o.maxOutputBytes ?? 1024 * 1024;
    const [cmd, args] = shellCommand(req.dialect, req.command, this.o.platform);
    return new Promise((resolve) => {
      const chunks: Buffer[] = [];
      let kept = 0;
      let bytes = 0;
      let timedOut = false;
      let child;
      try {
        child = spawn(cmd, args, { cwd, env: scrubEnv(this.o.env ?? process.env), stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
      } catch (e) {
        resolve({ code: null, signal: null, output: '', bytes: 0, capped: false, timedOut: false, error: `Could not start ${cmd}: ${(e as Error).message}` });
        return;
      }
      const take = (d: Buffer) => {
        bytes += d.length;
        if (kept < max) {
          const part = d.subarray(0, max - kept);
          chunks.push(part);
          kept += part.length;
        }
      };
      child.stdout!.on('data', take);
      child.stderr!.on('data', take);
      const kill = (sig: NodeJS.Signals) => {
        try {
          if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
          else child.kill(sig);
        } catch { /* already gone */ }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        kill('SIGTERM');
        setTimeout(() => kill('SIGKILL'), 2000).unref();
      }, (this.o.timeoutSeconds ?? 120) * 1000);
      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: null, signal: null, output: Buffer.concat(chunks).toString('utf8'), bytes, capped: bytes > max, timedOut, error: (e as NodeJS.ErrnoException).code === 'ENOENT' ? `${cmd} is not installed on this computer.` : e.message });
      });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, output: Buffer.concat(chunks).toString('utf8') + (bytes > max ? `\n… output cut at ${max} bytes (${bytes} in all) …` : ''), bytes, capped: bytes > max, timedOut });
      });
    });
  }
}

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const sep = process.platform === 'win32' ? ';' : ':';
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  return (env.PATH ?? '').split(sep).some((d) => d && exts.some((x) => existsSync(path.join(d, cmd + x))));
}
