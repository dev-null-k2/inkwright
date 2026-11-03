/**
 * The text tool protocol as it was before tool-dialects.ts (commit 8ccf6be): only Hermes
 * `<tool_call>{json}</tool_call>` blocks and bare JSON were understood. Kept verbatim so the
 * local-model evals can report "before" numbers against the same real model.
 */
import { extractJson } from '../src/json.ts';
import type { ChatMessage, ChatRequest, ChatResult, ContentPart, Provider, StreamHandler, ToolCall, ToolDef } from '../src/types.ts';
import { finish, localCallId, withToolNames } from '../src/providers/common.ts';

const OPEN = '<tool_call>';
const CLOSE = '</tool_call>';

export function toolProtocolInstructions(tools: ToolDef[], required = false): string {
  const list = tools
    .map((t) => `### ${t.name}\n${t.description}\nArguments (JSON Schema): ${JSON.stringify(t.parameters)}`)
    .join('\n\n');
  return [
    '# Tools',
    'You can call the tools below. To call one, write a block exactly like this (one block per call, JSON inside):',
    `${OPEN}{"name": "tool_name", "arguments": {"key": "value"}}${CLOSE}`,
    'After your tool calls, stop writing and wait: the results come back in <tool_result> blocks. You may call several tools at once.',
    required
      ? 'You must call at least one tool now.'
      : 'When you have everything you need, answer the user normally with no tool_call blocks. Never invent tool results.',
    '',
    list,
  ].join('\n');
}

/** Rewrites tool turns as plain text so text-only models can follow the conversation. */
export function renderToolTranscript(messages: ChatMessage[]): ChatMessage[] {
  const out: Array<ChatMessage & { fromTool?: boolean }> = [];
  for (const m of withToolNames(messages)) {
    if (m.role === 'assistant' && m.toolCalls?.length) {
      const base = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      const calls = m.toolCalls.map((c) => `${OPEN}${JSON.stringify({ name: c.name, arguments: c.arguments ?? {} })}${CLOSE}`).join('\n');
      out.push({ role: 'assistant', content: [base.trim(), calls].filter(Boolean).join('\n') });
    } else if (m.role === 'tool') {
      const parts: ContentPart[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
      const body = parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text).join('\n');
      const head = `<tool_result name="${m.name ?? 'tool'}"${m.isError ? ' error="true"' : ''}>`;
      const content: ContentPart[] = [{ type: 'text', text: `${head}\n${body || '(no output)'}\n</tool_result>` }, ...parts.filter((p) => p.type === 'image')];
      // Several results (or results then a user message) become one user turn, because some
      // APIs (Perplexity, older local servers) require strictly alternating roles.
      const prev = out[out.length - 1];
      if (prev?.role === 'user' && prev.fromTool) prev.content = [...(prev.content as ContentPart[]), { type: 'text', text: '\n' }, ...content];
      else out.push({ role: 'user', content, fromTool: true });
    } else {
      const prev = out[out.length - 1];
      if (m.role === 'user' && prev?.role === 'user' && prev.fromTool) {
        const extra: ContentPart[] = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
        prev.content = [...(prev.content as ContentPart[]), { type: 'text', text: '\n\n' }, ...extra];
      } else out.push({ role: m.role, content: m.content });
    }
  }
  return out.map(({ fromTool: _f, ...m }) => m);
}

