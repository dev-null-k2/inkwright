/**
 * Runbooks and incident notebooks: fenced code blocks in a note's typed text that can be run from
 * the page — ```http (a request), ```sql (a query over CSV/JSON files attached to the note) and
 * ```js (a computation in a sandboxed worker). This file is the pure part: finding blocks,
 * parsing requests, reading CSV, shaping results. Running them is the app's job
 * (apps/web/src/dev/runbook.ts), always with the user watching and recorded in Activity.
 */
import type { PageInk } from '../model.ts';

export const RUNBOOK_LANGS = ['http', 'sql', 'js'] as const;
export type RunbookLang = (typeof RUNBOOK_LANGS)[number];

export interface RunbookBlock {
  lang: RunbookLang;
  code: string;
  /** Character offsets of the whole fence (``` to ```) in the text. */
  start: number;
  end: number;
  /** 0-based line of the opening fence in the text. */
  line: number;
  /** Optional name after the language: ```http health-check */
  name?: string;
}

const FENCE = /^([ \t]*)(`{3,}|~{3,})[ \t]*([A-Za-z]+)?[ \t]*([^\n`]*)$/;
const ALIASES: Record<string, RunbookLang> = { http: 'http', rest: 'http', sql: 'sql', js: 'js', javascript: 'js' };

