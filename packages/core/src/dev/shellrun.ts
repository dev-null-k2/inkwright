/**
 * Runbook ```sh blocks, run on a computer by the always-on runner (`inkwright-agent run
 * --shell-allow <dir>`) after a signed, per-run approval in the app. The vault is the channel —
 * the app and the runner may be on different devices and only share the synced vault — so the
 * vault must never be enough to run a command: anyone who can write it (a sync remote, a paired
 * device; docs/SECURITY_REVIEW.md SR-13) could plant a request. Hence:
 *
 * 1. The person presses Run on a block and sees the exact command, shell, folder and computer.
 * 2. The app writes a **request** (`dev/shell/requests/<id>.json`) signed with this device's
 *    non-extractable ECDSA P-256 key (the authorship key), over a canonical, domain-separated
 *    encoding of every field that matters: command, shell, folder, runner, note, block, times.
 * 3. The runner runs it only if: the signature verifies; the signing key's fingerprint is one the
 *    runner was told to trust **on that computer** (`--shell-trust`, never from the vault); it is
 *    addressed to this runner; it is fresh (at most 5 minutes old, not from the future) and not
 *    seen before; and the folder resolves (symlinks followed) inside a folder the runner allows.
 * 4. The **result** (`dev/shell/results/<id>.json`) holds the exit status and the output,
 *    shortened like a log; the full output stays on the runner's computer. A `running` result is
 *    written before the command starts, so a request runs at most once.
 *
 * This file is the pure, shared part: formats, the signed payload, verification. The runner is
 * `apps/mcp-server/src/runner/shell.ts`; the app is `apps/web/src/dev/shell/`.
 */
import { canonicalJson, fingerprintOf } from '../authorship.ts';
import { fromBase64Url, sha256, toBase64Url, toHex } from '../sha256.ts';
import type { ShellDialect } from './runbook.ts';

export const SHELL_DIR = 'dev/shell';
export const shellRequestPath = (id: string) => `${SHELL_DIR}/requests/${id}.json`;
export const shellResultPath = (id: string) => `${SHELL_DIR}/results/${id}.json`;
export const shellRunnerPath = (runner: string) => `${SHELL_DIR}/runners/${runner}.json`;

/** How long a signed request stays valid. */
export const SHELL_REQUEST_TTL_MS = 5 * 60_000;
/** A runner whose heartbeat is older than this is shown as offline. */
export const SHELL_RUNNER_STALE_MS = 3 * 60_000;
const DOMAIN = 'inkwright-shell-run/1';

/** What a runner announces in the vault so the app can offer it. */
export interface ShellRunnerInfo {
  v: 1;
  /** Stable id of the runner (its lease holder id without the random part). */
  id: string;
  /** "Ana's MacBook" — the computer's name. */
  label: string;
  platform: string;
  /** Folders commands may run in (as configured on that computer). */
  allow: string[];
  /** Shells available there. */
  shells: ShellDialect[];
  timeoutSeconds: number;
  /** Fingerprints of the devices whose approvals it accepts (so the app can say whether this device is one). */
  trusted: string[];
  heartbeatAt: number;
}

export interface ShellRunRequest {
  v: 1;
  /** Random, 16+ characters of [0-9A-Za-z_-]. */
  id: string;
  /** The runner it is for (`ShellRunnerInfo.id`). */
  runner: string;
  command: string;
  dialect: ShellDialect;
  /** Folder to run in, as written in the block (`~` allowed); default: the first allowed folder. */
  cwd?: string;
  note: { id: string; title: string };
  /** Where the block is (for the result to find its way back) and a hash of its code. */
  block: { textId?: string; line: number; codeHash: string };
  requestedAt: number;
  expiresAt: number;
  /** The approving device: its public key, fingerprint and name. */
  device: { publicJwk: JsonWebKey; fingerprint: string; name?: string };
  /** Base64url ECDSA P-256 / SHA-256 signature (IEEE P1363) over `shellRequestPayload`. */
  sig: string;
}

export type ShellRunStatus = 'running' | 'done' | 'failed' | 'timeout' | 'refused';

export interface ShellRunResult {
  v: 1;
  id: string;
  runner: string;
  status: ShellRunStatus;
  /** Why it was refused or could not start, in plain words. */
  reason?: string;
  exitCode?: number | null;
  signal?: string | null;
  startedAt?: number;
  finishedAt?: number;
  /** Combined stdout and stderr, shortened when long. */
  output?: string;
  /** Size of the full output in bytes, and whether `output` was shortened. */
  outputBytes?: number;
  shortened?: boolean;
  /** Where the full output is kept on the runner's computer (a content ref), when shortened. */
  originalRef?: string;
  /** Folder it ran in (resolved). */
  cwd?: string;
}

export const codeHash = (code: string) => toHex(sha256(code.replace(/\r\n?/g, '\n')).subarray(0, 16));

