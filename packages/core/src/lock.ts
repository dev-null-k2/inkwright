import type { NoteLock, NoteMeta, PageInk, SealedBox } from './model.ts';
import { decodePage, encodePage } from './codec.ts';
import { fromBase64Url, toBase64Url } from './sha256.ts';

/**
 * Locked notes (docs/PRIVACY.md has the threat model). A passcode is stretched with PBKDF2-SHA-256
 * (600,000 iterations, a random 128-bit salt per note) into a non-extractable AES-GCM-256 key.
 * The key encrypts the note's pages, its assets (images, PDFs, recordings, certificates), its
 * version history and the metadata fields that reveal content. Files at rest — on the device and
 * in every synced copy — hold only ciphertext; the passcode and key never touch the disk.
 *
 * Every ciphertext carries associated data naming what it is (`inkwright:page:<id>`,
 * `inkwright:asset:<name>`…), so blobs can't be swapped between pages or files unnoticed.
 *
 * There is no recovery: a forgotten passcode means the note can't be opened by anyone.
 */

export const LOCK_ITERATIONS = 600_000;
/** Shortest passcode accepted (characters). */
export const MIN_PASSCODE = 4;
/** Fields of `NoteMeta` that hold content and are sealed in `lock.meta` while locked. */
export const SEALED_META_FIELDS = ['summary', 'forms', 'properties'] as const;

const enc = new TextEncoder();
const dec = new TextDecoder();
/** First bytes of an encrypted asset file: "INKSEAL1". */
const MAGIC = enc.encode('INKSEAL1');
const CHECK = 'inkwright-lock-check-v1';

export class NoteLockedError extends Error {
  constructor(readonly noteId: string) {
    super('This note is locked. Open it in Inkwright with its passcode to change it.');
    this.name = 'NoteLockedError';
  }
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('Locking notes needs Web Crypto (a secure context).');
  return s;
}

const buf = (u: Uint8Array) => u as Uint8Array<ArrayBuffer>;

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** Derives the note key from a passcode and the lock's salt and iteration count. */
export async function deriveLockKey(passcode: string, kdf: NoteLock['kdf']): Promise<CryptoKey> {
  const base = await subtle().importKey('raw', buf(enc.encode(passcode.normalize('NFKC'))), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(fromBase64Url(kdf.salt)), iterations: kdf.iterations },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function sealBox(key: CryptoKey, plain: Uint8Array, aad: string): Promise<SealedBox> {
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(enc.encode(aad)) }, key, buf(plain)));
  return { v: 1, iv: toBase64Url(iv), data: toBase64Url(ct) };
}

/** Decrypts a sealed box; throws when the key is wrong or the data was altered. */
export async function openBox(key: CryptoKey, box: SealedBox, aad: string): Promise<Uint8Array> {
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(fromBase64Url(box.iv)), additionalData: buf(enc.encode(aad)) }, key, buf(fromBase64Url(box.data))));
}

export const sealJson = (key: CryptoKey, value: unknown, aad: string) => sealBox(key, enc.encode(JSON.stringify(value)), aad);
export async function openJson<T>(key: CryptoKey, box: SealedBox, aad: string): Promise<T> {
  return JSON.parse(dec.decode(await openBox(key, box, aad))) as T;
}

/** Makes a new lock for a passcode: its record for `note.json` and the key. */
export async function createLock(passcode: string, opts: { now: number; iterations?: number }): Promise<{ lock: NoteLock; key: CryptoKey }> {
  if (passcode.length < MIN_PASSCODE) throw new Error(`Use at least ${MIN_PASSCODE} characters.`);
  const kdf: NoteLock['kdf'] = { name: 'PBKDF2', hash: 'SHA-256', iterations: opts.iterations ?? LOCK_ITERATIONS, salt: toBase64Url(randomBytes(16)) };
  const key = await deriveLockKey(passcode, kdf);
  const check = await sealBox(key, enc.encode(CHECK), 'inkwright:check');
  return { lock: { v: 1, kdf, cipher: 'AES-GCM-256', check, lockedAt: opts.now }, key };
}

