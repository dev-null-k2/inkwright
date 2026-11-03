/**
 * The credential store: provider API keys, connector (MCP server) tokens and REST API keys of
 * other Inkwright servers, encrypted at rest in one file that only the credential executor reads
 * (`~/.config/inkwright/credentials/store.json`, mode 0600).
 *
 * - Each secret is sealed with AES-256-GCM under a random 256-bit **data key**. The entry's
 *   non-secret description (kind, provider, base URL or server URL, allow-lists) is the
 *   additional authenticated data, so whoever can edit the file cannot re-point a key at their
 *   own server: changing `baseUrl` makes the secret fail to open.
 * - The data key is kept in the OS keychain when one is usable (keychain.ts), or derived from a
 *   passphrase with scrypt (N = 2^17, r = 8, p = 1: about 128 MiB and a quarter second, per
 *   unlock). A known plaintext sealed with the key (`check`) tells a wrong passphrase from a
 *   damaged file.
 * - Writes are atomic (temp file + rename) and keep mode 0600.
 *
 * Only the executor process (executor.ts) and the `creds` command (to add and remove entries)
 * open the store. Nothing in this module returns a secret to a caller outside this package.
 */
import { createCipheriv, createDecipheriv, randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { Keychain } from './keychain.ts';

export const STORE_FILE = 'store.json';
const KEYCHAIN_ACCOUNT = 'store-data-key';
const CHECK_TEXT = 'inkwright-credential-store-v1';

/** Default folder for the store and the executor's socket (outside the vault: it never syncs). */
export function defaultCredentialsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.INKWRIGHT_CREDENTIALS_DIR) return path.resolve(env.INKWRIGHT_CREDENTIALS_DIR);
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Inkwright', 'credentials');
  return path.join(homedir(), '.config', 'inkwright', 'credentials');
}

// ---- Entries -----------------------------------------------------------------------------------

export type CredentialKind = 'provider' | 'connector' | 'api';

/**
 * What an entry is for. Everything here is bound to the secret (AAD): the executor only ever
 * sends the secret to `baseUrl` / `url`.
 */
export type CredentialMeta =
  | {
      kind: 'provider';
      /** @inkwright/ai provider id (anthropic, openai, gemini, openrouter, custom…). */
      provider: string;
      /** API base URL (default: the provider's). */
      baseUrl: string;
      /** Models this key may be used with (glob `*`); empty = any. */
      models?: string[];
    }
  | {
      kind: 'connector';
      /** The MCP server's Streamable HTTP URL. */
      url: string;
      /** The app's name or id for this server, so routines that use it can find it. */
      server?: string;
      /** Tools that may be called; empty = any (the AI policy's deny list still applies). */
      tools?: string[];
    }
  | {
      kind: 'api';
      /** Any HTTPS API that takes `Authorization: Bearer <key>` (e.g. a teammate's Inkwright server). */
      baseUrl: string;
    };

export type CredentialInfo = CredentialMeta & { name: string; createdAt: number };

interface SealedEntry {
  name: string;
  meta: CredentialMeta;
  createdAt: number;
  iv: string;
  ct: string;
}

type KdfSpec = { kind: 'keychain'; backend: Keychain['id']; account: string } | { kind: 'scrypt'; salt: string; N: number; r: number; p: number };

interface StoreFile {
  version: 1;
  kdf: KdfSpec;
  check: { iv: string; ct: string };
  entries: SealedEntry[];
}

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export function validateName(name: string): string {
  if (!NAME.test(name)) throw new Error(`Credential names are lower-case letters, digits, dot, dash and underscore, starting with a letter or digit (got ${JSON.stringify(name)}).`);
  return name;
}

/** Normalizes and checks the non-secret part of an entry. */
export function normalizeMeta(meta: CredentialMeta): CredentialMeta {
  const url = (u: string, what: string) => {
    let p: URL;
    try {
      p = new URL(u);
    } catch {
      throw new Error(`${what} must be a full URL (got ${JSON.stringify(u)}).`);
    }
    const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(p.hostname);
    if (p.protocol !== 'https:' && !(p.protocol === 'http:' && loopback)) throw new Error(`${what} must use https (http only for this computer): ${u}`);
    if (p.username || p.password || p.search || p.hash) throw new Error(`${what} can't carry credentials, a query or a fragment: ${u}`);
    return `${p.origin}${p.pathname.replace(/\/+$/, '')}`;
  };
  switch (meta.kind) {
    case 'provider':
      return { kind: 'provider', provider: meta.provider, baseUrl: url(meta.baseUrl, 'The base URL'), ...(meta.models?.length ? { models: [...meta.models] } : {}) };
    case 'connector':
      return { kind: 'connector', url: url(meta.url, 'The connector URL'), ...(meta.server ? { server: meta.server } : {}), ...(meta.tools?.length ? { tools: [...meta.tools] } : {}) };
    case 'api':
      return { kind: 'api', baseUrl: url(meta.baseUrl, 'The base URL') };
    default:
      throw new Error(`Unknown credential kind ${(meta as { kind: string }).kind}.`);
  }
}

