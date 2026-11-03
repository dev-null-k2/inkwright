import type { ChatMessage, ChatRequest, ChatResult, ContentPart, Provider, StreamHandler, ToolCall, ToolDef } from '../types.ts';
import { finish, withToolNames } from './common.ts';
import { parseToolCalls, ToolSyntaxStream } from './tool-dialects.ts';

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

/**
 * Extracts tool calls (every dialect in tool-dialects.ts, not only `<tool_call>` blocks) and the
 * remaining prose. Kept for callers that only need calls and text.
 */
export function parseToolCallText(text: string, tools?: ToolDef[]): { text: string; toolCalls: ToolCall[] } {
  const r = parseToolCalls(text, tools);
  return { text: r.text, toolCalls: r.toolCalls };
}

/** The message that asks a model to rewrite a tool call it got wrong (the one repair retry). */
export function toolRepairMessage(malformed: string[]): string {
  return [
    'Your last message tried to call a tool, but the call could not be read:',
    malformed.map((m) => m.slice(0, 200)).join('\n'),
    `Write the call again exactly in this form, with JSON inside: ${OPEN}{"name": "tool_name", "arguments": {"key": "value"}}${CLOSE}`,
    'Or, if no tool is needed, just answer.',
  ].join('\n');
}

function sumUsage(a?: ChatResult['usage'], b?: ChatResult['usage']): ChatResult['usage'] {
  if (!a) return b;
  if (!b) return a;
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

/**
 * Gives tool calling to a text-only provider: tools are described in the system prompt, the
 * model writes `<tool_call>{json}</tool_call>` blocks, and those are parsed back into ToolCalls.
 * Tool results are fed back as `<tool_result>` user turns. Works with any provider.
 *
 * Models trained on another dialect (Gemma 4, Llama, Mistral, bare JSON) are understood too
 * (tool-dialects.ts); their syntax never reaches the stream, and a call that cannot be read gets
 * one repair retry before the turn ends as prose.
 */
export function withPromptTools(inner: Provider, opts: { id?: string; label?: string } = {}): Provider {
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
      const stream = new ToolSyntaxStream((s) => onEvent?.({ type: 'text', delta: s }), tools);
      let r = await inner.chat(innerReq, onEvent ? (e) => (e.type === 'text' ? stream.push(e.delta) : undefined) : undefined);
      let parsed = tools.length ? parseToolCalls(r.text, tools) : { ...parseToolCalls(r.text), toolCalls: [] };
      if (tools.length && !parsed.toolCalls.length && parsed.malformed.length && !req.signal?.aborted) {
        // One repair retry: show the model what could not be read and the exact form to use.
        const retry: ChatRequest = { ...innerReq, messages: [...messages, { role: 'assistant', content: r.text }, { role: 'user', content: toolRepairMessage(parsed.malformed) }] };
        const again = await inner.chat(retry);
        const reparsed = parseToolCalls(again.text, tools);
        if (reparsed.toolCalls.length || !reparsed.malformed.length) {
          r = { ...again, usage: sumUsage(r.usage, again.usage) };
          parsed = reparsed;
        }
      }
      if (!parsed.toolCalls.length) stream.finish(parsed.text);
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
