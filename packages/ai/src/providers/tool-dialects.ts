import { extractJson } from '../json.ts';
import { validateArgs } from '../schema.ts';
import type { JsonSchema, ToolCall, ToolDef } from '../types.ts';
import { localCallId } from './common.ts';

/**
 * Tool calls written as text, in every dialect the models we run can produce.
 *
 * Small local models are trained on different function-calling formats, and when a runtime does
 * not parse them itself the raw syntax ends up in the reply. On a Razr Fold, Gemma 4 E2B through
 * LiteRT-LM answered a question with
 * `<|tool_call>call:tool_search_notes{query:{"query": "car budget"}}<tool_call|>` — Gemma's native
 * syntax, a `tool_` prefix the model invented, and the argument wrapped one level too deep. The
 * parser below reads all of these, repairs what it can against the tool's JSON Schema, and the
 * stream filter makes sure none of it is ever shown to the person.
 *
 * Dialects (each pinned by a test made from a real transcript, packages/ai/test/tool-dialects.test.ts):
 *  - `hermes`  — Qwen2.5/Qwen3, Granite, Hermes: `<tool_call>{"name": …, "arguments": {…}}</tool_call>`
 *  - `gemma`   — Gemma 4: `<|tool_call>call:name{key:<|"|>text<|"|>,n:3}<tool_call|>`;
 *                FunctionGemma: `<start_function_call>call:name{…}<end_function_call>`
 *  - `llama`   — Llama 3.1+: `<|python_tag|>{"name": …, "parameters": {…}}` and `<function=name>{…}</function>`
 *  - `mistral` — `[TOOL_CALLS][{"name": …, "arguments": {…}}]` and `[TOOL_CALLS]name[ARGS]{…}`
 *  - `json`    — a bare or fenced JSON object/array of `{name, arguments|parameters}` naming a known tool
 *  - `pythonic`— Llama 3.2 / Gemma 3 `tool_code`: `[search_notes(query="car budget")]` naming a known tool
 */
export type ToolDialect = 'hermes' | 'gemma' | 'llama' | 'mistral' | 'json' | 'pythonic';

export interface ParsedToolText {
  /** The prose with every tool-call span removed (never contains tool syntax). */
  text: string;
  toolCalls: ToolCall[];
  /** Which dialects were seen, in order (diagnostics, evals). */
  dialects: ToolDialect[];
  /** Tool-call spans that were recognised as such but could not be read (for a repair retry). */
  malformed: string[];
}

// ---- Relaxed values (Gemma's argument syntax, Python literals, sloppy JSON) -----------------------

const GEMMA_QUOTE = '<|"|>';

/**
 * Reads one value in a relaxed syntax that covers Gemma 4's argument encoding (`{key:<|"|>v<|"|>}`,
 * unquoted keys), Python literals (`'single'`, `True`, `None`, `key=value`) and plain JSON.
 * Returns the value and the index after it, or null when `src` has no value at `i`.
 */
