/**
 * Heavy engines that download on first use instead of shipping in the install.
 *
 * DuckDB-WASM, ONNX Runtime Web and the tree-sitter grammars are ~100 MB of WebAssembly that most
 * people never use, or only use together with a download anyway (on-device models come from
 * Hugging Face). This plugin turns the exact files from node_modules into a catalog the app reads
 * at runtime (`__INKWRIGHT_ENGINES__`, see src/engines/catalog.ts):
 *
 * - every file's size, compressed transfer size and SHA-384 integrity, computed here from the very
 *   bytes npm installed, so the app can verify a download before caching it;
 * - where to fetch it from, which depends on the build:
 *   - `cdn`  (native apps by default): a version-pinned jsDelivr URL. jsDelivr serves npm package
 *            files byte for byte, so the integrity computed here matches. The files are *not* put
 *            in the APK, which is the point.
 *   - `app`  (web builds by default): emitted next to the app under `engines/<pkg>@<version>/`, so
 *            the hosted app needs no third party and works on intranets.
 *   - `dev`  (`vite` dev server): served straight from node_modules through `/@fs/`.
 *
 * `INKWRIGHT_ENGINE_SOURCE=app|cdn` overrides the default (e.g. a fully offline enterprise APK can
 * carry them with `app`), and `INKWRIGHT_ENGINES_CDN` points `cdn` at a mirror with the same layout.
 * See docs/PERFORMANCE.md.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

/** Package files that make up each engine. Ids are what the app asks for (src/engines). */
export const ENGINE_SOURCES: Record<string, Array<{ pkg: string; path: string }>> = {
  // DuckDB ships two builds; the app downloads only the one `selectBundle` picks for the browser.
  'duckdb-eh': [
    { pkg: '@duckdb/duckdb-wasm', path: 'dist/duckdb-eh.wasm' },
    { pkg: '@duckdb/duckdb-wasm', path: 'dist/duckdb-browser-eh.worker.js' },
  ],
  'duckdb-mvp': [
    { pkg: '@duckdb/duckdb-wasm', path: 'dist/duckdb-mvp.wasm' },
    { pkg: '@duckdb/duckdb-wasm', path: 'dist/duckdb-browser-mvp.worker.js' },
  ],
  'onnx-runtime': [
    { pkg: 'onnxruntime-web', path: 'dist/ort-wasm-simd-threaded.asyncify.wasm' },
    { pkg: 'onnxruntime-web', path: 'dist/ort-wasm-simd-threaded.asyncify.mjs' },
  ],
  'tree-sitter': [
    { pkg: 'web-tree-sitter', path: 'tree-sitter.wasm' },
    ...['typescript', 'tsx', 'javascript', 'python', 'go', 'rust', 'java'].map((l) => ({ pkg: '@vscode/tree-sitter-wasm', path: `wasm/tree-sitter-${l}.wasm` })),
  ],
};

export type EngineSourceMode = 'cdn' | 'app' | 'dev' | 'none';

/** One downloadable file, as the app sees it (mirrored in src/engines/catalog.ts). */
export interface EngineAssetInfo {
  /** Basename, e.g. `duckdb-eh.wasm`; unique within its engine. */
  file: string;
  /** Absolute URL (cdn, dev) or a path relative to the app's root (app). */
  url: string;
  bytes: number;
  /** gzip size: roughly what crosses the network. */
  transfer: number;
  /** Subresource Integrity string, `sha384-<base64>`. */
  integrity: string;
  type: string;
}

export interface EngineInfo {
  id: string;
  /** `<pkg>@<version>` of every package the engine's files come from. */
  packages: string[];
  source: Exclude<EngineSourceMode, 'none'>;
  assets: EngineAssetInfo[];
}

const DEFAULT_CDN = 'https://cdn.jsdelivr.net/npm/';

/**
 * Reads `INKWRIGHT_ENGINE_SOURCE`. Anything but `app` or `cdn` is a mistake that would otherwise
 * produce a build whose engines point at files nobody serves, so it fails the build instead.
 */
export function engineSourceFromEnv(value: string | undefined): 'app' | 'cdn' | undefined {
  if (value === undefined || value === '') return undefined;
  if (value === 'app' || value === 'cdn') return value;
  throw new Error(`INKWRIGHT_ENGINE_SOURCE must be "app" or "cdn", not "${value}"`);
}
const root = fileURLToPath(new URL('..', import.meta.url));

/** The installed copy of a package (workspaces hoist to the repo root). */
function packageDir(pkg: string): string {
  for (let dir = root; ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', pkg);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (dirname(dir) === dir) throw new Error(`engines: ${pkg} is not installed (npm install)`);
  }
}

