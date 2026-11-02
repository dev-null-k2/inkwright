/**
 * The three wire formats the proxy understands, reduced to what it needs: the text blocks it may
 * shorten (tool results anywhere; earlier user text), the question (the latest user text), the
 * tools a request offers, and — when the proxy answers `retrieve_original` itself — reading the
 * model's calls, adding the results and turning a final answer back into a stream.
 *
 * - `openai-chat` — `POST /v1/chat/completions` (OpenAI and every OpenAI-compatible API).
 * - `openai-responses` — `POST /v1/responses` (Codex CLI and newer OpenAI clients). Shortened
 *   only losslessly, or lossily when the client itself offers `retrieve_original` (the Inkwright
 *   MCP server's tool): answering the call inside the proxy would mean replaying reasoning items,
 *   which stateless Responses requests can't do reliably.
 * - `anthropic` — `POST /v1/messages` (Claude Code, the Anthropic SDKs).
 */
import { RETRIEVE_TOOL_DEF, RETRIEVE_TOOL_NAME } from '@inkwright/ai';

export type Dialect = 'openai-chat' | 'openai-responses' | 'anthropic';

type J = Record<string, any>;
const isObj = (v: unknown): v is J => !!v && typeof v === 'object' && !Array.isArray(v);

/** A shortenable piece of text inside a request body, with a setter that writes it back. */
export interface Slot {
  text: string;
  /** A tool result (else earlier user-supplied text). */
  tool: boolean;
  set(text: string): void;
}

export function dialectOf(pathname: string): Dialect | null {
  if (/\/v1\/messages$/.test(pathname)) return 'anthropic';
  if (/\/v1\/chat\/completions$/.test(pathname)) return 'openai-chat';
  if (/\/v1\/responses$/.test(pathname)) return 'openai-responses';
  return null;
}

/** Text parts of a content value (string or blocks), each as a slot. */
function textSlots(holder: J, key: string, tool: boolean, textType: string[]): Slot[] {
  const v = holder[key];
  if (typeof v === 'string') return [{ text: v, tool, set: (t) => (holder[key] = t) }];
  if (!Array.isArray(v)) return [];
  return v.filter((p) => isObj(p) && textType.includes(p.type) && typeof p.text === 'string').map((p) => ({ text: p.text as string, tool, set: (t: string) => (p.text = t) }));
}

function lastUserIndex(messages: J[], isQuestion: (m: J) => boolean): number {
  for (let i = messages.length - 1; i >= 0; i--) if (isQuestion(messages[i]!)) return i;
  return -1;
}

const anthropicUserText = (m: J) => m.role === 'user' && (typeof m.content === 'string' || (Array.isArray(m.content) && m.content.some((b: J) => isObj(b) && b.type === 'text')));

/** Every shortenable block and the question, in request order. */
export function slotsOf(d: Dialect, body: J): { slots: Slot[]; question: string } {
  const slots: Slot[] = [];
  let question = '';
  if (d === 'openai-chat' && Array.isArray(body.messages)) {
    const msgs = body.messages as J[];
    const q = lastUserIndex(msgs, (m) => m.role === 'user');
    msgs.forEach((m, i) => {
      if (!isObj(m)) return;
      if (m.role === 'tool') slots.push(...textSlots(m, 'content', true, ['text']));
      else if (m.role === 'user' && i !== q) slots.push(...textSlots(m, 'content', false, ['text']));
    });
    if (q >= 0) question = textSlots(msgs[q]!, 'content', false, ['text']).map((s) => s.text).join('\n');
  } else if (d === 'anthropic' && Array.isArray(body.messages)) {
    const msgs = body.messages as J[];
    const q = lastUserIndex(msgs, anthropicUserText);
    msgs.forEach((m, i) => {
      if (!isObj(m) || m.role !== 'user') return;
      if (typeof m.content === 'string') {
        if (i !== q) slots.push(...textSlots(m, 'content', false, []));
        return;
      }
      if (!Array.isArray(m.content)) return;
      for (const b of m.content as J[]) {
        if (!isObj(b)) continue;
        if (b.type === 'tool_result') slots.push(...textSlots(b, 'content', true, ['text']));
        else if (b.type === 'text' && i !== q && typeof b.text === 'string') slots.push({ text: b.text, tool: false, set: (t) => (b.text = t) });
      }
    });
    if (q >= 0) {
      const m = msgs[q]!;
      question = typeof m.content === 'string' ? m.content : (m.content as J[]).filter((b) => isObj(b) && b.type === 'text').map((b) => String(b.text)).join('\n');
    }
  } else if (d === 'openai-responses') {
    const input = body.input;
    if (typeof input === 'string') return { slots, question: input };
    if (!Array.isArray(input)) return { slots, question };
    const items = input as J[];
    const isUser = (m: J) => (m.type === 'message' || m.type === undefined) && m.role === 'user';
    const q = lastUserIndex(items, isUser);
    items.forEach((it, i) => {
      if (!isObj(it)) return;
      if (it.type === 'function_call_output') {
        if (typeof it.output === 'string') slots.push({ text: it.output, tool: true, set: (t) => (it.output = t) });
        else slots.push(...textSlots(it, 'output', true, ['input_text', 'output_text']));
      } else if (isUser(it) && i !== q) slots.push(...textSlots(it, 'content', false, ['input_text']));
    });
    if (q >= 0) question = textSlots(items[q]!, 'content', false, ['input_text']).map((s) => s.text).join('\n');
  }
  return { slots, question };
}

