/**
 * Downloads engines on first use, verifies them, and keeps them for offline use.
 *
 * Each file is fetched once (from the pinned CDN in the native apps, from the app's own server on
 * the web), its SHA-384 is checked against the integrity the build computed from the npm package
 * (build/engines.ts), and only then is it written to Cache Storage. From then on it is served from
 * there as a `blob:` URL, offline. Nothing unverified is ever cached or run: a mismatching file is
 * an error, not a fallback.
 *
 * Works in the page and in workers (the AI worker fetches its own runtime). Changes are announced
 * on a BroadcastChannel so Settings updates when a worker finishes a download.
 */
import { ENGINES, type Engine, type EngineAsset, type EngineId } from './catalog.ts';

/** Bump when the stored layout changes; old caches are then ignored (and cleared by `clearStaleEngineCaches`). */
export const ENGINE_CACHE = 'inkwright-engines-v1';
const CHANNEL = 'inkwright-engines';

export interface EngineProgress {
  /** Bytes of this engine on the device so far. */
  loaded: number;
  total: number;
  file?: string;
}

export interface EngineStatus {
  /** `ready`: every file stored; `partial`: some (e.g. two of seven grammars); `missing`: none. */
  state: 'ready' | 'partial' | 'missing' | 'unavailable';
  bytesOnDevice: number;
}

export class EngineIntegrityError extends Error {
  constructor(file: string) {
    super(`${file} did not match its published checksum, so it was not used. Try again later.`);
    this.name = 'EngineIntegrityError';
  }
}

/** Where relative engine URLs are resolved: the app's root (every built chunk sits in `assets/`). */
function appRoot(): string {
  try {
    return new URL('../', import.meta.url).href;
  } catch {
    return typeof location !== 'undefined' ? location.href : 'http://localhost/';
  }
}

export function assetUrl(a: EngineAsset, root = appRoot()): string {
  return new URL(a.url, root).href;
}

const hasCaches = () => typeof caches !== 'undefined';

async function openCache(): Promise<Cache | null> {
  if (!hasCaches()) return null;
  try {
    return await caches.open(ENGINE_CACHE);
  } catch {
    return null; // e.g. storage blocked in a private window
  }
}

function base64(bytes: ArrayBuffer): string {
  let s = '';
  const u = new Uint8Array(bytes);
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Whether `bytes` are exactly the file the build published (`sha384-…`). */
export async function matchesIntegrity(bytes: BufferSource, integrity: string): Promise<boolean> {
  const [algo, expected] = integrity.split('-', 2) as [string, string];
  const name = ({ sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' } as Record<string, string>)[algo];
  if (!name || !expected) return false;
  return base64(await crypto.subtle.digest(name, bytes)) === expected;
}

function announce(id: EngineId): void {
  try {
    const ch = new BroadcastChannel(CHANNEL);
    ch.postMessage({ id });
    ch.close();
  } catch { /* no BroadcastChannel: same-realm listeners below still hear it */ }
  for (const l of listeners) l(id);
}

const listeners = new Set<(id: EngineId) => void>();
let channel: BroadcastChannel | null = null;

/** Calls `fn` whenever an engine is downloaded or removed, in this or any other realm (worker, tab). */
export function onEngineChange(fn: (id: EngineId) => void): () => void {
  listeners.add(fn);
  if (!channel && typeof BroadcastChannel !== 'undefined') {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (e) => { for (const l of listeners) l((e.data as { id: EngineId }).id); };
  }
  return () => listeners.delete(fn);
}

function requireEngine(id: EngineId): Engine {
  const e = ENGINES.find((x) => x.id === id);
  if (!e) throw new Error('This engine is not part of this build of Inkwright.');
  return e;
}

/** What is stored for an engine. */
export async function engineStatus(id: EngineId): Promise<EngineStatus> {
  const e = ENGINES.find((x) => x.id === id);
  if (!e) return { state: 'unavailable', bytesOnDevice: 0 };
  const cache = await openCache();
  if (!cache) return { state: 'missing', bytesOnDevice: 0 };
  let have = 0;
  let bytes = 0;
  for (const a of e.assets) {
    if (await cache.match(assetUrl(a))) { have++; bytes += a.bytes; }
  }
  return { state: have === e.assets.length ? 'ready' : have ? 'partial' : 'missing', bytesOnDevice: bytes };
}

/** Object URLs handed out in this realm, so each file is read from the cache once per session. */
const objectUrls = new Map<string, Promise<string>>();

/** Fetches one file, reporting progress in decoded bytes, and verifies it. */
async function download(a: EngineAsset, url: string, report: (delta: number) => void, signal?: AbortSignal): Promise<Uint8Array> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    // No Web Crypto outside secure contexts: never run code we could not verify.
    throw new Error('Engines can only be downloaded over HTTPS (or localhost).');
  }
  // `no-store`: the verified copy goes to our own cache; a second one in the HTTP cache would only
  // double the space used.
  const res = await fetch(url, { signal, cache: 'no-store', credentials: 'omit' });
  if (!res.ok) throw new Error(`Downloading ${a.file} failed (HTTP ${res.status}).`);
  const parts: Uint8Array[] = [];
  let got = 0;
  if (res.body) {
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      report(value.length);
    }
  } else {
    const buf = new Uint8Array(await res.arrayBuffer());
    parts.push(buf);
    got = buf.length;
    report(got);
  }
  const bytes = new Uint8Array(got);
  let at = 0;
  for (const p of parts) { bytes.set(p, at); at += p.length; }
  if (!(await matchesIntegrity(bytes, a.integrity))) {
    report(-got);
    throw new EngineIntegrityError(a.file);
  }
  return bytes;
}