export function readRelaxedValue(src: string, i = 0): { value: unknown; end: number } | null {
  const ws = (k: number) => {
    while (k < src.length && /\s/.test(src[k]!)) k++;
    return k;
  };
  i = ws(i);
  if (i >= src.length) return null;
  const c = src[i]!;
  if (src.startsWith(GEMMA_QUOTE, i)) {
    const end = src.indexOf(GEMMA_QUOTE, i + GEMMA_QUOTE.length);
    if (end < 0) return { value: src.slice(i + GEMMA_QUOTE.length), end: src.length };
    return { value: src.slice(i + GEMMA_QUOTE.length, end), end: end + GEMMA_QUOTE.length };
  }
  if (c === '"' || c === "'" || c === '“') {
    const close = c === '“' ? '”' : c;
    let out = '';
    let k = i + 1;
    for (; k < src.length; k++) {
      const ch = src[k]!;
      if (ch === '\\' && k + 1 < src.length) {
        const n = src[++k]!;
        out += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n === 'u' && /^[0-9a-fA-F]{4}$/.test(src.slice(k + 1, k + 5)) ? String.fromCharCode(parseInt(src.slice(k + 1, (k += 4) + 1), 16)) : n;
        continue;
      }
      if (ch === close) return { value: out, end: k + 1 };
      out += ch;
    }
    return { value: out, end: k };
  }
  if (c === '{') {
    const obj: Record<string, unknown> = {};
    let k = ws(i + 1);
    while (k < src.length && src[k] !== '}') {
      // Key: quoted, Gemma-quoted or a bare identifier.
      let key: string;
      if (src[k] === '"' || src[k] === "'" || src.startsWith(GEMMA_QUOTE, k)) {
        const kv = readRelaxedValue(src, k);
        if (!kv) break;
        key = String(kv.value);
        k = kv.end;
      } else {
        const m = /^[^\s:=,{}[\]]+/.exec(src.slice(k));
        if (!m) break;
        key = m[0];
        k += m[0].length;
      }
      k = ws(k);
      if (src[k] !== ':' && src[k] !== '=') break;
      const v = readRelaxedValue(src, k + 1);
      if (!v) break;
      obj[key] = v.value;
      k = ws(v.end);
      if (src[k] === ',') k = ws(k + 1);
    }
    return { value: obj, end: Math.min(src.length, k + 1) };
  }
  if (c === '[') {
    const arr: unknown[] = [];
    let k = ws(i + 1);
    while (k < src.length && src[k] !== ']') {
      const v = readRelaxedValue(src, k);
      if (!v || v.end <= k) break;
      arr.push(v.value);
      k = ws(v.end);
      if (src[k] === ',') k = ws(k + 1);
    }
    return { value: arr, end: Math.min(src.length, k + 1) };
  }
  const num = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?(?![\w.])/.exec(src.slice(i));
  if (num) return { value: Number(num[0]), end: i + num[0].length };
  const word = /^(true|false|null|True|False|None)(?![\w])/.exec(src.slice(i));
  if (word) return { value: word[1] === 'true' || word[1] === 'True' ? true : word[1] === 'false' || word[1] === 'False' ? false : null, end: i + word[1]!.length };
  // A bare word (some models leave strings unquoted): up to the next separator.
  const bare = /^[^,}\])\n]+/.exec(src.slice(i));
  if (!bare) return null;
  return { value: bare[0].trim(), end: i + bare[0].length };
}

/** Index just past the `{…}` / `(…)` span starting at `start` (aware of all three quote styles), or -1. */
function spanEnd(src: string, start: number): number {
  const open = src[start];
  const close = open === '{' ? '}' : open === '(' ? ')' : ']';
  let depth = 0;
  for (let k = start; k < src.length; k++) {
    if (src.startsWith(GEMMA_QUOTE, k)) {
      const e = src.indexOf(GEMMA_QUOTE, k + GEMMA_QUOTE.length);
      if (e < 0) return -1;
      k = e + GEMMA_QUOTE.length - 1;
      continue;
    }
    const ch = src[k];
    if (ch === '"' || ch === "'") {
      let j = k + 1;
      while (j < src.length && src[j] !== ch) j += src[j] === '\\' ? 2 : 1;
      k = j;
      continue;
    }
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return k + 1;
  }
  return -1;
}

// ---- Names and arguments --------------------------------------------------------------------------

const NAME_PREFIX = /^(?:tools?|functions?|default_api|api|call)[_.:]/i;

/**
 * Maps the name a model wrote to one of `tools`: exact, then case/separator-insensitive, then with
 * prefixes models like to invent (`tool_`, `functions.`, `default_api.`) removed. Without a tool
 * list the name is returned trimmed; null when it matches none of the tools.
 */