/** The note key for a passcode, or null when the passcode is wrong. */
export async function unlockWith(lock: NoteLock, passcode: string): Promise<CryptoKey | null> {
  const key = await deriveLockKey(passcode, lock.kdf);
  try {
    const v = await openBox(key, lock.check, 'inkwright:check');
    return dec.decode(v) === CHECK ? key : null;
  } catch {
    return null;
  }
}

// ---- Pages ------------------------------------------------------------------------------------------

/** Whether a page file holds encrypted content. */
export const isSealedPage = (p: PageInk) => !!p.sealed;

/**
 * The file form of a locked page: everything visible is empty (a blank page to any reader that
 * doesn't know about locks); the content is in `sealed`.
 */
export async function sealPage(key: CryptoKey, page: PageInk): Promise<PageInk> {
  if (page.sealed) return page;
  const box = await sealBox(key, enc.encode(encodePage(page)), `inkwright:page:${page.id}`);
  return { id: page.id, strokes: [], sealed: box, formatVersion: page.formatVersion };
}

export async function openPage(key: CryptoKey, page: PageInk): Promise<PageInk> {
  if (!page.sealed) return page;
  const plain = decodePage(dec.decode(await openBox(key, page.sealed, `inkwright:page:${page.id}`)));
  return { ...plain, id: page.id };
}

/** The blank stand-in a locked page shows to indexers and agents (same id, no content). */
export function sealedView(page: Pick<PageInk, 'id' | 'formatVersion'>): PageInk {
  return { id: page.id, strokes: [], formatVersion: page.formatVersion };
}

// ---- Metadata -------------------------------------------------------------------------------------

/** Moves content-bearing metadata into `lock.meta` (encrypted). */
export async function sealNoteMeta(key: CryptoKey, meta: NoteMeta): Promise<NoteMeta> {
  if (!meta.lock) return meta;
  const hidden: Record<string, unknown> = {};
  const out: Record<string, unknown> = { ...meta };
  for (const f of SEALED_META_FIELDS) {
    if (meta[f] !== undefined) hidden[f] = meta[f];
    delete out[f];
  }
  const lock = { ...meta.lock };
  if (Object.keys(hidden).length) lock.meta = await sealJson(key, hidden, `inkwright:meta:${meta.id}`);
  else delete lock.meta;
  out.lock = lock;
  return out as unknown as NoteMeta;
}

/** Puts the sealed metadata fields back (in memory only). */
export async function openNoteMeta(key: CryptoKey, meta: NoteMeta): Promise<NoteMeta> {
  if (!meta.lock?.meta) return meta;
  const hidden = await openJson<Record<string, unknown>>(key, meta.lock.meta, `inkwright:meta:${meta.id}`);
  const out: Record<string, unknown> = { ...meta };
  for (const f of SEALED_META_FIELDS) if (hidden[f] !== undefined) out[f] = hidden[f];
  return out as unknown as NoteMeta;
}

// ---- Assets ----------------------------------------------------------------------------------------

export function isSealedBytes(b: Uint8Array): boolean {
  if (b.length < MAGIC.length + 12) return false;
  for (let i = 0; i < MAGIC.length; i++) if (b[i] !== MAGIC[i]) return false;
  return true;
}

/** An encrypted asset file: "INKSEAL1" ‖ 12-byte IV ‖ AES-GCM ciphertext. */
export async function sealBytes(key: CryptoKey, bytes: Uint8Array, aad: string): Promise<Uint8Array> {
  if (isSealedBytes(bytes)) return bytes;
  const iv = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(enc.encode(aad)) }, key, buf(bytes)));
  const out = new Uint8Array(MAGIC.length + 12 + ct.length);
  out.set(MAGIC, 0);
  out.set(iv, MAGIC.length);
  out.set(ct, MAGIC.length + 12);
  return out;
}

export async function openBytes(key: CryptoKey, bytes: Uint8Array, aad: string): Promise<Uint8Array> {
  if (!isSealedBytes(bytes)) return bytes;
  const iv = bytes.slice(MAGIC.length, MAGIC.length + 12);
  const ct = bytes.slice(MAGIC.length + 12);
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(iv), additionalData: buf(enc.encode(aad)) }, key, buf(ct)));
}

export const assetAad = (name: string) => `inkwright:asset:${name}`;
