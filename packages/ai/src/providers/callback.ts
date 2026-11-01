import { AIError, abortError, isAbortLike } from '../errors.ts';
import {
  DEFAULT_CAPABILITIES,
  type ChatRequest,
  type ChatResult,
  type ModelInfo,
  type Provider,
  type ProviderCapabilities,
  type StreamHandler,
  type ToolCall,
} from '../types.ts';
import { finish, localCallId } from './common.ts';

/**
 * The function a CallbackProvider wraps. It may stream through `emit` (text deltas, tool calls)
 * and/or return the final answer: a string, or a partial ChatResult.
 */
export type CallbackHandler = (req: ChatRequest, emit: StreamHandler) => Promise<string | Partial<ChatResult>> | string | Partial<ChatResult>;

export interface CallbackProviderOptions {
  id?: string;
  label?: string;
  capabilities?: Partial<ProviderCapabilities>;
  handler: CallbackHandler;
  listModels?: (signal?: AbortSignal) => Promise<ModelInfo[]>;
}

/**
 * A provider backed by any async function: the claude.ai artifact `sample` capability (see
 * `createClaudeSampleProvider`), an on-device model, a server proxy, or a scripted fake in tests.
 * Normalizes whatever the handler returns into a ChatResult and makes sure the stream events
 * (text, tool_call, done) are emitted exactly once each.
 */
export class CallbackProvider implements Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  private handler: CallbackHandler;
  private models?: (signal?: AbortSignal) => Promise<ModelInfo[]>;

  constructor(opts: CallbackProviderOptions) {
    this.id = opts.id ?? 'callback';
    this.label = opts.label ?? 'Custom function';
    this.handler = opts.handler;
    this.models = opts.listModels;
    this.capabilities = { ...DEFAULT_CAPABILITIES, listModels: !!opts.listModels, ...opts.capabilities };
  }

  async chat(req: ChatRequest, onEvent?: StreamHandler): Promise<ChatResult> {
    if (req.signal?.aborted) throw abortError(this.id, req.signal.reason);
    let streamed = '';
    let sawText = false;
    const emittedCalls = new Set<string>();
    const emit: StreamHandler = (e) => {
      if (req.signal?.aborted) return;
      if (e.type === 'done') return; // we emit done ourselves
      if (e.type === 'text') {
        if (!e.delta) return;
        sawText = true;
        streamed += e.delta;
      } else emittedCalls.add(e.call.id);
      onEvent?.(e);
    };
    let out: string | Partial<ChatResult>;
    try {
      out = await this.handler(req, emit);
    } catch (e) {
      if (isAbortLike(e, req.signal)) throw abortError(this.id, e);
      if (e instanceof AIError) throw e;
      throw new AIError({ code: 'unknown', provider: this.id, message: `${this.label} failed: ${(e as Error)?.message ?? String(e)}`, cause: e });
    }
    if (req.signal?.aborted) throw abortError(this.id, req.signal.reason);
    const r: Partial<ChatResult> = typeof out === 'string' ? { text: out } : (out ?? {});
    const text = r.text ?? streamed;
    if (!sawText && text) onEvent?.({ type: 'text', delta: text });
    const toolCalls: ToolCall[] = (r.toolCalls ?? []).map((c, i) => ({ ...c, id: c.id || localCallId(`cb${i}`), arguments: c.arguments ?? {} }));
    for (const call of toolCalls) if (!emittedCalls.has(call.id)) onEvent?.({ type: 'tool_call', call });
    const result: ChatResult = { text, toolCalls, stopReason: r.stopReason ?? (toolCalls.length ? 'tool_calls' : 'stop') };
    if (r.usage) result.usage = r.usage;
    if (r.raw !== undefined) result.raw = r.raw;
    return finish(result, onEvent);
  }

  async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
    return this.models ? this.models(signal) : [];
  }
}