/** Canonical bytes of an entry's description: the AES-GCM additional data. */
function aad(name: string, meta: CredentialMeta): Buffer {
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v);
  return Buffer.from(JSON.stringify(['inkwright-credential', 1, name, sorted(meta)]), 'utf8');
}

function seal(key: Buffer, plaintext: string, additional: Buffer): { iv: string; ct: string } {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(additional);
  const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final(), c.getAuthTag()]);
  return { iv: iv.toString('base64'), ct: ct.toString('base64') };
}

function open(key: Buffer, sealed: { iv: string; ct: string }, additional: Buffer): string {
  const raw = Buffer.from(sealed.ct, 'base64');
  const iv = Buffer.from(sealed.iv, 'base64');
  if (iv.length !== 12 || raw.length < 16) throw new Error('Damaged credential entry.');
  // authTagLength pins the tag to 16 bytes, so a truncated tag can never be accepted.
  const d = createDecipheriv('aes-256-gcm', key, iv, { authTagLength: 16 });
  d.setAAD(additional);
  d.setAuthTag(raw.subarray(raw.length - 16));
  return Buffer.concat([d.update(raw.subarray(0, raw.length - 16)), d.final()]).toString('utf8');
}

const scrypt = (pass: string, salt: Buffer, o: { N: number; r: number; p: number }) =>
  new Promise<Buffer>((resolve, reject) => scryptCb(pass.normalize('NFKC'), salt, 32, { N: o.N, r: o.r, p: o.p, maxmem: 256 * o.N * o.r + 32 * 1024 * 1024 } satisfies ScryptOptions, (e, k) => (e ? reject(e) : resolve(k))));

export class CredentialStoreError extends Error {
  constructor(readonly code: 'missing' | 'locked' | 'bad_passphrase' | 'damaged' | 'exists' | 'not_found' | 'permissions', message: string) {
    super(message);
  }
}

export interface UnlockOptions {
  keychain?: Keychain | null;
  /** Called only for passphrase stores. */
  passphrase?: () => Promise<string>;
}

/**
 * An unlocked store. `secretOf` is package-internal: the executor uses it to authenticate the
 * one request it is making, and nothing returns it over IPC.
 */
export class CredentialStore {
  private constructor(readonly dir: string, private file: StoreFile, private key: Buffer) {}

  /** How the data key is kept, in words. */
  get protection(): string {
    return this.file.kdf.kind === 'keychain' ? `OS keychain (${this.file.kdf.backend})` : 'passphrase (scrypt)';
  }

  static async exists(dir: string): Promise<boolean> {
    return !!(await stat(path.join(dir, STORE_FILE)).catch(() => null));
  }

  /**
   * Creates an empty store. With a keychain the data key goes there; otherwise a passphrase is
   * required (at least 12 characters).
   */
  static async create(dir: string, o: { keychain?: Keychain | null; passphrase?: string; scryptN?: number }): Promise<CredentialStore> {
    await ensurePrivateDir(dir);
    if (await CredentialStore.exists(dir)) throw new CredentialStoreError('exists', `A credential store already exists in ${dir}.`);
    let key: Buffer;
    let kdf: KdfSpec;
    if (o.keychain && o.passphrase === undefined) {
      key = randomBytes(32);
      await o.keychain.set(KEYCHAIN_ACCOUNT, key.toString('base64'));
      kdf = { kind: 'keychain', backend: o.keychain.id, account: KEYCHAIN_ACCOUNT };
    } else {
      if (!o.passphrase || o.passphrase.length < 12) throw new Error('Choose a passphrase of at least 12 characters (no keychain is available here).');
      const salt = randomBytes(16);
      const params = { N: o.scryptN ?? 2 ** 17, r: 8, p: 1 };
      key = await scrypt(o.passphrase, salt, params);
      kdf = { kind: 'scrypt', salt: salt.toString('base64'), ...params };
    }
    const file: StoreFile = { version: 1, kdf, check: seal(key, CHECK_TEXT, Buffer.from('check')), entries: [] };
    const s = new CredentialStore(dir, file, key);
    await s.save();
    return s;
  }

