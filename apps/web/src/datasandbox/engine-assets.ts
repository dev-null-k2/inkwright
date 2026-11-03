/**
 * The data sandbox's SQL engines:
 *
 * - DuckDB-WASM (MIT) downloads on first use (src/engines): ~35 MB of WebAssembly that would
 *   otherwise be most of the app's install size. Its two builds (MVP, and exception handling) are
 *   separate engines; `selectBundle` picks one and only that one is fetched. The "bundle" values
 *   below are engine ids, turned into verified `blob:` URLs by `openDuckDb` once chosen.
 * - SQLite (sql.js, 0.3 MB compressed) ships with the app, so queries work offline from the
 *   first launch and while DuckDB is still downloading.
 *
 * The single-file preview build swaps this module for `engine-assets-unavailable.ts`
 * (vite.config.ts): it has neither engine.
 */
import sqlite from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { engine } from '../engines/catalog.ts';

export const DUCKDB_BUNDLES: { mvp: { mainModule: string; mainWorker: string }; eh: { mainModule: string; mainWorker: string } } | null =
  engine('duckdb-eh') && engine('duckdb-mvp')
    ? { mvp: { mainModule: 'duckdb-mvp', mainWorker: 'duckdb-mvp' }, eh: { mainModule: 'duckdb-eh', mainWorker: 'duckdb-eh' } }
    : null;
export const SQLITE_WASM_URL: string | null = sqlite;