function toolNames(d: Dialect, body: J): string[] {
  if (!Array.isArray(body.tools)) return [];
  return (body.tools as J[]).map((t) => (d === 'openai-chat' ? t?.function?.name : t?.name)).filter((n): n is string => typeof n === 'string');
}

export const hasTools = (d: Dialect, body: J) => toolNames(d, body).length > 0;

/** True when the client itself offers `retrieve_original` (it is connected to the Inkwright MCP server). */
export const declaresRetrieve = (d: Dialect, body: J) => toolNames(d, body).some((n) => n === RETRIEVE_TOOL_NAME || n.endsWith(`__${RETRIEVE_TOOL_NAME}`) || n.endsWith(`_${RETRIEVE_TOOL_NAME}`));

/** Adds the `retrieve_original` tool (the proxy answers calls to it). */
export function injectRetrieve(d: Dialect, body: J): void {
  const tools = Array.isArray(body.tools) ? (body.tools as J[]) : (body.tools = []);
  if (d === 'openai-chat') tools.push({ type: 'function', function: { name: RETRIEVE_TOOL_DEF.name, description: RETRIEVE_TOOL_DEF.description, parameters: RETRIEVE_TOOL_DEF.parameters } });
  else if (d === 'anthropic') tools.push({ name: RETRIEVE_TOOL_DEF.name, description: RETRIEVE_TOOL_DEF.description, input_schema: RETRIEVE_TOOL_DEF.parameters });
  else tools.push({ type: 'function', name: RETRIEVE_TOOL_DEF.name, description: RETRIEVE_TOOL_DEF.description, parameters: RETRIEVE_TOOL_DEF.parameters });
}

export interface ModelCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/** Tool calls in a (non-streamed) response. */
export function callsOf(d: Dialect, res: J): ModelCall[] {
  const parse = (s: unknown): Record<string, unknown> => {
    if (isObj(s)) return s;
    try {
      const v = JSON.parse(String(s ?? '{}'));
      return isObj(v) ? v : {};
    } catch {
      return {};
    }
  };
  if (d === 'openai-chat') return ((res.choices?.[0]?.message?.tool_calls ?? []) as J[]).map((c) => ({ id: String(c.id), name: String(c.function?.name), args: parse(c.function?.arguments) }));
  if (d === 'anthropic') return ((res.content ?? []) as J[]).filter((b) => b?.type === 'tool_use').map((b) => ({ id: String(b.id), name: String(b.name), args: parse(b.input) }));
  return ((res.output ?? []) as J[]).filter((b) => b?.type === 'function_call').map((b) => ({ id: String(b.call_id), name: String(b.name), args: parse(b.arguments) }));
}

/**
 * Continues the conversation after the proxy answered the model's `retrieve_original` calls:
 * the model's turn (only its text and those calls — other calls are dropped and the model makes
 * them again after reading) and the results.
 */
export function appendRetrieveRound(d: Dialect, body: J, res: J, results: Array<{ id: string; text: string }>): void {
  const ids = new Set(results.map((r) => r.id));
  if (d === 'openai-chat') {
    const m = { ...(res.choices?.[0]?.message ?? {}) } as J;
    m.tool_calls = ((m.tool_calls ?? []) as J[]).filter((c) => ids.has(String(c.id)));
    body.messages.push(m);
    for (const r of results) body.messages.push({ role: 'tool', tool_call_id: r.id, content: r.text });
  } else if (d === 'anthropic') {
    const content = ((res.content ?? []) as J[]).filter((b) => b?.type !== 'tool_use' || ids.has(String(b.id)));
    body.messages.push({ role: 'assistant', content });
    body.messages.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.text })) });
  } else {
    throw new Error('The proxy does not answer retrieve_original for the Responses API.');
  }
}

/** Token counts a response reports (input includes cached input). */
export function usageOf(d: Dialect, res: J): { input: number; output: number } | null {
  const u = res?.usage;
  if (!isObj(u)) return null;
  if (d === 'anthropic') return { input: (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0), output: u.output_tokens ?? 0 };
  if (d === 'openai-chat') return { input: u.prompt_tokens ?? 0, output: u.completion_tokens ?? 0 };
  return { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0 };
}

