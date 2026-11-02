import type { Transcriber, TranscribeOptions } from '@inkwright/ai';
import type { NativeLLM, NativeLLMAvailability, NativeLLMRequest } from '../../platform/native-llm.ts';
import { decodeToPcm16, pcm16ToBase64, SPEECH_SAMPLE_RATE } from './pcm.ts';
import type { NativeAIPlugin, NativeTask } from './plugin.ts';

/**
 * The web side of the Android on-device AI (Kotlin: app/inkwright/ai/). Turns the plugin's
 * request/response + event protocol into the app's interfaces: `NativeLLM` for chat (streaming
 * through `aiDelta` events, cancellable), `Transcriber` for recordings, a live push-to-talk session,
 * and the ML Kit task APIs. Every function takes the plugin, so tests drive it with a fake.
 */

let seq = 0;
const newId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${(++seq).toString(36)}`;

/** A plugin rejection, with the stable code from Kotlin's AiException (`busy`, `unsupported`, …). */
export class NativeAIError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'NativeAIError';
  }
}

function abortError(): Error {
  const e = new Error('Stopped.');
  e.name = 'AbortError';
  return e;
}

/** Normalizes a Capacitor rejection; `cancelled` (or an aborted signal) becomes an AbortError. */
export function toNativeError(e: unknown, signal?: AbortSignal): Error {
  const code = (e as { code?: unknown })?.code;
  if (signal?.aborted || code === 'cancelled') return abortError();
  const message = (e as { message?: unknown })?.message;
  return new NativeAIError(typeof message === 'string' && message ? message : 'On-device AI failed.', typeof code === 'string' ? code : 'failed');
}

/**
 * Runs one streaming request: listens for its deltas, cancels it natively when [signal] aborts,
 * and always removes the listener.
 */
async function streamed(plugin: NativeAIPlugin, call: (requestId: string) => Promise<{ text: string }>, onDelta: (text: string) => void, signal?: AbortSignal): Promise<{ text: string }> {
  if (signal?.aborted) throw abortError();
  const requestId = newId('ai');
  const handle = await plugin.addListener('aiDelta', (e) => {
    if (e.requestId === requestId && e.delta) onDelta(e.delta);
  });
  const onAbort = () => void plugin.aiCancel({ requestId }).catch(() => {});
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    return await call(requestId);
  } catch (e) {
    throw toNativeError(e, signal);
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await handle.remove();
  }
}

export interface NativeEngineSpec {
  engine: 'gemini-nano' | 'litert';
  /** LiteRT model id; ignored for Gemini Nano. */
  modelId?: string;
  id: string;
  label: string;
  contextTokens?: number;
  availability(): Promise<NativeLLMAvailability>;
}

/** A `NativeLLM` over one engine. */
export function createNativeLLM(plugin: NativeAIPlugin, spec: NativeEngineSpec, extras: { describeImage?: NativeLLM['describeImage'] } = {}): NativeLLM {
  return {
    id: spec.id,
    label: spec.label,
    contextTokens: spec.contextTokens,
    availability: spec.availability,
    describeImage: extras.describeImage,
    generate: (req: NativeLLMRequest, onDelta, signal) =>
      streamed(plugin, (requestId) => plugin.aiGenerate({
        requestId,
        engine: spec.engine,
        modelId: spec.modelId,
        messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: req.maxTokens,
        temperature: req.temperature,
      }), onDelta, signal),
  };
}

export interface NativeTaskRequest {
  task: NativeTask;
  language?: string;
  text?: string;
  /** Base64 (or a data: URL) of a PNG/JPEG, for `describe-image`. */
  image?: string;
  /** Summaries: `short` (one bullet) or `bullets` (three). */
  style?: 'short' | 'bullets';
  /** Rewrites: elaborate, emojify, shorten, friendly, professional, rephrase. */
  tone?: string;
  /** Proofreading: `voice` for dictated text, otherwise typed/handwritten. */
  inputKind?: 'keyboard' | 'voice';
}

/** Runs an ML Kit GenAI task (summarize, proofread, rewrite, describe an image). */
export function runNativeTask(plugin: NativeAIPlugin, req: NativeTaskRequest, onDelta: (text: string) => void = () => {}, signal?: AbortSignal): Promise<string> {
  return streamed(plugin, (requestId) => plugin.aiTask({ requestId, ...req }), onDelta, signal).then((r) => r.text.trim());
}

/** Android's on-device recognizer as a `Transcriber` (recordings; Android 13+ with offline speech). */
export function createNativeTranscriber(plugin: NativeAIPlugin, decode: (audio: Blob) => Promise<Int16Array> = decodeToPcm16): Transcriber {
  return {
    id: 'android:on-device-speech',
    label: 'Android speech recognition (on this phone)',
    onDevice: true,
    async transcribe(audio: Blob, opts: TranscribeOptions = {}) {
      if (opts.signal?.aborted) throw abortError();
      const pcm = await decode(audio);
      if (!pcm.length) return '';
      try {
        const r = await plugin.speechTranscribe({ pcm: pcm16ToBase64(pcm), sampleRate: SPEECH_SAMPLE_RATE, language: opts.language });
        if (opts.signal?.aborted) throw abortError();
        return r.text.trim();
      } catch (e) {
        throw toNativeError(e, opts.signal);
      }
    },
  };
}

export interface NativeListening {
  /** True when Android's on-device recognizer is listening (audio never leaves the phone). */
  onDevice: boolean;
  stop(): Promise<string>;
  cancel(): void;
}

/** Starts push-to-talk with Android's recognizer; [onPartial] gets live text. */
export async function startNativeListening(plugin: NativeAIPlugin, opts: { language?: string; onPartial?: (text: string) => void } = {}): Promise<NativeListening> {
  const sessionId = newId('speech');
  const handle = await plugin.addListener('speechPartial', (e) => {
    if (e.sessionId === sessionId) opts.onPartial?.(e.text);
  });
  let started: { onDevice: boolean };
  try {
    started = await plugin.speechStart({ sessionId, language: opts.language });
  } catch (e) {
    await handle.remove();
    throw toNativeError(e);
  }
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    void handle.remove();
  };
  return {
    onDevice: started.onDevice,
    async stop() {
      try {
        return (await plugin.speechStop({ sessionId })).text.trim();
      } catch (e) {
        throw toNativeError(e);
      } finally {
        close();
      }
    },
    cancel() {
      void plugin.speechCancel({ sessionId }).catch(() => {});
      close();
    },
  };
}
