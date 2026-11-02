import { AIError } from '../errors.ts';
import { CallbackProvider } from '../providers/callback.ts';
import { JSON_INSTRUCTION, systemText } from '../providers/common.ts';
import { withPromptTools } from '../providers/prompt-tools.ts';
import type { ChatRequest, Provider } from '../types.ts';

/**
 * Chrome's built-in AI (the Prompt API, `LanguageModel`, Gemini Nano on the device). Shipped on
 * desktop Chrome 148+ (Windows, macOS, Linux, Chromebook Plus); not in Android WebView. Structural
 * types only, so this compiles without DOM typings for an API that is still evolving.
 */
export type ChromeAIAvailability = 'unavailable' | 'downloadable' | 'downloading' | 'available';

export interface ChromeAISession {
  prompt(input: string, opts?: { signal?: AbortSignal; responseConstraint?: unknown }): Promise<string>;
  promptStreaming(input: string, opts?: { signal?: AbortSignal; responseConstraint?: unknown }): ReadableStream<string> | AsyncIterable<string>;
  destroy(): void;
  contextWindow?: number;
}

export interface ChromeLanguageModel {
  availability(opts?: Record<string, unknown>): Promise<ChromeAIAvailability>;
  create(opts?: {
    initialPrompts?: { role: 'system' | 'user' | 'assistant'; content: string }[];
    expectedInputs?: { type: string; languages?: string[] }[];
    expectedOutputs?: { type: string; languages?: string[] }[];
    monitor?: (m: { addEventListener(type: 'downloadprogress', cb: (e: { loaded: number }) => void): void }) => void;
    signal?: AbortSignal;
  }): Promise<ChromeAISession>;
}

const LANG_OPTS = { expectedInputs: [{ type: 'text', languages: ['en'] }], expectedOutputs: [{ type: 'text', languages: ['en'] }] };

/** The Prompt API entry point, when this browser has one. */
export function chromeLanguageModel(g: unknown = globalThis): ChromeLanguageModel | null {
  const lm = (g as { LanguageModel?: ChromeLanguageModel }).LanguageModel;
  return lm && typeof lm.availability === 'function' && typeof lm.create === 'function' ? lm : null;
}

export async function chromeAIAvailability(lm: ChromeLanguageModel | null = chromeLanguageModel()): Promise<ChromeAIAvailability> {
  if (!lm) return 'unavailable';
  try {
    return await lm.availability(LANG_OPTS);
  } catch {
    return 'unavailable';
  }
}

async function* chunks(stream: ReadableStream<string> | AsyncIterable<string>): AsyncIterable<string> {
  if (Symbol.asyncIterator in (stream as object)) {
    yield* stream as AsyncIterable<string>;
    return;
  }
  const reader = (stream as ReadableStream<string>).getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/**
 * A Provider over Chrome's Prompt API. Each request opens a session seeded with the system prompt
 * and earlier turns and streams the answer to the last user message; tools use the text protocol.
 * `onDownloadProgress` reports Chrome fetching Gemini Nano the first time (0..1).
 */
export function createChromeAIProvider(lm: ChromeLanguageModel, opts: { onDownloadProgress?: (fraction: number) => void } = {}): Provider {
  const inner = new CallbackProvider({
    id: 'chrome-ai',
    label: 'Chrome built-in AI',
    capabilities: { vision: false, tools: false, streaming: true, listModels: false, json: false },
    handler: async (req: ChatRequest, emit) => {
      let sys = systemText(req.messages);
      if (req.json) sys = sys ? `${sys}\n\n${JSON_INSTRUCTION}` : JSON_INSTRUCTION;
      const turns = req.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role as 'user' | 'assistant', content: typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('') }));
      const last = turns.pop();
      if (!last || last.role !== 'user') throw new AIError({ code: 'bad_request', provider: 'chrome-ai', message: 'Nothing to answer.' });
      const session = await lm.create({
        ...LANG_OPTS,
        initialPrompts: [...(sys ? [{ role: 'system' as const, content: sys }] : []), ...turns],
        monitor: opts.onDownloadProgress ? (m) => m.addEventListener('downloadprogress', (e) => opts.onDownloadProgress!(e.loaded)) : undefined,
        signal: req.signal,
      });
      try {
        let text = '';
        for await (const chunk of chunks(session.promptStreaming(last.content, { signal: req.signal }))) {
          // Chunks are deltas; very early Chrome builds streamed the whole text so far.
          const delta = text.length > 20 && chunk.length > text.length && chunk.startsWith(text) ? chunk.slice(text.length) : chunk;
          text += delta;
          if (delta) emit({ type: 'text', delta });
        }
        return { text, stopReason: 'stop' };
      } finally {
        session.destroy();
      }
    },
  });
  return withPromptTools(inner);
}
