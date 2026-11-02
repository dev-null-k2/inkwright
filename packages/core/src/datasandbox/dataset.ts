import { sqlIdent, uniqueIdents } from '../dev/runbook.ts';

/**
 * Data sandbox: tabular data dropped onto a page (CSV, TSV, JSON, NDJSON, spreadsheets) as a
 * typed, column-oriented dataset that any SQL engine can load. Parsing and typing are here, pure
 * and engine-neutral, so DuckDB-WASM and the sql.js fallback see exactly the same table and
 * tests need no engine at all.
 */

export type ColumnType = 'integer' | 'number' | 'boolean' | 'date' | 'text';

export interface DataColumn {
  name: string;
  type: ColumnType;
}

export type Cell = string | number | boolean | null;

export interface Dataset {
  /** SQL table name (a safe identifier derived from the file name). */
  name: string;
  /** The file it came from. */
  source: string;
  columns: DataColumn[];
  /** Row-major values, already converted to each column's type; dates are ISO strings. */
  rows: Cell[][];
}

/**
 * The table name of a data file — the same as the developer module's runbook ```sql blocks use
 * (`sqlIdent`), so one attached file is one table everywhere: "Sales 2024 (Q1).csv" →
 * "sales_2024_q1". Names already taken get `_2`, `_3`.
 */
export function tableName(fileName: string, taken: ReadonlySet<string> = new Set()): string {
  const base = sqlIdent(fileName) || 'data';
  let name = base;
  for (let i = 2; taken.has(name); i++) name = `${base}_${i}`;
  return name;
}

/** Column names as SQL identifiers, unique — again exactly as runbook SQL blocks name them. */
export function uniqueColumns(names: readonly string[]): string[] {
  return uniqueIdents(names.map((n, i) => String(n ?? '').trim() || `column_${i + 1}`));
}

const INT = /^[-+]?\d{1,15}$/;
const NUM = /^[-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?$/;
const THOUSANDS = /^[-+]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/;
const BOOL = /^(true|false|yes|no)$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const NULLS = new Set(['', 'na', 'n/a', 'null', 'none', 'nan', '-']);

function isNullish(v: unknown): boolean {
  return v == null || (typeof v === 'string' && NULLS.has(v.trim().toLowerCase()));
}

/** The narrowest type every non-empty value of a column fits. */
export function inferType(values: readonly unknown[]): ColumnType {
  let int = true, num = true, bool = true, date = true, any = false;
  for (const v of values) {
    if (isNullish(v)) continue;
    any = true;
    if (typeof v === 'number') { bool = false; date = false; if (!Number.isInteger(v)) int = false; continue; }
    if (typeof v === 'boolean') { int = num = date = false; continue; }
    const s = String(v).trim();
    if (int && !INT.test(s)) int = false;
    if (num && !NUM.test(s) && !THOUSANDS.test(s)) num = false;
    if (bool && !BOOL.test(s)) bool = false;
    if (date && !(ISO_DATE.test(s) && !Number.isNaN(Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s)))) date = false;
    if (!int && !num && !bool && !date) return 'text';
  }
  if (!any) return 'text';
  return int ? 'integer' : num ? 'number' : bool ? 'boolean' : date ? 'date' : 'text';
}

