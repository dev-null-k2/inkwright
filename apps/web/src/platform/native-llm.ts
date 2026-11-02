import { CallbackProvider, toLocalMessages, withPromptTools, ThinkFilter, stripThinking, type LocalChatMessage, type Provider } from '@inkstone/ai';

/**
 * Hook for a native on-device model provided by the host app — on Android, Gemini Nano through
 * the ML Kit GenAI Prompt API (AICore) or a LiteRT-LM model; on iOS, Apple's Foundation Models.
 * Native runtimes use the NPU/GPU directly and share one system-wide model, so when one is
 * available it beats downloading weights into the WebView.
 *
 * The web app owns everything around the model (prompting, tools, retrieval, citations); the
 * native side only has to implement this interface — typically by adding three methods to
 * `InkstoneNativePlugin` (native.ts) and registering an adapter at startup:
 *
 * ```ts
 * registerNativeLLM({
 *   id: 'gemini-nano', label: 'Gemini Nano (on this phone)',
 *   availability: () => InkstoneNative.llmAvailability().then((r) => r.state),
 *   generate: (req, onDelta, signal) => … InkstoneNative.llmGenerate(req) + 'llmDelta' listener …,
 * });
 * ```
 *
 * `chooseAssistant` (packages/ai) prefers a ready native model over a downloaded web model.
 */
export type NativeLLMAvailability = 'available' | 'downloadable' | 'downloading' | 'unavailable';

export interface NativeLLMRequest {
  /** System prompt first, then alternating user/assistant turns, ending with the user. */
  messages: LocalChatMessage[];
  maxTokens?: number;
  temperature?: number;
}

export interface NativeLLM {
  /** Stable id, e.g. `gemini-nano`. */
  readonly id: string;
  /** Shown as "who answered", e.g. "Gemini Nano (on this phone)". */
  readonly label: string;
  /** Approximate context window in tokens (default 4096). */
  readonly contextTokens?: number;
  availability(): Promise<NativeLLMAvailability>;
  /** Streams text through `onDelta` and resolves with the full answer. Must stop when `signal` aborts. */
  generate(req: NativeLLMRequest, onDelta: (text: string) => void, signal?: AbortSignal): Promise<{ text: string }>;
  /** Optional native embeddings (L2-normalized), used for semantic search when present. */
  embed?(inputs: string[]): Promise<Float32Array[]>;
}

let registered: NativeLLM | null = null;

/** Called once by the native shell at startup. */
export function registerNativeLLM(llm: NativeLLM | null): void {
  registered = llm;
}

export function nativeLLM(): NativeLLM | null {
  return registered;
}

/** Whether a registered native model can answer right now. */
export async function nativeLLMReady(): Promise<boolean> {
  if (!registered) return false;
  try {
    return (await registered.availability()) === 'available';
  } catch {
    return false;
  }
}

/** A Provider over the native model (tools through the text protocol, like other local models). */
export function createNativeProvider(llm: NativeLLM): Provider {
  const context = llm.contextTokens ?? 4096;
  return withPromptTools(
    new CallbackProvider({
      id: `native-${llm.id}`,
      label: llm.label,
      capabilities: { vision: false, tools: false, streaming: true, listModels: false, json: false },
      handler: async (req, emit) => {
        const maxTokens = Math.min(req.maxTokens ?? 1024, Math.floor(context / 2));
        const messages = toLocalMessages(req.messages, { budgetTokens: context - maxTokens - 64, json: req.json });
        const filter = new ThinkFilter((s) => emit({ type: 'text', delta: s }));
        const r = await llm.generate({ messages, maxTokens, temperature: req.temperature }, (d) => filter.push(d), req.signal);
        filter.end();
        return { text: stripThinking(r.text).trim() };
      },
    }),
  );
}