export function normalizeToolName(name: string, tools?: readonly Pick<ToolDef, 'name'>[]): string | null {
  const raw = name.trim().replace(/^["'`]|["'`]$/g, '');
  if (!tools) return raw || null;
  const key = (s: string) => s.toLowerCase().replace(/[-.\s]/g, '_');
  const byKey = new Map(tools.map((t) => [key(t.name), t.name]));
  let n = raw;
  for (let guard = 0; guard < 3; guard++) {
    const hit = tools.find((t) => t.name === n)?.name ?? byKey.get(key(n));
    if (hit) return hit;
    if (!NAME_PREFIX.test(n)) break;
    n = n.replace(NAME_PREFIX, '');
  }
  return null;
}

const WRAPPER_KEYS = ['arguments', 'parameters', 'args', 'input', 'params', 'kwargs'];

/**
 * Fixes the argument shapes small models get wrong, guided by the tool's schema: a needless
 * `{"arguments": {...}}` wrapper, a string argument wrapped in an object (`{query: {query: "x"}}`),
 * a list where one string is expected, then the schema's own coercions ("5" → 5). Returns the
 * repaired arguments and the validation errors that remain (the agent reports those to the model).
 */
export function repairArguments(args: Record<string, unknown>, schema: JsonSchema | undefined): { args: Record<string, unknown>; errors: string[] } {
  const props = (schema?.properties ?? {}) as Record<string, JsonSchema>;
  let a: Record<string, unknown> = { ...args };
  const keys = Object.keys(a);
  if (keys.length === 1 && WRAPPER_KEYS.includes(keys[0]!) && !(keys[0]! in props) && a[keys[0]!] && typeof a[keys[0]!] === 'object' && !Array.isArray(a[keys[0]!])) {
    a = { ...(a[keys[0]!] as Record<string, unknown>) };
  }
  for (const [k, p] of Object.entries(props)) {
    const v = a[k];
    const t = p.type;
    const wantsString = t === 'string' || (Array.isArray(t) && t.includes('string') && !t.includes('object'));
    if (!wantsString || v == null || typeof v !== 'object') continue;
    if (Array.isArray(v)) {
      if (v.every((x) => typeof x === 'string' || typeof x === 'number')) a[k] = v.join(', ');
      continue;
    }
    const inner = v as Record<string, unknown>;
    const vals = Object.values(inner);
    const own = inner[k];
    if (typeof own === 'string' || typeof own === 'number') a[k] = String(own);
    else if (vals.length === 1 && (typeof vals[0] === 'string' || typeof vals[0] === 'number')) a[k] = String(vals[0]);
  }
  // A single required string given as the whole argument object's only, differently named key.
  const required = (schema?.required as string[] | undefined) ?? [];
  if (required.length === 1 && !(required[0]! in a)) {
    const only = Object.entries(a);
    if (only.length === 1 && !(only[0]![0] in props) && typeof only[0]![1] === 'string') a = { [required[0]!]: only[0]![1] };
  }
  const v = validateArgs(schema, a);
  return { args: (v.value as Record<string, unknown>) ?? a, errors: v.errors };
}

function makeCall(rawName: string, args: unknown, tools: readonly ToolDef[] | undefined, strictNames: boolean): ToolCall | null {
  const name = normalizeToolName(rawName, tools);
  if (!name) {
    // Inside explicit tool-call markers an unknown name is still a call (the agent tells the model
    // which tools exist); in free text it is just text.
    if (strictNames || !rawName.trim()) return null;
    return { id: localCallId('ptc'), name: rawName.trim(), arguments: args && typeof args === 'object' && !Array.isArray(args) ? (args as Record<string, unknown>) : {} };
  }
  let obj: Record<string, unknown> = {};
  if (typeof args === 'string') {
    const parsed = extractJson(args) ?? readRelaxedValue(args)?.value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) obj = parsed as Record<string, unknown>;
    else if (args.trim()) obj = { value: args.trim() };
  } else if (args && typeof args === 'object' && !Array.isArray(args)) obj = args as Record<string, unknown>;
  const tool = tools?.find((t) => t.name === name);
  const repaired = tool ? repairArguments(obj, tool.parameters) : { args: obj, errors: [] };
  return { id: localCallId('ptc'), name, arguments: repaired.args };
}

/** `{name, arguments}` / `{function: {name, arguments}}` / `{tool_call: …}` → name + args. */
function fromJsonCall(v: unknown): { name: string; args: unknown } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const wrap of ['tool_call', 'function_call', 'function', 'call']) {
    const inner = o[wrap];
    if (inner && typeof inner === 'object' && !Array.isArray(inner) && typeof (inner as Record<string, unknown>).name === 'string') return fromJsonCall(inner);
  }
  const name = o.name ?? o.tool ?? o.tool_name ?? o.function;
  if (typeof name !== 'string') return null;
  const args = o.arguments ?? o.parameters ?? o.args ?? o.input ?? o.params ?? {};
  return { name, args };
}

