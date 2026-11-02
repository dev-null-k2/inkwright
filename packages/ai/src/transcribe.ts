/**
 * Speech to text for talking to the assistant. `Transcriber` is the seam: the app picks the
 * browser's Web Speech API when present, otherwise a transcriber for the configured provider
 * (OpenAI, Groq and other OpenAI-compatible `/audio/transcriptions` endpoints, or Gemini). An
 * on-device engine (e.g. Whisper in WASM or a native plugin) only has to implement this interface.
 */
import { AIError } from './errors.ts';
import { joinUrl, readJson, send } from './http.ts';
import type { FetchLike, HttpOptions } from './types.ts';

export interface TranscribeOptions {
  /** BCP-47 or ISO-639-1 language of the speech ("en-US", "de"). */
  language?: string;
  /** Words likely to appear (names, jargon) to improve accuracy. */
  prompt?: string;
  signal?: AbortSignal;
}

export interface Transcriber {
  readonly id: string;
  readonly label: string;
  /** Runs on this device (no audio leaves it). */
  readonly onDevice?: boolean;
  transcribe(audio: Blob, opts?: TranscribeOptions): Promise<string>;
}

export interface HttpTranscriberConfig extends HttpOptions {
  apiKey?: string;
  baseUrl: string;
  model: string;
  /** Provider id for error messages. */
  provider: string;
  label: string;
}

const lang2 = (l?: string) => (l ? l.toLowerCase().split(/[-_]/)[0] : undefined);

function extFor(type: string): string {
  if (type.includes('webm')) return 'webm';
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mp4') || type.includes('m4a') || type.includes('aac')) return 'm4a';
  if (type.includes('mpeg') || type.includes('mp3')) return 'mp3';
  if (type.includes('wav')) return 'wav';
  return 'webm';
}

/** OpenAI-style `POST /audio/transcriptions` (OpenAI, Groq, and compatible local servers). */
export function createOpenAITranscriber(c: HttpTranscriberConfig): Transcriber {
  return {
    id: `${c.provider}:${c.model}`,
    label: `${c.label} · ${c.model}`,
    async transcribe(audio, opts = {}) {
      const form = new FormData();
      form.append('file', audio, `speech.${extFor(audio.type)}`);
      form.append('model', c.model);
      form.append('response_format', 'json');
      const l = lang2(opts.language);
      if (l) form.append('language', l);
      if (opts.prompt) form.append('prompt', opts.prompt.slice(0, 800));
      const headers: Record<string, string> = {};
      if (c.apiKey) headers.authorization = `Bearer ${c.apiKey}`;
      const res = await send({ ...c, provider: c.provider, label: c.label, url: joinUrl(c.baseUrl, 'audio/transcriptions'), init: { method: 'POST', headers, body: form }, signal: opts.signal });
      const j = await readJson(res, c.provider);
      if (typeof j?.text !== 'string') throw new AIError({ code: 'parse', provider: c.provider, message: `${c.label} returned no transcription.` });
      return j.text.trim();
    },
  };
}

async function toBase64(b: Blob): Promise<string> {
  const bytes = new Uint8Array(await b.arrayBuffer());
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Gemini `generateContent` with the audio inline. */
export function createGeminiTranscriber(c: HttpTranscriberConfig): Transcriber {
  return {
    id: `gemini:${c.model}`,
    label: `${c.label} · ${c.model}`,
    async transcribe(audio, opts = {}) {
      const base = c.baseUrl.replace(/\/+$/, '').replace(/\/v1(beta)?$/, '');
      const url = `${base}/v1beta/models/${encodeURIComponent(c.model)}:generateContent`;
      const instruction = `Transcribe this speech exactly as spoken${opts.language ? ` (language: ${opts.language})` : ''}. Output only the transcription, no commentary.${opts.prompt ? ` Words that may appear: ${opts.prompt.slice(0, 400)}` : ''}`;
      const body = {
        contents: [{ role: 'user', parts: [{ text: instruction }, { inline_data: { mime_type: (audio.type || 'audio/webm').split(';')[0], data: await toBase64(audio) } }] }],
        generationConfig: { temperature: 0 },
      };
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (c.apiKey) headers['x-goog-api-key'] = c.apiKey;
      const res = await send({ ...c, provider: 'gemini', label: c.label, url, init: { method: 'POST', headers, body: JSON.stringify(body) }, signal: opts.signal });
      const j = await readJson(res, 'gemini');
      const text = (j?.candidates?.[0]?.content?.parts ?? []).map((p: { text?: string }) => p.text ?? '').join('').trim();
      return text;
    },
  };
}

/** Providers with a speech-to-text endpoint, and the model used for it. */
export const TRANSCRIPTION_MODELS: Readonly<Record<string, { model: string; kind: 'openai' | 'gemini' }>> = {
  openai: { model: 'gpt-4o-mini-transcribe', kind: 'openai' },
  groq: { model: 'whisper-large-v3-turbo', kind: 'openai' },
  gemini: { model: 'gemini-2.5-flash', kind: 'gemini' },
  custom: { model: 'whisper-1', kind: 'openai' },
};

/**
 * A transcriber for a configured provider, or null when it has no speech-to-text endpoint
 * (the app then falls back to the browser's speech recognition, if any).
 */
export function transcriberForProvider(args: { providerId: string; label: string; baseUrl: string; apiKey?: string; model?: string; fetch?: FetchLike }): Transcriber | null {
  const t = TRANSCRIPTION_MODELS[args.providerId];
  if (!t || !args.baseUrl) return null;
  const cfg: HttpTranscriberConfig = { provider: args.providerId, label: args.label, baseUrl: args.baseUrl, apiKey: args.apiKey, model: args.model ?? t.model, fetch: args.fetch, maxRetries: 1 };
  return t.kind === 'gemini' ? createGeminiTranscriber(cfg) : createOpenAITranscriber(cfg);
}