/**
 * Makes the given files of an engine (all of them by default) available offline and returns
 * `blob:` URLs for them, downloading whatever is not stored yet. Concurrent callers share work.
 */
export async function ensureEngine(id: EngineId, opts: { files?: string[]; onProgress?: (p: EngineProgress) => void; signal?: AbortSignal } = {}): Promise<Record<string, string>> {
  const e = requireEngine(id);
  const assets = opts.files ? e.assets.filter((a) => opts.files!.includes(a.file)) : e.assets;
  if (opts.files && assets.length !== opts.files.length) throw new Error(`Unknown file in ${id}: ${opts.files.join(', ')}`);
  const cache = await openCache();
  const total = assets.reduce((n, a) => n + a.bytes, 0);
  let loaded = 0;
  let file: string | undefined;
  const report = (delta: number) => { loaded += delta; opts.onProgress?.({ loaded, total, file }); };
  // What is already stored counts as downloaded (resuming a set of files after an interruption).
  const missing: EngineAsset[] = [];
  for (const a of assets) {
    if (objectUrls.has(assetUrl(a)) || (cache && (await cache.match(assetUrl(a))))) loaded += a.bytes;
    else missing.push(a);
  }
  opts.onProgress?.({ loaded, total });
  let downloaded = false;
  for (const a of missing) {
    const url = assetUrl(a);
    if (objectUrls.has(url)) continue; // fetched meanwhile by another caller in this realm
    opts.signal?.throwIfAborted();
    file = a.file;
    const pending = download(a, url, report, opts.signal).then(async (bytes) => {
      const blob = new Blob([bytes as BlobPart], { type: a.type });
      if (cache) {
        await cache.put(url, new Response(blob, { headers: { 'content-type': a.type, 'content-length': String(a.bytes), 'x-integrity': a.integrity } })).catch((err) => {
          // Out of quota: still usable this session, just not offline.
          console.warn(`engines: could not store ${a.file}`, err);
        });
      }
      return URL.createObjectURL(blob);
    });
    objectUrls.set(url, pending);
    pending.catch(() => objectUrls.delete(url));
    await pending;
    downloaded = true;
  }
  if (downloaded) {
    announce(id);
    // Ask the browser not to evict what we just stored (granted silently for installed apps).
    if (typeof navigator !== 'undefined' && typeof window !== 'undefined') void navigator.storage?.persist?.().catch(() => false);
  }
  const out: Record<string, string> = {};
  for (const a of assets) out[a.file] = await objectUrlFor(a, cache);
  return out;
}

/** A `blob:` URL for a stored (or just downloaded) file. */
function objectUrlFor(a: EngineAsset, cache: Cache | null): Promise<string> {
  const url = assetUrl(a);
  let p = objectUrls.get(url);
  if (!p) {
    p = (async () => {
      const hit = cache ? await cache.match(url) : undefined;
      if (!hit) throw new Error(`${a.file} is not on this device.`);
      // Re-type the blob (WebAssembly.instantiateStreaming insists on application/wasm); wrapping a
      // cached blob does not copy it into memory.
      return URL.createObjectURL(new Blob([await hit.blob()], { type: a.type }));
    })();
    objectUrls.set(url, p);
    p.catch(() => objectUrls.delete(url));
  }
  return p;
}

/** One file of an engine as a `blob:` URL (downloaded first if needed). */
export async function engineFileUrl(id: EngineId, file: string, opts: { onProgress?: (p: EngineProgress) => void; signal?: AbortSignal } = {}): Promise<string> {
  return (await ensureEngine(id, { ...opts, files: [file] }))[file]!;
}

/** Deletes an engine's stored files (it downloads again when next needed). */
export async function removeEngine(id: EngineId): Promise<void> {
  const e = requireEngine(id);
  const cache = await openCache();
  for (const a of e.assets) {
    const url = assetUrl(a);
    const held = objectUrls.get(url);
    objectUrls.delete(url);
    void held?.then((u) => URL.revokeObjectURL(u), () => {});
    await cache?.delete(url);
  }
  announce(id);
}

/**
 * Removes engine files this build no longer references (an app update pinned new versions), and
 * caches from older layouts. Runs once the app is idle; never touches files still in the catalog.
 */
export async function clearStaleEngineCaches(): Promise<number> {
  if (!hasCaches()) return 0;
  let removed = 0;
  for (const name of await caches.keys()) {
    if (name.startsWith('inkwright-engines-') && name !== ENGINE_CACHE) { await caches.delete(name); removed++; }
  }
  const cache = await openCache();
  if (!cache) return removed;
  const known = new Set(ENGINES.flatMap((e) => e.assets.map((a) => assetUrl(a))));
  for (const req of await cache.keys()) {
    if (!known.has(req.url)) { await cache.delete(req); removed++; }
  }
  return removed;
}