/** Every runnable fenced block in a piece of Markdown, in order. Unclosed fences run to the end. */
export function parseRunbookBlocks(text: string): RunbookBlock[] {
  const out: RunbookBlock[] = [];
  if (!text || !/(```|~~~)/.test(text)) return out;
  const lines = text.split('\n');
  let offset = 0;
  const starts: number[] = [];
  for (const l of lines) { starts.push(offset); offset += l.length + 1; }
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]!);
    if (!m) continue;
    const fence = m[2]!;
    let j = i + 1;
    while (j < lines.length && !new RegExp(`^[ \\t]*${fence[0] === '`' ? '`' : '~'}{${fence.length},}[ \\t]*$`).test(lines[j]!)) j++;
    const tag = (m[3] ?? '').toLowerCase();
    const lang = Object.hasOwn(ALIASES, tag) ? ALIASES[tag] : undefined;
    if (lang) {
      const code = lines.slice(i + 1, j).join('\n');
      const end = j < lines.length ? starts[j]! + lines[j]!.length : text.length;
      const name = m[4]?.trim();
      out.push({ lang, code, start: starts[i]!, end, line: i, ...(name ? { name } : {}) });
    }
    i = j;
  }
  return out;
}

export interface PageRunbookBlock extends RunbookBlock {
  pageIndex: number;
  textId: string;
}

/** Runnable blocks in a note's typed text, page by page. */
export function noteRunbookBlocks(pages: readonly PageInk[]): PageRunbookBlock[] {
  const out: PageRunbookBlock[] = [];
  pages.forEach((p, pageIndex) => {
    for (const t of p.texts ?? []) for (const b of parseRunbookBlocks(t.text)) out.push({ ...b, pageIndex, textId: t.id });
  });
  return out;
}

// ---- HTTP --------------------------------------------------------------------------------------

export interface HttpRequestSpec {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
}

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

/**
 * The `.http` / REST Client format: a request line (`GET https://…`, method optional = GET),
 * header lines (`Name: value`), a blank line, then the body. `#` and `//` lines are comments.
 * `{{name}}` variables are filled from `vars`.
 */
export function parseHttpBlock(code: string, vars: Record<string, string> = {}): HttpRequestSpec {
  const fill = (s: string) => s.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
  const lines = code.split('\n');
  let i = 0;
  while (i < lines.length && (!lines[i]!.trim() || /^\s*(#|\/\/)/.test(lines[i]!))) i++;
  const first = lines[i]?.trim();
  if (!first) throw new Error('The block has no request line. Start with e.g. "GET https://example.com/health".');
  const m = /^([A-Za-z]+)\s+(\S+)(\s+HTTP\/[\d.]+)?$/.exec(first);
  const method = m && METHODS.has(m[1]!.toUpperCase()) ? m[1]!.toUpperCase() : 'GET';
  const rawUrl = m && METHODS.has(m[1]!.toUpperCase()) ? m[2]! : first.split(/\s+/)[0]!;
  const url = fill(rawUrl);
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`"${url}" is not a full URL. Include the scheme, e.g. https://${url.replace(/^\/+/, '')}.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error(`Only http and https requests can run (got ${parsed.protocol}).`);
  const headers: [string, string][] = [];
  i++;
  for (; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.trim()) { i++; break; }
    if (/^\s*(#|\/\/)/.test(l)) continue;
    const h = /^([A-Za-z0-9!#$%&'*+.^_`|~-]+)\s*:\s*(.*)$/.exec(l);
    if (!h) throw new Error(`Line ${i + 1} is not a header ("Name: value"): ${l.trim()}`);
    headers.push([h[1]!, fill(h[2]!.trim())]);
  }
  const body = lines.slice(i).join('\n').trim();
  return { method, url: parsed.toString(), headers, ...(body ? { body: fill(body) } : {}) };
}

/** Header names whose values are secrets: never shown in full or logged. */
export const SECRET_HEADERS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|x-auth-token)$/i;

export function maskHeader(name: string, value: string): string {
  if (!SECRET_HEADERS.test(name)) return value;
  const scheme = /^(\w+)\s+/.exec(value)?.[1];
  return scheme ? `${scheme} ••••` : '••••';
}

export interface HttpResult {
  status: number;
  statusText: string;
  ms: number;
  headers: [string, string][];
  /** The body as text, cut to `maxBody` characters. */
  body: string;
  /** The full body was longer by this many characters. */
  truncated: number;
  contentType?: string;
}

/** Pretty-prints JSON bodies and cuts long ones (what the page shows). */
export function shapeBody(text: string, contentType: string | undefined, maxBody = 4000): { body: string; truncated: number } {
  let body = text;
  if (/json/i.test(contentType ?? '') || /^\s*[[{]/.test(text)) {
    try { body = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON after all */ }
  }
  return body.length > maxBody ? { body: body.slice(0, maxBody), truncated: body.length - maxBody } : { body, truncated: 0 };
}

// ---- CSV / JSON data for SQL -------------------------------------------------------------------

/** RFC 4180 CSV (quoted fields, doubled quotes, CRLF or LF; `;` or tab when that is clearly the delimiter). */
export function parseCsv(text: string): string[][] {
  const src = text.replace(/^﻿/, '');
  const head = src.slice(0, src.indexOf('\n') >= 0 ? src.indexOf('\n') : src.length);
  const count = (c: string) => head.split(c).length - 1;
  const delim = count('\t') > count(',') && count('\t') > count(';') ? '\t' : count(';') > count(',') ? ';' : ',';
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === delim) { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export interface DataTable {
  /** SQL-safe table name. */
  name: string;
  columns: string[];
  rows: (string | number | null)[][];
}

/** A safe SQL identifier from a file or column name (`incidents-2026.csv` → `incidents_2026`). */
export function sqlIdent(name: string): string {
  const base = name.replace(/\.[A-Za-z0-9]+$/, '').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();
  return /^[a-z_]/.test(base) ? base || 't' : `t_${base}`;
}

const asValue = (v: string): string | number | null => {
  const t = v.trim();
  if (t === '') return null;
  return /^-?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?$/.test(t) && t.length < 17 ? Number(t) : v;
};

/** An attached `.csv` or `.json` file as a table (first CSV row = column names; JSON = array of objects). */
export function dataTableFrom(fileName: string, text: string): DataTable {
  const name = sqlIdent(fileName);
  if (/\.json$/i.test(fileName)) {
    const parsed = JSON.parse(text) as unknown;
    const list = Array.isArray(parsed) ? parsed : parsed && typeof parsed === 'object' ? Object.values(parsed).find(Array.isArray) ?? [parsed] : [];
    const objs = (list as unknown[]).filter((x): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x));
    const cols: string[] = [];
    for (const o of objs) for (const k of Object.keys(o)) if (!cols.includes(k)) cols.push(k);
    const columns = uniqueIdents(cols);
    const rows = objs.map((o) => cols.map((k) => { const v = o[k]; return v == null ? null : typeof v === 'number' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v); }));
    return { name, columns, rows };
  }
  const all = parseCsv(text);
  const header = all[0] ?? [];
  const columns = uniqueIdents(header.length ? header : ['value']);
  const rows = all.slice(1).map((r) => columns.map((_, i) => asValue(r[i] ?? '')));
  return { name, columns, rows };
}

function uniqueIdents(names: readonly string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    let id = sqlIdent(n) || 'col';
    let k = 2;
    while (out.includes(id)) id = `${sqlIdent(n)}_${k++}`;
    out.push(id);
  }
  return out;
}

/** Data files attachable to a note for SQL blocks. */
export const isDataAsset = (name: string) => /\.(csv|tsv|json)$/i.test(name);

export interface QueryResult {
  columns: string[];
  rows: unknown[][];
  /** Rows not shown (cut at the display limit). */
  more: number;
  ms: number;
}

/** A result grid as Markdown (copying a result into the note, agents). */
export function resultToMarkdown(r: Pick<QueryResult, 'columns' | 'rows' | 'more'>): string {
  const cell = (v: unknown) => (v == null ? '' : String(v)).replace(/\|/g, '\\|').replace(/\n/g, ' ');
  const lines = [`| ${r.columns.map(cell).join(' | ')} |`, `| ${r.columns.map(() => '---').join(' | ')} |`, ...r.rows.map((row) => `| ${row.map(cell).join(' | ')} |`)];
  if (r.more) lines.push(`\n…and ${r.more} more rows`);
  return lines.join('\n');
}
