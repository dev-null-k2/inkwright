/**
 * Running runbook blocks from a note (the pure parsing is @inkwright/core runbook.ts):
 *
 * - ```http — one request from this device, after the user approves that exact request. The
 *   response's status, headers (secrets masked) and body (pretty-printed, cut) are shown.
 * - ```sql — SQLite (sql.js, WebAssembly) in the page over the CSV/JSON files attached to the
 *   note, each as a table named after the file. Nothing leaves the device.
 * - ```js — the block runs as its own Web Worker script with the network and storage APIs removed
 *   and a time limit; console output and the returned value come back.
 *
 * Shell commands are deliberately not runnable here (docs/DEVELOPERS.md › Runbooks). Every run —
 * declined requests included — is recorded in Settings › AI › Activity.
 */
import {
  dataTableFrom, isDataAsset, maskHeader, parseHttpBlock, shapeBody,
  type HttpResult, type QueryResult, type RunbookBlock, type RunbookLang,
} from '@inkwright/core';
import { RunRecorder } from '@inkwright/ai';
import { agentHub } from '../lib/agent/hub.ts';
import type { AppVault } from '../lib/vault.ts';
import { askConfirm } from '../ui/prompts.tsx';
import { useDevSettings } from './settings.ts';
import { SQLITE_WASM } from './wasm-assets.ts';

export interface RunOutput {
  lang: RunbookLang;
  ok: boolean;
  ms: number;
  error?: string;
  http?: HttpResult;
  sql?: QueryResult & { tables: string[] };
  js?: { logs: string[]; value?: string };
}

export const HTTP_TIMEOUT_MS = 20_000;
export const JS_TIMEOUT_MS = 5_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SQL_ROWS = 200;

interface RunContext {
  vault: AppVault;
  noteId: string;
  noteTitle: string;
}

/** Runs a block; null when the user declined. Always logged to Activity. */
export async function runBlock(block: RunbookBlock, ctx: RunContext): Promise<RunOutput | null> {
  const started = performance.now();
  let out: RunOutput | null;
  let summary: string;
  try {
    if (block.lang === 'http') ({ out, summary } = await runHttp(block, started));
    else if (block.lang === 'sql') ({ out, summary } = await runSql(block, ctx, started));
    else ({ out, summary } = await runJs(block, started));
  } catch (e) {
    out = { lang: block.lang, ok: false, ms: Math.round(performance.now() - started), error: (e as Error).message };
    summary = `${label(block.lang)} failed: ${out.error}`;
  }
  await record(block, ctx, out, summary);
  return out;
}

const label = (l: RunbookLang) => (l === 'http' ? 'HTTP request' : l === 'sql' ? 'SQL query' : 'JavaScript');

async function record(block: RunbookBlock, ctx: RunContext, out: RunOutput | null, summary: string) {
  const hub = agentHub();
  if (!hub) return;
  const rec = new RunRecorder(hub.activity, { source: 'external', label: 'Runbook', prompt: `${label(block.lang)}${block.name ? ` “${block.name}”` : ''} in “${ctx.noteTitle}”` });
  // A run changes nothing in the notes; it is listed (like a connected app's action), not undoable.
  rec.record({ kind: 'external', tool: `run_${block.lang}`, server: 'Runbook', summary, detail: block.code.slice(0, 300) });
  await rec.finish(out?.ok === false ? 'error' : out ? 'done' : 'cancelled', out?.error ? { error: out.error } : {});
}

// ---- HTTP --------------------------------------------------------------------------------------

