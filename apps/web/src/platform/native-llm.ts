import { CallbackProvider, toLocalMessages, withPromptTools, ThinkFilter, stripThinking, type ChatMessage, type ContentPart, type LocalChatMessage, type Provider } from '@inkstone/ai';

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
  /**
   * Optional on-device image description (Android: ML Kit GenAI). Lets a text-only native model
   * answer about an attached image from its description. `image` is base64 PNG/JPEG.
   */
  describeImage?(image: string, signal?: AbortSignal): Promise<string>;
}

/**
 * Several native engines can be registered (Android: Gemini Nano and a LiteRT-LM model). They are
 * tried in registration order — the shell registers the one it prefers first — and the first that
 * reports `available` answers.
 */
let registered: NativeLLM[] = [];
let ready: NativeLLM | null = null;

/** Registers (or, with the same id, replaces) a native engine; `null` removes them all. */
export function registerNativeLLM(llm: NativeLLM | null): void {
  if (!llm) {
    registered = [];
    ready = null;
    return;
  }
  const i = registered.findIndex((r) => r.id === llm.id);
  if (i >= 0) registered = registered.map((r, k) => (k === i ? llm : r));
  else registered = [...registered, llm];
  if (ready?.id === llm.id) ready = llm;
}

/** Removes the engine with this id. */
export function unregisterNativeLLM(id: string): void {
  registered = registered.filter((r) => r.id !== id);
  if (ready?.id === id) ready = null;
}

/** Every registered engine, in preference order. */
export function nativeLLMs(): readonly NativeLLM[] {
  return registered;
}

/** The engine that last reported ready (see `nativeLLMReady`), else the first registered. */
export function nativeLLM(): NativeLLM | null {
  return ready ?? registered[0] ?? null;
}

/** Whether a registered native model can answer right now; remembers which one for `nativeLLM()`. */
export async function nativeLLMReady(): Promise<boolean> {
  for (const llm of registered) {
    try {
      if ((await llm.availability()) === 'available') {
        ready = llm;
        return true;
      }
    } catch {
      /* this engine can't answer; try the next */
    }
  }
  ready = null;
  return false;
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
        const described = llm.describeImage ? await describeImages(req.messages, llm.describeImage, req.signal) : req.messages;
        const messages = toLocalMessages(described, { budgetTokens: context - maxTokens - 64, json: req.json });
        const filter = new ThinkFilter((s) => emit({ type: 'text', delta: s }));
        const r = await llm.generate({ messages, maxTokens, temperature: req.temperature }, (d) => filter.push(d), req.signal);
        filter.end();
        return { text: stripThinking(r.text).trim() };
      },
    }),
  );
}

/**
 * Replaces attached images with their on-device description, so a text-only model can still talk
 * about a sketch or photo. An image that can't be described keeps the default "text only" note.
 */
export async function describeImages(messages: ChatMessage[], describe: NonNullable<NativeLLM['describeImage']>, signal?: AbortSignal): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    if (typeof m.content === 'string' || !m.content.some((p) => p.type === 'image')) {
      out.push(m);
      continue;
    }
    const parts: ContentPart[] = [];
    for (const p of m.content) {
      if (p.type !== 'image') {
        parts.push(p);
        continue;
      }
      let text: string | null = null;
      try {
        text = (await describe(p.data, signal)).trim() || null;
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
      }
      parts.push(text ? { type: 'text', text: `[Attached image, described on this phone: ${text}]` } : p);
    }
    out.push({ ...m, content: parts });
  }
  return out;
}
