import { datasetToCsv, quoteIdent, type Cell, type ColumnType, type Dataset, type SqlResult } from '@inkwright/core';
import { DUCKDB_BUNDLES, SQLITE_WASM_URL } from './engine-assets.ts';

/**
 * SQL engines for the data sandbox, all in the page and offline:
 *
 * 1. **DuckDB-WASM** — analytical SQL (window functions, `QUALIFY`, `PIVOT`, fast aggregates over
 *    hundreds of thousands of rows), in its own worker, loaded the first time a query runs.
 * 2. **SQLite via sql.js** — the fallback when DuckDB can't start (no Worker or WebAssembly
 *    support, memory limits, or a build without the DuckDB files). The same table and column
 *    names, so a query that sticks to standard SQL runs on either.
 *
 * Both load a dataset with the column types the core inferred, so results agree.
 */
export interface SqlEngine {
  /** Shown to the user and in the query log. */
  readonly name: string;
  /** For prompts ("DuckDB", "SQLite"). */
  readonly dialect: string;
  load(d: Dataset): Promise<void>;
  /** Removes a table (another note's data must never be queryable from this one). */
  drop(table: string): Promise<void>;
  query(sql: string): Promise<SqlResult>;
  close(): Promise<void>;
}

/** Plain JS values from engine results (BigInt → number, Date → ISO). */
export function normalizeCell(v: unknown): Cell {
  if (v == null) return null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') return v;
  if (v instanceof Date) return v.toISOString().replace(/T00:00:00\.000Z$/, '');
  if (v instanceof Uint8Array) return `<${v.length} bytes>`;
  return String(v);
}

const DUCK_TYPES: Record<ColumnType, string> = { integer: 'BIGINT', number: 'DOUBLE', boolean: 'BOOLEAN', date: 'VARCHAR', text: 'VARCHAR' };
const SQLITE_TYPES: Record<ColumnType, string> = { integer: 'INTEGER', number: 'REAL', boolean: 'INTEGER', date: 'TEXT', text: 'TEXT' };

// ---- DuckDB --------------------------------------------------------------------------------------

interface DuckConn { query(sql: string): Promise<{ schema: { fields: { name: string }[] }; toArray(): Record<string, unknown>[] }>; close(): Promise<void> }

export async function openDuckDb(): Promise<SqlEngine> {
  if (!DUCKDB_BUNDLES) throw new Error('DuckDB is not part of this build');
  if (typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') throw new Error('This browser has no Web Workers or WebAssembly');
  const duckdb = await import('@duckdb/duckdb-wasm');
  const bundle = await duckdb.selectBundle(DUCKDB_BUNDLES);
  const worker = new Worker(bundle.mainWorker!);
  const db = new duckdb.AsyncDuckDB(new duckdb.VoidLogger(), worker);
  try {
    await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  } catch (e) {
    worker.terminate();
    throw e;
  }
  const conn = (await db.connect()) as unknown as DuckConn;
  return {
    name: 'DuckDB',
    dialect: 'DuckDB',
    async load(d) {
      const file = `${d.name}.csv`;
      await db.registerFileText(file, datasetToCsv(d));
      const cols = d.columns.map((c) => `'${c.name.replace(/'/g, "''")}': '${DUCK_TYPES[c.type]}'`).join(', ');
      await conn.query(`CREATE OR REPLACE TABLE ${quoteIdent(d.name)} AS SELECT * FROM read_csv('${file}', header = true, columns = {${cols}}, nullstr = '')`);
    },
    async drop(table) {
      await conn.query(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
    },
    async query(sql) {
      const t = await conn.query(sql);
      const columns = t.schema.fields.map((f) => f.name);
      return { columns, rows: t.toArray().map((r) => columns.map((c) => normalizeCell((r as Record<string, unknown>)[c]))) };
    },
    async close() {
      await conn.close().catch(() => {});
      await db.terminate().catch(() => {});
    },
  };
}

// ---- SQLite (sql.js) ----------------------------------------------------------------------------

export interface SqlJsStatic {
  Database: new () => { run(sql: string, params?: unknown[]): void; exec(sql: string): { columns: string[]; values: unknown[][] }[]; close(): void };
}

/** A sql.js engine over an already initialized sql.js module (tests pass Node's). */
export function sqlJsEngine(SQL: SqlJsStatic): SqlEngine {
  const db = new SQL.Database();
  return {
    name: 'SQLite (sql.js)',
    dialect: 'SQLite',
    async load(d) {
      db.run(`DROP TABLE IF EXISTS ${quoteIdent(d.name)}`);
      db.run(`CREATE TABLE ${quoteIdent(d.name)} (${d.columns.map((c) => `${quoteIdent(c.name)} ${SQLITE_TYPES[c.type]}`).join(', ')})`);
      const ins = `INSERT INTO ${quoteIdent(d.name)} VALUES (${d.columns.map(() => '?').join(', ')})`;
      db.run('BEGIN');
      try {
        for (const r of d.rows) db.run(ins, r.map((v) => (typeof v === 'boolean' ? (v ? 1 : 0) : v)));
        db.run('COMMIT');
      } catch (e) {
        db.run('ROLLBACK');
        throw e;
      }
    },
    async drop(table) {
      db.run(`DROP TABLE IF EXISTS ${quoteIdent(table)}`);
    },
    async query(sql) {
      const res = db.exec(sql);
      const last = res[res.length - 1] ?? { columns: [], values: [] };
      return { columns: last.columns, rows: last.values.map((r) => r.map(normalizeCell)) };
    },
    async close() { db.close(); },
  };
}

export async function openSqlJs(): Promise<SqlEngine> {
  if (!SQLITE_WASM_URL) throw new Error('SQLite is not part of this build');
  const mod = (await import('sql.js')) as unknown as { default: (o: unknown) => Promise<SqlJsStatic> };
  return sqlJsEngine(await mod.default({ locateFile: () => SQLITE_WASM_URL }));
}

/** DuckDB, else SQLite; the reason DuckDB failed is kept for the panel and the docs. */
export async function openSqlEngine(): Promise<{ engine: SqlEngine; fallbackReason?: string }> {
  try {
    return { engine: await openDuckDb() };
  } catch (e) {
    const reason = (e as Error).message || String(e);
    console.warn('DuckDB unavailable, using SQLite', e);
    return { engine: await openSqlJs(), fallbackReason: reason };
  }
}