async function runHttp(block: RunbookBlock, started: number): Promise<{ out: RunOutput | null; summary: string }> {
  const req = parseHttpBlock(block.code, useDevSettings.getState().httpVars);
  const host = new URL(req.url).host;
  const shown = req.headers.map(([k, v]) => `${k}: ${maskHeader(k, v)}`).join('\n');
  const ok = await askConfirm(`Send ${req.method} to ${host}?`, `${req.method} ${req.url}${shown ? `\n${shown}` : ''}${req.body ? `\n\n${req.body.length > 400 ? `${req.body.slice(0, 400)}…` : req.body}` : ''}\n\nThe request goes from this device to ${host}.`, 'Send request');
  if (!ok) return { out: null, summary: `Declined ${req.method} ${req.url}` };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(req.url, { method: req.method, headers: req.headers, body: req.body && req.method !== 'GET' && req.method !== 'HEAD' ? req.body : undefined, signal: ctrl.signal, credentials: 'omit', redirect: 'follow', cache: 'no-store' });
  } catch (e) {
    clearTimeout(timer);
    const msg = ctrl.signal.aborted ? `No answer within ${HTTP_TIMEOUT_MS / 1000} s.` : `The request did not go through (${(e as Error).message}). The server may be unreachable, or it does not allow requests from apps in a browser (CORS).`;
    throw new Error(msg);
  }
  const reader = res.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      size += value.length;
      if (size >= MAX_BODY_BYTES) { void reader.cancel(); break; }
    }
  }
  clearTimeout(timer);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c.subarray(0, Math.min(c.length, size - at)), at); at += c.length; }
  const contentType = res.headers.get('content-type') ?? undefined;
  const { body, truncated } = shapeBody(new TextDecoder().decode(all), contentType);
  const headers: [string, string][] = [];
  res.headers.forEach((v, k) => headers.push([k, maskHeader(k, v)]));
  const ms = Math.round(performance.now() - started);
  const http: HttpResult = { status: res.status, statusText: res.statusText, ms, headers, body, truncated, ...(contentType ? { contentType } : {}) };
  return { out: { lang: 'http', ok: res.ok, ms, http }, summary: `${req.method} ${req.url} → ${res.status}${res.statusText ? ` ${res.statusText}` : ''} (${ms} ms)` };
}

// ---- SQL ---------------------------------------------------------------------------------------

interface SqlJs { Database: new () => { run(sql: string, params?: unknown[]): void; exec(sql: string): { columns: string[]; values: unknown[][] }[]; close(): void } }
let sqlJs: Promise<SqlJs> | null = null;

async function loadSqlJs(): Promise<SqlJs> {
  if (!SQLITE_WASM) throw new Error('SQL blocks need the full app (this preview has no SQLite).');
  sqlJs ??= import('sql.js').then((m) => ((m as unknown as { default: (o: unknown) => Promise<SqlJs> }).default)({ locateFile: () => SQLITE_WASM }));
  return sqlJs;
}

/** The note's attached data files (CSV, TSV, JSON), for SQL blocks and the "attached data" list. */
export async function noteDataFiles(vault: AppVault, noteId: string): Promise<string[]> {
  return (await vault.fs.list(`notes/${noteId}/assets`)).filter((e) => e.kind === 'file' && isDataAsset(e.name)).map((e) => e.name).sort();
}

async function runSql(block: RunbookBlock, ctx: RunContext, started: number): Promise<{ out: RunOutput; summary: string }> {
  const files = await noteDataFiles(ctx.vault, ctx.noteId);
  if (!files.length) throw new Error('Attach a CSV or JSON file to this note first (••• › Developer › Attach data file). Each file becomes a table.');
  const SQL = await loadSqlJs();
  const db = new SQL.Database();
  const tables: string[] = [];
  try {
    for (const f of files) {
      const bytes = await ctx.vault.vault.readAsset(ctx.noteId, f);
      if (!bytes) continue;
      const t = dataTableFrom(f, new TextDecoder().decode(bytes));
      if (tables.includes(t.name) || !t.columns.length) continue;
      tables.push(t.name);
      db.run(`CREATE TABLE "${t.name}" (${t.columns.map((c) => `"${c}"`).join(', ')})`);
      const ins = `INSERT INTO "${t.name}" VALUES (${t.columns.map(() => '?').join(', ')})`;
      db.run('BEGIN');
      for (const r of t.rows) db.run(ins, r);
      db.run('COMMIT');
    }
    let res: { columns: string[]; values: unknown[][] }[];
    try {
      res = db.exec(block.code);
    } catch (e) {
      throw new Error(`${(e as Error).message}. Tables: ${tables.map((t) => `"${t}"`).join(', ')}.`);
    }
    const last = res[res.length - 1] ?? { columns: [], values: [] };
    const ms = Math.round(performance.now() - started);
    const sql = { columns: last.columns, rows: last.values.slice(0, SQL_ROWS), more: Math.max(0, last.values.length - SQL_ROWS), ms, tables };
    return { out: { lang: 'sql', ok: true, ms, sql }, summary: `SQL over ${tables.join(', ')} → ${last.values.length} ${last.values.length === 1 ? 'row' : 'rows'} (${ms} ms)` };
  } finally {
    db.close();
  }
}

// ---- JavaScript --------------------------------------------------------------------------------

