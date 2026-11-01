import { streamError } from '../errors.ts';
import { joinUrl, readJson, readSSE, safeJsonParse, send } from '../http.ts';
import {
  DEFAULT_CAPABILITIES,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
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

export interface OpenAICompatibleConfig extends HttpOptions {
  id?: string;
  label?: string;
  /** e.g. `https://api.openai.com/v1` — `/chat/completions` and `/models` are appended. */
  baseUrl: string;
  apiKey?: string;
  /** Extra headers on every request (OpenRouter attribution, org ids, …). */
  headers?: Record<string, string>;
  /** How the key is sent: `Authorization: Bearer` (default) or Azure's `api-key` header. */
  auth?: 'bearer' | 'api-key' | 'none';
  /** Query parameters on every request (Azure `api-version`). */
  query?: Record<string, string>;
  /** Overrides the chat URL per model (Azure deployments). */
  chatUrl?: (model: string) => string;
  /** Models endpoint; `null` disables listModels. Default `${baseUrl}/models`. */
  modelsUrl?: string | null;
  capabilities?: Partial<ProviderCapabilities>;
  /** Send `stream_options.include_usage` (default true). */
  streamUsage?: boolean;
  /** `max_tokens` (default) or `max_completion_tokens` (OpenAI reasoning-era models). */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  /** Models that reject a custom temperature. */
  omitTemperature?: (model: string) => boolean;
  /** Merged into every request body. */
  extraBody?: Record<string, unknown>;
}

type OAIContent = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }> | null;

interface OAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: OAIContent;
  tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
  name?: string;
}

const dataUrl = (mediaType: string, data: string) => `data:${mediaType};base64,${data}`;

