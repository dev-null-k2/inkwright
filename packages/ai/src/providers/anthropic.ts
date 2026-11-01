import { streamError } from '../errors.ts';
import { joinUrl, readJson, readSSE, safeJsonParse, send } from '../http.ts';
import {
  DEFAULT_CAPABILITIES,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ContentPart,
  type HttpOptions,
  type ModelInfo,
  type Provider,
  type ProviderCapabilities,
  type StopReason,
  type StreamHandler,
  type ToolCall,
  type ToolChoice,
  type Usage,
} from '../types.ts';
import { JSON_INSTRUCTION, finish, localCallId, makeToolCall, systemText, toolResultParts } from './common.ts';

export const ANTHROPIC_VERSION = '2023-06-01';

export interface AnthropicConfig extends HttpOptions {
  id?: string;
  label?: string;
  apiKey?: string;
  /** Default `https://api.anthropic.com` (`/v1/messages` is appended). */
  baseUrl?: string;
  headers?: Record<string, string>;
  /** `max_tokens` is required by the API; used when the request has none (default 4096). */
  defaultMaxTokens?: number;
  /** Send `anthropic-dangerous-direct-browser-access: true` (default true; needed for browser CORS). */
  browserAccess?: boolean;
}

type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
type TextBlock = { type: 'text'; text: string };
type Block =
  | TextBlock
  | ImageBlock
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'tool_result'; tool_use_id: string; content: Array<TextBlock | ImageBlock>; is_error?: boolean };

interface AMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

function partBlocks(parts: ContentPart[]): Array<TextBlock | ImageBlock> {
  const out: Array<TextBlock | ImageBlock> = [];
  for (const p of parts) {
    if (p.type === 'text') {
      if (p.text.trim()) out.push({ type: 'text', text: p.text });
    } else out.push({ type: 'image', source: { type: 'base64', media_type: p.mediaType, data: p.data } });
  }
  return out;
}

