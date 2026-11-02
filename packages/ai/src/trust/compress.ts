/**
 * The reversible context budgeter. Tool results, retrieved passages and long notes are what make
 * agent calls expensive: a `list_notes` of 300 notes or a lecture transcript can be 90 % of a
 * request. Before a request leaves the choke point, each large block is shrunk by a shape-aware
 * rule (JSON arrays keep their first items, matching items and a field summary; tables keep the
 * header, matching rows and the ends; logs collapse repeats and keep errors with context; prose
 * keeps headings, the start, the end and the passages that match the question). The original
 * is kept in a local content-addressed store, and the shortened text ends with a marker telling
 * the model it can call `retrieve_original` for the full text — so nothing is lost, only
 * deferred. `createGuardedProvider` answers those calls on the device without involving the
 * caller.
 *
 * Two properties matter for cost as much as the ratio:
 * - **Deterministic.** The same block always compresses to the same text, so the conversation
 *   prefix stays byte-identical across turns and provider prompt caching keeps working.
 * - **Sticky expansion.** Once the model retrieved a block, later turns send it in full.
 *
 * Where it does not help (published in docs/TRUST.md from the benchmark): short results (left
 * alone), questions whose answer is in a dropped middle part of prose without matching words (one
 * extra round trip, which can cost more than it saved), and requests without tools (the model
 * cannot retrieve, so only lossless shortening is applied there).
 */
import { sha256 } from '@inkstone/core';
import type { ChatMessage, ContentPart } from '../types.ts';

// ---- Tokens ------------------------------------------------------------------------------------

/**
 * Estimated tokens for text, for budgeting and the meter when a provider doesn't report usage:
 * ~4 characters per token for Latin script (the usual BPE average for English prose and JSON),
 * ~1 token per character for CJK and other wide scripts. Within ±15 % of real tokenizers on the
 * fixtures; provider-reported usage replaces it whenever available.
 */
export function estimateTokens(text: string): number {
  let narrow = 0;
  let wide = 0;
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x2e80) narrow++;
    else wide++;
  }
  return Math.ceil(narrow / 4 + wide);
}

/** Tokens of a whole request's text (images count as a flat ~800, a typical page render). */
export function estimateMessagesTokens(messages: readonly ChatMessage[]): number {
  let n = 0;
  for (const m of messages) {
    n += 4;
    if (typeof m.content === 'string') n += estimateTokens(m.content);
    else for (const p of m.content) n += p.type === 'text' ? estimateTokens(p.text) : 800;
    for (const c of m.toolCalls ?? []) n += estimateTokens(JSON.stringify(c.arguments)) + 8;
  }
  return n;
}

// ---- Content store -------------------------------------------------------------------------------

/** Content-addressed storage for originals. Refs are the first 16 hex chars of SHA-256. */
export interface ContentStore {
  put(text: string): Promise<string>;
  get(ref: string): Promise<string | null>;
}

export function contentRef(text: string): string {
  const h = sha256(text);
  let s = '';
  for (let i = 0; i < 8; i++) s += h[i]!.toString(16).padStart(2, '0');
  return s;
}

/** An in-memory store bounded by total characters (least recently used go first). */
export class MemoryContentStore implements ContentStore {
  private map = new Map<string, string>();
  private size = 0;
  constructor(private maxChars = 20_000_000) {}
  async put(text: string): Promise<string> {
    const ref = contentRef(text);
    if (this.map.has(ref)) {
      this.map.delete(ref);
      this.map.set(ref, text);
      return ref;
    }
    this.map.set(ref, text);
    this.size += text.length;
    for (const [k, v] of this.map) {
      if (this.size <= this.maxChars || k === ref) break;
      this.map.delete(k);
      this.size -= v.length;
    }
    return ref;
  }
  async get(ref: string): Promise<string | null> {
    const v = this.map.get(ref);
    if (v === undefined) return null;
    this.map.delete(ref);
    this.map.set(ref, v);
    return v;
  }
}

