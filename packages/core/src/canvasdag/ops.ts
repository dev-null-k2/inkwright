import { datasetFromCsv, datasetFromJson, type Cell } from '../datasandbox/dataset.ts';
import { inferChart, type ChartSpec } from '../datasandbox/chart.ts';

/**
 * Executable canvas, step two: what a box's label means. A label that starts with a known verb is
 * a deterministic local operation (no AI, same answer every time); anything else is a step for
 * the agent, which gets the upstream outputs as its inputs.
 *
 *   fetch <url>                 GET an http(s) URL → a table (CSV/JSON) or text
 *   filter <col> <op> <value>   keep rows (op: > >= < <= = != contains, or "is"); filter <word> keeps rows mentioning it
 *   sort [by] <col> [desc]      order rows
 *   top|limit|first <n>         keep the first n rows
 *   sum|average|avg|mean|min|max [<col>]   one number (the first numeric column by default)
 *   count                       number of rows (or items)
 *   chart [bar|line]            a chart of the input table
 *   <number> | "<text>"         a constant
 */

export type DagValue =
  | { kind: 'table'; columns: string[]; rows: Cell[][] }
  | { kind: 'number'; value: number }
  | { kind: 'text'; value: string }
  | { kind: 'chart'; spec: ChartSpec; columns: string[]; rows: Cell[][] };

export type DagOp =
  | { op: 'fetch'; url: string }
  | { op: 'filter'; column?: string; cmp?: '>' | '>=' | '<' | '<=' | '=' | '!=' | 'contains'; value: string }
  | { op: 'sort'; column: string; desc: boolean }
  | { op: 'limit'; n: number }
  | { op: 'agg'; fn: 'sum' | 'avg' | 'min' | 'max'; column?: string }
  | { op: 'count' }
  | { op: 'chart'; kind?: 'bar' | 'line' }
  | { op: 'const'; value: DagValue }
  | { op: 'agent'; prompt: string };

