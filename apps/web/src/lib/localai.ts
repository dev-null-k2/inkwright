import { create } from 'zustand';
import {
  LocalEngineClient,
  chooseAssistant,
  chooseEmbedder,
  chromeAIAvailability,
  chromeLanguageModel,
  createChromeAIProvider,
  createLocalProvider,
  detectHardware,
  detectLocalServers,
  getLocalModel,
  getProviderInfo,
  modelRef,
  pickVariant,
  recommendAsr,
  recommendLocal,
  remoteEmbed,
  runnableModels,
  type AssistantChoice,
  type AssistantPreference,
  type ChromeAIAvailability,
  type DetectedServer,
  type EmbeddingPreference,
  type HardwareInfo,
  type LocalEngine,
  type LocalRecommendation,
  type ModelChoice,
  type ModelRef,
  type Provider,
} from '@inkstone/ai';
import { BUILD_TARGET, isNative, safeStorage } from '../platform/env.ts';
import { createNativeProvider, nativeLLM, nativeLLMReady } from '../platform/native-llm.ts';
import { useSettings } from '../state/settings.ts';
import { opfsAvailable, removeStored, storedStatus } from '../ai/model-files.ts';
import { getSecret } from './secrets.ts';
import { spawnLocalWorker } from '../ai/spawn.ts';

/**
 * The app side of on-device AI: what this device can run, which models the person chose, what is
 * downloaded, and the worker that runs them. Preferences live in their own small store (per
 * device, never synced), so the main settings schema is untouched.
 */

export interface LocalPrefs {
  /** Who answers when several AIs are available. */
  assistant: AssistantPreference;
  /** Chosen chat model id; null = the recommended one for this device. */
  chatModel: string | null;
  embedModel: string | null;
  /** Where semantic-search embeddings come from. */
  embeddings: EmbeddingPreference;
  /** Embedding model name at the user's provider (when embeddings = 'provider'). */
  embedProviderModel: string;
  /** Chosen speech-to-text model id; null = the recommended one for this device and language. */
  asrModel: string | null;
}

export interface DownloadState {
  loaded: number;
  total: number;
  error?: string;
}

interface LocalState extends LocalPrefs {
  ready: boolean;
  hardware: HardwareInfo | null;
  rec: LocalRecommendation | null;
  /** Keyed by `modelKey`. */
  installed: Record<string, boolean>;
  onDevice: Record<string, number>;
  downloads: Record<string, DownloadState>;
  chrome: ChromeAIAvailability;
  servers: DetectedServer[] | null;
  scanning: boolean;
  setPrefs: (p: Partial<LocalPrefs>) => void;
}

const KEY = 'inkstone.localai.v1';
const DEFAULT_PREFS: LocalPrefs = { assistant: 'auto', chatModel: null, embedModel: null, embeddings: 'device', embedProviderModel: '', asrModel: null };

function loadPrefs(): LocalPrefs {
  try {
    return { ...DEFAULT_PREFS, ...(JSON.parse(safeStorage.get(KEY) ?? '{}') as Partial<LocalPrefs>) };
  } catch {
    return DEFAULT_PREFS;
  }
}

export const useLocalAI = create<LocalState>((set, get) => ({
  ...loadPrefs(),
  ready: false,
  hardware: null,
  rec: null,
  installed: {},
  onDevice: {},
  downloads: {},
  chrome: 'unavailable',
  servers: null,
  scanning: false,
  setPrefs: (p) => {
    set(p);
    const s = get();
    const prefs: LocalPrefs = { assistant: s.assistant, chatModel: s.chatModel, embedModel: s.embedModel, embeddings: s.embeddings, embedProviderModel: s.embedProviderModel, asrModel: s.asrModel };
    safeStorage.set(KEY, JSON.stringify(prefs));
    listeners.forEach((l) => l());
  },
}));

