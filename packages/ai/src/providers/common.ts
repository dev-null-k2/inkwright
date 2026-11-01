import { extractJson } from '../json.ts';
import type { ChatMessage, ChatResult, ContentPart, StreamHandler, ToolCall } from '../types.ts';

/** Appended to the system prompt when JSON is requested from an API without a JSON mode. */
export const JSON_INSTRUCTION = 'Respond with only valid JSON — no prose, no code fences.';

/** Parses streamed/returned tool-argument text. Empty → {}. Repairs what it can. */
export function parseToolArguments(raw: string | undefined | null): { args: Record<string, unknown>; invalid?: string } {
  const s = (raw ?? '').trim();
  if (!s) return { args: {} };
  try {
    const v = JSON.parse(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v as Record<string, unknown> };
    return { args: {}, invalid: s };
  } catch {
    const v = extractJson(s);
    if (v && typeof v === 'object' && !Array.isArray(v)) return { args: v as Record<string, unknown> };
    return { args: {}, invalid: s };
  }
}

export function makeToolCall(id: string | undefined, name: string, rawArgs: string | Record<string, unknown> | undefined, fallbackId: string): ToolCall {
  const call: ToolCall = { id: id || fallbackId, name, arguments: {} };
  if (rawArgs && typeof rawArgs === 'object') call.arguments = rawArgs;
  else {
    const p = parseToolArguments(rawArgs);
    call.arguments = p.args;
    if (p.invalid !== undefined) call.invalidArguments = p.invalid;
  }
  return call;
}

/** Fills `name` on tool messages from the assistant call they answer (some APIs need it). */
export function withToolNames(messages: ChatMessage[]): ChatMessage[] {
  const names = new Map<string, string>();
  for (const m of messages) for (const c of m.toolCalls ?? []) names.set(c.id, c.name);
  return messages.map((m) => (m.role === 'tool' && !m.name && m.toolCallId && names.has(m.toolCallId) ? { ...m, name: names.get(m.toolCallId) } : m));
}

export function systemText(messages: ChatMessage[]): string {
  return messages
    .filter((m) => m.role === 'system')
    .map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('')))
    .filter((s) => s.trim())
    .join('\n\n');
}

export function toolResultParts(m: ChatMessage): ContentPart[] {
  if (typeof m.content === 'string') return [{ type: 'text', text: m.content }];
  return m.content;
}

export function finish(result: ChatResult, onEvent?: StreamHandler): ChatResult {
  onEvent?.({ type: 'done', result });
  return result;
}

let counter = 0;
/** Ids for providers that do not assign tool-call ids. */
export function localCallId(prefix = 'call'): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}`;
}
