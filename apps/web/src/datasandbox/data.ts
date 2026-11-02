import {
  chartSvg,
  dataAssetName,
  datasetFromCsv,
  datasetFromJson,
  describeValue,
  isDatasetFile,
  isInternalAsset,
  newId,
  runSqlWithRepair,
  type Cell,
  type ChartSpec,
  type Dataset,
  type NoteDocument,
  type QueryAttempt,
  type RepairOutcome,
  type SqlResult,
  type TableObject,
} from '@inkstone/core';
import type { AppVault } from '../lib/vault.ts';
import { aiForNote } from '../inkactions/ai.ts';
import { openSqlEngine, type SqlEngine } from './engine.ts';

/**
 * The data sandbox's model of a note's data. Data lives in the note's assets in the format the
 * developer module's runbook ```sql blocks already read — one CSV/TSV/JSON file per table, named
 * after the file (docs/DEVELOPERS.md) — so a file dropped here is queryable there and vice versa.
 * Spreadsheets are converted on the way in (one CSV per sheet; the original .xlsx is kept).
 *
 * Every query — typed by the user or written by the assistant, including each failed attempt of
 * the repair loop — is appended to the note's `data-queries.jsonl` asset (docs/VAULT_FORMAT.md).
 */

export const QUERY_LOG_ASSET = 'data-queries.jsonl';
const enc = new TextEncoder();
const dec = new TextDecoder();

/** The note's datasets, parsed and typed (internal JSON like provenance is skipped). */
export async function noteDatasets(vault: AppVault, noteId: string): Promise<Dataset[]> {
  const names = (await vault.fs.list(`notes/${noteId}/assets`)).filter((e) => e.kind === 'file' && isDatasetFile(e.name) && !isInternalAsset(e.name)).map((e) => e.name).sort();
  const out: Dataset[] = [];
  const taken = new Set<string>();
  for (const n of names) {
    const bytes = await vault.vault.readAsset(noteId, n);
    if (!bytes) continue;
    try {
      const d = parseDataText(n, dec.decode(bytes), taken);
      taken.add(d.name);
      out.push(d);
    } catch (e) {
      console.warn(`Skipping ${n}: ${(e as Error).message}`);
    }
  }
  return out;
}

export function parseDataText(name: string, text: string, taken?: ReadonlySet<string>): Dataset {
  return /\.(json|ndjson)$/i.test(name) ? datasetFromJson(name, text, taken) : datasetFromCsv(name, text, taken);
}

export const DATA_FILE_ACCEPT = '.csv,.tsv,.json,.ndjson,.xlsx,.xls,.ods,text/csv,application/json';
export const isDataFile = (f: { name: string }) => /\.(csv|tsv|json|ndjson|xlsx|xls|ods)$/i.test(f.name);

/** Spreadsheet bytes → one CSV per non-empty sheet (SheetJS, loaded on first use). */
export async function spreadsheetToCsv(bytes: Uint8Array): Promise<{ sheet: string; csv: string }[]> {
  const XLSX = await import('xlsx');
  const wb = XLSX.read(bytes, { type: 'array', cellDates: true, dense: true });
  return wb.SheetNames.map((sheet) => ({ sheet, csv: XLSX.utils.sheet_to_csv(wb.Sheets[sheet]!, { blankrows: false, rawNumbers: true, dateNF: 'yyyy-mm-dd' }) })).filter((s) => s.csv.trim());
}

/** Adds dropped/picked files to a note as data; returns the datasets they became. */
export async function importDataFiles(vault: AppVault, noteId: string, files: File[]): Promise<{ asset: string; dataset: Dataset }[]> {
  const out: { asset: string; dataset: Dataset }[] = [];
  for (const f of files) {
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (/\.(xlsx|xls|ods)$/i.test(f.name)) {
      await vault.vault.writeAsset(noteId, dataAssetName(f.name), bytes);
      const sheets = await spreadsheetToCsv(bytes);
      if (!sheets.length) throw new Error(`${f.name} has no data`);
      const base = f.name.replace(/\.[^.]+$/, '');
      for (const s of sheets) {
        const asset = dataAssetName(`${sheets.length > 1 ? `${base}-${s.sheet}` : base}.csv`);
        const dataset = datasetFromCsv(asset, s.csv);
        await vault.vault.writeAsset(noteId, asset, enc.encode(s.csv));
        out.push({ asset, dataset });
      }
      continue;
    }
    const asset = dataAssetName(f.name);
    const dataset = parseDataText(asset, dec.decode(bytes)); // validate before saving
    await vault.vault.writeAsset(noteId, asset, bytes);
    out.push({ asset, dataset });
  }
  return out;
}

