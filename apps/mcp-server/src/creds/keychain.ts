/**
 * Where the credential store's data key lives: the operating system's own secret store when one
 * is usable, otherwise nowhere (the key is derived from a passphrase each time; store.ts).
 *
 * | OS | Backend | How the secret travels |
 * | --- | --- | --- |
 * | macOS | the login keychain, through `security` | written with `security -i` (commands on stdin), read with `find-generic-password -w` |
 * | Linux | the Secret Service (GNOME Keyring, KWallet) through `secret-tool` (libsecret) | written on stdin, read from stdout |
 * | Windows | DPAPI (`ProtectedData`, CurrentUser scope) through PowerShell | the script, with the secret in it, goes on stdin; the protected blob is kept in a file beside the store |
 *
 * The secret is never put on a command line: other processes can read command lines (`ps`,
 * `/proc/<pid>/cmdline`, Task Manager), but not another process's stdin. Every backend runs
 * through an injectable `exec` so the logic is unit-tested without touching the real keychain.
 *
 * What a keychain adds over a file: the key is encrypted with the user's login secret and, on
 * macOS, bound to the `security` tool's access list; a copy of the home folder (a backup, a stolen
 * disk image) doesn't carry a usable key. What it doesn't add: any process running as the user
 * can ask for the item just as the executor does (docs/CREDENTIALS.md, "Limits").
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import * as path from 'node:path';

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a program with arguments (no shell) and the given stdin. */
export type Exec = (cmd: string, args: string[], stdin?: string) => Promise<ExecResult>;

export const nodeExec: Exec = (cmd, args, stdin) =>
  new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let child;
    try {
      child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    } catch (e) {
      resolve({ code: 127, stdout: '', stderr: (e as Error).message });
      return;
    }
    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e) => resolve({ code: 127, stdout, stderr: stderr || e.message }));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(stdin ?? '');
  });

export const KEYCHAIN_SERVICE = 'app.inkwright.credentials';

/** A place that keeps one secret per account name. */
export interface Keychain {
  readonly id: 'macos-keychain' | 'secret-service' | 'windows-dpapi';
  /** "the macOS login keychain" — for messages. */
  readonly label: string;
  get(account: string): Promise<string | null>;
  set(account: string, secret: string): Promise<void>;
  delete(account: string): Promise<void>;
}

const safeName = (s: string) => {
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(s)) throw new Error(`Keychain account names are letters, digits, dot, dash and underscore (got ${JSON.stringify(s)}).`);
  return s;
};

export class MacKeychain implements Keychain {
  readonly id = 'macos-keychain' as const;
  readonly label = 'the macOS login keychain';
  constructor(private exec: Exec = nodeExec, private service = KEYCHAIN_SERVICE) {}

