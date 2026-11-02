import { describeDataset, type Cell, type Dataset } from './dataset.ts';

/**
 * Asking data questions in SQL with a model, safely and observably:
 *
 * - `readOnlySql` accepts one SELECT/WITH statement (comments and a trailing `;` allowed) and
 *   refuses anything that writes, attaches files or changes settings — the sandbox is in memory,
 *   but a model should still not be able to read local files through the engine.
 * - `runSqlWithRepair` is the repair loop: the model writes SQL, the engine runs it, and an error
 *   goes back to the model *verbatim* with the failed SQL, up to `maxTries` attempts in total
 *   (default 3). Every attempt — SQL, error or row count, time — is returned for the log.
 */

export interface SqlResult {
  columns: string[];
  rows: Cell[][];
}

export interface QueryAttempt {
  sql: string;
  ok: boolean;
  error?: string;
  rowCount?: number;
  ms: number;
  /** Which engine ran it ("DuckDB", "SQLite (sql.js)"). */
  engine?: string;
}

export interface RepairOutcome {
  ok: boolean;
  sql?: string;
  result?: SqlResult;
  attempts: QueryAttempt[];
  error?: string;
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|create|attach|detach|copy|export|import|install|load|pragma|vacuum|checkpoint|truncate|grant|revoke)\b/i;
const FILE_FUNCS = /\b(read_\w+|\w+_scan|parquet_\w+|sniff_csv|glob|httpfs|readfile|writefile|load_extension|query|query_table|getvariable)\s*\(/i;
// After `skeleton`, a string literal is `''` and a quoted identifier `""`. DuckDB reads a file or
// URL named by a string where a table goes (`FROM 'https://…'`), and calls a quoted function name
// like any other (`"read_csv"(…)`): both slipped past the list above (security review SR-02).
const FILE_AS_TABLE = /\b(from|join)\s*(\(\s*)*''/i;
const QUOTED_CALL = /""\s*\(/;

/** Strips comments and string literals so keyword checks don't trip over data. */
function skeleton(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, ' ')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/'(?:[^']|'')*'/g, "''")
    .replace(/"(?:[^"]|"")*"/g, '""');
}

/** Returns the statement without a trailing semicolon, or throws why it is not allowed. */
export function readOnlySql(sql: string): string {
  const s = sql.trim().replace(/;\s*$/, '').trim();
  if (!s) throw new Error('Empty query');
  const sk = skeleton(s);
  if (sk.includes(';')) throw new Error('Only one statement at a time');
  if (!/^\s*(with|select|values|from|table|describe|summarize)\b/i.test(sk)) throw new Error('Only SELECT queries can run here');
  if (FORBIDDEN.test(sk)) throw new Error(`Not allowed in the sandbox: ${FORBIDDEN.exec(sk)![0].toUpperCase()} (quote it with double quotes if it is a column name)`);
  if (FILE_FUNCS.test(sk) || FILE_AS_TABLE.test(sk) || QUOTED_CALL.test(sk)) throw new Error('Reading files from SQL is not allowed; drop the file on the page instead');
  return s;
}

/** Pulls SQL out of a model reply (```sql fences, or the first SELECT/WITH statement). */
export function extractSql(reply: string): string {
  const fence = /```(?:sql|duckdb|sqlite)?\s*\n([\s\S]*?)```/i.exec(reply);
  if (fence) return fence[1]!.trim();
  const m = /\b(with|select)\b[\s\S]*/i.exec(reply);
  return (m ? m[0] : reply).trim().replace(/;[\s\S]*$/, '');
}

/** The prompt that asks for SQL over the datasets. */
export function sqlPrompt(question: string, datasets: readonly Dataset[], dialect: string): string {
  return [
    `Write one ${dialect} SQL SELECT query that answers the question. Reply with only the SQL in a \`\`\`sql block.`,
    'Tables:',
    ...datasets.map(describeDataset),
    'Quote column names that contain spaces or capitals with double quotes.',
    `Question: ${question}`,
  ].join('\n');
}

/** The follow-up that feeds an engine error back to the model. */
export function repairPrompt(sql: string, error: string): string {
  return `That query failed.\nSQL:\n\`\`\`sql\n${sql}\n\`\`\`\nError: ${error}\nFix the query. Reply with only the corrected SQL in a \`\`\`sql block.`;
}

export interface RepairOptions {
  /** First SQL to try (an agent's own); without it the model writes the first attempt. */
  sql?: string;
  question: string;
  datasets: readonly Dataset[];
  dialect: string;
  /** Asks the model; `messages` alternate user/assistant, starting with the SQL prompt. */
  ask: (messages: { role: 'user' | 'assistant'; content: string }[]) => Promise<string>;
  run: (sql: string) => Promise<SqlResult>;
  maxTries?: number;
  engine?: string;
  clock?: () => number;
  /** Called after each attempt (for live logs). */
  onAttempt?: (a: QueryAttempt) => void;
}

/** Runs the write → execute → repair loop (see the module comment). */
export async function runSqlWithRepair(o: RepairOptions): Promise<RepairOutcome> {
  const max = Math.max(1, Math.min(10, o.maxTries ?? 3));
  const clock = o.clock ?? (() => Date.now());
  const messages: { role: 'user' | 'assistant'; content: string }[] = [{ role: 'user', content: sqlPrompt(o.question, o.datasets, o.dialect) }];
  const attempts: QueryAttempt[] = [];
  let sql = o.sql?.trim() ? o.sql.trim() : '';
  if (sql) messages.push({ role: 'assistant', content: `\`\`\`sql\n${sql}\n\`\`\`` });
  for (let k = 0; k < max; k++) {
    if (!sql) {
      const reply = await o.ask(messages);
      sql = extractSql(reply);
      messages.push({ role: 'assistant', content: reply });
    }
    const t0 = clock();
    try {
      const safe = readOnlySql(sql);
      const result = await o.run(safe);
      const a: QueryAttempt = { sql: safe, ok: true, rowCount: result.rows.length, ms: clock() - t0, ...(o.engine ? { engine: o.engine } : {}) };
      attempts.push(a);
      o.onAttempt?.(a);
      return { ok: true, sql: safe, result, attempts };
    } catch (e) {
      const error = (e as Error).message || String(e);
      const a: QueryAttempt = { sql, ok: false, error, ms: clock() - t0, ...(o.engine ? { engine: o.engine } : {}) };
      attempts.push(a);
      o.onAttempt?.(a);
      messages.push({ role: 'user', content: repairPrompt(sql, error) });
      sql = '';
    }
  }
  return { ok: false, attempts, error: attempts[attempts.length - 1]?.error ?? 'No query ran' };
}