// ---- Engine per note -----------------------------------------------------------------------------

let shared: Promise<{ engine: SqlEngine; fallbackReason?: string }> | null = null;
/** What the shared engine holds now: one note's tables (a fingerprint to skip reloads, and their names). */
let loaded: { key: string; tables: string[] } | null = null;

/** The engine with this note's datasets loaded (DuckDB, else SQLite). */
export async function engineFor(vault: AppVault, noteId: string): Promise<{ engine: SqlEngine; datasets: Dataset[]; fallbackReason?: string }> {
  shared ??= openSqlEngine().catch((e) => { shared = null; throw e; });
  const { engine, fallbackReason } = await shared;
  const datasets = await noteDatasets(vault, noteId);
  const key = `${noteId}:${datasets.map((d) => `${d.name}/${d.rows.length}/${d.columns.length}`).join(',')}`;
  if (loaded?.key !== key) {
    // Only this note's data is ever queryable: drop whatever the last note loaded.
    for (const t of loaded?.tables ?? []) await engine.drop(t).catch(() => {});
    loaded = null;
    for (const d of datasets) await engine.load(d);
    loaded = { key, tables: datasets.map((d) => d.name) };
  }
  return { engine, datasets, ...(fallbackReason ? { fallbackReason } : {}) };
}

/** Forgets loaded tables (after a file changes). */
export function invalidateEngine(): void {
  if (loaded) loaded = { ...loaded, key: '' };
}

// ---- Query log -----------------------------------------------------------------------------------

export interface QueryLogEntry {
  at: number;
  by: 'you' | 'assistant';
  question?: string;
  ok: boolean;
  attempts: QueryAttempt[];
}

export async function appendQueryLog(vault: AppVault, noteId: string, e: QueryLogEntry): Promise<void> {
  const prev = await vault.vault.readAsset(noteId, QUERY_LOG_ASSET).catch(() => null);
  const text = (prev ? dec.decode(prev) : '') + JSON.stringify(e) + '\n';
  await vault.vault.writeAsset(noteId, QUERY_LOG_ASSET, enc.encode(text));
}

export async function readQueryLog(vault: AppVault, noteId: string): Promise<QueryLogEntry[]> {
  const bytes = await vault.vault.readAsset(noteId, QUERY_LOG_ASSET).catch(() => null);
  if (!bytes) return [];
  return dec.decode(bytes).split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as QueryLogEntry]; } catch { return []; } });
}

// ---- Running queries -------------------------------------------------------------------------------

/** Runs SQL the user typed (read-only; logged). */
export async function runUserSql(vault: AppVault, noteId: string, sql: string): Promise<RepairOutcome & { engine: string; fallbackReason?: string }> {
  const { engine, datasets, fallbackReason } = await engineFor(vault, noteId);
  const out = await runSqlWithRepair({ sql, question: '', datasets, dialect: engine.dialect, engine: engine.name, maxTries: 1, run: (q) => engine.query(q), ask: async () => '' });
  await appendQueryLog(vault, noteId, { at: Date.now(), by: 'you', ok: out.ok, attempts: out.attempts });
  return { ...out, engine: engine.name, ...(fallbackReason ? { fallbackReason } : {}) };
}

/**
 * A question in words (or the assistant's SQL) through the repair loop: the model writes SQL,
 * errors go back to it verbatim, at most `maxTries` attempts, every one logged.
 */
export async function askData(o: { vault: AppVault; doc: Pick<NoteDocument, 'meta'>; question: string; sql?: string; by: QueryLogEntry['by']; maxTries?: number; signal?: AbortSignal }): Promise<RepairOutcome & { engine: string }> {
  const { engine, datasets } = await engineFor(o.vault, o.doc.meta.id);
  if (!datasets.length) throw new Error('This note has no data yet: drop a CSV, JSON or spreadsheet file on the page.');
  const ai = await aiForNote(o.doc.meta, { source: 'data-sandbox', task: 'chat' });
  const out = await runSqlWithRepair({
    question: o.question,
    ...(o.sql ? { sql: o.sql } : {}),
    datasets,
    dialect: engine.dialect,
    engine: engine.name,
    maxTries: o.maxTries ?? 3,
    run: (q) => engine.query(q),
    ask: async (messages) => (await ai.provider.chat({ model: ai.model, messages: [{ role: 'system', content: 'You write SQL for the user\'s own data, which is loaded in an in-browser database. Reply with SQL only.' }, ...messages], maxTokens: 800, ...(o.signal ? { signal: o.signal } : {}) })).text,
  });
  await appendQueryLog(o.vault, o.doc.meta.id, { at: Date.now(), by: o.by, question: o.question, ok: out.ok, attempts: out.attempts });
  return { ...out, engine: engine.name };
}