/** Notified when anything that changes "who answers" or "who embeds" changes. */
const listeners = new Set<() => void>();
export function onLocalAIChange(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** The in-browser runtime needs workers and WebAssembly; the single-file preview build leaves it out. */
export function localAISupported(): boolean {
  return BUILD_TARGET !== 'single' && typeof Worker !== 'undefined' && typeof WebAssembly !== 'undefined';
}

export const modelKey = (ref: Pick<ModelRef, 'id' | 'dtype' | 'device'>) => `${ref.id}:${ref.dtype}`;

// ---- Worker ----------------------------------------------------------------------------------

let client: LocalEngineClient | null = null;
let worker: Worker | null = null;

/** The model runtime, started on first use. */
export function localEngine(): LocalEngine {
  if (client) return client;
  if (!localAISupported()) throw new Error('On-device AI is not available in this build.');
  worker = spawnLocalWorker();
  const c = new LocalEngineClient(worker);
  worker.addEventListener('error', (e) => {
    console.warn('On-device AI worker stopped', e);
    c.dispose('The on-device AI stopped unexpectedly (often: not enough memory). Try a smaller model in Settings › AI.');
    if (client === c) { client = null; worker = null; }
  });
  client = c;
  return c;
}

/** Frees the worker and everything it loaded. */
export function stopLocalEngine() {
  client?.dispose();
  worker?.terminate();
  client = null;
  worker = null;
}

// ---- Device and models -------------------------------------------------------------------------

let init: Promise<void> | null = null;

/** Reads the hardware once and what is downloaded. Cheap: never starts the worker. */
export function initLocalAI(): Promise<void> {
  if (!init) {
    init = (async () => {
      const hardware = localAISupported() ? await detectHardware(navigator as any) : null;
      const chrome = await chromeAIAvailability(chromeLanguageModel());
      useLocalAI.setState({ hardware, rec: hardware ? recommendLocal(hardware) : null, chrome });
      await refreshInstalled();
      useLocalAI.setState({ ready: true });
      listeners.forEach((l) => l());
    })().catch((e) => {
      console.warn('On-device AI unavailable', e);
      useLocalAI.setState({ ready: true });
    });
  }
  return init;
}

function choice(id: string | null, fallback: ModelChoice | null | undefined): ModelChoice | null {
  const hw = useLocalAI.getState().hardware;
  if (!hw) return null;
  const spec = getLocalModel(id);
  const variant = spec && pickVariant(spec, hw);
  return spec && variant ? { spec, variant } : (fallback ?? null);
}

/** The chat model in use on this device (chosen, or recommended). */
export function chatChoice(): ModelChoice | null {
  const s = useLocalAI.getState();
  return choice(s.chatModel, s.rec?.chat);
}

export function embedChoice(): ModelChoice | null {
  const s = useLocalAI.getState();
  return choice(s.embedModel, s.rec?.embed);
}

/**
 * The speech-to-text model in use on this device (chosen, or recommended for its tier and the
 * speech language: Moonshine for English, Whisper otherwise).
 */
export function asrChoice(language: string = (typeof navigator !== 'undefined' && navigator.language) || 'en'): ModelChoice | null {
  const s = useLocalAI.getState();
  const hw = s.hardware;
  return choice(s.asrModel, hw ? recommendAsr(hw, language) : null);
}

export const refOf = (c: ModelChoice): ModelRef => modelRef(c.spec, c.variant as ModelChoice['variant'] & { device: 'webgpu' | 'wasm' });

export function isInstalled(c: ModelChoice | null): boolean {
  return !!c && !!useLocalAI.getState().installed[modelKey(refOf(c))];
}

/** Re-reads which models are on this device (OPFS on the main thread; the worker otherwise). */
export async function refreshInstalled(): Promise<void> {
  const s = useLocalAI.getState();
  if (!s.hardware) return;
  const all = [...runnableModels(s.hardware, 'chat'), ...runnableModels(s.hardware, 'embed'), ...runnableModels(s.hardware, 'asr')];
  const installed: Record<string, boolean> = {};
  const onDevice: Record<string, number> = {};
  for (const c of all) {
    const ref = refOf(c);
    try {
      const st = opfsAvailable() ? await storedStatus(ref) : await localEngine().status(ref);
      installed[modelKey(ref)] = st.installed;
      onDevice[modelKey(ref)] = st.bytesOnDevice;
    } catch {
      installed[modelKey(ref)] = false;
    }
  }
  useLocalAI.setState({ installed, onDevice });
}

const aborts = new Map<string, AbortController>();

/** Downloads (or resumes) a model with progress in the store. Resolves true when installed. */
export async function downloadModel(c: ModelChoice): Promise<boolean> {
  const ref = refOf(c);
  const key = modelKey(ref);
  if (aborts.has(key)) return false;
  const ac = new AbortController();
  aborts.set(key, ac);
  const setDl = (d: DownloadState | null) => useLocalAI.setState((s) => {
    const downloads = { ...s.downloads };
    if (d) downloads[key] = d;
    else delete downloads[key];
    return { downloads };
  });
  setDl({ loaded: useLocalAI.getState().onDevice[key] ?? 0, total: ref.bytes });
  try {
    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
    await localEngine().download(ref, (p) => setDl({ loaded: p.loaded, total: p.total }), ac.signal);
    setDl(null);
    useLocalAI.setState((s) => ({ installed: { ...s.installed, [key]: true }, onDevice: { ...s.onDevice, [key]: ref.bytes } }));
    listeners.forEach((l) => l());
    return true;
  } catch (e) {
    const err = e as Error;
    if (err.name === 'AbortError') setDl(null);
    else setDl({ loaded: useLocalAI.getState().downloads[key]?.loaded ?? 0, total: ref.bytes, error: err.message });
    await refreshInstalled().catch(() => {});
    return false;
  } finally {
    aborts.delete(key);
  }
}

/** Stops a download; what arrived stays on the device and the next download resumes from it. */
export function cancelDownload(c: ModelChoice) {
  aborts.get(modelKey(refOf(c)))?.abort();
}

export async function removeModel(c: ModelChoice): Promise<void> {
  const ref = refOf(c);
  if (client) await client.remove(ref);
  else if (opfsAvailable()) await removeStored(ref);
  else await localEngine().remove(ref);
  await refreshInstalled();
  listeners.forEach((l) => l());
}

/** Scans localhost for Ollama, LM Studio, llama.cpp and Foundry Local (desktop only). */
export async function scanLocalServers(): Promise<DetectedServer[]> {
  if (isNative) return [];
  useLocalAI.setState({ scanning: true });
  try {
    const servers = await detectLocalServers();
    useLocalAI.setState({ servers });
    return servers;
  } finally {
    useLocalAI.setState({ scanning: false });
  }
}

// ---- Who answers ---------------------------------------------------------------------------------

export interface LocalActiveAI {
  provider: Provider;
  model: string;
  label: string;
  vision: boolean;
  tools: boolean;
}

/** Decides who answers, given what the app knows about configured providers. */
export async function pickAssistant(ctx: { providerConfigured: boolean; builtinClaude: boolean }): Promise<AssistantChoice> {
  await initLocalAI();
  const s = useLocalAI.getState();
  const chat = chatChoice();
  return chooseAssistant({
    preference: s.assistant,
    providerConfigured: ctx.providerConfigured,
    builtinClaude: ctx.builtinClaude,
    nativeReady: await nativeLLMReady(),
    deviceInstalled: isInstalled(chat),
    deviceRunnable: !!chat,
    chrome: s.chrome,
  });
}

/** The provider for an on-device choice made by `pickAssistant`. */
export function localActiveAI(kind: 'device' | 'chrome' | 'native'): LocalActiveAI | null {
  if (kind === 'native') {
    const n = nativeLLM();
    return n ? { provider: createNativeProvider(n), model: n.id, label: n.label, vision: false, tools: true } : null;
  }
  if (kind === 'chrome') {
    const lm = chromeLanguageModel();
    return lm ? { provider: createChromeAIProvider(lm), model: 'gemini-nano', label: 'Chrome built-in AI (Gemini Nano)', vision: false, tools: true } : null;
  }
  const c = chatChoice();
  if (!c || !isInstalled(c)) return null;
  const ref = refOf(c);
  return { provider: createLocalProvider(localEngine(), ref, { contextTokens: c.spec.contextTokens, label: `On this device · ${c.spec.label}` }), model: ref.id, label: `On this device · ${c.spec.label}`, vision: false, tools: true };
}

// ---- Embeddings ---------------------------------------------------------------------------------

/** Turns passages and queries into vectors for semantic search. */
export interface Embedder {
  /** Vectors from different models are not comparable; stored vectors are keyed by this. */
  key: string;
  label: string;
  embedDocuments(items: { title: string; text: string }[], signal?: AbortSignal): Promise<Float32Array[]>;
  embedQuery(query: string, signal?: AbortSignal): Promise<Float32Array>;
}

async function providerEmbedder(model: string): Promise<Embedder | null> {
  const ai = useSettings.getState().ai;
  const cfg = ai.providers.find((p) => p.id === ai.activeId);
  const info = cfg && getProviderInfo(cfg.providerId);
  if (!cfg || !info || info.kind !== 'openai-compatible' || !model) return null;
  const baseUrl = (cfg.baseUrl?.trim() || info.defaultBaseUrl).replace(/\/+$/, '');
  const apiKey = cfg.hasKey ? (await getSecret(`ai-key:${cfg.id}`)) ?? undefined : undefined;
  const run = (inputs: string[], signal?: AbortSignal) => remoteEmbed({ baseUrl, apiKey, model, provider: info.label }, inputs, signal);
  return {
    key: `provider:${cfg.providerId}:${model}`,
    label: `${info.label} · ${model}`,
    embedDocuments: (items, signal) => run(items.map((i) => `${i.title}\n${i.text}`), signal),
    embedQuery: async (q, signal) => (await run([q], signal))[0]!,
  };
}

/** The embedder semantic search should use now, or null (keyword search only). */
export async function currentEmbedder(): Promise<Embedder | null> {
  await initLocalAI();
  const s = useLocalAI.getState();
  const c = embedChoice();
  const provider = s.embeddings === 'provider' ? await providerEmbedder(s.embedProviderModel) : null;
  const pick = chooseEmbedder({ preference: s.embeddings, deviceInstalled: isInstalled(c), providerEmbeddings: !!provider });
  if (pick.kind === 'provider') return provider;
  if (pick.kind !== 'device' || !c) return null;
  const ref = refOf(c);
  const cfg = c.spec.embed!;
  return {
    key: `device:${modelKey(ref)}:${cfg.dims}`,
    label: `${c.spec.label} on this device`,
    embedDocuments: (items, signal) => localEngine().embed(ref, items.map((i) => cfg.document(i.text, i.title)), signal),
    embedQuery: async (q, signal) => (await localEngine().embed(ref, [cfg.query(q)], signal))[0]!,
  };
}