/** `call:name{…}` (Gemma) or `name{…}` → name + relaxed args; null when it doesn't look like one. */
function fromGemmaBody(body: string): Array<{ name: string; args: unknown }> | null {
  const out: Array<{ name: string; args: unknown }> = [];
  let rest = body.trim();
  while (rest) {
    const m = /^(?:call\s*:\s*)?([A-Za-z_][\w.:-]*)\s*(?=[{(])/.exec(rest);
    if (!m) break;
    const start = m[0].length;
    const end = spanEnd(rest, start);
    const argSrc = end < 0 ? rest.slice(start) : rest.slice(start, end);
    const v = readRelaxedValue(rest[start] === '(' ? `{${argSrc.slice(1, end < 0 ? undefined : -1)}}` : argSrc);
    out.push({ name: m[1]!, args: v?.value ?? {} });
    if (end < 0) break;
    rest = rest.slice(end).replace(/^[\s,;]+/, '');
  }
  return out.length ? out : null;
}

/** `[a(x=1), b(y="z")]` or `a(x=1)` with known names → calls (Python keyword arguments). */
function fromPythonic(src: string, tools: readonly ToolDef[] | undefined): Array<{ name: string; args: unknown }> | null {
  if (!tools?.length) return null;
  let s = src.trim();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1).trim();
  const calls = fromGemmaBody(s);
  if (!calls || !calls.every((c) => normalizeToolName(c.name, tools))) return null;
  return calls;
}

// ---- The parser ---------------------------------------------------------------------------------

interface Span {
  start: number;
  end: number;
  dialect: ToolDialect;
  calls: Array<{ name: string; args: unknown }> | null;
  /** Explicit markers: unknown names still count as calls. */
  explicit: boolean;
}

const GEMMA_RE = /<\|tool_call\|?>([\s\S]*?)(?:<\|?\/?tool_call\|>|<\|tool_call\|?>|$)/g;
const FN_GEMMA_RE = /<start_function_call>([\s\S]*?)(?:<end_function_call>|$)/g;
const HERMES_RE = /<tool_call>([\s\S]*?)(?:<\/tool_call>|(?=<tool_call>)|$)/g;
const LLAMA_TAG_RE = /<\|python_tag\|>([\s\S]*?)(?:<\|eom_id\|>|<\|eot_id\|>|$)/g;
const LLAMA_FN_RE = /<function=([\w.:-]+)>([\s\S]*?)(?:<\/function>|$)/g;
const MISTRAL_RE = /\[TOOL_CALLS\]([\s\S]*?)(?=\[TOOL_CALLS\]|$)/g;
const FENCE_RE = /```[ \t]*(json|tool_code|tool_call|tool|python|)[ \t]*\n([\s\S]*?)(?:```|$)/g;

function jsonCalls(body: string): Array<{ name: string; args: unknown }> | null {
  const v = extractJson(body);
  const list = Array.isArray(v) ? v : [v];
  const calls = list.map(fromJsonCall).filter((c): c is { name: string; args: unknown } => !!c);
  return calls.length && calls.length === list.length ? calls : null;
}

/**
 * Finds every tool call in a model's text, in any supported dialect, and returns the remaining
 * prose. With `tools`, names are normalised to the real tool names and arguments are repaired
 * against each tool's schema; free-text forms (bare JSON, Python calls) only count when they name
 * one of the tools, so an answer that merely contains JSON stays an answer.
 */
