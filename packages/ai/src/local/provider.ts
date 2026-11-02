import { CallbackProvider } from '../providers/callback.ts';
import { JSON_INSTRUCTION } from '../providers/common.ts';
import { withPromptTools } from '../providers/prompt-tools.ts';
import type { ChatMessage, ChatRequest, Provider } from '../types.ts';
import type { LocalChatMessage, LocalEngine, ModelRef } from './protocol.ts';

/** Removes `<think>…</think>` reasoning blocks (an unclosed one at the end too). */
export function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').replace(/<think>[\s\S]*$/, '').trimStart();
}

/** Streams text through while hiding reasoning blocks, even when tags arrive split across deltas. */
export class ThinkFilter {
  private buf = '';
  private inside = false;
  private started = false;
  constructor(private emit: (s: string) => void) {}
  push(delta: string) {
    this.buf += delta;
    for (;;) {
      if (this.inside) {
        const end = this.buf.indexOf('</think>');
        if (end < 0) { this.buf = this.buf.slice(-8); return; }
        this.buf = this.buf.slice(end + 8).replace(/^\s+/, '');
        this.inside = false;
        continue;
      }
      const at = this.buf.indexOf('<think>');
      if (at >= 0) {
        this.out(this.buf.slice(0, at));
        this.buf = this.buf.slice(at + 7);
        this.inside = true;
        continue;
      }
      let keep = 0;
      for (let k = Math.min(6, this.buf.length); k > 0; k--) if ('<think>'.startsWith(this.buf.slice(-k))) { keep = k; break; }
      this.out(this.buf.slice(0, this.buf.length - keep));
      this.buf = this.buf.slice(this.buf.length - keep);
      return;
    }
  }
  end() {
    if (!this.inside) this.out(this.buf);
    this.buf = '';
  }
  private out(s: string) {
    if (!this.started) s = s.replace(/^\s+/, '');
    if (!s) return;
    this.started = true;
    this.emit(s);
  }
}

const textOfContent = (c: ChatMessage['content']) => (typeof c === 'string' ? c : c.map((p) => (p.type === 'text' ? p.text : '')).join(''));

/**
 * Fits a conversation into a small model's context: one system message first, strict
 * user/assistant alternation, and the oldest turns dropped (never the system prompt or the latest
 * question) when the estimate exceeds the budget. Text only — images are described as omitted.
 */
export function toLocalMessages(messages: ChatMessage[], opts: { budgetTokens: number; json?: boolean }): LocalChatMessage[] {
  const system = messages.filter((m) => m.role === 'system').map((m) => textOfContent(m.content)).filter((s) => s.trim());
  if (opts.json) system.push(JSON_INSTRUCTION);
  const turns: LocalChatMessage[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    let text = textOfContent(m.content);
    if (typeof m.content !== 'string' && m.content.some((p) => p.type === 'image')) text += '\n[An image was attached; this on-device model reads text only.]';
    const prev = turns[turns.length - 1];
    if (prev && prev.role === role) prev.content += `\n\n${text}`;
    else turns.push({ role, content: text });
  }
  if (!turns.length || turns[0]!.role !== 'user') turns.unshift({ role: 'user', content: '(start)' });
  const est = (s: string) => Math.ceil(s.length / 3.5);
  const sys = system.join('\n\n');
  let used = est(sys) + turns.reduce((a, t) => a + est(t.content), 0);
  while (used > opts.budgetTokens && turns.length > 1) {
    const dropped = turns.shift()!;
    used -= est(dropped.content);
    if (turns[0]?.role === 'assistant') used -= est(turns.shift()!.content);
  }
  // A single huge turn: keep its end (the question), trim the middle of the context.
  const last = turns[turns.length - 1]!;
  if (used > opts.budgetTokens && last) {
    const room = Math.max(400, (opts.budgetTokens - est(sys)) * 3.5);
    if (last.content.length > room) last.content = `${last.content.slice(0, room * 0.7)}\n…\n${last.content.slice(-room * 0.3)}`;
  }
  return sys ? [{ role: 'system', content: sys }, ...turns] : turns;
}

export interface LocalProviderOptions {
  id?: string;
  label?: string;
  /** The model's context window (tokens). */
  contextTokens?: number;
  /** Default answer length when the request sets none. */
  maxTokens?: number;
}

/**
 * The "On this device" provider: an open model running in the app's worker. Text in, streamed
 * text out; tool calling uses the `<tool_call>` text protocol, which is also the format Qwen3 and
 * Granite were trained on, so small local models call tools reliably.
 */
export function createLocalProvider(engine: LocalEngine, model: ModelRef, opts: LocalProviderOptions = {}): Provider {
  const context = opts.contextTokens ?? 8192;
  const inner = new CallbackProvider({
    id: opts.id ?? 'on-device',
    label: opts.label ?? 'On this device',
    capabilities: { vision: false, tools: false, streaming: true, listModels: false, json: false },
    handler: async (req: ChatRequest, emit) => {
      const maxTokens = Math.min(req.maxTokens ?? opts.maxTokens ?? 1024, Math.floor(context / 2));
      const messages = toLocalMessages(req.messages, { budgetTokens: context - maxTokens - 64, json: req.json });
      const filter = new ThinkFilter((s) => emit({ type: 'text', delta: s }));
      const r = await engine.generate(model, { messages, maxTokens, temperature: req.temperature }, (d) => filter.push(d), req.signal);
      filter.end();
      return { text: stripThinking(r.text).trim(), stopReason: r.stopReason, usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens } };
    },
  });
  return withPromptTools(inner);
}
