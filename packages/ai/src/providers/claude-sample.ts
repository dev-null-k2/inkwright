import { AIError, type AIErrorCode } from '../errors.ts';
import type { ChatMessage, ChatRequest, ImagePart, Provider } from '../types.ts';
import { CallbackProvider } from './callback.ts';
import { JSON_INSTRUCTION, systemText } from './common.ts';
import { withPromptTools } from './prompt-tools.ts';

/** Structural type of the claude.ai artifact `sample` function (`await claude.use("sample")`). */
export type ClaudeSampleFn = (
  input: string | Array<{ role: 'user' | 'assistant'; content: string }>,
  options?: {
    onText?: (u: { text: string; delta: string }) => void;
    signal?: AbortSignal;
    images?: Blob[];
    modelTier?: 'default' | 'complex' | 'quick' | 'inherit';
    model?: string;
    cache?: boolean;
  },
) => Promise<{ text: string; truncated?: boolean }>;

export interface ClaudeSampleProviderOptions {
  id?: string;
  label?: string;
  /** Tier used when the request's model is not a tier name or a `claude-…` id (default `default`). */
  modelTier?: 'default' | 'complex' | 'quick' | 'inherit';
  /** Whether this view may send images (`(await sample.limits()).images` is present). */
  images?: boolean;
}

const TIERS = new Set(['default', 'complex', 'quick', 'inherit']);

const SAMPLE_CODES: Record<string, { code: AIErrorCode; retryable?: boolean; message: string }> = {
  cancelled: { code: 'aborted', message: 'Request cancelled.' },
  rate_limited: { code: 'rate_limit', retryable: true, message: 'Claude is rate-limiting requests from Inkwright right now. Try again in a little while.' },
  not_granted: { code: 'permission', message: 'Claude access was not allowed for Inkwright. Allow it from the artifact’s permissions, or add an API key in Settings → AI.' },
  sampling_disabled: { code: 'permission', message: 'Claude is not available for this account.' },
  not_declared: { code: 'permission', message: 'Claude access is not enabled for this page.' },
  capability_disabled: { code: 'permission', message: 'Claude access is disabled in this view.' },
  capability_removed: { code: 'unsupported', message: 'This Claude app version cannot run this request.' },
  session_expired: { code: 'auth', message: 'Your Claude session expired. Sign in again.' },
  prompt_too_large: { code: 'context_length', message: 'That is too much text for one request. Use fewer or shorter notes.' },
  images_unavailable: { code: 'unsupported', message: 'Images cannot be sent to Claude from this view.' },
  image_rejected: { code: 'bad_request', message: 'Claude could not accept that image.' },
  refused: { code: 'content_filter', message: 'Claude declined this request.' },
  empty_completion: { code: 'unknown', message: 'Claude returned an empty answer. Try rephrasing.' },
  invalid_request: { code: 'bad_request', message: 'The request to Claude was malformed.' },
  transform_error: { code: 'bad_request', message: 'The request to Claude could not be prepared.' },
  upstream_error: { code: 'server', retryable: true, message: 'Claude had a temporary problem. Try again.' },
};

function sampleError(provider: string, e: unknown): AIError {
  const err = (e ?? {}) as { code?: string; message?: string };
  const m = SAMPLE_CODES[err.code ?? ''] ?? SAMPLE_CODES.upstream_error!;
  return new AIError({ code: m.code, provider, message: m.message, retryable: m.retryable, detail: err.message, cause: e });
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Unified messages (already tool-free) → sample turns: start and end on `user`, no system role. */
export function toSampleInput(messages: ChatMessage[], json = false): { turns: Array<{ role: 'user' | 'assistant'; content: string }>; images: ImagePart[] } {
  const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  let sys = systemText(messages);
  if (json) sys = sys ? `${sys}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION;
  if (sys) turns.push({ role: 'user', content: `Instructions for this conversation:\n${sys}` });
  const convo = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  let lastUser = -1;
  convo.forEach((m, i) => (m.role === 'user' ? (lastUser = i) : null));
  let images: ImagePart[] = [];
  convo.forEach((m, i) => {
    const parts = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
    let content = parts.map((p) => (p.type === 'text' ? p.text : '')).join('');
    const imgs = parts.filter((p): p is ImagePart => p.type === 'image');
    // `sample` attaches images to the final user turn only; earlier ones are summarized.
    if (imgs.length && i === lastUser) images = imgs;
    else if (imgs.length) content += `\n[${imgs.length} image(s) shown earlier]`;
    if (!content.trim()) content = imgs.length ? '(see the attached image)' : '';
    if (content.trim()) turns.push({ role: m.role as 'user' | 'assistant', content });
  });
  if (!turns.length || turns[turns.length - 1]!.role !== 'user') turns.push({ role: 'user', content: 'Continue.' });
  return { turns, images };
}

/**
 * Claude through the claude.ai artifact `sample` capability — no API key needed when Inkwright
 * runs as a claude.ai artifact. `sample` is text-in/text-out, so tool calling uses the prompt
 * protocol (`withPromptTools`) and the Inkwright agent loop keeps control of tools and
 * confirmations. Request `model` may be a tier (`quick`/`default`/`complex`) or a Claude model id.
 */
export function createClaudeSampleProvider(sample: ClaudeSampleFn, opts: ClaudeSampleProviderOptions = {}): Provider {
  const id = opts.id ?? 'claude-sample';
  const inner = new CallbackProvider({
    id,
    label: opts.label ?? 'Claude (built-in)',
    capabilities: { vision: opts.images ?? false, tools: false, streaming: true, listModels: true, json: false },
    listModels: async () => [
      { id: 'default', label: 'Claude — balanced' },
      { id: 'complex', label: 'Claude — most capable' },
      { id: 'quick', label: 'Claude — fastest' },
    ],
    handler: async (req: ChatRequest, emit) => {
      const { turns, images } = toSampleInput(req.messages, req.json);
      const options: NonNullable<Parameters<ClaudeSampleFn>[1]> = { cache: false, onText: ({ delta }) => emit({ type: 'text', delta }) };
      if (req.signal) options.signal = req.signal;
      if (TIERS.has(req.model)) options.modelTier = req.model as 'default';
      else {
        options.modelTier = opts.modelTier ?? 'default';
        if (/^claude-/.test(req.model)) options.model = req.model;
      }
      if (images.length && opts.images) options.images = images.map((p) => new Blob([base64ToBytes(p.data)], { type: p.mediaType }));
      const input = turns.length === 1 ? turns[0]!.content : turns;
      try {
        const r = await sample(input, options);
        return { text: r.text, stopReason: r.truncated ? 'length' : 'stop' };
      } catch (e) {
        throw sampleError(id, e);
      }
    },
  });
  return withPromptTools(inner);
}
