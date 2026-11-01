import { AIError, streamError } from '../errors.ts';
import { joinUrl, readJson, readSSE, safeJsonParse, send } from '../http.ts';
import {
  DEFAULT_CAPABILITIES,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type HttpOptions,
  type JsonSchema,
  type ModelInfo,
  type Provider,
  type ProviderCapabilities,
  type StopReason,
  type StreamHandler,
  type ToolCall,
  type ToolChoice,
  type Usage,
} from '../types.ts';
import { finish, localCallId, systemText, toolResultParts, withToolNames } from './common.ts';

export interface GeminiConfig extends HttpOptions {
  id?: string;
  label?: string;
  apiKey?: string;
  /** Default `https://generativelanguage.googleapis.com`. */
  baseUrl?: string;
  /** Default `v1beta`. */
  apiVersion?: string;
  headers?: Record<string, string>;
}

type GPart =
  | { text: string; thought?: boolean; thoughtSignature?: string }
  | { inlineData: { mimeType: string; data: string } }
  | { functionCall: { name: string; args: Record<string, unknown>; id?: string }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

interface GContent {
  role: 'user' | 'model';
  parts: GPart[];
}

const SCHEMA_KEYS = new Set(['type', 'format', 'description', 'nullable', 'enum', 'items', 'properties', 'required', 'anyOf', 'minimum', 'maximum', 'minItems', 'maxItems', 'minLength', 'maxLength', 'title', 'propertyOrdering']);

/** JSON Schema → the OpenAPI subset Gemini accepts (drops `additionalProperties`, `$schema`, …). */
export function toGeminiSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(k)) continue;
    if (k === 'type' && Array.isArray(v)) {
      const types = v.filter((t) => t !== 'null');
      out.type = types[0] ?? 'string';
      if (types.length < v.length) out.nullable = true;
    } else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v as Record<string, JsonSchema>).map(([pk, pv]) => [pk, toGeminiSchema(pv)]));
    } else if (k === 'items' && v && typeof v === 'object') {
      out.items = toGeminiSchema(v as JsonSchema);
    } else if (k === 'anyOf' && Array.isArray(v)) {
      out.anyOf = v.map((s) => toGeminiSchema(s as JsonSchema));
    } else if (k === 'enum' && Array.isArray(v)) {
      out.enum = v.map(String);
    } else out[k] = v;
  }
  return out;
}

function responseObject(m: ChatMessage): Record<string, unknown> {
  const t = toolResultParts(m)
    .filter((p) => p.type === 'text')
    .map((p) => (p as { text: string }).text)
    .join('\n');
  if (m.isError) return { error: t || 'Tool failed' };
  const v = safeJsonParse(t);
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  return { result: v !== undefined ? v : t };
}

/** Unified messages → Gemini `contents` + `systemInstruction`. */
export function toGeminiContents(messages: ChatMessage[]): { systemInstruction?: { parts: Array<{ text: string }> }; contents: GContent[] } {
  const msgs = withToolNames(messages);
  const calls = new Map<string, ToolCall>();
  for (const m of msgs) for (const c of m.toolCalls ?? []) calls.set(c.id, c);
  const contents: GContent[] = [];
  const push = (role: 'user' | 'model', parts: GPart[]) => {
    if (!parts.length) return;
    const last = contents[contents.length - 1];
    if (last && last.role === role) last.parts.push(...parts);
    else contents.push({ role, parts });
  };
  for (const m of msgs) {
    if (m.role === 'system') continue;
    if (m.role === 'user' || m.role === 'assistant') {
      const parts: GPart[] = [];
      for (const p of typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content) {
        if (p.type === 'text') {
          if (p.text) parts.push({ text: p.text });
        } else parts.push({ inlineData: { mimeType: p.mediaType, data: p.data } });
      }
      for (const c of m.toolCalls ?? []) {
        const pd = c.providerData ?? {};
        const fc: { name: string; args: Record<string, unknown>; id?: string } = { name: c.name, args: c.arguments ?? {} };
        if (typeof pd.geminiId === 'string') fc.id = pd.geminiId;
        const part: GPart = { functionCall: fc };
        if (typeof pd.thoughtSignature === 'string') (part as { thoughtSignature?: string }).thoughtSignature = pd.thoughtSignature;
        parts.push(part);
      }
      push(m.role === 'user' ? 'user' : 'model', parts);
    } else {
      const call = m.toolCallId ? calls.get(m.toolCallId) : undefined;
      const fr: { name: string; response: Record<string, unknown>; id?: string } = { name: m.name ?? call?.name ?? 'tool', response: responseObject(m) };
      const gid = call?.providerData?.geminiId;
      if (typeof gid === 'string') fr.id = gid;
      const parts: GPart[] = [{ functionResponse: fr }];
      for (const p of toolResultParts(m)) if (p.type === 'image') parts.push({ inlineData: { mimeType: p.mediaType, data: p.data } });
      push('user', parts);
    }
  }
  const sys = systemText(msgs);
  return { ...(sys ? { systemInstruction: { parts: [{ text: sys }] } } : {}), contents };
}