/**
 * Reads usage out of a streamed response as it passes through (OpenAI: the final chunk when the
 * client asked for `stream_options.include_usage`; Anthropic: `message_start` and
 * `message_delta`; Responses: `response.completed`).
 */
export class StreamUsage {
  input = 0;
  output = 0;
  model: string | null = null;
  seen = false;
  private buf = '';
  constructor(private d: Dialect) {}

  push(chunk: string): void {
    this.buf += chunk;
    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim();
      this.buf = this.buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let e: J;
      try {
        e = JSON.parse(data);
      } catch {
        continue;
      }
      if (this.d === 'anthropic') {
        if (e.type === 'message_start' && isObj(e.message)) {
          const u = usageOf('anthropic', e.message);
          if (u) { this.input = u.input; this.output = u.output; this.seen = true; }
          this.model ??= e.message.model ?? null;
        } else if (e.type === 'message_delta' && isObj(e.usage)) {
          this.output = e.usage.output_tokens ?? this.output;
          if (typeof e.usage.input_tokens === 'number') this.input = e.usage.input_tokens + (e.usage.cache_read_input_tokens ?? 0) + (e.usage.cache_creation_input_tokens ?? 0);
          this.seen = true;
        }
      } else if (this.d === 'openai-chat') {
        this.model ??= e.model ?? null;
        const u = usageOf('openai-chat', e);
        if (u) { this.input = u.input; this.output = u.output; this.seen = true; }
      } else if (e.type === 'response.completed' && isObj(e.response)) {
        const u = usageOf('openai-responses', e.response);
        if (u) { this.input = u.input; this.output = u.output; this.seen = true; }
        this.model ??= e.response.model ?? null;
      }
    }
  }
}

const sse = (event: string | null, data: unknown) => `${event ? `event: ${event}\n` : ''}data: ${JSON.stringify(data)}\n\n`;

/**
 * A final (non-streamed) response as the stream the client asked for. Used when the proxy had to
 * make the upstream call without streaming so it could answer `retrieve_original` first.
 */
export function responseToSse(d: Dialect, res: J, includeUsage = false): string {
  if (d === 'openai-chat') {
    const base = { id: res.id, object: 'chat.completion.chunk', created: res.created, model: res.model, ...(res.system_fingerprint ? { system_fingerprint: res.system_fingerprint } : {}) };
    const choice = res.choices?.[0] ?? {};
    const msg = choice.message ?? {};
    let out = sse(null, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] });
    if (typeof msg.content === 'string' && msg.content) out += sse(null, { ...base, choices: [{ index: 0, delta: { content: msg.content }, finish_reason: null }] });
    ((msg.tool_calls ?? []) as J[]).forEach((c, index) => {
      out += sse(null, { ...base, choices: [{ index: 0, delta: { tool_calls: [{ index, id: c.id, type: 'function', function: { name: c.function?.name, arguments: c.function?.arguments ?? '' } }] }, finish_reason: null }] });
    });
    out += sse(null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: choice.finish_reason ?? 'stop' }] });
    if (includeUsage && res.usage) out += sse(null, { ...base, choices: [], usage: res.usage });
    return `${out}data: [DONE]\n\n`;
  }
  if (d === 'anthropic') {
    let out = sse('message_start', { type: 'message_start', message: { ...res, content: [], stop_reason: null, stop_sequence: null, usage: { ...(res.usage ?? {}), output_tokens: 0 } } });
    ((res.content ?? []) as J[]).forEach((b, index) => {
      if (b.type === 'text') {
        out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'text', text: '' } });
        out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'text_delta', text: b.text } });
      } else if (b.type === 'tool_use') {
        out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: b.id, name: b.name, input: {} } });
        out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(b.input ?? {}) } });
      } else if (b.type === 'thinking') {
        out += sse('content_block_start', { type: 'content_block_start', index, content_block: { type: 'thinking', thinking: '' } });
        out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'thinking_delta', thinking: b.thinking } });
        if (b.signature) out += sse('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'signature_delta', signature: b.signature } });
      } else {
        out += sse('content_block_start', { type: 'content_block_start', index, content_block: b });
      }
      out += sse('content_block_stop', { type: 'content_block_stop', index });
    });
    out += sse('message_delta', { type: 'message_delta', delta: { stop_reason: res.stop_reason ?? 'end_turn', stop_sequence: res.stop_sequence ?? null }, usage: { output_tokens: res.usage?.output_tokens ?? 0 } });
    return out + sse('message_stop', { type: 'message_stop' });
  }
  throw new Error('No stream synthesis for the Responses API.');
}
