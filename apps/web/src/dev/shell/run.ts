/**
 * Running a runbook ```sh block from the app: the command runs on a computer, by the always-on
 * runner, after this device signs an approval of that exact command (protocol and threat model in
 * packages/core/src/dev/shellrun.ts and docs/DEVELOPERS.md › Runbooks).
 *
 * 1. Find a runner that announced itself in the vault recently and trusts this device.
 * 2. Show the person the command, shell, folder and computer; nothing happens without "Run".
 * 3. Sign the request with this device's non-extractable key and write it to the vault; sync.
 * 4. Wait for the runner's result (it arrives through sync) and show it.
 */
import {
  SHELL_DIR, SHELL_REQUEST_TTL_MS, codeHash, liveRunners, newShellRunId, shellRequestPath, shellResultPath, signShellRequest,
  type RunbookBlock, type ShellRunResult, type ShellRunnerInfo, type VaultFS,
} from '@inkwright/core';
import { deviceKey } from '../../authorship/keys.ts';
import { useSettings } from '../../state/settings.ts';
import { askConfirm } from '../../ui/prompts.tsx';

export interface ShellRunOutcome {
  runner: ShellRunnerInfo;
  result: ShellRunResult;
}

/** Runners announced in the vault, freshest first (offline ones left out). */
export async function shellRunners(fs: VaultFS, now = Date.now()): Promise<ShellRunnerInfo[]> {
  const out: ShellRunnerInfo[] = [];
  for (const e of await fs.list(`${SHELL_DIR}/runners`).catch(() => [])) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
    try {
      out.push(JSON.parse((await fs.readText(`${SHELL_DIR}/runners/${e.name}`)) ?? 'null') as ShellRunnerInfo);
    } catch {
      /* half-synced */
    }
  }
  return liveRunners(out.filter(Boolean), now);
}

const norm = (f: string) => f.replace(/\s+/g, '').toUpperCase();

/** The command a person runs on their computer to let this device's approvals through. */
export function setupCommand(fingerprint: string, folder = '~/code'): string {
  return `inkwright-agent run --vault <your vault> --shell-allow ${folder} --shell-trust "${fingerprint}"`;
}

export class ShellRunError extends Error {}

/**
 * Asks, signs, sends and waits. Returns null when the person declined. `sync` pushes the request
 * out (and pulls results in); `poll` is how long to wait between looks at the result.
 */
export async function runShellBlock(block: RunbookBlock, ctx: { fs: VaultFS; noteId: string; noteTitle: string; sync?: () => void; pollMs?: number; signal?: AbortSignal }): Promise<ShellRunOutcome | null> {
  const key = await deviceKey();
  const runners = await shellRunners(ctx.fs);
  if (!runners.length) throw new ShellRunError(`No computer is set up to run shell blocks. On a computer with this vault, run:\n${setupCommand(key.fingerprint)}`);
  const runner = runners.find((r) => r.trusted.some((t) => norm(t) === norm(key.fingerprint)));
  if (!runner) throw new ShellRunError(`${runners[0]!.label} doesn't accept approvals from this device yet. Add it there with --shell-trust "${key.fingerprint}".`);
  const dialect = block.shell?.dialect ?? 'sh';
  if (!runner.shells.includes(dialect)) throw new ShellRunError(`${runner.label} has no ${dialect}; it has ${runner.shells.join(', ')}.`);
  const folder = block.shell?.cwd ?? runner.allow[0] ?? '';
  const ok = await askConfirm(
    `Run this on ${runner.label}?`,
    `${block.code}\n\nShell: ${dialect} · Folder: ${folder} · Stops after ${runner.timeoutSeconds} s\n\nIt runs on ${runner.label} with your account there, in a folder that computer allows. The output comes back into this note's run result; the approval is signed by this device and works once, for 5 minutes.`,
    `Run on ${runner.label}`,
  );
  if (!ok) return null;
  const now = Date.now();
  const deviceName = useSettings.getState().authorship.deviceName.trim();
  const req = await signShellRequest({
    v: 1, id: newShellRunId(), runner: runner.id, command: block.code, dialect, ...(block.shell?.cwd ? { cwd: block.shell.cwd } : {}),
    note: { id: ctx.noteId, title: ctx.noteTitle }, block: { line: block.line, codeHash: codeHash(block.code) },
    requestedAt: now, expiresAt: now + SHELL_REQUEST_TTL_MS,
    device: { publicJwk: key.publicJwk, fingerprint: key.fingerprint, ...(deviceName ? { name: deviceName } : {}) },
  }, key.privateKey);
  await ctx.fs.writeText(shellRequestPath(req.id), `${JSON.stringify(req, null, 1)}\n`);
  ctx.sync?.();
  // Wait for a final result: the runner must pick it up before it expires, then run it.
  const deadline = req.expiresAt + runner.timeoutSeconds * 1000 + 60_000;
  const pollMs = ctx.pollMs ?? 1500;
  for (;;) {
    if (ctx.signal?.aborted) throw new ShellRunError('Stopped waiting for the result.');
    const raw = await ctx.fs.readText(shellResultPath(req.id)).catch(() => null);
    const result = raw ? (JSON.parse(raw) as ShellRunResult) : null;
    if (result && result.status !== 'running') {
      await ctx.fs.delete(shellRequestPath(req.id)).catch(() => {});
      return { runner, result };
    }
    if (!result && Date.now() > req.expiresAt) {
      await ctx.fs.delete(shellRequestPath(req.id)).catch(() => {});
      throw new ShellRunError(`${runner.label} didn't pick the command up within 5 minutes (asleep, or the vault hasn't synced there). Nothing ran.`);
    }
    if (Date.now() > deadline) throw new ShellRunError(`No result from ${runner.label} yet. It may still be running; the result will be in ${shellResultPath(req.id)}.`);
    await new Promise((r) => setTimeout(r, pollMs));
    ctx.sync?.();
  }
}

// End-to-end tests play the computer's part (announce, verify the signed request, answer) through
// the vault, as a real runner does through sync.
declare const __E2E__: boolean;
if (typeof __E2E__ !== 'undefined' && __E2E__ && typeof window !== 'undefined') {
  void Promise.all([import('../../state/app.ts'), import('@inkwright/core')]).then(([{ useApp }, core]) => {
    (window as unknown as { __inkwrightShell?: unknown }).__inkwrightShell = {
      fs: () => useApp.getState().vault?.fs,
      fingerprint: async () => (await deviceKey()).fingerprint,
      verify: (r: { runner: string }, trusted: string[]) => core.verifyShellRequest(r, { runner: r.runner, trusted, now: Date.now(), seen: () => false }),
    };
  });
}