function toolConfigOf(c: ToolChoice | undefined): unknown {
  if (!c) return undefined;
  if (c === 'auto') return { functionCallingConfig: { mode: 'AUTO' } };
  if (c === 'none') return { functionCallingConfig: { mode: 'NONE' } };
  if (c === 'required') return { functionCallingConfig: { mode: 'ANY' } };
  return { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [c.name] } };
}

export function mapGeminiFinish(reason: string | undefined, hasTools: boolean): StopReason {
  if (hasTools) return 'tool_calls';
  switch (reason) {
    case undefined:
    case 'STOP':
    case 'FINISH_REASON_UNSPECIFIED':
      return 'stop';
    case 'MAX_TOKENS':
      return 'length';
    case 'SAFETY':
    case 'RECITATION':
    case 'BLOCKLIST':
    case 'PROHIBITED_CONTENT':
    case 'SPII':
    case 'IMAGE_SAFETY':
      return 'content_filter';
    case 'MALFORMED_FUNCTION_CALL':
      return 'error';
    default:
      return 'other';
  }
}

/** Google Gemini API (generativelanguage.googleapis.com). */
export class GeminiProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities = { ...DEFAULT_CAPABILITIES };
  private baseUrl: string;
  private version: string;

  constructor(readonly config: GeminiConfig) {
    this.id = config.id ?? 'gemini';
    this.label = config.label ?? 'Google Gemini';
    this.baseUrl = config.baseUrl ?? 'https://generativelanguage.googleapis.com';
    this.version = config.apiVersion ?? 'v1beta';
  }

  headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json' };
    if (this.config.apiKey) h['x-goog-api-key'] = this.config.apiKey;
    return { ...h, ...this.config.headers };
  }

  private url(path: string): string {
    const base = this.baseUrl.replace(/\/+$/, '').replace(new RegExp(`/${this.version}$`), '');
    return joinUrl(base, `${this.version}/${path}`);
  }

  chatUrl(model: string, stream: boolean): string {
    const m = encodeURIComponent(model.replace(/^models\//, '')).replace(/%2F/g, '/');
    return this.url(`models/${m}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`);
  }

  buildBody(req: ChatRequest): Record<string, unknown> {
    const { systemInstruction, contents } = toGeminiContents(req.messages);
    const body: Record<string, unknown> = { contents };
    if (systemInstruction) body.systemInstruction = systemInstruction;
    if (req.tools?.length) {
      body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: toGeminiSchema(t.parameters) })) }];
      const tc = toolConfigOf(req.toolChoice);
      if (tc) body.toolConfig = tc;
    }
    const gen: Record<string, unknown> = {};
    if (req.temperature !== undefined) gen.temperature = req.temperature;
    if (req.maxTokens !== undefined) gen.maxOutputTokens = req.maxTokens;
    // JSON mime type cannot be combined with function calling.
    if (req.json && !req.tools?.length) gen.responseMimeType = 'application/json';
    if (Object.keys(gen).length) body.generationConfig = gen;
    return body;
  }

  async chat(req: ChatRequest, onEvent?: StreamHandler): Promise<ChatResult> {
    const stream = !!onEvent;
    const url = this.chatUrl(req.model, stream);
    const res = await send({
      ...this.config,
      provider: this.id,
      label: this.label,
      url,
      signal: req.signal,
      init: { method: 'POST', headers: this.headers(), body: JSON.stringify(this.buildBody(req)) },
    });
    const state = { text: '', toolCalls: [] as ToolCall[], usage: undefined as Usage | undefined, finish: undefined as string | undefined, raw: undefined as unknown };
    if (!stream) {
      const data = await readJson(res, this.id);
      this.absorb(data, state);
    } else {
      for await (const msg of readSSE(res, { provider: this.id, label: this.label, url, signal: req.signal })) {
        const data = safeJsonParse(msg.data);
        if (data) this.absorb(data, state, onEvent);
      }
    }
    return finish({ text: state.text, toolCalls: state.toolCalls, usage: state.usage, stopReason: mapGeminiFinish(state.finish, state.toolCalls.length > 0), raw: state.raw }, onEvent);
  }

  private absorb(data: any, s: { text: string; toolCalls: ToolCall[]; usage?: Usage; finish?: string; raw: unknown }, onEvent?: StreamHandler) {
    s.raw = data;
    if (Array.isArray(data)) {
      for (const d of data) this.absorb(d, s, onEvent);
      return;
    }
    if (data?.error) throw streamError(this.id, this.label, data);
    if (data?.promptFeedback?.blockReason && !data.candidates?.length) {
      throw new AIError({ code: 'content_filter', provider: this.id, message: `${this.label} blocked this request (${data.promptFeedback.blockReason}).` });
    }
    const um = data?.usageMetadata;
    if (um) s.usage = { inputTokens: Number(um.promptTokenCount ?? 0), outputTokens: Number(um.candidatesTokenCount ?? 0) + Number(um.thoughtsTokenCount ?? 0) };
    const cand = data?.candidates?.[0];
    if (!cand) return;
    if (cand.finishReason) s.finish = cand.finishReason;
    for (const p of cand.content?.parts ?? []) {
      if (typeof p.text === 'string' && !p.thought) {
        if (!p.text) continue;
        s.text += p.text;
        onEvent?.({ type: 'text', delta: p.text });
      } else if (p.functionCall) {
        const providerData: Record<string, unknown> = {};
        if (p.functionCall.id) providerData.geminiId = p.functionCall.id;
        if (p.thoughtSignature) providerData.thoughtSignature = p.thoughtSignature;
        const call: ToolCall = { id: p.functionCall.id ?? localCallId('gemini'), name: p.functionCall.name, arguments: p.functionCall.args ?? {} };
        if (Object.keys(providerData).length) call.providerData = providerData;
        s.toolCalls.push(call);
        onEvent?.({ type: 'tool_call', call });
      }
    }
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    const out: ModelInfo[] = [];
    let token: string | undefined;
    for (let page = 0; page < 5; page++) {
      const url = this.url(`models?pageSize=1000${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`);
      const res = await send({ ...this.config, provider: this.id, label: this.label, url, signal, init: { method: 'GET', headers: this.headers() } });
      const data = await readJson(res, this.id);
      for (const m of data?.models ?? []) {
        const methods: string[] = m.supportedGenerationMethods ?? [];
        if (methods.length && !methods.includes('generateContent')) continue;
        const info: ModelInfo = { id: String(m.name ?? '').replace(/^models\//, ''), vision: true };
        if (m.displayName) info.label = m.displayName;
        if (typeof m.inputTokenLimit === 'number') info.contextWindow = m.inputTokenLimit;
        out.push(info);
      }
      token = data?.nextPageToken;
      if (!token) break;
    }
    return out;
  }
}