  async get(account: string): Promise<string | null> {
    const r = await this.exec('security', ['find-generic-password', '-s', this.service, '-a', safeName(account), '-w']);
    if (r.code === 44) return null; // errSecItemNotFound
    if (r.code !== 0) throw new Error(`Reading ${this.label} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout.replace(/\r?\n$/, '');
  }

  async set(account: string, secret: string): Promise<void> {
    if (!/^[A-Za-z0-9+/=_-]+$/.test(secret)) throw new Error('Only encoded keys are stored in the keychain.');
    // `-i` reads commands from stdin, so the secret never appears in a process listing.
    const r = await this.exec('security', ['-i'], `add-generic-password -U -s ${this.service} -a ${safeName(account)} -l "Inkwright credentials" -w ${secret}\n`);
    if (r.code !== 0 || /error/i.test(r.stderr)) throw new Error(`Writing ${this.label} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  async delete(account: string): Promise<void> {
    const r = await this.exec('security', ['delete-generic-password', '-s', this.service, '-a', safeName(account)]);
    if (r.code !== 0 && r.code !== 44) throw new Error(`Deleting from ${this.label} failed: ${r.stderr.trim()}`);
  }
}

export class SecretServiceKeychain implements Keychain {
  readonly id = 'secret-service' as const;
  readonly label = 'the Secret Service (GNOME Keyring / KWallet)';
  constructor(private exec: Exec = nodeExec, private service = KEYCHAIN_SERVICE) {}

  async get(account: string): Promise<string | null> {
    const r = await this.exec('secret-tool', ['lookup', 'service', this.service, 'account', safeName(account)]);
    // Not found: exit 1 with nothing on stderr. Anything on stderr is a real failure (no bus, locked).
    if (r.code !== 0 && r.stderr.trim()) throw new Error(`Reading ${this.label} failed: ${r.stderr.trim()}`);
    if (r.code !== 0) return null;
    return r.stdout.replace(/\r?\n$/, '') || null;
  }

  async set(account: string, secret: string): Promise<void> {
    const r = await this.exec('secret-tool', ['store', '--label=Inkwright credentials', 'service', this.service, 'account', safeName(account)], secret);
    if (r.code !== 0) throw new Error(`Writing ${this.label} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
  }

  async delete(account: string): Promise<void> {
    await this.exec('secret-tool', ['clear', 'service', this.service, 'account', safeName(account)]);
  }
}

/**
 * Windows: DPAPI protects the secret with the user's logon credentials. The protected blob is a
 * file next to the store (`<dir>/<account>.dpapi`); only the same Windows user on the same machine
 * can unprotect it.
 */
export class DpapiKeychain implements Keychain {
  readonly id = 'windows-dpapi' as const;
  readonly label = 'Windows DPAPI (current user)';
  constructor(private dir: string, private exec: Exec = nodeExec) {}

  private file(account: string) {
    return path.join(this.dir, `${safeName(account)}.dpapi`);
  }

  private async ps(script: string): Promise<string> {
    const r = await this.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '-'], `${script}\n`);
    if (r.code !== 0) throw new Error(`${this.label} failed: ${r.stderr.trim() || `exit ${r.code}`}`);
    return r.stdout.trim();
  }

  async get(account: string): Promise<string | null> {
    const blob = await readFile(this.file(account), 'utf8').catch(() => null);
    if (!blob) return null;
    if (!/^[A-Za-z0-9+/=]+$/.test(blob.trim())) throw new Error(`${this.file(account)} is damaged.`);
    const out = await this.ps(`Add-Type -AssemblyName System.Security; $b=[Convert]::FromBase64String('${blob.trim()}'); [Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser'))`);
    return out || null;
  }

  async set(account: string, secret: string): Promise<void> {
    if (!/^[A-Za-z0-9+/=_-]+$/.test(secret)) throw new Error('Only encoded keys are stored with DPAPI.');
    const out = await this.ps(`Add-Type -AssemblyName System.Security; $b=[Text.Encoding]::UTF8.GetBytes('${secret}'); [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$null,'CurrentUser'))`);
    await writeFile(this.file(account), `${out}\n`, { mode: 0o600 });
  }

  async delete(account: string): Promise<void> {
    await writeFile(this.file(account), '', { mode: 0o600 }).catch(() => {});
  }
}

function onPath(cmd: string, env: NodeJS.ProcessEnv): boolean {
  const sep = process.platform === 'win32' ? ';' : ':';
  return (env.PATH ?? '').split(sep).some((d) => d && existsSync(path.join(d, cmd)));
}

/**
 * The keychain usable here, or null. Linux needs `secret-tool` and a session bus (a desktop
 * login); headless servers usually have neither and fall back to a passphrase.
 */
export function detectKeychain(o: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv; dir: string; exec?: Exec }): Keychain | null {
  const platform = o.platform ?? process.platform;
  const env = o.env ?? process.env;
  if (platform === 'darwin') return new MacKeychain(o.exec);
  if (platform === 'win32') return new DpapiKeychain(o.dir, o.exec);
  if (platform === 'linux' && env.DBUS_SESSION_BUS_ADDRESS && onPath('secret-tool', env)) return new SecretServiceKeychain(o.exec);
  return null;
}
