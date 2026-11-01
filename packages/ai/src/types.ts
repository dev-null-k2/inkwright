/**
 * Provider-neutral chat types. Every provider adapter converts to and from these, so the agent
 * loop, skills and UI never see a vendor wire format.
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool';

export interface TextPart {
  type: 'text';
  text: string;
}

/** An inline image. `data` is base64 without a `data:` prefix. */
export interface ImagePart {
  type: 'image';
  mediaType: string;
  data: string;
}

export type ContentPart = TextPart | ImagePart;

/** A JSON Schema object (only the subset providers agree on is relied upon). */
export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  /** `^[a-zA-Z0-9_-]{1,64}$` — the intersection every provider accepts. */
  name: string;
  description: string;
  /** JSON Schema for the single object argument. */
  parameters: JsonSchema;
}

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
  /** Set when the model's argument text was not valid JSON (the agent reports it back). */
  invalidArguments?: string;
  /**
   * Opaque provider data that must be echoed back with this call on the next turn
   * (e.g. Gemini `thoughtSignature`). Persist it with the transcript.
   */
  providerData?: Record<string, unknown>;
}

export interface ChatMessage {
  role: Role;
  content: string | ContentPart[];
  /** Assistant turns: the tools the model asked to call. */
  toolCalls?: ToolCall[];
  /** Tool turns: the call this message answers. */
  toolCallId?: string;
  /** Tool turns: the tool's name (Gemini needs it; filled in from the call when missing). */
  name?: string;
  /** Tool turns: the result is an error message. */
  isError?: boolean;
}

export type ToolChoice = 'auto' | 'none' | 'required' | { name: string };

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  toolChoice?: ToolChoice;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** Ask for a JSON response (native JSON mode where the API has one, otherwise an instruction). */
  json?: boolean;
}

export type StopReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'other';

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export interface ChatResult {
  text: string;
  toolCalls: ToolCall[];
  usage?: Usage;
  stopReason: StopReason;
  /** The last raw response object/event (debugging only; shape is provider-specific). */
  raw?: unknown;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'done'; result: ChatResult };

export type StreamHandler = (e: StreamEvent) => void;

export interface ProviderCapabilities {
  vision: boolean;
  tools: boolean;
  streaming: boolean;
  /** `listModels()` is implemented. */
  listModels: boolean;
  /** Native JSON output mode. */
  json: boolean;
}

export interface ModelInfo {
  id: string;
  label?: string;
  contextWindow?: number;
  vision?: boolean;
}

export interface Provider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  /**
   * One model turn. With `onEvent` the response is streamed (text deltas as they arrive, each
   * tool call once its arguments are complete, then `done`); without it a plain request is made.
   */
  chat(req: ChatRequest, onEvent?: StreamHandler): Promise<ChatResult>;
  listModels?(signal?: AbortSignal): Promise<ModelInfo[]>;
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Transport options shared by every HTTP provider. */
export interface HttpOptions {
  /** Injected fetch (tests, Capacitor native HTTP to avoid CORS). Default: global fetch. */
  fetch?: FetchLike;
  /** Retries for 408/429/5xx (default 2). */
  maxRetries?: number;
  /** First backoff delay in ms (default 600, doubled each retry, plus jitter). */
  retryBaseMs?: number;
}

// ---- Helpers --------------------------------------------------------------------------------

export function textOf(content: string | ContentPart[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((p): p is TextPart => p.type === 'text')
    .map((p) => p.text)
    .join('');
}

export function partsOf(content: string | ContentPart[]): ContentPart[] {
  return typeof content === 'string' ? (content ? [{ type: 'text', text: content }] : []) : content;
}

export function hasImages(messages: ChatMessage[]): boolean {
  return messages.some((m) => typeof m.content !== 'string' && m.content.some((p) => p.type === 'image'));
}

export const textPart = (t: string): TextPart => ({ type: 'text', text: t });
/** Image part from base64 or a `data:` URL. */
export const imagePart = (mediaType: string, data: string): ImagePart => ({ type: 'image', mediaType, data: stripDataUrl(data) });

/** Accepts raw base64 or a `data:...;base64,` URL and returns the base64 payload. */
export function stripDataUrl(data: string): string {
  const m = /^data:[^;,]+;base64,/.exec(data);
  return m ? data.slice(m[0].length) : data;
}

export const DEFAULT_CAPABILITIES: ProviderCapabilities = { vision: true, tools: true, streaming: true, listModels: true, json: true };