/** The bytes the approving device signs: everything except the signature, canonical, domain-tagged. */
export function shellRequestPayload(r: Omit<ShellRunRequest, 'sig'>): Uint8Array {
  const { v, id, runner, command, dialect, cwd, note, block, requestedAt, expiresAt, device } = r;
  return new TextEncoder().encode(`${DOMAIN}\n${canonicalJson({ v, id, runner, command, dialect, cwd: cwd ?? null, note, block, requestedAt, expiresAt, device: { publicJwk: { kty: device.publicJwk.kty, crv: device.publicJwk.crv, x: device.publicJwk.x, y: device.publicJwk.y }, fingerprint: device.fingerprint } })}`);
}

const ALG = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Signs a request with the device's private key (WebCrypto). */
export async function signShellRequest(r: Omit<ShellRunRequest, 'sig'>, key: CryptoKey): Promise<ShellRunRequest> {
  const sig = new Uint8Array(await crypto.subtle.sign(ALG, key, shellRequestPayload(r) as BufferSource));
  return { ...r, sig: toBase64Url(sig) };
}

export type ShellVerdict = { ok: true } | { ok: false; reason: string };

/**
 * Checks a request as the runner must before running anything (see the module comment). `seen`
 * answers whether this id was handled before. Never throws: every problem is a reason.
 */
export async function verifyShellRequest(r: unknown, o: { runner: string; trusted: readonly string[]; now: number; seen: (id: string) => boolean; dialects?: readonly ShellDialect[] }): Promise<ShellVerdict> {
  const q = r as Partial<ShellRunRequest> | null;
  if (!q || typeof q !== 'object' || q.v !== 1) return { ok: false, reason: 'Not a shell run request.' };
  if (typeof q.id !== 'string' || !/^[0-9A-Za-z_-]{16,64}$/.test(q.id)) return { ok: false, reason: 'The request has no valid id.' };
  if (q.runner !== o.runner) return { ok: false, reason: 'The request is for another computer.' };
  if (typeof q.command !== 'string' || !q.command.trim() || q.command.length > 20_000) return { ok: false, reason: 'The command is empty or too long.' };
  if (!q.dialect || !(o.dialects ?? ['sh', 'bash', 'zsh', 'pwsh']).includes(q.dialect)) return { ok: false, reason: `The shell ${String(q.dialect)} is not available here.` };
  if (q.cwd !== undefined && (typeof q.cwd !== 'string' || q.cwd.length > 1024 || /\0/.test(q.cwd))) return { ok: false, reason: 'The folder is not valid.' };
  if (typeof q.requestedAt !== 'number' || typeof q.expiresAt !== 'number') return { ok: false, reason: 'The request has no times.' };
  if (q.expiresAt - q.requestedAt > SHELL_REQUEST_TTL_MS || q.expiresAt < o.now) return { ok: false, reason: 'The approval expired; run the block again in the app.' };
  if (q.requestedAt > o.now + 60_000) return { ok: false, reason: 'The request is dated in the future (check the clocks).' };
  if (o.seen(q.id)) return { ok: false, reason: 'This approval was already used.' };
  if (!q.note || typeof q.note.id !== 'string' || !q.block || typeof q.block.line !== 'number' || typeof q.block.codeHash !== 'string') return { ok: false, reason: 'The request does not say which block it is.' };
  if (codeHash(q.command) !== q.block.codeHash) return { ok: false, reason: 'The command does not match the approved block.' };
  const jwk = q.device?.publicJwk;
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || typeof q.sig !== 'string') return { ok: false, reason: 'The request is not signed.' };
  let fp: string;
  try {
    fp = fingerprintOf(jwk);
  } catch {
    return { ok: false, reason: 'The signing key is not valid.' };
  }
  if (fp !== q.device!.fingerprint) return { ok: false, reason: 'The signing key does not match its fingerprint.' };
  const norm = (f: string) => f.replace(/\s+/g, '').toUpperCase();
  if (!o.trusted.some((t) => norm(t) === norm(fp))) return { ok: false, reason: `This computer doesn't accept approvals from device ${fp}. On the computer, add it with --shell-trust "${fp}".` };
  try {
    const key = await crypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, ext: true }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify(ALG, key, fromBase64Url(q.sig) as BufferSource, shellRequestPayload(q as ShellRunRequest) as BufferSource);
    if (!ok) return { ok: false, reason: 'The approval signature does not verify (the request was changed after it was approved).' };
  } catch {
    return { ok: false, reason: 'The approval signature could not be checked.' };
  }
  return { ok: true };
}

/** A runner the app can offer: announced recently. */
export function liveRunners(list: readonly ShellRunnerInfo[], now: number): ShellRunnerInfo[] {
  return list.filter((r) => r && r.v === 1 && now - r.heartbeatAt < SHELL_RUNNER_STALE_MS).sort((a, b) => b.heartbeatAt - a.heartbeatAt);
}

/** A random request id (URL- and file-safe). */
export function newShellRunId(random: (n: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n))): string {
  return toBase64Url(random(18));
}