// ---- On the page ---------------------------------------------------------------------------------

const fmt = (v: Cell) => (v == null ? '' : typeof v === 'number' ? (Number.isInteger(v) ? String(v) : String(+v.toFixed(4))) : String(v));

/**
 * A table object previewing data (header + first rows), linked to the full data; tables are the
 * smart-ink object everyone already knows (draws everywhere, exports, syncs, undoes).
 */
export function dataTableObject(o: { columns: string[]; rows: Cell[][]; x: number; y: number; origin: 'import' | 'solver'; data: TableObject['data']; maxRows?: number; maxCols?: number }): TableObject {
  const maxRows = o.maxRows ?? 8, maxCols = o.maxCols ?? 6;
  const cols = o.columns.slice(0, maxCols);
  const rows = o.rows.slice(0, maxRows);
  const widths = cols.map((c, i) => Math.max(64, Math.min(170, 14 + 7.2 * Math.max(c.length, ...rows.map((r) => fmt(r[i] ?? null).length)))));
  const cells = [cols.map((c) => ({ text: c })), ...rows.map((r) => cols.map((_, i) => ({ text: fmt(r[i] ?? null) })))];
  return { id: newId(), type: 'table', x: o.x, y: o.y, createdAt: Date.now(), cols: widths, rows: cells.map(() => 26), cells, color: '#FF4A4F57', lineWidth: 1.2, header: true, origin: o.origin, ...(o.data ? { data: o.data } : {}) };
}

/** Renders a chart SVG to PNG bytes (an image object on the page, like any picture). */
export async function chartPng(spec: ChartSpec, r: SqlResult, width = 480, height = 300): Promise<{ bytes: Uint8Array; width: number; height: number }> {
  const svg = chartSvg(spec, r, { width, height, font: getComputedStyle(document.documentElement).getPropertyValue('--font-ui') || 'system-ui, sans-serif' });
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const k = 2;
    const c = document.createElement('canvas');
    c.width = width * k; c.height = height * k;
    const ctx = c.getContext('2d')!;
    ctx.scale(k, k);
    ctx.drawImage(img, 0, 0, width, height);
    const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Could not draw the chart'))), 'image/png'));
    return { bytes: new Uint8Array(await blob.arrayBuffer()), width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Puts a query result on the page as a table (one undo step). */
export function placeResultTable(doc: NoteDocument, pageIndex: number, r: SqlResult, at: { x: number; y: number }, sql: string): TableObject {
  const t = dataTableObject({ columns: r.columns, rows: r.rows, x: at.x, y: at.y, origin: 'solver', data: { asset: '', table: 'result', rowCount: r.rows.length, columns: r.columns.map((name) => ({ name, type: 'text' })), query: sql } });
  doc.editObjects(pageIndex, 'Query result', { upsert: [t] });
  return t;
}

/** Puts a chart of a result on the page as an image (computed here: origin 'solver'). */
export async function placeChart(vault: AppVault, doc: NoteDocument, pageIndex: number, spec: ChartSpec, r: SqlResult, at: { x: number; y: number }): Promise<void> {
  const png = await chartPng(spec, r);
  const asset = vault.newAssetName('png');
  await vault.vault.writeAsset(doc.meta.id, asset, png.bytes);
  doc.addImage(pageIndex, { id: newId(), x: at.x, y: at.y, width: png.width * 0.75, height: png.height * 0.75, asset, rotation: 0, createdAt: Date.now(), origin: 'solver' });
}

/** A short text form of a result for agents (Markdown table, capped). */
export function resultForAgent(r: SqlResult, max = 50): string {
  return describeValue({ kind: 'table', columns: r.columns, rows: r.rows }, max);
}