const mime = (path: string) => (path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');

interface Resolved { info: EngineInfo; files: Array<{ fileName: string; path: string }> }

/**
 * Integrity and compressed size are pure functions of the file, and hashing ~110 MB on every
 * build (and every e2e run) costs seconds, so they are memoized by path, size and mtime.
 */
const digestCacheFile = join(root, 'node_modules', '.cache', 'inkwright-engines.json');
type Digest = { key: string; integrity: string; transfer: number };
let digestCache: Record<string, Digest> | null = null;

function digest(path: string): { bytes: number; integrity: string; transfer: number } {
  const st = statSync(path);
  const key = `${st.size}:${st.mtimeMs}`;
  if (!digestCache) {
    try { digestCache = JSON.parse(readFileSync(digestCacheFile, 'utf8')) as Record<string, Digest>; } catch { digestCache = {}; }
  }
  const hit = digestCache[path];
  if (hit?.key === key) return { bytes: st.size, integrity: hit.integrity, transfer: hit.transfer };
  const source = readFileSync(path);
  const d: Digest = { key, integrity: `sha384-${createHash('sha384').update(source).digest('base64')}`, transfer: gzipSync(source, { level: 6 }).length };
  digestCache[path] = d;
  try {
    mkdirSync(dirname(digestCacheFile), { recursive: true });
    writeFileSync(digestCacheFile, JSON.stringify(digestCache));
  } catch { /* read-only checkout: just slower next time */ }
  return { bytes: source.length, integrity: d.integrity, transfer: d.transfer };
}

/** Reads the engine files and builds the catalog for one source mode. */
export function resolveEngines(mode: Exclude<EngineSourceMode, 'none'>, cdn = DEFAULT_CDN): Resolved[] {
  const base = cdn.endsWith('/') ? cdn : `${cdn}/`;
  return Object.entries(ENGINE_SOURCES).map(([id, sources]) => {
    const files: Resolved['files'] = [];
    const packages = new Set<string>();
    const assets = sources.map(({ pkg, path }) => {
      const dir = packageDir(pkg);
      const version = (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version: string }).version;
      const abs = join(dir, path);
      const pinned = `${pkg}@${version}/${path}`;
      packages.add(`${pkg}@${version}`);
      // engines/<pkg>@<version>/<path>, with a scope's slash flattened (@duckdb/x → duckdb__x).
      const fileName = `engines/${pkg.replace(/^@/, '').replace('/', '__')}@${version}/${path}`;
      if (mode === 'app') files.push({ fileName, path: abs });
      return {
        file: path.split('/').pop()!,
        url: mode === 'cdn' ? base + pinned : mode === 'dev' ? `/@fs${abs}` : fileName,
        ...digest(abs),
        type: mime(path),
      };
    });
    return { info: { id, packages: [...packages], source: mode, assets }, files };
  });
}

/**
 * Engine packages point at their own WebAssembly with `new URL('<file>.wasm', import.meta.url)`,
 * which Vite would copy into every build: the very files the engine catalog keeps out of the
 * install (ONNX Runtime's 26 MB, tree-sitter's runtime). The app always hands those libraries the
 * verified engine files first (`wasmPaths` in src/ai/local-worker.ts, `locateFile` in
 * src/dev/treesitter.ts), so the defaults are dead code: mark them `@vite-ignore`. Must also be in
 * the worker plugin list (vite.config.ts), since ONNX Runtime runs in the AI worker.
 */
export function keepEngineWasmOut(): Plugin {
  const rules: Array<{ id: RegExp; file: string }> = [
    { id: /[\\/](onnxruntime-web|@huggingface[\\/]transformers)[\\/]/, file: 'ort-wasm' },
    { id: /[\\/]web-tree-sitter[\\/]/, file: 'tree-sitter.wasm' },
  ];
  return {
    name: 'inkwright-keep-engine-wasm-out',
    enforce: 'pre',
    transform(code, id) {
      const rule = rules.find((r) => r.id.test(id) && code.includes(r.file));
      if (!rule) return null;
      const re = new RegExp(`new\\s+URL\\(\\s*(?=(['"\`])${rule.file.replace('.', '\\.')}[^'"\`]*\\1\\s*,\\s*import\\.meta\\.url)`, 'g');
      const out = code.replace(re, (m) => `${m}/* @vite-ignore */ `);
      return out === code ? null : { code: out, map: null };
    },
  };
}

/**
 * Provides `__INKWRIGHT_ENGINES__` and, for `app` builds, emits the files. `mode` is decided by
 * vite.config.ts from the build mode; `none` (the single-file preview) leaves the catalog empty.
 */
export function engineAssets(mode: EngineSourceMode): Plugin {
  let resolved: Resolved[] = [];
  let effective: EngineSourceMode = mode;
  return {
    name: 'inkwright-engines',
    config(_config, env) {
      effective = mode === 'none' ? 'none' : env.command === 'serve' ? 'dev' : mode;
      resolved = effective === 'none' ? [] : resolveEngines(effective, process.env.INKWRIGHT_ENGINES_CDN || DEFAULT_CDN);
      return { define: { __INKWRIGHT_ENGINES__: JSON.stringify(resolved.map((r) => r.info)) } };
    },
    generateBundle() {
      if (effective !== 'app') return;
      for (const r of resolved) for (const f of r.files) this.emitFile({ type: 'asset', fileName: f.fileName, source: readFileSync(f.path) });
    },
  };
}
