// @vitest-environment node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ENGINE_SOURCES, engineSourceFromEnv, keepEngineWasmOut, resolveEngines } from '../../build/engines.ts';
import { ENGINE_COPY, type EngineId } from './catalog.ts';

/**
 * The build-time half of engines (build/engines.ts): the catalog must describe the exact bytes npm
 * installed, at a URL pinned to that version, or a native app would refuse (or worse, run) a file.
 */
// npm workspaces hoist dependencies to the repository root.
const pkgDir = (pkg: string) => fileURLToPath(new URL(`../../../../node_modules/${pkg}`, import.meta.url));

describe('engine catalog (build)', () => {
  it('pins every file to the installed version on the CDN, with its SHA-384', () => {
    const cdn = resolveEngines('cdn');
    const ts = cdn.find((e) => e.info.id === 'tree-sitter')!.info;
    const runtime = ts.assets.find((a) => a.file === 'tree-sitter.wasm')!;
    const dir = pkgDir('web-tree-sitter');
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version as string;
    const bytes = readFileSync(join(dir, 'tree-sitter.wasm'));
    expect(runtime.url).toBe(`https://cdn.jsdelivr.net/npm/web-tree-sitter@${version}/tree-sitter.wasm`);
    expect(runtime.integrity).toBe(`sha384-${createHash('sha384').update(bytes).digest('base64')}`);
    expect(runtime.bytes).toBe(bytes.length);
    expect(runtime.transfer).toBeLessThan(bytes.length);
    expect(runtime.type).toBe('application/wasm');
    expect(ts.packages).toContain(`web-tree-sitter@${version}`);
    // Native builds carry no files.
    expect(cdn.every((e) => e.files.length === 0)).toBe(true);
  });

  it('self-hosted builds emit the files under engines/<pkg>@<version>/ and point at them', () => {
    const app = resolveEngines('app');
    const duck = app.find((e) => e.info.id === 'duckdb-eh')!;
    expect(duck.info.assets.map((a) => a.url)).toEqual(duck.files.map((f) => f.fileName));
    expect(duck.files[0]!.fileName).toMatch(/^engines\/duckdb__duckdb-wasm@[\d.]+\/dist\/duckdb-eh\.wasm$/);
  });

  it('honours a mirror for the CDN', () => {
    const [first] = resolveEngines('cdn', 'https://mirror.example/npm');
    expect(first!.info.assets[0]!.url.startsWith('https://mirror.example/npm/')).toBe(true);
  });

  it('accepts only app or cdn as an engine source override', () => {
    expect(engineSourceFromEnv(undefined)).toBeUndefined();
    expect(engineSourceFromEnv('cdn')).toBe('cdn');
    expect(engineSourceFromEnv('app')).toBe('app');
    // `all` is what e2e:all puts in INKWRIGHT_ENGINES (browser engines); it must never reach here.
    expect(() => engineSourceFromEnv('all')).toThrow(/must be "app" or "cdn"/);
  });

  it('describes every engine to people', () => {
    for (const id of Object.keys(ENGINE_SOURCES)) expect(ENGINE_COPY[id as EngineId]?.name).toBeTruthy();
  });

  it('keeps the libraries’ own copies of the WebAssembly out of the bundle', () => {
    const plugin = keepEngineWasmOut();
    const transform = plugin.transform as (code: string, id: string) => { code: string } | null;
    const ort = 'x = new URL("ort-wasm-simd-threaded.asyncify.wasm", import.meta.url).href;';
    expect(transform(ort, '/repo/node_modules/onnxruntime-web/dist/ort.bundle.min.mjs')!.code).toBe('x = new URL(/* @vite-ignore */ "ort-wasm-simd-threaded.asyncify.wasm", import.meta.url).href;');
    expect(transform("new URL('tree-sitter.wasm', import.meta.url)", '/repo/node_modules/web-tree-sitter/tree-sitter.js')!.code).toContain('@vite-ignore');
    // Other packages, and other files, are left alone.
    expect(transform(ort, '/repo/apps/web/src/ai/local-worker.ts')).toBeNull();
    expect(transform("new URL('./icon.png', import.meta.url)", '/repo/node_modules/web-tree-sitter/tree-sitter.js')).toBeNull();
  });
});