  static async unlock(dir: string, o: UnlockOptions): Promise<CredentialStore> {
    await checkPrivate(dir);
    const raw = await readFile(path.join(dir, STORE_FILE), 'utf8').catch(() => null);
    if (raw == null) throw new CredentialStoreError('missing', `No credential store in ${dir}. Create one with: inkwright-mcp creds init`);
    let file: StoreFile;
    try {
      file = JSON.parse(raw) as StoreFile;
      if (file.version !== 1 || !file.kdf || !file.check || !Array.isArray(file.entries)) throw new Error('shape');
    } catch {
      throw new CredentialStoreError('damaged', `${path.join(dir, STORE_FILE)} is not a credential store.`);
    }
    let key: Buffer;
    if (file.kdf.kind === 'keychain') {
      if (!o.keychain) throw new CredentialStoreError('locked', 'This store keeps its key in the OS keychain, which is not available here.');
      const k = await o.keychain.get(file.kdf.account);
      if (!k) throw new CredentialStoreError('locked', `The store's key is missing from ${o.keychain.label}.`);
      key = Buffer.from(k, 'base64');
    } else {
      if (!o.passphrase) throw new CredentialStoreError('locked', 'This store is protected by a passphrase.');
      key = await scrypt(await o.passphrase(), Buffer.from(file.kdf.salt, 'base64'), file.kdf);
    }
    try {
      const check = open(key, file.check, Buffer.from('check'));
      if (!timingSafeEqual(Buffer.from(check), Buffer.from(CHECK_TEXT))) throw new Error('check');
    } catch {
      throw new CredentialStoreError(file.kdf.kind === 'scrypt' ? 'bad_passphrase' : 'damaged', file.kdf.kind === 'scrypt' ? 'Wrong passphrase.' : 'The keychain key does not open this store.');
    }
    return new CredentialStore(dir, file, key);
  }

  list(): CredentialInfo[] {
    return this.file.entries.map((e) => ({ ...e.meta, name: e.name, createdAt: e.createdAt }));
  }

  get(name: string): CredentialInfo | null {
    const e = this.file.entries.find((x) => x.name === name);
    return e ? { ...e.meta, name: e.name, createdAt: e.createdAt } : null;
  }

  /**
   * The secret of an entry, after checking its seal against its description. Only the executor
   * calls this, right before it authenticates a request it is making itself.
   */
  secretOf(name: string): string {
    const e = this.file.entries.find((x) => x.name === name);
    if (!e) throw new CredentialStoreError('not_found', `No credential named ${name}.`);
    try {
      return open(this.key, e, aad(e.name, e.meta));
    } catch {
      throw new CredentialStoreError('damaged', `The credential ${name} does not match its description (the store file was edited). Remove it and add it again.`);
    }
  }

  async put(name: string, meta: CredentialMeta, secret: string, now = Date.now()): Promise<CredentialInfo> {
    validateName(name);
    if (!secret || /[\r\n]/.test(secret) || secret.length > 16_384) throw new Error('The secret must be one line of at most 16 KiB.');
    const m = normalizeMeta(meta);
    const sealed: SealedEntry = { name, meta: m, createdAt: now, ...seal(this.key, secret, aad(name, m)) };
    this.file.entries = [...this.file.entries.filter((e) => e.name !== name), sealed].sort((a, b) => a.name.localeCompare(b.name));
    await this.save();
    return { ...m, name, createdAt: now };
  }

  async remove(name: string): Promise<boolean> {
    const before = this.file.entries.length;
    this.file.entries = this.file.entries.filter((e) => e.name !== name);
    if (this.file.entries.length === before) return false;
    await this.save();
    return true;
  }

  /** Re-reads the file (entries added by `creds add` while the executor runs). */
  async reload(): Promise<void> {
    const raw = await readFile(path.join(this.dir, STORE_FILE), 'utf8');
    const next = JSON.parse(raw) as StoreFile;
    // Same key or nothing: a file sealed under another key is not ours to trust.
    open(this.key, next.check, Buffer.from('check'));
    this.file = next;
  }

  private async save(): Promise<void> {
    const target = path.join(this.dir, STORE_FILE);
    const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tmp, `${JSON.stringify(this.file, null, 1)}\n`, { mode: 0o600 });
    await rename(tmp, target);
    await chmod(target, 0o600).catch(() => {});
  }
}

/** Creates the folder 0700 (or tightens it) and checks it is ours. */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(dir, 0o700);
  await checkPrivate(dir);
}

/**
 * Refuses a folder another user owns or can read (Unix). A store or socket in a group- or
 * world-accessible folder could be replaced or reached by someone else.
 */
export async function checkPrivate(dir: string): Promise<void> {
  if (process.platform === 'win32') return;
  const st = await stat(dir).catch(() => null);
  if (!st) return;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) throw new CredentialStoreError('permissions', `${dir} belongs to another user; refusing to use it.`);
  if (st.mode & 0o077) throw new CredentialStoreError('permissions', `${dir} is readable by other users (mode ${(st.mode & 0o777).toString(8)}); run: chmod 700 "${dir}"`);
}
