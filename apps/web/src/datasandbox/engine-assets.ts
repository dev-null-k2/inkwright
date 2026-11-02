/**
 * WebAssembly the data sandbox loads on demand: DuckDB-WASM (MIT; the MVP and exception-handling
 * builds plus their workers — `selectBundle` picks the one the browser supports) and SQLite
 * (sql.js) as the fallback. Vite emits each as a separate file fetched only when a query first
 * runs; the service worker leaves `.wasm` out of the install-time precache.
 *
 * The single-file preview build swaps this module for `engine-assets-unavailable.ts`
 * (vite.config.ts): inlining ~70 MB of DuckDB into one HTML file is not an option there.
 */
import duckdbMvp from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url';
import duckdbEh from '@duckdb/duckdb-wasm/dist/duckdb-eh.wasm?url';
import duckdbMvpWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url';
import duckdbEhWorker from '@duckdb/duckdb-wasm/dist/duckdb-browser-eh.worker.js?url';
import sqlite from 'sql.js/dist/sql-wasm-browser.wasm?url';

export const DUCKDB_BUNDLES: { mvp: { mainModule: string; mainWorker: string }; eh: { mainModule: string; mainWorker: string } } | null = {
  mvp: { mainModule: duckdbMvp, mainWorker: duckdbMvpWorker },
  eh: { mainModule: duckdbEh, mainWorker: duckdbEhWorker },
};
export const SQLITE_WASM_URL: string | null = sqlite;