/** Converts unified messages to Chat Completions messages. */
export function toOpenAIMessages(messages: ChatMessage[], opts: { json?: boolean } = {}): OAIMessage[] {
  const out: OAIMessage[] = [];
  let system = systemText(messages);
  if (opts.json) system = system ? `${system}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION;
  if (system) out.push({ role: 'system', content: system });
  // Tool messages can only carry text; images they return are sent in a user turn right after
  // the run of tool messages (which must directly follow the assistant turn).
  let pendingImages: Array<{ type: 'image_url'; image_url: { url: string } }> = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    out.push({ role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, ...pendingImages] });
    pendingImages = [];
  };
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role !== 'tool') flushImages();
    if (m.role === 'user') {
      if (typeof m.content === 'string') out.push({ role: 'user', content: m.content });
      else
        out.push({
          role: 'user',
          content: m.content.map((p) => (p.type === 'text' ? { type: 'text' as const, text: p.text } : { type: 'image_url' as const, image_url: { url: dataUrl(p.mediaType, p.data) } })),
        });
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      const msg: OAIMessage = { role: 'assistant', content: text || (m.toolCalls?.length ? null : '') };
      if (m.toolCalls?.length) {
        msg.tool_calls = m.toolCalls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: c.invalidArguments ?? JSON.stringify(c.arguments ?? {}) } }));
      }
      out.push(msg);
    } else {
      const parts = toolResultParts(m);
      const texts = parts.filter((p) => p.type === 'text').map((p) => (p as { text: string }).text);
      const imgs = parts.filter((p) => p.type === 'image');
      for (const p of imgs) if (p.type === 'image') pendingImages.push({ type: 'image_url', image_url: { url: dataUrl(p.mediaType, p.data) } });
      let content = texts.join('\n');
      if (!content) content = imgs.length ? '(image attached below)' : '(no output)';
      if (m.isError && !/^error/i.test(content)) content = `Error: ${content}`;
      out.push({ role: 'tool', tool_call_id: m.toolCallId ?? '', content });
    }
  }
  flushImages();
  return out;
}

function toolChoiceOf(c: ToolChoice | undefined): unknown {
  if (!c) return undefined;
  if (typeof c === 'string') return c;
  return { type: 'function', function: { name: c.name } };
}

export function mapOpenAIFinish(reason: string | null | undefined, hasTools: boolean): StopReason {
  if (hasTools) return 'tool_calls';
  switch (reason) {
    case 'stop':
    case 'end_turn':
    case null:
    case undefined:
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      return 'tool_calls';
    case 'length':
    case 'max_tokens':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

function usageOf(u: any): Usage | undefined {
  if (!u || typeof u !== 'object') return undefined;
  return { inputTokens: Number(u.prompt_tokens ?? u.input_tokens ?? 0), outputTokens: Number(u.completion_tokens ?? u.output_tokens ?? 0) };
}

function contentText(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((p) => (typeof p === 'string' ? p : typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}

/** Any server speaking the OpenAI Chat Completions API. */
export class OpenAICompatibleProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;

  constructor(readonly config: OpenAICompatibleConfig) {
    this.id = config.id ?? 'openai-compatible';
    this.label = config.label ?? 'OpenAI-compatible';
    this.capabilities = { ...DEFAULT_CAPABILITIES, listModels: config.modelsUrl !== null, ...config.capabilities };
  }

  private withQuery(url: string): string {
    const q = this.config.query;
    if (!q || !Object.keys(q).length) return url;
    const u = new URL(url);
    for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
    return u.toString();
  }

  headers(stream = false): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (stream) h.accept = 'text/event-stream';
    const key = this.config.apiKey;
    const auth = this.config.auth ?? 'bearer';
    if (key && auth === 'bearer') h.authorization = `Bearer ${key}`;
    if (key && auth === 'api-key') h['api-key'] = key;
    return { ...h, ...this.config.headers };
  }

  chatUrl(model: string): string {
    return this.withQuery(this.config.chatUrl ? this.config.chatUrl(model) : joinUrl(this.config.baseUrl, 'chat/completions'));
  }

  buildBody(req: ChatRequest, stream: boolean): Record<string, unknown> {
    const c = this.config;
    const body: Record<string, unknown> = { model: req.model, messages: toOpenAIMessages(req.messages, { json: req.json }) };
    if (req.tools?.length && this.capabilities.tools) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      const tc = toolChoiceOf(req.toolChoice);
      if (tc !== undefined) body.tool_choice = tc;
    }
    if (req.temperature !== undefined && !c.omitTemperature?.(req.model)) body.temperature = req.temperature;
    if (req.maxTokens !== undefined) body[c.maxTokensField ?? 'max_tokens'] = req.maxTokens;
    if (req.json && this.capabilities.json) body.response_format = { type: 'json_object' };
    if (stream) {
      body.stream = true;
      if (c.streamUsage !== false) body.stream_options = { include_usage: true };
    }
    return { ...body, ...c.extraBody };
  }

  async chat(req: ChatRequest, onEvent?: StreamHandler): Promise<ChatResult> {
    const stream = !!onEvent && this.capabilities.streaming;
    const url = this.chatUrl(req.model);
    const res = await send({
      ...this.config,
      provider: this.id,
      label: this.label,
      url,
      signal: req.signal,
      init: { method: 'POST', headers: this.headers(stream), body: JSON.stringify(this.buildBody(req, stream)) },
    });
    // Some proxies/local servers ignore `stream: true` and answer with one JSON body.
    const jsonBody = (res.headers.get('content-type') ?? '').includes('application/json');
    if (!stream || jsonBody) {
      const data = await readJson(res, this.id);
      if (data?.error) throw streamError(this.id, this.label, data);
      const choice = data?.choices?.[0] ?? {};
      const msg = choice.message ?? {};
      const toolCalls: ToolCall[] = (msg.tool_calls ?? []).map((tc: any, i: number) =>
        makeToolCall(tc.id, tc.function?.name ?? '', tc.function?.arguments, localCallId(`call${i}`)),
      );
      const text = contentText(msg.content);
      const result: ChatResult = { text, toolCalls, usage: usageOf(data.usage), stopReason: mapOpenAIFinish(choice.finish_reason, toolCalls.length > 0), raw: data };
      if (onEvent) {
        if (text) onEvent({ type: 'text', delta: text });
        for (const call of toolCalls) onEvent({ type: 'tool_call', call });
      }
      return finish(result, onEvent);
    }
    return this.readStream(res, url, req.signal, onEvent);
  }

  private async readStream(res: Response, url: string, signal: AbortSignal | undefined, onEvent?: StreamHandler): Promise<ChatResult> {
    interface Slot { id?: string; name: string; args: string; argsObj?: Record<string, unknown> }
    const slots = new Map<number, Slot>();
    const byId = new Map<string, number>();
    let lastKey = -1;
    let text = '';
    let usage: Usage | undefined;
    let finishReason: string | null | undefined;
    let raw: unknown;
    for await (const msg of readSSE(res, { provider: this.id, label: this.label, url, signal })) {
      const payload = msg.data.trim();
      if (payload === '[DONE]') break;
      const chunk = safeJsonParse(payload) as any;
      if (!chunk) continue;
      raw = chunk;
      if (chunk.error || msg.event === 'error') throw streamError(this.id, this.label, chunk);
      if (chunk.usage) usage = usageOf(chunk.usage) ?? usage;
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = choice.delta ?? choice.message ?? {};
      const piece = contentText(delta.content);
      if (piece) {
        text += piece;
        onEvent?.({ type: 'text', delta: piece });
      }
      for (const tc of delta.tool_calls ?? []) {
        let key: number;
        if (typeof tc.index === 'number') key = tc.index;
        else if (tc.id && byId.has(tc.id)) key = byId.get(tc.id)!;
        else if (!tc.id && lastKey >= 0) key = lastKey;
        else key = slots.size ? Math.max(...slots.keys()) + 1 : 0;
        let slot = slots.get(key);
        if (!slot) slots.set(key, (slot = { name: '', args: '' }));
        if (tc.id) {
          slot.id = tc.id;
          byId.set(tc.id, key);
        }
        const name = tc.function?.name;
        if (name && (!slot.name || name.startsWith(slot.name))) slot.name = name;
        const a = tc.function?.arguments;
        if (typeof a === 'string') slot.args += a;
        else if (a && typeof a === 'object') slot.argsObj = a;
        lastKey = key;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
    const toolCalls = [...slots.entries()]
      .sort((a, b) => a[0] - b[0])
      .filter(([, s]) => s.name)
      .map(([k, s]) => makeToolCall(s.id, s.name, s.argsObj ?? s.args, localCallId(`call${k}`)));
    for (const call of toolCalls) onEvent?.({ type: 'tool_call', call });
    return finish({ text, toolCalls, usage, stopReason: mapOpenAIFinish(finishReason, toolCalls.length > 0), raw }, onEvent);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    if (this.config.modelsUrl === null) return [];
    const url = this.withQuery(this.config.modelsUrl ?? joinUrl(this.config.baseUrl, 'models'));
    const res = await send({ ...this.config, provider: this.id, label: this.label, url, signal, init: { method: 'GET', headers: this.headers() } });
    const data = await readJson(res, this.id);
    const list: any[] = Array.isArray(data) ? data : (data?.data ?? data?.models ?? []);
    return list
      .map((m): ModelInfo => {
        const info: ModelInfo = { id: String(m.id ?? m.name ?? m.model) };
        if (m.name && m.name !== info.id) info.label = String(m.name);
        const ctx = m.context_length ?? m.context_window ?? m.max_context_length;
        if (typeof ctx === 'number') info.contextWindow = ctx;
        const mods = m.architecture?.input_modalities;
        if (Array.isArray(mods)) info.vision = mods.includes('image');
        return info;
      })
      .filter((m) => m.id && m.id !== 'undefined')
      .sort((a, b) => a.id.localeCompare(b.id));
  }
}
