/**
 * The engines that download on first use (DuckDB, the on-device AI runtime, code parsers), as
 * the build described them (build/engines.ts → `__INKWRIGHT_ENGINES__`). Plain data: safe to import
 * from workers and from the startup bundle.
 */

export type EngineId = 'duckdb-eh' | 'duckdb-mvp' | 'onnx-runtime' | 'tree-sitter';

export interface EngineAsset {
  /** Basename, unique within its engine (e.g. `duckdb-eh.wasm`). */
  file: string;
  /** Absolute (CDN, dev server) or relative to the app's root (self-hosted builds). */
  url: string;
  /** Size once stored on the device. */
  bytes: number;
  /** Approximate download size (gzip), for "one-time download" copy. */
  transfer: number;
  /** `sha384-<base64>` of the exact file, checked before anything is cached or run. */
  integrity: string;
  /** MIME type to serve it with (WebAssembly must be `application/wasm` to stream-compile). */
  type: string;
}

export interface Engine {
  id: EngineId;
  /** Pinned `<pkg>@<version>` it comes from. */
  packages: string[];
  /** `cdn`: a pinned public CDN (native apps); `app`: next to the app; `dev`: the dev server. */
  source: 'cdn' | 'app' | 'dev';
  assets: EngineAsset[];
}

/** What people see in Settings and in the one-time download notices. */
export const ENGINE_COPY: Record<EngineId, { name: string; purpose: string }> = {
  'duckdb-eh': { name: 'DuckDB', purpose: 'Fast SQL over data on your pages. Until it is downloaded, data queries run in SQLite.' },
  'duckdb-mvp': { name: 'DuckDB (compatibility build)', purpose: 'Fast SQL over data on your pages, for browsers without WebAssembly exceptions.' },
  'onnx-runtime': { name: 'AI runtime', purpose: 'Runs on-device models for search by meaning, transcripts and the assistant.' },
  'tree-sitter': { name: 'Code parsers', purpose: 'Reads TypeScript, JavaScript, Python, Go, Rust and Java when you scan a repository.' },
};

declare const __INKWRIGHT_ENGINES__: Engine[] | undefined;

/** Every engine this build knows how to fetch (none in the single-file preview, or in unit tests). */
export const ENGINES: readonly Engine[] = typeof __INKWRIGHT_ENGINES__ !== 'undefined' ? __INKWRIGHT_ENGINES__ : [];

export function engine(id: EngineId): Engine | undefined {
  return ENGINES.find((e) => e.id === id);
}

/** Total size on the device and approximate download size of an engine. */
export function engineSize(e: Engine): { bytes: number; transfer: number } {
  return e.assets.reduce((s, a) => ({ bytes: s.bytes + a.bytes, transfer: s.transfer + a.transfer }), { bytes: 0, transfer: 0 });
}
