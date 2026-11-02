// @vitest-environment node
import { resolveObjectURL } from 'node:buffer';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The engine store downloads, verifies and caches engine files. Node provides fetch, Blob, Web
 * Crypto and blob: URLs; Cache Storage is replaced by a small in-memory one, and the catalog by two
 * test engines (the real one is generated at build time).
 */

const sri = (b: Uint8Array) => `sha384-${createHash('sha384').update(b).digest('base64')}`;
const WASM = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 9, 9, 9]);
const JS = new TextEncoder().encode('self.onmessage = () => {};');
const GRAMMAR = new Uint8Array(70_000).fill(3); // several stream chunks

vi.mock('./catalog.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('./catalog.ts')>();
  const asset = (file: string, bytes: Uint8Array, type: string) => ({ file, url: `https://cdn.test/pkg@1.0.0/${file}`, bytes: bytes.length, transfer: bytes.length, integrity: sri(bytes), type });
  const ENGINES = [
    { id: 'duckdb-eh', packages: ['pkg@1.0.0'], source: 'cdn', assets: [asset('engine.wasm', WASM, 'application/wasm'), asset('engine.worker.js', JS, 'text/javascript')] },
    { id: 'tree-sitter', packages: ['pkg@1.0.0'], source: 'cdn', assets: [asset('tree-sitter.wasm', WASM, 'application/wasm'), asset('tree-sitter-go.wasm', GRAMMAR, 'application/wasm')] },
  ];
  return { ...real, ENGINES, engine: (id: string) => ENGINES.find((e) => e.id === id) };
});

/** Minimal Cache Storage: what the store uses (open, match, put, delete, keys). */
class MemoryCache {
  entries = new Map<string, Response>();
  async match(req: string | Request) { const r = this.entries.get(typeof req === 'string' ? req : req.url); return r?.clone(); }
  async put(req: string | Request, res: Response) { this.entries.set(typeof req === 'string' ? req : req.url, res.clone()); }
  async delete(req: string | Request) { return this.entries.delete(typeof req === 'string' ? req : req.url); }
  async keys() { return [...this.entries.keys()].map((u) => new Request(u)); }
}
class MemoryCaches {
  stores = new Map<string, MemoryCache>();
  async open(name: string) { if (!this.stores.has(name)) this.stores.set(name, new MemoryCache()); return this.stores.get(name)!; }
  async keys() { return [...this.stores.keys()]; }
  async delete(name: string) { return this.stores.delete(name); }
}

let served: Record<string, Uint8Array>;
let fetches: string[];
let cacheStorage: MemoryCaches;

/** Serves the test files in small chunks, like a network would. */
function body(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let at = 0;
  return new ReadableStream({
    pull(c) {
      if (at >= bytes.length) return c.close();
      c.enqueue(bytes.slice(at, at + 16_384));
      at += 16_384;
    },
  });
}