/**
 * Runs first in the worker: removes every way out (network, storage, more workers) from the
 * global scope and its prototypes before the block's code exists, then captures console output.
 * The block itself is the rest of the worker's script — no eval, so the app's CSP still applies.
 */
const PRELUDE = `'use strict';
(() => {
  const gone = ['fetch', 'XMLHttpRequest', 'WebSocket', 'WebSocketStream', 'EventSource', 'WebTransport', 'importScripts', 'indexedDB', 'caches', 'BroadcastChannel', 'Worker', 'SharedWorker', 'FileSystemHandle', 'cookieStore'];
  for (let p = Object.getPrototypeOf(self); p; p = Object.getPrototypeOf(p)) for (const k of gone) { try { delete p[k]; } catch {} }
  for (const k of gone) { try { Object.defineProperty(self, k, { value: undefined, writable: false, configurable: false }); } catch {} }
  // The worker shares the app's origin, so its navigator reaches the origin's storage (OPFS) and
  // locks. The getters live on WorkerNavigator.prototype: remove them there, not only on the
  // instance, or Object.getOwnPropertyDescriptor(WorkerNavigator.prototype, 'storage').get
  // brings them back (security review SR-05).
  const nav = ['storage', 'locks', 'serviceWorker', 'usb', 'serial', 'hid', 'bluetooth'];
  for (let p = self.navigator; p; p = Object.getPrototypeOf(p)) for (const k of nav) { try { delete p[k]; } catch {} }
  for (const k of nav) { try { Object.defineProperty(self.navigator, k, { value: undefined, writable: false, configurable: false }); } catch {} }
  for (const k of ['StorageManager', 'FileSystemDirectoryHandle', 'FileSystemFileHandle', 'FileSystemSyncAccessHandle', 'LockManager']) { try { delete self[k]; } catch {} }
})();
const __fmt = (v) => { if (typeof v === 'string') return v; try { const s = JSON.stringify(v, (k, x) => typeof x === 'bigint' ? String(x) : x, 2); return s === undefined ? String(v) : s; } catch { return String(v); } };
const __post = self.postMessage.bind(self);
let __n = 0;
for (const level of ['log', 'info', 'warn', 'error', 'debug']) console[level] = (...a) => { if (++__n <= 500) __post({ t: 'log', text: (level === 'log' || level === 'info' ? '' : level + ': ') + a.map(__fmt).join(' ') }); };
(async () => {
`;
const POSTLUDE = `
})().then((v) => __post({ t: 'done', value: v === undefined ? undefined : __fmt(v) }), (e) => __post({ t: 'error', message: e && e.stack ? String(e.stack).split('\\n').slice(0, 3).join('\\n') : String(e) }));
`;

async function runJs(block: RunbookBlock, started: number): Promise<{ out: RunOutput; summary: string }> {
  const url = URL.createObjectURL(new Blob([PRELUDE, block.code, POSTLUDE], { type: 'text/javascript' }));
  const worker = new Worker(url, { name: 'inkwright-runbook-js' });
  const logs: string[] = [];
  try {
    const result = await new Promise<{ value?: string; error?: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ error: `Stopped after ${JS_TIMEOUT_MS / 1000} s.` }), JS_TIMEOUT_MS);
      worker.onmessage = (e: MessageEvent<{ t: string; text?: string; value?: string; message?: string }>) => {
        if (e.data?.t === 'log') logs.push(String(e.data.text).slice(0, 2000));
        else if (e.data?.t === 'done') { clearTimeout(timer); resolve({ value: e.data.value }); }
        else if (e.data?.t === 'error') { clearTimeout(timer); resolve({ error: String(e.data.message) }); }
      };
      // A syntax error stops the whole script before it runs.
      worker.onerror = (e) => { e.preventDefault(); clearTimeout(timer); resolve({ error: e.message || 'The code could not run.' }); };
    });
    const ms = Math.round(performance.now() - started);
    const out: RunOutput = { lang: 'js', ok: !result.error, ms, js: { logs, ...(result.value !== undefined ? { value: result.value.slice(0, 20_000) } : {}) }, ...(result.error ? { error: result.error } : {}) };
    return { out, summary: result.error ? `JavaScript failed: ${result.error.split('\n')[0]}` : `JavaScript ran (${ms} ms${logs.length ? `, ${logs.length} log ${logs.length === 1 ? 'line' : 'lines'}` : ''})` };
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}