export function parseToolCalls(text: string, tools?: readonly ToolDef[]): ParsedToolText {
  const spans: Span[] = [];
  const taken = (s: number, e: number) => spans.some((x) => s < x.end && e > x.start);
  const scan = (re: RegExp, dialect: ToolDialect, read: (m: RegExpExecArray) => Span['calls'], explicit = true) => {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) { re.lastIndex++; continue; }
      if (taken(m.index, m.index + m[0].length)) continue;
      spans.push({ start: m.index, end: m.index + m[0].length, dialect, calls: read(m), explicit });
    }
  };
  scan(GEMMA_RE, 'gemma', (m) => fromGemmaBody(m[1]!) ?? jsonCalls(m[1]!));
  scan(FN_GEMMA_RE, 'gemma', (m) => fromGemmaBody(m[1]!) ?? jsonCalls(m[1]!));
  scan(HERMES_RE, 'hermes', (m) => jsonCalls(m[1]!) ?? fromGemmaBody(m[1]!));
  scan(LLAMA_TAG_RE, 'llama', (m) => jsonCalls(m[1]!) ?? fromPythonic(m[1]!, tools));
  scan(LLAMA_FN_RE, 'llama', (m) => [{ name: m[1]!, args: extractJson(m[2]!) ?? readRelaxedValue(m[2]!)?.value ?? {} }]);
  scan(MISTRAL_RE, 'mistral', (m) => {
    const body = m[1]!.trim();
    const named = /^([A-Za-z_][\w.-]*)\[ARGS\]([\s\S]*)$/.exec(body);
    if (named) return [{ name: named[1]!, args: extractJson(named[2]!) ?? {} }];
    return jsonCalls(body);
  });
  // Fenced blocks: only when they hold calls to known tools (a JSON answer in a fence stays text).
  FENCE_RE.lastIndex = 0;
  for (let m = FENCE_RE.exec(text); m; m = FENCE_RE.exec(text)) {
    if (taken(m.index, m.index + m[0].length)) continue;
    const body = m[2]!;
    const lang = m[1]!;
    const calls = jsonCalls(body) ?? fromPythonic(body, tools);
    const known = calls?.every((c) => normalizeToolName(c.name, tools ?? []));
    if (calls && known) spans.push({ start: m.index, end: m.index + m[0].length, dialect: lang === 'json' || body.trim().startsWith('{') || body.trim().startsWith('[{') ? 'json' : 'pythonic', calls, explicit: false });
    else if ((lang === 'tool_code' || lang === 'tool_call' || lang === 'tool') && !calls) spans.push({ start: m.index, end: m.index + m[0].length, dialect: 'pythonic', calls: null, explicit: true });
  }
  // The whole reply is one bare call (JSON or Python), naming a known tool.
  if (!spans.length && tools?.length) {
    const t = text.trim();
    const calls = (t.startsWith('{') || t.startsWith('[{') ? jsonCalls(t) : null) ?? (/^\[?[A-Za-z_][\w.]*\(/.test(t) ? fromPythonic(t, tools) : null);
    if (calls && calls.every((c) => normalizeToolName(c.name, tools))) {
      const start = text.indexOf(t);
      spans.push({ start, end: start + t.length, dialect: t.startsWith('{') || t.startsWith('[{') ? 'json' : 'pythonic', calls, explicit: false });
    }
  }
  spans.sort((a, b) => a.start - b.start);
  const toolCalls: ToolCall[] = [];
  const malformed: string[] = [];
  const dialects: ToolDialect[] = [];
  let prose = '';
  let at = 0;
  for (const s of spans) {
    prose += text.slice(at, s.start);
    at = s.end;
    const made = (s.calls ?? []).map((c) => makeCall(c.name, c.args, tools, !s.explicit)).filter((c): c is ToolCall => !!c);
    if (made.length) {
      toolCalls.push(...made);
      if (!dialects.includes(s.dialect)) dialects.push(s.dialect);
    } else malformed.push(text.slice(s.start, s.end).slice(0, 400));
  }
  prose += text.slice(at);
  return { text: stripToolSyntax(prose), toolCalls, dialects, malformed };
}

/**
 * Last line of defence for display: removes control tokens and stray tool-call markers a model
 * may leave in prose (`<|…|>`, `<tool_call|>`, `</tool_call>`, `[TOOL_CALLS]`, `<|python_tag|>`).
 */
export function stripToolSyntax(text: string): string {
  return text
    .replace(/<\|?\/?(?:tool_call|tool_response|tool|function_call)\|?>/g, '')
    .replace(/<\/?(?:tool_call|tool_response|tool_result|start_function_call|end_function_call|function(?:=[^>]*)?)>/g, '')
    .replace(/\[TOOL_CALLS\]|\[ARGS\]/g, '')
    .replace(/<\|[a-z_]{1,24}\|>|<\|[a-z_]{1,24}>|<[a-z_]{1,24}\|>/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---- Streaming ----------------------------------------------------------------------------------

/** Markers after which everything is tool syntax (hidden for the rest of the turn). */
export const HARD_TOOL_MARKERS = ['<tool_call>', '<|tool_call>', '<|tool_call|>', '<start_function_call>', '<|python_tag|>', '<function=', '[TOOL_CALLS]'] as const;

/**
 * Streams prose through while holding back anything that is, or may become, tool syntax:
 *  - from a hard marker (any dialect) to the end of the turn;
 *  - a trailing partial marker (`<|tool_ca`) until the next delta says what it is;
 *  - a code fence until it closes (then shown, unless it held a tool call);
 *  - a reply that starts with `{` or `[` (a bare JSON / Python call) until the end.
 * `finish(clean)` then releases whatever of the final, parsed prose was held back, so the person
 * sees exactly `parseToolCalls(...).text` and never a raw call.
 */
export class ToolSyntaxStream {
  private pending = '';
  private emitted = '';
  private hidden = false;
  private holdAll = false;
  private seen = '';
  constructor(private emit: (s: string) => void, private tools?: readonly ToolDef[]) {}

  push(delta: string): void {
    this.seen += delta;
    if (this.hidden || this.holdAll) return;
    this.pending += delta;
    if (!this.emitted && !this.pending.trim()) return;
    if (!this.emitted && /^\s*[[{]/.test(this.pending)) {
      this.holdAll = true;
      return;
    }
    const hard = HARD_TOOL_MARKERS.map((m) => this.pending.indexOf(m)).filter((i) => i >= 0);
    const fence = this.pending.indexOf('```');
    const cut = Math.min(...hard, fence >= 0 ? fence : Infinity);
    if (cut !== Infinity) {
      this.out(this.pending.slice(0, cut));
      this.pending = this.pending.slice(cut);
      if (hard.includes(cut)) {
        this.hidden = true;
        return;
      }
      // A fence: wait for its end, then show it unless it is a tool call.
      const close = this.pending.indexOf('```', 3);
      if (close < 0) return;
      const block = this.pending.slice(0, close + 3);
      if (!parseToolCalls(block, this.tools).toolCalls.length) this.out(block);
      else {
        this.hidden = true;
        return;
      }
      this.pending = this.pending.slice(close + 3);
      return this.push('');
    }
    const keep = partialMarkerLength(this.pending);
    this.out(this.pending.slice(0, this.pending.length - keep));
    this.pending = this.pending.slice(this.pending.length - keep);
  }

  /** Ends the turn: emits what remains of `clean` (the parsed prose) beyond what was shown. */
  finish(clean?: string): void {
    const final = clean ?? parseToolCalls(this.seen, this.tools).text;
    // What was shown is a prefix of the raw text; the clean text may differ only in what was held.
    const shown = this.emitted.replace(/^\s+/, '');
    if (final.startsWith(shown.trimEnd())) {
      const rest = final.slice(shown.length).replace(shown.length && /\s$/.test(shown) ? /^\s+/ : /^$/, '');
      this.out(rest);
    }
    this.pending = '';
  }

  /** Everything the model wrote this turn. */
  get raw(): string {
    return this.seen;
  }

  private out(s: string) {
    if (!s) return;
    this.emitted += s;
    this.emit(s);
  }
}

/** Length of a suffix of `s` that is the start of some marker (or of a fence), else 0. */
function partialMarkerLength(s: string): number {
  const markers = [...HARD_TOOL_MARKERS, '```'];
  let best = 0;
  for (const m of markers) {
    for (let k = Math.min(m.length - 1, s.length); k > best; k--) {
      if (m.startsWith(s.slice(-k))) {
        best = k;
        break;
      }
    }
  }
  return best;
}