// ---- Shapes ---------------------------------------------------------------------------------------

export type ContentShape = 'json' | 'table' | 'log' | 'prose';

const LOG_LINE = /^(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}|\[?\d{2}:\d{2}:\d{2}|(?:DEBUG|INFO|WARN|WARNING|ERROR|TRACE|FATAL)\b|\s+at\s+\S+\s+\()/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;

export function detectShape(text: string): ContentShape {
  const t = text.trim();
  if ((t.startsWith('{') && t.endsWith('}')) || (t.startsWith('[') && t.endsWith(']'))) {
    try {
      JSON.parse(t);
      return 'json';
    } catch {
      /* not JSON */
    }
  }
  const lines = t.split('\n').slice(0, 200);
  if (lines.length >= 4) {
    if (lines.filter((l) => TABLE_ROW.test(l)).length / lines.length > 0.7) return 'table';
    const commas = lines.map((l) => (l.match(/,/g) ?? []).length);
    if (commas[0]! >= 2 && commas.filter((c) => c === commas[0]).length / lines.length > 0.8) return 'table';
    const tabs = lines.map((l) => (l.match(/\t/g) ?? []).length);
    if (tabs[0]! >= 1 && tabs.filter((c) => c === tabs[0]).length / lines.length > 0.8) return 'table';
    if (lines.filter((l) => LOG_LINE.test(l)).length / lines.length > 0.5) return 'log';
  }
  return 'prose';
}

// ---- Query terms ------------------------------------------------------------------------------------

const STOP = new Set('a an and are as at be by did do does for from had has have how i in is it its me my of on or our so than that the their them then there these they this to was we were what when where which who why will with you your about into over under can could would should'.split(' '));

export function queryTerms(query: string | undefined): string[] {
  if (!query) return [];
  return [...new Set(query.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').match(/[\p{L}\p{N}][\p{L}\p{N}'_-]{1,}/gu) ?? [])].filter((w) => !STOP.has(w) && w.length > 1).slice(0, 24);
}

function score(text: string, terms: readonly string[]): number {
  if (!terms.length) return 0;
  const t = text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '');
  let s = 0;
  for (const w of terms) if (t.includes(w)) s += 1 + Math.min(2, w.length / 6);
  return s;
}

// ---- Compressors ------------------------------------------------------------------------------------

export interface CompressOptions {
  /** Aim for about this many tokens (the result can be a little over). */
  targetTokens: number;
  /** The user's question: items and passages that mention it are kept. */
  query?: string;
}