beforeEach(() => {
  vi.resetModules();
  served = { 'engine.wasm': WASM, 'engine.worker.js': JS, 'tree-sitter.wasm': WASM, 'tree-sitter-go.wasm': GRAMMAR };
  fetches = [];
  cacheStorage = new MemoryCaches();
  vi.stubGlobal('caches', cacheStorage);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    fetches.push(url);
    const file = url.split('/').pop()!;
    const bytes = served[file];
    return bytes ? new Response(body(bytes), { status: 200 }) : new Response('missing', { status: 404 });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const load = () => import('./store.ts');

describe('engine store', () => {
  it('checks bytes against an SRI string', async () => {
    const { matchesIntegrity } = await load();
    expect(await matchesIntegrity(WASM, sri(WASM))).toBe(true);
    expect(await matchesIntegrity(JS, sri(WASM))).toBe(false);
    expect(await matchesIntegrity(WASM, `md5-${sri(WASM).slice(7)}`)).toBe(false);
  });

  it('downloads an engine once, verified, then serves it from the cache', async () => {
    const { ensureEngine, engineStatus, ENGINE_CACHE } = await load();
    expect((await engineStatus('duckdb-eh')).state).toBe('missing');
    const progress: number[] = [];
    const urls = await ensureEngine('duckdb-eh', { onProgress: (p) => progress.push(p.loaded) });
    expect(Object.keys(urls).sort()).toEqual(['engine.wasm', 'engine.worker.js']);
    expect(urls['engine.wasm']).toMatch(/^blob:/);
    expect(fetches).toHaveLength(2);
    expect(progress.at(-1)).toBe(WASM.length + JS.length);
    expect(progress).toEqual([...progress].sort((a, b) => a - b)); // never goes backwards
    // Stored with the right type (WebAssembly must stream-compile).
    const stored = await (await cacheStorage.open(ENGINE_CACHE)).match('https://cdn.test/pkg@1.0.0/engine.wasm');
    expect(stored?.headers.get('content-type')).toBe('application/wasm');
    expect((await engineStatus('duckdb-eh')).state).toBe('ready');

    // A new session (fresh module state) reads it from the cache: no network.
    vi.resetModules();
    const again = await load();
    const urls2 = await again.ensureEngine('duckdb-eh');
    expect(fetches).toHaveLength(2);
    const blob = resolveObjectURL(urls2['engine.wasm']!)!;
    expect(blob.type).toBe('application/wasm');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(WASM);
  });

  it('refuses a file that does not match its checksum and caches nothing', async () => {
    const { ensureEngine, engineStatus, EngineIntegrityError } = await load();
    served['engine.wasm'] = new Uint8Array([0, 97, 115, 109, 6, 6, 6]); // tampered
    await expect(ensureEngine('duckdb-eh')).rejects.toBeInstanceOf(EngineIntegrityError);
    expect((await engineStatus('duckdb-eh')).state).toBe('missing');
    // Fixed upstream: the next attempt downloads again and succeeds.
    served['engine.wasm'] = WASM;
    await expect(ensureEngine('duckdb-eh')).resolves.toHaveProperty('engine.wasm');
  });

  it('reports HTTP failures in words', async () => {
    const { ensureEngine } = await load();
    delete served['engine.worker.js'];
    await expect(ensureEngine('duckdb-eh')).rejects.toThrow(/engine\.worker\.js failed \(HTTP 404\)/);
  });

  it('fetches single files on demand (one grammar at a time)', async () => {
    const { engineFileUrl, engineStatus } = await load();
    const url = await engineFileUrl('tree-sitter', 'tree-sitter-go.wasm');
    expect(url).toMatch(/^blob:/);
    expect(fetches).toEqual(['https://cdn.test/pkg@1.0.0/tree-sitter-go.wasm']);
    expect(await engineStatus('tree-sitter')).toEqual({ state: 'partial', bytesOnDevice: GRAMMAR.length });
    // Concurrent callers share one download.
    vi.resetModules();
    const { engineFileUrl: again } = await load();
    await Promise.all([again('tree-sitter', 'tree-sitter.wasm'), again('tree-sitter', 'tree-sitter.wasm')]);
    expect(fetches.filter((u) => u.endsWith('/tree-sitter.wasm'))).toHaveLength(1);
  });

  it('announces downloads and removals, and removal frees the files', async () => {
    const { ensureEngine, removeEngine, engineStatus, onEngineChange } = await load();
    const heard: string[] = [];
    const stop = onEngineChange((id) => heard.push(id));
    await ensureEngine('duckdb-eh');
    await removeEngine('duckdb-eh');
    stop();
    expect(heard.filter((h) => h === 'duckdb-eh').length).toBeGreaterThanOrEqual(2);
    expect((await engineStatus('duckdb-eh')).state).toBe('missing');
  });

  it('clears files an update no longer uses, and old cache layouts', async () => {
    const { ensureEngine, clearStaleEngineCaches, ENGINE_CACHE } = await load();
    await ensureEngine('duckdb-eh');
    const cache = await cacheStorage.open(ENGINE_CACHE);
    await cache.put('https://cdn.test/pkg@0.9.0/engine.wasm', new Response('old'));
    await cacheStorage.open('inkwright-engines-v0');
    expect(await clearStaleEngineCaches()).toBe(2);
    expect([...cache.entries.keys()].sort()).toEqual(['https://cdn.test/pkg@1.0.0/engine.wasm', 'https://cdn.test/pkg@1.0.0/engine.worker.js']);
    expect(await cacheStorage.keys()).toEqual([ENGINE_CACHE]);
  });

  it('still works this session when Cache Storage is unavailable', async () => {
    vi.stubGlobal('caches', undefined);
    const { ensureEngine } = await load();
    const urls = await ensureEngine('duckdb-eh');
    expect(urls['engine.worker.js']).toMatch(/^blob:/);
  });

  it('says so for an engine this build does not have', async () => {
    const { ensureEngine, engineStatus } = await load();
    await expect(ensureEngine('onnx-runtime')).rejects.toThrow(/not part of this build/);
    expect((await engineStatus('onnx-runtime')).state).toBe('unavailable');
  });
});