/** Converts one raw value to its column's type (null for empty or unparseable values). */
export function convert(v: unknown, t: ColumnType): Cell {
  if (isNullish(v)) return null;
  if (t === 'text') return typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  if (t === 'boolean') return typeof v === 'boolean' ? v : /^(true|yes)$/i.test(String(v).trim());
  if (t === 'integer' || t === 'number') {
    if (typeof v === 'number') return v;
    const n = Number(String(v).trim().replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  const s = String(v).trim();
  return s;
}

/** Builds a typed dataset from a header row and raw rows. */
export function datasetFromRows(source: string, header: readonly string[], raw: readonly unknown[][], taken?: ReadonlySet<string>): Dataset {
  const names = uniqueColumns(header);
  const width = names.length;
  const types = names.map((_, c) => inferType(raw.map((r) => r[c])));
  return {
    name: tableName(source, taken),
    source,
    columns: names.map((name, i) => ({ name, type: types[i]! })),
    rows: raw.map((r) => Array.from({ length: width }, (_, c) => convert(r[c], types[c]!))),
  };
}

// ---- CSV ----------------------------------------------------------------------------------------

/** Picks the delimiter that splits the first lines most consistently (comma, semicolon, tab, pipe). */
export function sniffDelimiter(text: string): string {
  const sample = text.split(/\r?\n/).filter((l) => l.trim()).slice(0, 12);
  let best = ',';
  let bestScore = -1;
  for (const d of [',', ';', '\t', '|']) {
    const counts = sample.map((l) => splitCsvLine(l, d).length);
    if (!counts.length || counts[0]! < 2) continue;
    const same = counts.filter((c) => c === counts[0]).length;
    const score = same * 10 + counts[0]!;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

function splitCsvLine(line: string, d: string): string[] {
  return parseDelimited(line, d)[0] ?? [];
}

/**
 * RFC 4180 CSV: quoted fields with doubled quotes, delimiters and newlines inside quotes, CRLF or
 * LF, a UTF-8 BOM, and a trailing newline. Returns rows of strings.
 */
export function parseDelimited(text: string, delimiter = ','): string[][] {
  const s = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let q = false;
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i]!;
    if (q) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i += 2; continue; }
        q = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"' && field === '') { q = true; i++; continue; }
    if (c === delimiter) { row.push(field); field = ''; i++; continue; }
    if (c === '\r' || c === '\n') {
      row.push(field); field = '';
      rows.push(row); row = [];
      i += c === '\r' && s[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    field += c; i++;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => !(r.length === 1 && r[0] === ''));
}

/** CSV/TSV text → dataset (the first row is the header). */
export function datasetFromCsv(source: string, text: string, taken?: ReadonlySet<string>): Dataset {
  const d = /\.tsv$/i.test(source) ? '\t' : sniffDelimiter(text);
  const rows = parseDelimited(text, d);
  if (!rows.length) throw new Error(`${source} is empty`);
  const [header, ...body] = rows;
  return datasetFromRows(source, header!, body, taken);
}

// ---- JSON ---------------------------------------------------------------------------------------

/** Flattens nested objects to joined keys ({a:{b:1}} → {"a_b":1}); arrays stay JSON text. */
export function flattenRecord(o: Record<string, unknown>, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  for (const [k, v] of Object.entries(o)) {
    const key = prefix ? `${prefix}_${k}` : k;
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenRecord(v as Record<string, unknown>, key, out);
    else out[key] = Array.isArray(v) ? JSON.stringify(v) : v;
  }
  return out;
}

/**
 * JSON → dataset: an array of objects, an array of arrays (first row = header), an object holding
 * one such array (`{"data": [...]}`), or newline-delimited JSON.
 */
export function datasetFromJson(source: string, text: string, taken?: ReadonlySet<string>): Dataset {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    // NDJSON: one object per line.
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    try { data = lines.map((l) => JSON.parse(l)); } catch (e) { throw new Error(`${source} is not valid JSON: ${(e as Error).message}`); }
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const arr = Object.values(data as Record<string, unknown>).find((v) => Array.isArray(v) && v.length && typeof v[0] === 'object');
    data = arr ?? [data];
  }
  if (!Array.isArray(data) || !data.length) throw new Error(`${source} has no rows`);
  if (Array.isArray(data[0])) {
    const [header, ...body] = data as unknown[][];
    return datasetFromRows(source, header!.map(String), body, taken);
  }
  const recs = (data as unknown[]).map((r) => (r && typeof r === 'object' ? flattenRecord(r as Record<string, unknown>) : { value: r }));
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const r of recs) for (const k of Object.keys(r)) if (!seen.has(k)) { seen.add(k); keys.push(k); }
  return datasetFromRows(source, keys, recs.map((r) => keys.map((k) => r[k])), taken);
}

/** A dataset as CSV (for result exports and engines that load CSV). */
export function datasetToCsv(d: Pick<Dataset, 'columns' | 'rows'>): string {
  const q = (v: Cell) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [d.columns.map((c) => q(c.name)).join(','), ...d.rows.map((r) => r.map(q).join(','))].join('\n') + '\n';
}

/** Schema description for prompts: `sales(region TEXT, amount NUMBER, …) — 120 rows`. */
export function describeDataset(d: Dataset): string {
  const sample = d.rows.slice(0, 3).map((r) => `  ${JSON.stringify(Object.fromEntries(d.columns.map((c, i) => [c.name, r[i]])))}`).join('\n');
  return `${d.name}(${d.columns.map((c) => `${quoteIdent(c.name)} ${c.type.toUpperCase()}`).join(', ')}) — ${d.rows.length} rows, from ${d.source}\n${sample}`;
}

/** Quotes an identifier for SQL when it needs it. */
export function quoteIdent(name: string): string {
  return /^[a-z_][a-z0-9_]*$/.test(name) && !SQL_RESERVED.has(name) ? name : `"${name.replace(/"/g, '""')}"`;
}

const SQL_RESERVED = new Set(['select', 'from', 'where', 'table', 'order', 'group', 'by', 'join', 'limit', 'union', 'insert', 'update', 'delete', 'create', 'drop', 'index', 'values', 'as', 'on', 'and', 'or', 'not', 'null', 'is', 'in', 'case', 'when', 'then', 'else', 'end', 'having', 'distinct', 'all']);

/** Files that are data in the shared attachment format (runbook SQL reads CSV/TSV/JSON; the sandbox also NDJSON). */
export function isDatasetFile(name: string): boolean {
  return /\.(csv|tsv|json|ndjson)$/i.test(name);
}

/**
 * JSON assets the app writes for itself (provenance, page summaries, transcripts, certificates):
 * never data, even though they end in `.json`.
 */
export function isInternalAsset(name: string): boolean {
  return /^(provenance|page-summaries)\.json$|\.transcript\.json$|^authorship-\d+\.json$/.test(name);
}

/** A dropped or picked file's name as a note asset in the shared data format ("Q1 sales.csv" → "Q1-sales.csv"). */
export function dataAssetName(fileName: string): string {
  return fileName.replace(/[^0-9A-Za-z_.-]+/g, '-').replace(/^[-.]+/, '').slice(0, 90) || 'data.csv';
}