/** Unified messages → Messages API `system` + alternating user/assistant turns. */
export function toAnthropicMessages(messages: ChatMessage[]): { system: string; messages: AMessage[] } {
  const out: AMessage[] = [];
  const push = (role: 'user' | 'assistant', blocks: Block[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: blocks });
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'user') push('user', partBlocks(typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content));
    else if (m.role === 'assistant') {
      const blocks: Block[] = partBlocks(typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content).filter((b) => b.type === 'text');
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.arguments ?? {} });
      push('assistant', blocks);
    } else {
      let content = partBlocks(toolResultParts(m));
      if (!content.length) content = [{ type: 'text', text: '(no output)' }];
      const block: Block = { type: 'tool_result', tool_use_id: m.toolCallId ?? '', content };
      if (m.isError) block.is_error = true;
      push('user', [block]);
    }
  }
  if (out[0]?.role === 'assistant') out.unshift({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
  return { system: systemText(messages), messages: out };
}

function toolChoiceOf(c: ToolChoice | undefined): unknown {
  if (!c) return undefined;
  if (c === 'auto') return { type: 'auto' };
  if (c === 'required') return { type: 'any' };
  if (c === 'none') return { type: 'none' };
  return { type: 'tool', name: c.name };
}

export function mapAnthropicStop(reason: string | null | undefined, hasTools: boolean): StopReason {
  if (hasTools || reason === 'tool_use') return 'tool_calls';
  if (reason === 'max_tokens' || reason === 'model_context_window_exceeded') return 'length';
  if (reason === 'refusal') return 'content_filter';
  if (!reason || reason === 'end_turn' || reason === 'stop_sequence' || reason === 'pause_turn') return 'stop';
  return 'other';
}

function inputTokens(u: any): number {
  return Number(u?.input_tokens ?? 0) + Number(u?.cache_creation_input_tokens ?? 0) + Number(u?.cache_read_input_tokens ?? 0);
}

/** Anthropic Messages API (Claude). */
export class AnthropicProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities = { ...DEFAULT_CAPABILITIES, json: false };
  private baseUrl: string;

  constructor(readonly config: AnthropicConfig) {
    this.id = config.id ?? 'anthropic';
    this.label = config.label ?? 'Anthropic';
    this.baseUrl = config.baseUrl ?? 'https://api.anthropic.com';
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', 'anthropic-version': ANTHROPIC_VERSION };
    if (this.config.apiKey) h['x-api-key'] = this.config.apiKey;
    if (this.config.browserAccess !== false) h['anthropic-dangerous-direct-browser-access'] = 'true';
    return { ...h, ...this.config.headers };
  }

  private url(path: string): string {
    // Accept base URLs given with or without the `/v1` suffix.
    const base = this.baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');
    return joinUrl(base, `v1/${path}`);
  }

  buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const { system, messages } = toAnthropicMessages(req.messages);
    const sys = req.json ? (system ? `${system}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION) : system;
    const body: Record<string, unknown> = { model: req.model, max_tokens: req.maxTokens ?? this.config.defaultMaxTokens ?? 4096, messages };
    if (sys) body.system = sys;
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
      const tc = toolChoiceOf(req.toolChoice);
      if (tc) body.tool_choice = tc;
    }
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (stream) body.stream = true;
    return body;
  }

  async chat(req: ChatRequest, onEvent?: StreamHandler): Promise<ChatResult> {
    const stream = !!onEvent;
    const url = this.url('messages');
    const res = await send({
      ...this.config,
      provider: this.id,
      label: this.label,
      url,
      signal: req.signal,
      init: { method: 'POST', headers: { ...this.headers(), ...(stream ? { accept: 'text/event-stream' } : {}) }, body: JSON.stringify(this.buildBody(req, stream)) },
    });
    if (!stream) {
      const data = await readJson(res, this.id);
      if (data?.type === 'error') throw streamError(this.id, this.label, data);
      let text = '';
      const toolCalls: ToolCall[] = [];
      for (const b of data?.content ?? []) {
        if (b.type === 'text') text += b.text;
        else if (b.type === 'tool_use') toolCalls.push(makeToolCall(b.id, b.name, b.input ?? {}, localCallId('toolu')));
      }
      const usage = data?.usage ? { inputTokens: inputTokens(data.usage), outputTokens: Number(data.usage.output_tokens ?? 0) } : undefined;
      return finish({ text, toolCalls, usage, stopReason: mapAnthropicStop(data?.stop_reason, toolCalls.length > 0), raw: data });
    }
    return this.readStream(res, url, req.signal, onEvent!);
  }

  private async readStream(res: Response, url: string, signal: AbortSignal | undefined, onEvent: StreamHandler): Promise<ChatResult> {
    interface Slot { type: string; id?: string; name?: string; json: string; input?: Record<string, unknown>; done?: boolean }
    const blocks = new Map<number, Slot>();
    const toolCalls: ToolCall[] = [];
    let text = '';
    const usage: Usage = { inputTokens: 0, outputTokens: 0 };
    let sawUsage = false;
    let stop: string | null | undefined;
    let raw: unknown;
    const closeTool = (slot: Slot) => {
      if (slot.type !== 'tool_use' || slot.done) return;
      slot.done = true;
      const call = makeToolCall(slot.id, slot.name ?? '', slot.json ? slot.json : (slot.input ?? {}), localCallId('toolu'));
      toolCalls.push(call);
      onEvent({ type: 'tool_call', call });
    };
    for await (const msg of readSSE(res, { provider: this.id, label: this.label, url, signal })) {
      const data = safeJsonParse(msg.data) as any;
      if (!data) continue;
      raw = data;
      const type = data.type ?? msg.event;
      if (type === 'error') throw streamError(this.id, this.label, data);
      if (type === 'message_start') {
        const u = data.message?.usage;
        if (u) {
          sawUsage = true;
          usage.inputTokens = inputTokens(u);
          usage.outputTokens = Number(u.output_tokens ?? 0);
        }
      } else if (type === 'content_block_start') {
        const cb = data.content_block ?? {};
        const slot: Slot = { type: cb.type, json: '' };
        if (cb.type === 'tool_use') {
          slot.id = cb.id;
          slot.name = cb.name;
          slot.input = cb.input && Object.keys(cb.input).length ? cb.input : undefined;
        } else if (cb.type === 'text' && cb.text) {
          text += cb.text;
          onEvent({ type: 'text', delta: cb.text });
        }
        blocks.set(data.index ?? blocks.size, slot);
      } else if (type === 'content_block_delta') {
        const d = data.delta ?? {};
        if (d.type === 'text_delta' && d.text) {
          text += d.text;
          onEvent({ type: 'text', delta: d.text });
        } else if (d.type === 'input_json_delta') {
          const slot = blocks.get(data.index);
          if (slot) slot.json += d.partial_json ?? '';
        }
      } else if (type === 'content_block_stop') {
        const slot = blocks.get(data.index);
        if (slot) closeTool(slot);
      } else if (type === 'message_delta') {
        if (data.delta?.stop_reason) stop = data.delta.stop_reason;
        if (data.usage) {
          sawUsage = true;
          if (data.usage.output_tokens != null) usage.outputTokens = Number(data.usage.output_tokens);
          if (data.usage.input_tokens != null) usage.inputTokens = inputTokens(data.usage);
        }
      } else if (type === 'message_stop') {
        break;
      }
    }
    for (const slot of blocks.values()) closeTool(slot);
    return finish({ text, toolCalls, usage: sawUsage ? usage : undefined, stopReason: mapAnthropicStop(stop, toolCalls.length > 0), raw }, onEvent);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let after: string | undefined;
    for (let page = 0; page < 5; page++) {
      const url = this.url(`models?limit=1000${after ? `&after_id=${encodeURIComponent(after)}` : ''}`);
      const res = await send({ ...this.config, provider: this.id, label: this.label, url, signal, init: { method: 'GET', headers: this.headers() } });
      const data = await readJson(res, this.id);
      for (const m of data?.data ?? []) out.push({ id: m.id, label: m.display_name ?? undefined, vision: true });
      if (!data?.has_more || !data?.last_id) break;
      after = data.last_id;
    }
    return out;
  }
}