export interface CompressResult {
  text: string;
  method: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}… (${s.length - n} more characters)` : s);

function compressJson(value: unknown, o: CompressOptions, terms: string[], depth = 0): unknown {
  if (typeof value === 'string') return clip(value, depth === 0 ? 4000 : 280);
  if (Array.isArray(value)) {
    const budgetItems = Math.max(3, Math.min(12, Math.floor(o.targetTokens / 60)));
    if (value.length <= budgetItems + 2) return value.map((v) => compressJson(v, o, terms, depth + 1));
    const keep = new Set<number>();
    for (let i = 0; i < Math.min(budgetItems, value.length); i++) keep.add(i);
    keep.add(value.length - 1);
    if (terms.length) {
      const ranked = value.map((v, i) => ({ i, s: score(JSON.stringify(v), terms) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i);
      for (const r of ranked.slice(0, budgetItems)) keep.add(r.i);
    }
    const idx = [...keep].sort((a, b) => a - b);
    const out: unknown[] = [];
    let last = -1;
    for (const i of idx) {
      if (i > last + 1) out.push(`… ${i - last - 1} more item${i - last - 1 === 1 ? '' : 's'} …`);
      out.push(compressJson(value[i], o, terms, depth + 1));
      last = i;
    }
    if (last < value.length - 1) out.push(`… ${value.length - 1 - last} more items …`);
    const fields = new Set<string>();
    for (const v of value.slice(0, 50)) if (v && typeof v === 'object' && !Array.isArray(v)) Object.keys(v).forEach((k) => fields.add(k));
    return fields.size ? { _shortened: `${value.length} items with fields ${[...fields].slice(0, 20).join(', ')}; showing ${idx.length}`, items: out } : out;
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, compressJson(v, o, terms, depth + 1)]));
  }
  return value;
}

function compressTable(text: string, o: CompressOptions, terms: string[]): string {
  const lines = text.split('\n');
  const isMd = TABLE_ROW.test(lines[0] ?? '');
  const head = lines.slice(0, isMd ? 2 : 1);
  const body = lines.slice(head.length).filter((l) => l.trim());
  const budgetRows = Math.max(5, Math.min(40, Math.floor(o.targetTokens / 25)));
  if (body.length <= budgetRows + 3) return text;
  const keep = new Set<number>();
  for (let i = 0; i < Math.ceil(budgetRows / 2); i++) keep.add(i);
  keep.add(body.length - 1);
  keep.add(body.length - 2);
  if (terms.length) {
    body.map((l, i) => ({ i, s: score(l, terms) })).filter((x) => x.s > 0).sort((a, b) => b.s - a.s || a.i - b.i).slice(0, budgetRows).forEach((x) => keep.add(x.i));
  }
  const out = [...head];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`… ${i - last - 1} rows …`);
    out.push(body[i]!);
    last = i;
  }
  out.push(`(${body.length} rows in all)`);
  return out.join('\n');
}

const normalizeLogLine = (l: string) => l.replace(/\d{4}-\d{2}-\d{2}[T ][\d:.,]+Z?/g, '<t>').replace(/0x[0-9a-f]+|\b[0-9a-f]{8,}\b/gi, '<h>').replace(/\d+/g, '<n>').trim();
const IMPORTANT = /\b(?:error|err|fail(?:ed|ure)?|fatal|exception|traceback|panic|warn(?:ing)?|denied|refused|timeout|timed out)\b/i;

function compressLog(text: string, o: CompressOptions, terms: string[]): string {
  const lines = text.split('\n');
  // 1. collapse runs of lines that differ only in numbers, times and hashes
  const runs: Array<{ line: string; count: number; idx: number }> = [];
  for (const [i, l] of lines.entries()) {
    const prev = runs[runs.length - 1];
    if (prev && normalizeLogLine(prev.line) === normalizeLogLine(l)) prev.count++;
    else runs.push({ line: l, count: 1, idx: i });
  }
  const budget = Math.max(20, Math.floor(o.targetTokens / 18));
  const keep = new Set<number>();
  for (let i = 0; i < Math.min(8, runs.length); i++) keep.add(i);
  for (let i = Math.max(0, runs.length - 12); i < runs.length; i++) keep.add(i);
  runs.forEach((r, i) => {
    if (IMPORTANT.test(r.line) || score(r.line, terms) > 0) for (let j = i - 2; j <= i + 2; j++) if (j >= 0 && j < runs.length) keep.add(j);
  });
  const idx = [...keep].sort((a, b) => a - b);
  // Too many important lines: keep the important ones themselves, dropping context first.
  const chosen = idx.length > budget ? idx.filter((i) => IMPORTANT.test(runs[i]!.line) || score(runs[i]!.line, terms) > 0 || i < 4 || i >= runs.length - 6).slice(0, budget) : idx;
  const out: string[] = [];
  let last = -1;
  for (const i of chosen) {
    if (i > last + 1) out.push(`… ${runs.slice(last + 1, i).reduce((a, r) => a + r.count, 0)} lines …`);
    const r = runs[i]!;
    out.push(r.count > 1 ? `${r.line}  [×${r.count} similar]` : r.line);
    last = i;
  }
  if (last < runs.length - 1) out.push(`… ${runs.slice(last + 1).reduce((a, r) => a + r.count, 0)} lines …`);
  return out.join('\n');
}

function compressProse(text: string, o: CompressOptions, terms: string[]): string {
  const paras = text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
  // One giant paragraph (a transcript): split into sentence groups instead.
  const blocks = paras.length >= 4 ? paras : (text.match(/[^.!?\n]+[.!?]+["')\]]*\s*|[^.!?\n]+$/g) ?? [text]).reduce<string[]>((acc, s, i) => {
    if (i % 4 === 0) acc.push(s.trim());
    else acc[acc.length - 1] += ` ${s.trim()}`;
    return acc;
  }, []);
  if (blocks.length <= 3) return clip(text, o.targetTokens * 4);
  const tokens = blocks.map(estimateTokens);
  const keep = new Set<number>([0, blocks.length - 1]);
  let used = tokens[0]! + tokens[blocks.length - 1]!;
  blocks.forEach((b, i) => {
    if (/^#{1,6}\s/.test(b) && used + Math.min(tokens[i]!, 20) <= o.targetTokens) {
      keep.add(i);
      used += tokens[i]!;
    }
  });
  const ranked = blocks.map((b, i) => ({ i, s: score(b, terms) })).filter((x) => x.s > 0 && !keep.has(x.i)).sort((a, b) => b.s - a.s || a.i - b.i);
  for (const r of ranked) {
    if (used + tokens[r.i]! > o.targetTokens) continue;
    keep.add(r.i);
    used += tokens[r.i]!;
  }
  // Fill what budget is left with the earliest remaining blocks (the start of a document carries the most).
  for (let i = 1; i < blocks.length && used < o.targetTokens * 0.8; i++) {
    if (keep.has(i) || used + tokens[i]! > o.targetTokens) continue;
    keep.add(i);
    used += tokens[i]!;
  }
  const out: string[] = [];
  let last = -1;
  for (const i of [...keep].sort((a, b) => a - b)) {
    if (i > last + 1) out.push(`[… ${i - last - 1} passage${i - last - 1 === 1 ? '' : 's'} left out …]`);
    out.push(clip(blocks[i]!, o.targetTokens * 4));
    last = i;
  }
  return out.join('\n\n');
}

/**
 * Lossless shortening only: trailing whitespace, runs of blank lines, and lines repeated
 * back-to-back (kept once with a count). Safe even when the model can't ask for the original.
 */
export function shortenLossless(text: string): string {
  const lines = text.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    let j = i + 1;
    while (j < lines.length && lines[j] === lines[i] && lines[i]!.trim()) j++;
    out.push(j - i > 2 ? `${lines[i]}  [repeated ${j - i}×]` : lines.slice(i, j).join('\n'));
    i = j;
  }
  return out.join('\n');
}

/** Shrinks one block by its shape. Returns null when the rules can't make it meaningfully smaller. */
export function compressContent(text: string, o: CompressOptions): CompressResult | null {
  const terms = queryTerms(o.query);
  const shape = detectShape(text);
  let out: string;
  if (shape === 'json') out = JSON.stringify(compressJson(JSON.parse(text.trim()), o, terms));
  else if (shape === 'table') out = compressTable(text, o, terms);
  else if (shape === 'log') out = compressLog(text, o, terms);
  else out = compressProse(shortenLossless(text), o, terms);
  if (estimateTokens(out) > estimateTokens(text) * 0.85) return null;
  return { text: out, method: shape };
}

// ---- The budgeter ------------------------------------------------------------------------------------

/** One block that was shortened in a request. */
export interface CompressionItem {
  ref: string;
  method: string;
  originalTokens: number;
  compressedTokens: number;
}

export interface BudgetOptions {
  /** Blocks under this many estimated tokens are left alone (policy `compression.minTokens`). */
  minTokens: number;
  /** Target size as a share of the original (default 0.25), never below `minTokens / 2`. */
  ratio?: number;
  /** Ceiling for a shortened block in tokens (default 2,000). */
  maxTokens?: number;
  /** Optional summarizer (a model on this device) for prose the rules shorten poorly. */
  summarize?: (text: string, targetTokens: number, query?: string) => Promise<string | null>;
}

export const RETRIEVE_TOOL_NAME = 'retrieve_original';

export const RETRIEVE_TOOL_DEF = {
  name: RETRIEVE_TOOL_NAME,
  description:
    'Returns the full original of a block that was shortened to save tokens (marked "Full text: retrieve_original ref …"). Pass the ref; pass a query to get only the parts that mention it.',
  parameters: {
    type: 'object',
    properties: {
      ref: { type: 'string', description: 'The ref from the shortened block.' },
      query: { type: 'string', description: 'Optional words to look for; only matching parts are returned.' },
    },
    required: ['ref'],
    additionalProperties: false,
  },
};

const MARK_RE = /\[Inkstone shortened this[^\]]*ref "([0-9a-f]{16})"[^\]]*\]/;

/** The ref of a block shortened by the budgeter, if `text` is one. */
export function shortenedRef(text: string): string | null {
  return MARK_RE.exec(text)?.[1] ?? null;
}

/**
 * Per-session budgeter: decides what to shorten in each request, remembers its decisions (so
 * every turn sends the same bytes) and which originals the model asked for (those go in full).
 */
export class ContextBudgeter {
  private decisions = new Map<string, { text: string; item: CompressionItem } | null>();
  readonly expanded = new Set<string>();

  constructor(readonly store: ContentStore, private o: BudgetOptions) {}

  /**
   * Shortens tool results (and long user-supplied context in tool-less requests, losslessly) in
   * `messages`. `canRetrieve` says whether the request offers tools — only then is lossy
   * shortening allowed, since the model must be able to ask for the original.
   */
  async apply(messages: ChatMessage[], opts: { canRetrieve: boolean; query?: string }): Promise<{ messages: ChatMessage[]; items: CompressionItem[] }> {
    const items: CompressionItem[] = [];
    const out: ChatMessage[] = [];
    // The final user message is the question; it is never shortened.
    const lastUser = messages.map((m) => m.role).lastIndexOf('user');
    for (const [i, m] of messages.entries()) {
      const eligible = m.role === 'tool' || (m.role === 'user' && i !== lastUser);
      if (!eligible) {
        out.push(m);
        continue;
      }
      if (typeof m.content === 'string') {
        const r = await this.block(m.content, opts, m.role === 'tool');
        if (r.item) items.push(r.item);
        out.push(r.text === m.content ? m : { ...m, content: r.text });
      } else {
        const parts: ContentPart[] = [];
        let changed = false;
        for (const p of m.content) {
          if (p.type !== 'text') {
            parts.push(p);
            continue;
          }
          const r = await this.block(p.text, opts, m.role === 'tool');
          if (r.item) items.push(r.item);
          changed ||= r.text !== p.text;
          parts.push(r.text === p.text ? p : { type: 'text', text: r.text });
        }
        out.push(changed ? { ...m, content: parts } : m);
      }
    }
    return { messages: out, items };
  }

  private async block(text: string, opts: { canRetrieve: boolean; query?: string }, isTool: boolean): Promise<{ text: string; item?: CompressionItem }> {
    const tokens = estimateTokens(text);
    if (tokens < this.o.minTokens || shortenedRef(text)) return { text };
    if (!opts.canRetrieve) {
      const s = shortenLossless(text);
      return s.length < text.length ? { text: s, item: { ref: '', method: 'lossless', originalTokens: tokens, compressedTokens: estimateTokens(s) } } : { text };
    }
    const ref = contentRef(text);
    if (this.expanded.has(ref)) return { text };
    // Decisions are per content (and question, since ranking uses it) and never change in a session.
    const key = `${ref}:${isTool ? 't' : 'u'}:${opts.query ?? ''}`;
    if (!this.decisions.has(key)) this.decisions.set(key, await this.decide(text, tokens, ref, opts.query));
    const d = this.decisions.get(key);
    return d ? { text: d.text, item: d.item } : { text };
  }

  private async decide(text: string, tokens: number, ref: string, query?: string): Promise<{ text: string; item: CompressionItem } | null> {
    const target = Math.max(Math.floor(this.o.minTokens / 2), Math.min(this.o.maxTokens ?? 2000, Math.floor(tokens * (this.o.ratio ?? 0.25))));
    let r = compressContent(text, { targetTokens: target, ...(query ? { query } : {}) });
    if (this.o.summarize && (!r || r.method === 'prose')) {
      const s = await this.o.summarize(text, target, query).catch(() => null);
      if (s && estimateTokens(s) < (r ? estimateTokens(r.text) : tokens * 0.85)) r = { text: s, method: 'summary' };
    }
    if (!r) return null;
    await this.store.put(text);
    const marked = `${r.text}\n[Inkstone shortened this from ~${tokens.toLocaleString('en-US')} to ~${estimateTokens(r.text).toLocaleString('en-US')} tokens to save cost. Full text: call ${RETRIEVE_TOOL_NAME} with ref "${ref}" (add a query to get only matching parts).]`;
    return { text: marked, item: { ref, method: r.method, originalTokens: tokens, compressedTokens: estimateTokens(marked) } };
  }

  /** Answers a `retrieve_original` call. With a query, only matching parts (with neighbours). */
  async retrieve(args: { ref?: unknown; query?: unknown }): Promise<{ ok: boolean; text: string }> {
    const ref = typeof args.ref === 'string' ? args.ref.trim().replace(/^"|"$/g, '') : '';
    const original = /^[0-9a-f]{16}$/.test(ref) ? await this.store.get(ref) : null;
    if (original == null) return { ok: false, text: `No original with ref "${ref}" is stored on this device. Answer from what you have.` };
    const terms = queryTerms(typeof args.query === 'string' ? args.query : undefined);
    if (!terms.length) {
      this.expanded.add(ref);
      return { ok: true, text: original };
    }
    if (detectShape(original) === 'json') {
      const matches: unknown[] = [];
      // Matching items of the innermost arrays (a note in a list, not the whole list).
      const walk = (v: unknown, depth: number) => {
        if (matches.length >= 200 || depth > 6) return;
        if (Array.isArray(v)) {
          for (const x of v) {
            const leaf = x === null || typeof x !== 'object' || !Object.values(x).some((y) => Array.isArray(y) && y.some((z) => z && typeof z === 'object'));
            if (leaf && score(JSON.stringify(x), terms) > 0) matches.push(x);
            else if (!leaf) walk(x, depth + 1);
          }
        } else if (v && typeof v === 'object') for (const x of Object.values(v)) walk(x, depth + 1);
      };
      walk(JSON.parse(original.trim()), 0);
      if (matches.length) return { ok: true, text: JSON.stringify({ matching: matches.length, items: matches }) };
    }
    const units = detectShape(original) === 'prose' ? original.split(/\n\s*\n/) : original.split('\n');
    const hits = new Set<number>();
    units.forEach((u, i) => {
      if (score(u, terms) > 0) for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < units.length) hits.add(j);
    });
    if (!hits.size) {
      this.expanded.add(ref);
      return { ok: true, text: `Nothing in the original mentions ${terms.join(', ')}; here it is in full:\n${original}` };
    }
    const sep = detectShape(original) === 'prose' ? '\n\n' : '\n';
    return { ok: true, text: [...hits].sort((a, b) => a - b).map((i) => units[i]).join(sep) };
  }
}