/** Extracts `<tool_call>` blocks (closed, or one left open at the end) and the remaining prose. */
export function parseToolCallText(text: string, tools?: ToolDef[]): { text: string; toolCalls: ToolCall[] } {
  const calls: ToolCall[] = [];
  const known = tools ? new Set(tools.map((t) => t.name)) : undefined;
  const add = (body: string) => {
    const v = extractJson(body) as any;
    if (!v || typeof v !== 'object' || typeof v.name !== 'string') return false;
    let args = v.arguments ?? v.args ?? v.parameters ?? v.input ?? {};
    if (typeof args === 'string') args = (extractJson(args) as Record<string, unknown>) ?? {};
    calls.push({ id: localCallId('ptc'), name: v.name, arguments: args && typeof args === 'object' ? args : {} });
    return true;
  };
  let rest = text.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_m, body: string) => (add(body) ? '' : _m));
  const open = rest.lastIndexOf(OPEN);
  if (open >= 0 && add(rest.slice(open + OPEN.length))) rest = rest.slice(0, open);
  // Small models sometimes answer with a bare {"name", "arguments"} object.
  if (!calls.length && known) {
    const v = extractJson(text) as any;
    if (v && typeof v === 'object' && typeof v.name === 'string' && known.has(v.name) && ('arguments' in v || 'args' in v) && text.trim().startsWith('{')) {
      add(JSON.stringify(v));
      rest = '';
    }
  }
  return { text: rest.replace(/\n{3,}/g, '\n\n').trim(), toolCalls: calls };
}

/** Streams text deltas through, holding back anything that may be (part of) a tool_call block. */
class ToolTagFilter {
  private pending = '';
  private hidden = false;
  constructor(private emit: (s: string) => void) {}
  push(delta: string) {
    if (this.hidden) return;
    this.pending += delta;
    const at = this.pending.indexOf(OPEN);
    if (at >= 0) {
      this.out(this.pending.slice(0, at));
      this.pending = '';
      this.hidden = true;
      return;
    }
    // Keep a trailing partial "<tool_ca" until we know what it is.
    let keep = 0;
    for (let k = Math.min(OPEN.length - 1, this.pending.length); k > 0; k--) {
      if (OPEN.startsWith(this.pending.slice(-k))) {
        keep = k;
        break;
      }
    }
    this.out(this.pending.slice(0, this.pending.length - keep));
    this.pending = this.pending.slice(this.pending.length - keep);
  }
  end() {
    if (!this.hidden) this.out(this.pending);
    this.pending = '';
  }
  private out(s: string) {
    if (s) this.emit(s);
  }
}

/**
 * Gives tool calling to a text-only provider: tools are described in the system prompt, the
 * model writes `<tool_call>{json}</tool_call>` blocks, and those are parsed back into ToolCalls.
 * Tool results are fed back as `<tool_result>` user turns. Works with any provider.
 */
export function withLegacyPromptTools(inner: Provider, opts: { id?: string; label?: string } = {}): Provider {
  return {
    id: opts.id ?? inner.id,
    label: opts.label ?? inner.label,
    capabilities: { ...inner.capabilities, tools: true },
    listModels: inner.listModels?.bind(inner),
    async chat(req: ChatRequest, onEvent?: StreamHandler): Promise<ChatResult> {
      const tools = req.toolChoice === 'none' ? [] : (req.tools ?? []);
      let messages = renderToolTranscript(req.messages);
      if (tools.length) {
        const forced = req.toolChoice && typeof req.toolChoice === 'object' ? tools.filter((t) => t.name === (req.toolChoice as { name: string }).name) : tools;
        const instr = toolProtocolInstructions(forced.length ? forced : tools, req.toolChoice === 'required' || typeof req.toolChoice === 'object');
        messages = [{ role: 'system', content: instr }, ...messages];
      }
      const innerReq: ChatRequest = { ...req, messages, tools: undefined, toolChoice: undefined };
      const filter = new ToolTagFilter((s) => onEvent?.({ type: 'text', delta: s }));
      const r = await inner.chat(innerReq, onEvent ? (e) => (e.type === 'text' ? filter.push(e.delta) : undefined) : undefined);
      const parsed = tools.length ? parseToolCallText(r.text, tools) : { text: r.text, toolCalls: [] };
      if (parsed.toolCalls.length === 0) filter.end();
      for (const call of parsed.toolCalls) onEvent?.({ type: 'tool_call', call });
      const result: ChatResult = {
        text: parsed.text,
        toolCalls: parsed.toolCalls,
        stopReason: parsed.toolCalls.length ? 'tool_calls' : r.stopReason,
        raw: r.raw,
      };
      if (r.usage) result.usage = r.usage;
      return finish(result, onEvent);
    },
  };
}