/** Parses a node label (case-insensitive verbs, forgiving punctuation from handwriting). */
export function parseOp(label: string): DagOp {
  const raw = label.trim().replace(/\s+/g, ' ');
  const s = raw.replace(/[.:]+$/, '');
  let m: RegExpExecArray | null;
  if ((m = /^fetch\s+(\S+)/i.exec(s))) {
    const url = /^https?:\/\//i.test(m[1]!) ? m[1]! : `https://${m[1]!}`;
    return { op: 'fetch', url };
  }
  if ((m = /^filter\s+(?:where\s+)?(.+?)\s*(>=|<=|!=|<>|>|<|==|=|\bcontains\b|\bis not\b|\bis\b)\s*(.+)$/i.exec(s))) {
    const op = m[2]!.toLowerCase();
    const cmp = op === '==' || op === 'is' ? '=' : op === '<>' || op === 'is not' ? '!=' : (op as '>' | '>=' | '<' | '<=' | '=' | '!=' | 'contains');
    return { op: 'filter', column: m[1]!.trim(), cmp, value: m[3]!.trim().replace(/^["']|["']$/g, '') };
  }
  if ((m = /^filter\s+(.+)$/i.exec(s))) return { op: 'filter', value: m[1]!.trim().replace(/^["']|["']$/g, '') };
  if ((m = /^sort\s+(?:by\s+)?(.+?)(?:\s+(desc|descending|asc|ascending))?$/i.exec(s))) return { op: 'sort', column: m[1]!.trim(), desc: /^desc/i.test(m[2] ?? '') };
  if ((m = /^(?:top|limit|first|head)\s+(\d+)/i.exec(s))) return { op: 'limit', n: Number(m[1]) };
  if ((m = /^(sum|total|average|avg|mean|min|minimum|max|maximum)(?:\s+(?:of\s+)?(.+))?$/i.exec(s))) {
    const w = m[1]!.toLowerCase();
    const fn = w === 'sum' || w === 'total' ? 'sum' : w.startsWith('min') ? 'min' : w.startsWith('max') ? 'max' : 'avg';
    return { op: 'agg', fn, ...(m[2] ? { column: m[2].trim() } : {}) };
  }
  if (/^count(\s+rows)?$/i.test(s)) return { op: 'count' };
  if ((m = /^(?:chart|plot|graph)(?:\s+(bar|line))?/i.exec(s))) return { op: 'chart', ...(m[1] ? { kind: m[1].toLowerCase() as 'bar' | 'line' } : {}) };
  if (/^[-+]?\d+(\.\d+)?$/.test(s)) return { op: 'const', value: { kind: 'number', value: Number(s) } };
  if ((m = /^["“](.*)["”]$/.exec(raw))) return { op: 'const', value: { kind: 'text', value: m[1]! } };
  return { op: 'agent', prompt: raw };
}

export const isLocalOp = (o: DagOp) => o.op !== 'agent';

/** The first table among the inputs (ops that need one). */
function tableOf(inputs: readonly DagValue[]): Extract<DagValue, { kind: 'table' }> {
  const t = inputs.find((v) => v.kind === 'table' || v.kind === 'chart');
  if (!t) throw new Error('This step needs a table coming in (draw an arrow from a fetch or data step).');
  return { kind: 'table', columns: (t as { columns: string[] }).columns, rows: (t as { rows: Cell[][] }).rows };
}

/** Finds a column by name, case- and space-insensitively. */
export function columnIndex(columns: readonly string[], name: string): number {
  const norm = (x: string) => x.toLowerCase().replace(/[\s_-]+/g, '');
  const i = columns.findIndex((c) => norm(c) === norm(name));
  if (i < 0) throw new Error(`No column “${name}” (columns: ${columns.join(', ')})`);
  return i;
}

const num = (v: Cell) => (typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

function compare(a: Cell, cmp: NonNullable<Extract<DagOp, { op: 'filter' }>['cmp']>, b: string): boolean {
  if (cmp === 'contains') return String(a ?? '').toLowerCase().includes(b.toLowerCase());
  const an = num(a), bn = Number(b);
  const both = an != null && b.trim() !== '' && Number.isFinite(bn);
  const x: number | string = both ? an : String(a ?? '').toLowerCase();
  const y: number | string = both ? bn : b.toLowerCase();
  switch (cmp) {
    case '>': return x > y;
    case '>=': return x >= y;
    case '<': return x < y;
    case '<=': return x <= y;
    case '=': return x === y;
    case '!=': return x !== y;
  }
}

export interface LocalContext {
  /** Fetches text; the app supplies it (with a timeout and size cap). */
  fetchText?: (url: string, signal?: AbortSignal) => Promise<{ text: string; contentType: string }>;
  signal?: AbortSignal;
}

/** Runs a local op on its inputs. Throws a readable message on bad input. */
export async function runLocalOp(o: DagOp, inputs: readonly DagValue[], ctx: LocalContext = {}): Promise<DagValue> {
  switch (o.op) {
    case 'const': return o.value;
    case 'fetch': {
      if (!/^https?:\/\//i.test(o.url)) throw new Error('Only http(s) addresses can be fetched');
      if (!ctx.fetchText) throw new Error('Fetching is not available here');
      const { text, contentType } = await ctx.fetchText(o.url, ctx.signal);
      const path = new URL(o.url).pathname;
      try {
        if (/json/i.test(contentType) || /\.(json|ndjson)$/i.test(path)) { const d = datasetFromJson(path || 'data.json', text); return { kind: 'table', columns: d.columns.map((c) => c.name), rows: d.rows }; }
        if (/csv|tab-separated/i.test(contentType) || /\.(csv|tsv)$/i.test(path)) { const d = datasetFromCsv(path || 'data.csv', text); return { kind: 'table', columns: d.columns.map((c) => c.name), rows: d.rows }; }
      } catch (e) { throw new Error(`Fetched, but couldn't read it as data: ${(e as Error).message}`); }
      return { kind: 'text', value: text.length > 20000 ? `${text.slice(0, 20000)}…` : text };
    }
    case 'filter': {
      const t = tableOf(inputs);
      if (!o.column || !o.cmp) return { ...t, rows: t.rows.filter((r) => r.some((c) => String(c ?? '').toLowerCase().includes(o.value.toLowerCase()))) };
      const i = columnIndex(t.columns, o.column);
      return { ...t, rows: t.rows.filter((r) => compare(r[i]!, o.cmp!, o.value)) };
    }
    case 'sort': {
      const t = tableOf(inputs);
      const i = columnIndex(t.columns, o.column);
      const rows = [...t.rows].sort((a, b) => {
        const x = a[i], y = b[i];
        if (x == null) return 1;
        if (y == null) return -1;
        const r = typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), undefined, { numeric: true });
        return o.desc ? -r : r;
      });
      return { ...t, rows };
    }
    case 'limit': {
      const t = tableOf(inputs);
      return { ...t, rows: t.rows.slice(0, o.n) };
    }
    case 'count': {
      const v = inputs[0];
      if (!v) throw new Error('Nothing to count: draw an arrow into this step');
      return { kind: 'number', value: v.kind === 'table' || v.kind === 'chart' ? v.rows.length : v.kind === 'text' ? v.value.split(/\n/).filter(Boolean).length : 1 };
    }
    case 'agg': {
      const nums = inputs.filter((v): v is Extract<DagValue, { kind: 'number' }> => v.kind === 'number').map((v) => v.value);
      let values: number[];
      if (nums.length === inputs.length && nums.length) values = nums;
      else {
        const t = tableOf(inputs);
        const i = o.column ? columnIndex(t.columns, o.column) : t.columns.findIndex((_, k) => t.rows.some((r) => num(r[k]!) != null));
        if (i < 0) throw new Error('No numeric column to add up');
        values = t.rows.map((r) => num(r[i]!)).filter((v): v is number => v != null);
      }
      if (!values.length) throw new Error('No numbers to work with');
      const value = o.fn === 'sum' ? values.reduce((a, b) => a + b, 0) : o.fn === 'avg' ? values.reduce((a, b) => a + b, 0) / values.length : o.fn === 'min' ? Math.min(...values) : Math.max(...values);
      return { kind: 'number', value: Math.round(value * 1e9) / 1e9 };
    }
    case 'chart': {
      const t = tableOf(inputs);
      const spec = inferChart({ columns: t.columns, rows: t.rows });
      if (!spec) throw new Error('Nothing numeric to chart');
      return { kind: 'chart', spec: o.kind ? { ...spec, kind: o.kind } : spec, columns: t.columns, rows: t.rows };
    }
    case 'agent': throw new Error('Agent steps run through the AI');
  }
}

/** A value as text for prompts, stickies and screen readers (tables as Markdown, capped). */
export function describeValue(v: DagValue, maxRows = 20): string {
  if (v.kind === 'number') return Number.isInteger(v.value) ? String(v.value) : String(+v.value.toFixed(6));
  if (v.kind === 'text') return v.value;
  const head = `| ${v.columns.join(' | ')} |\n|${v.columns.map(() => ' --- ').join('|')}|`;
  const body = v.rows.slice(0, maxRows).map((r) => `| ${r.map((c) => (c == null ? '' : String(c).replace(/\|/g, '\\|'))).join(' | ')} |`).join('\n');
  const more = v.rows.length > maxRows ? `\n… ${v.rows.length - maxRows} more rows` : '';
  return `${v.kind === 'chart' ? `Chart (${v.spec.kind}) of:\n` : ''}${head}\n${body}${more}`;
}

/** Reads an agent's reply as a value: a Markdown or CSV table becomes a table, a lone number a number. */
export function valueFromText(text: string): DagValue {
  const t = text.trim();
  if (/^[-+]?\d+(\.\d+)?$/.test(t.replace(/,/g, ''))) return { kind: 'number', value: Number(t.replace(/,/g, '')) };
  const lines = t.split('\n').map((l) => l.trim());
  const tableLines = lines.filter((l) => /^\|.*\|$/.test(l));
  if (tableLines.length >= 3 && /^\|\s*:?-{2,}/.test(tableLines[1]!)) {
    const cells = (l: string) => l.slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
    const columns = cells(tableLines[0]!);
    const rows = tableLines.slice(2).map((l) => cells(l).map((c) => (c === '' ? null : Number.isFinite(Number(c)) && /\d/.test(c) ? Number(c) : c)));
    return { kind: 'table', columns, rows };
  }
  return { kind: 'text', value: t };
}
