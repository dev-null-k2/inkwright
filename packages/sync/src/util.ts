import { normalizePath, type FsEntry, type VaultFS } from '@inkwright/core';

/** Shared helpers. Browser-safe: no Node APIs. */

const enc = new TextEncoder();
const dec = new TextDecoder();

export function utf8Encode(s: string): Uint8Array {
  return enc.encode(s);
}

export function utf8Decode(b: Uint8Array): string {
  return dec.decode(b);
}

/**
 * Normalizes a vault-relative path and refuses anything that could escape the vault on any
 * platform: `..` segments (via core's normalizePath), backslashes (Windows separators) and NULs.
 */
export function safePath(path: string): string {
  if (path.includes('\\') || path.includes('\0')) throw new Error(`Unsafe path: ${path}`);
  return normalizePath(path);
}

/** Splits a normalized path into segments (empty array for the root). */
export function segments(path: string): string[] {
  return path === '' ? [] : path.split('/');
}

/** Copies into a fresh ArrayBuffer-backed view when needed (Web APIs reject SharedArrayBuffer views). */
export function toBufferView(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  return bytes.buffer instanceof ArrayBuffer ? (bytes as Uint8Array<ArrayBuffer>) : new Uint8Array(bytes);
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

export function concatBytes(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));

export function toHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]!];
  return s;
}

/** SHA-256 of the bytes as lowercase hex, via WebCrypto (browsers, Node ≥ 19, Capacitor WebViews). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', toBufferView(bytes));
  return toHex(new Uint8Array(digest));
}

// ---- base64 (no Buffer: must run in browsers) ------------------------------------------------

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = (() => {
  const t = new Int16Array(128).fill(-1);
  for (let i = 0; i < B64.length; i++) t[B64.charCodeAt(i)] = i;
  t['-'.charCodeAt(0)] = 62; // base64url
  t['_'.charCodeAt(0)] = 63;
  return t;
})();

export function base64Encode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + B64[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + '==';
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += B64[(n >> 18) & 63]! + B64[(n >> 12) & 63]! + B64[(n >> 6) & 63]! + '=';
  }
  return out;
}

export function base64Decode(s: string): Uint8Array {
  // Tolerates data: URL prefixes, whitespace, missing padding and base64url.
  const comma = s.startsWith('data:') ? s.indexOf(',') : -1;
  const clean = (comma >= 0 ? s.slice(comma + 1) : s).replace(/[\s=]/g, '');
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean.charCodeAt(i);
    const v = c < 128 ? B64_LOOKUP[c]! : -1;
    if (v < 0) throw new Error('Invalid base64');
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === out.length ? out : out.slice(0, o);
}

// ---- Abort / timing -------------------------------------------------------------------------

export function abortError(signal?: AbortSignal): Error {
  const r = signal?.reason;
  if (r instanceof Error) return r;
  return new DOMException('The operation was aborted.', 'AbortError');
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

export function isAbortError(e: unknown): boolean {
  return (e as { name?: string } | null)?.name === 'AbortError';
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError(signal));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError(signal));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Runs `fn` over `items` with at most `limit` in flight. Stops scheduling on abort or on the
 * first thrown error, waits for in-flight work, then rethrows.
 */
export async function mapLimit<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  let next = 0;
  let failure: { e: unknown } | null = null;
  const worker = async () => {
    while (!failure && !signal?.aborted && next < items.length) {
      const i = next++;
      try {
        await fn(items[i]!, i);
      } catch (e) {
        failure ??= { e };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  if (failure) throw (failure as { e: unknown }).e;
  throwIfAborted(signal);
}

/** Deduplicates concurrent async work by key (e.g. two uploads creating the same folder). */
export class Inflight<V> {
  private map = new Map<string, Promise<V>>();
  run(key: string, fn: () => Promise<V>): Promise<V> {
    const cur = this.map.get(key);
    if (cur) return cur;
    const p = fn().finally(() => this.map.delete(key));
    this.map.set(key, p);
    return p;
  }
}

// ---- Vault traversal --------------------------------------------------------------------------

export interface FileInfo {
  path: string;
  size?: number;
  mtime?: number;
}

/** Like core's `walk`, but keeps size/mtime from the listing. */
export async function walkFiles(fs: VaultFS, dir = '', skip?: (path: string, entry: FsEntry) => boolean): Promise<FileInfo[]> {
  const out: FileInfo[] = [];
  const visit = async (d: string) => {
    for (const e of await fs.list(d)) {
      const p = d ? `${d}/${e.name}` : e.name;
      if (skip?.(p, e)) continue;
      if (e.kind === 'dir') await visit(p);
      else out.push({ path: p, size: e.size, mtime: e.mtime });
    }
  };
  await visit(dir);
  return out;
}

/** Suffix used by backends for in-progress atomic writes; never listed. */
export const TEMP_SUFFIX = '.inkwright-tmp';

/** Junk that backends and sync must never surface (temp files, OS metadata, Chrome swap files). */
export function isJunkName(name: string): boolean {
  return (
    name.endsWith(TEMP_SUFFIX) ||
    name.endsWith('.crswap') ||
    name === '.DS_Store' ||
    name === 'Thumbs.db' ||
    name === 'desktop.ini' ||
    name.startsWith('~$')
  );
}

export function randomToken(n = 8): string {
  const bytes = new Uint8Array(n);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

/** Best-effort MIME type for vault files (used by HTTP remotes). */
export function mimeTypeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  switch (ext) {
    case 'json':
      return 'application/json';
    case 'md':
      return 'text/markdown';
    case 'svg':
      return 'image/svg+xml';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    case 'webm':
      return 'audio/webm';
    case 'm4a':
    case 'mp4':
      return 'audio/mp4';
    case 'ogg':
      return 'audio/ogg';
    case 'mp3':
      return 'audio/mpeg';
    case 'wav':
      return 'audio/wav';
    case 'txt':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}
