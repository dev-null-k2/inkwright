import { create } from 'zustand';
import type { Transcriber } from '@inkwright/ai';
import { safeStorage } from '../platform/env.ts';
import { hasNativePlugin, InkwrightNative } from '../platform/native.ts';
import { registerNativeLLM, type NativeLLMAvailability } from '../platform/native-llm.ts';
import { useSettings } from '../state/settings.ts';
import { createNativeLLM, createNativeTranscriber, runNativeTask, startNativeListening, type NativeListening, type NativeTaskRequest } from '../ai/native/bridge.ts';
import type { DownloadEvent, NativeAIPlugin, NativeAIStatus, NativeModelInfo, NativeTask } from '../ai/native/plugin.ts';
import { initAppleAI } from '../ai/apple/plugin.ts';
import { classifyDownloadError, retriesOnItsOwn, retryDelayMs } from './assistant/download-status.ts';

/**
 * The app side of the Android shell's on-device AI: what the phone offers (Gemini Nano through
 * AICore, the ML Kit task APIs, LiteRT-LM models, offline speech), downloads with progress, the
 * person's choice of engine and model (per device, never synced), and registering the engines as
 * `NativeLLM`s so `pickAssistant` (lib/localai.ts) prefers them on Android.
 *
 * Everything is a no-op off Android: `nativeAIPlugin()` is null there.
 */

export type NativeEnginePref = 'auto' | 'gemini-nano' | 'litert';

export interface NativeAIPrefs {
  /** Which native engine answers first when both are ready. `auto`: Gemini Nano. */
  engine: NativeEnginePref;
  /** The LiteRT-LM model; null = the one recommended for this phone's memory. */
  modelId: string | null;
}

export interface NativeDownload {
  /** `retrying`: a transient error (AICore restarting, the connection) and another try is scheduled. */
  phase: DownloadEvent['phase'] | 'retrying';
  loaded: number;
  total: number;
  /** The raw error, for Details (the UI words it with describeDownloadIssue). */
  error?: string;
  code?: string;
  /** Automatic retries so far. */
  attempt?: number;
}

interface NativeAIState extends NativeAIPrefs {
  /** The status has been read at least once. */
  ready: boolean;
  status: NativeAIStatus | null;
  /** Keyed by download target (`gemini-nano`, `task:summarize`, `litert:<id>`). */
  downloads: Record<string, NativeDownload>;
  setPrefs(p: Partial<NativeAIPrefs>): void;
}

const KEY = 'inkwright.nativeai.v1';

function loadPrefs(): NativeAIPrefs {
  try {
    return { engine: 'auto', modelId: null, ...(JSON.parse(safeStorage.get(KEY) ?? '{}') as Partial<NativeAIPrefs>) };
  } catch {
    return { engine: 'auto', modelId: null };
  }
}

export const useNativeAI = create<NativeAIState>((set, get) => ({
  ...loadPrefs(),
  ready: false,
  status: null,
  downloads: {},
  setPrefs: (p) => {
    set(p);
    const { engine, modelId } = get();
    safeStorage.set(KEY, JSON.stringify({ engine, modelId }));
    registerEngines();
  },
}));

declare const __E2E__: boolean;
const E2E_BUILD = typeof __E2E__ !== 'undefined' && __E2E__;

/**
 * The Android plugin (same Capacitor object as native.ts; only its AI methods are typed here). E2E
 * builds also accept a scripted stand-in set by the test before the app loads, so the Settings and
 * assistant flows can be exercised in a desktop browser.
 */
let plugin: NativeAIPlugin | null = hasNativePlugin
  ? (InkwrightNative as unknown as NativeAIPlugin)
  : E2E_BUILD ? ((globalThis as { __inkwrightFakeNativeAI?: NativeAIPlugin }).__inkwrightFakeNativeAI ?? null) : null;

/** The plugin, or null off Android. */
export function nativeAIPlugin(): NativeAIPlugin | null {
  return plugin;
}

/** Tests only: drive the module with a fake plugin (null: back to "not Android"). */
export function setNativeAIPluginForTests(p: NativeAIPlugin | null) {
  plugin = p;
  init = null;
  for (const t of retryTimers.values()) clearTimeout(t);
  retryTimers.clear();
  registerNativeLLM(null);
  useNativeAI.setState({ ...loadPrefs(), ready: false, status: null, downloads: {} });
}

/** The language notes are written in (the handwriting setting), for the task APIs. */
const noteLanguage = () => useSettings.getState().recognition.language || 'en-US';

let init: Promise<void> | null = null;

/** Reads what the phone offers and registers the engines. Cheap and idempotent. */
export function initNativeAI(): Promise<void> {
  // On iOS the engine is Apple's on-device model (ai/apple/plugin.ts); no downloads to manage.
  if (!plugin) return initAppleAI();
  if (!init) {
    const p = plugin;
    init = (async () => {
      await p.addListener('aiDownload', onDownloadEvent);
      await refreshNativeAI();
    })().catch((e) => {
      console.warn('On-device AI status unavailable', e);
      useNativeAI.setState({ ready: true });
    });
  }
  return init;
}

/** Re-reads the status (after a download, when Settings opens). */
export async function refreshNativeAI(): Promise<void> {
  if (!plugin) return;
  const status = await plugin.aiStatus({ language: noteLanguage() });
  useNativeAI.setState({ status, ready: true });
  registerEngines();
}

function onDownloadEvent(e: DownloadEvent) {
  useNativeAI.setState((s) => {
    const downloads = { ...s.downloads };
    const prev = downloads[e.target];
    if (e.phase === 'done' || e.phase === 'cancelled') delete downloads[e.target];
    // A transient failure is never shown as one: downloadNative schedules the retry.
    else if (e.phase === 'failed' && retriesOnItsOwn(classifyDownloadError(e.code, e.error)) && (prev?.attempt ?? 0) < MAX_RETRIES) downloads[e.target] = { ...(prev ?? { loaded: 0, total: 0 }), phase: 'retrying', error: e.error, code: e.code };
    else downloads[e.target] = { phase: e.phase, loaded: e.loaded ?? prev?.loaded ?? 0, total: e.total ?? prev?.total ?? 0, error: e.error, ...(e.code ? { code: e.code } : {}), ...(prev?.attempt ? { attempt: prev.attempt } : {}) };
    return { downloads };
  });
}

const MAX_RETRIES = 5;
const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The LiteRT-LM model in use: the chosen one if this phone can run it, else the recommended one. */
export function chosenModel(s: Pick<NativeAIState, 'status' | 'modelId'> = useNativeAI.getState()): NativeModelInfo | null {
  const models = s.status?.models ?? [];
  const chosen = models.find((m) => m.id === s.modelId && m.state !== 'unavailable');
  return chosen ?? models.find((m) => m.id === s.status?.recommendedModel) ?? null;
}

export function nanoState(s: Pick<NativeAIState, 'status'> = useNativeAI.getState()): NativeLLMAvailability {
  return s.status?.engines.find((e) => e.id === 'gemini-nano')?.state ?? 'unavailable';
}

/** A native engine can answer now (as of the last status read). */
export function nativeEngineReady(s: Pick<NativeAIState, 'status' | 'modelId'> = useNativeAI.getState()): boolean {
  return nanoState(s) === 'available' || chosenModel(s)?.state === 'available';
}

export function taskState(task: NativeTask, s: Pick<NativeAIState, 'status'> = useNativeAI.getState()): NativeLLMAvailability {
  return s.status?.tasks[task] ?? 'unavailable';
}

/**
 * Registers the native engines in preference order: Gemini Nano first (system-managed, NPU, no
 * download of our own) unless the person picked the open model. Each reports the last status read,
 * so choosing who answers costs no native round trip.
 */
function registerEngines() {
  const p = plugin;
  registerNativeLLM(null);
  const s = useNativeAI.getState();
  if (!p || !s.status) return;
  const nano = s.status.engines.find((e) => e.id === 'gemini-nano');
  const model = chosenModel(s);
  const engines = [];
  if (nano && nano.state !== 'unavailable') {
    engines.push(createNativeLLM(p, {
      engine: 'gemini-nano', id: 'gemini-nano', label: 'Gemini Nano (on this phone)', contextTokens: nano.contextTokens ?? 4096,
      availability: async () => nanoState(),
    }, {
      describeImage: taskState('describe-image', s) === 'available' ? (image, signal) => runNativeTask(p, { task: 'describe-image', image, language: 'en' }, undefined, signal) : undefined,
    }));
  }
  if (model && model.state !== 'unavailable') {
    const id = model.id;
    const llm = createNativeLLM(p, {
      engine: 'litert', modelId: id, id: `litert:${id}`, label: `${model.label} (on this phone)`, contextTokens: model.contextTokens,
      availability: async () => useNativeAI.getState().status?.models.find((m) => m.id === id)?.state ?? 'unavailable',
    });
    if (s.engine === 'litert') engines.unshift(llm);
    else engines.push(llm);
  }
  engines.forEach(registerNativeLLM);
}

/** Whether a target is ready (or Android is downloading it on its own), per the last status read. */
function targetState(target: string): string | undefined {
  const st = useNativeAI.getState().status;
  if (!st) return undefined;
  if (target === 'gemini-nano') return st.engines.find((e) => e.id === 'gemini-nano')?.state;
  if (target.startsWith('task:')) return st.tasks[target.slice(5) as NativeTask];
  if (target.startsWith('litert:')) return st.models.find((m) => m.id === target.slice(7))?.state;
  return undefined;
}

/**
 * Downloads Gemini Nano, a task feature or a LiteRT model. Resolves true when it is ready.
 *
 * Transient errors — AICore's service disconnecting while it installs a model, a dropped
 * connection — are retried with backoff (3 s … 90 s, five times) while the row says "Retrying…";
 * if Android reports the model downloading or ready in the meantime, the retry stands down. Only
 * then, or for a real problem (storage, an AICore update, an unsupported phone), is it a failure.
 */
export async function downloadNative(target: string, attempt = 0): Promise<boolean> {
  const p = plugin;
  const current = useNativeAI.getState().downloads[target];
  if (!p || (current && current.phase !== 'failed' && !(attempt > 0 && current.phase === 'retrying'))) return false;
  useNativeAI.setState((s) => ({ downloads: { ...s.downloads, [target]: { phase: 'started', loaded: s.downloads[target]?.loaded ?? 0, total: s.downloads[target]?.total ?? 0, ...(attempt ? { attempt } : {}) } } }));
  let retry = false;
  try {
    await p.aiDownload({ target, language: noteLanguage() });
    // Done (the plugin's `done` event usually got here first).
    useNativeAI.setState((s) => { const downloads = { ...s.downloads }; delete downloads[target]; return { downloads }; });
    return true;
  } catch (e) {
    const err = e as { code?: string; message?: string };
    const kind = classifyDownloadError(err.code, err.message);
    const delay = retriesOnItsOwn(kind) ? retryDelayMs(attempt + 1) : null;
    retry = err.code !== 'cancelled' && delay != null;
    useNativeAI.setState((s) => {
      const downloads = { ...s.downloads };
      const prev = downloads[target];
      if (err.code === 'cancelled') delete downloads[target];
      else downloads[target] = { phase: retry ? 'retrying' : 'failed', loaded: prev?.loaded ?? 0, total: prev?.total ?? 0, error: err.message || 'Download failed.', ...(err.code ? { code: err.code } : {}), attempt };
      return { downloads };
    });
    if (retry) {
      retryTimers.set(target, setTimeout(() => {
        retryTimers.delete(target);
        void (async () => {
          await refreshNativeAI().catch(() => {});
          const state = targetState(target);
          if (useNativeAI.getState().downloads[target]?.phase !== 'retrying') return; // cancelled meanwhile
          if (state === 'available' || state === 'downloading') {
            // Android carries on (or finished) by itself: nothing to retry, nothing to report.
            useNativeAI.setState((s) => { const downloads = { ...s.downloads }; delete downloads[target]; return { downloads }; });
            return;
          }
          await downloadNative(target, attempt + 1);
        })();
      }, delay!));
    }
    return false;
  } finally {
    if (!retry) await refreshNativeAI().catch(() => {});
  }
}

export function cancelNativeDownload(target: string) {
  const timer = retryTimers.get(target);
  if (timer) {
    clearTimeout(timer);
    retryTimers.delete(target);
  }
  useNativeAI.setState((s) => {
    if (s.downloads[target]?.phase !== 'retrying' && s.downloads[target]?.phase !== 'failed') return {};
    const downloads = { ...s.downloads };
    delete downloads[target];
    return { downloads };
  });
  void plugin?.aiCancelDownload({ target });
}

export async function deleteNativeModel(modelId: string): Promise<void> {
  await plugin?.aiDeleteModel({ modelId });
  await refreshNativeAI();
}

/** Frees the loaded LiteRT model (switching models). */
export async function unloadNativeModel(): Promise<void> {
  await plugin?.aiUnload().catch(() => {});
}

// ---- Task APIs in app features ---------------------------------------------------------------------

/**
 * Summarizes with ML Kit's summarization API when Gemini Nano is the one answering and the feature
 * is ready for the note's language (English, Japanese, Korean); null otherwise, and the caller uses
 * the general prompt. The task API is tuned for this and stays within Nano's limits on long notes.
 */
export async function nativeSummary(answering: { model: string }, text: string, style: 'short' | 'bullets', onText?: (soFar: string) => void, signal?: AbortSignal): Promise<string | null> {
  const p = plugin;
  if (!p || answering.model !== 'gemini-nano' || taskState('summarize') !== 'available') return null;
  let soFar = '';
  try {
    return await runNativeTask(p, { task: 'summarize', text, style, language: noteLanguage() }, (d) => onText?.((soFar += d)), signal);
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    // `unsupported` (another language) or a transient AICore error: the prompt path still works.
    return null;
  }
}

/**
 * Cleans up text from on-device handwriting recognition with ML Kit's proofreading API (spelling,
 * grammar, recognition slips) when the feature is ready; the text unchanged otherwise.
 */
export async function nativeProofread(text: string, signal?: AbortSignal): Promise<string> {
  const p = plugin;
  if (!p || !text.trim() || taskState('proofread') !== 'available') return text;
  try {
    const fixed = await runNativeTask(p, { task: 'proofread', text, language: noteLanguage(), inputKind: 'keyboard' }, undefined, signal);
    return fixed || text;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return text;
  }
}

/** Runs any task directly (tests and future features use the same path). */
export function nativeTask(req: NativeTaskRequest, onDelta?: (d: string) => void, signal?: AbortSignal): Promise<string> {
  if (!plugin) return Promise.reject(new Error('On-device AI needs the Android app.'));
  return runNativeTask(plugin, req, onDelta, signal);
}

// ---- Speech -----------------------------------------------------------------------------------------

/** Android's recognizer is there (on-device or offline-preferred). */
export function nativeSpeechAvailable(): boolean {
  return !!plugin && !!useNativeAI.getState().status?.speech.available;
}

/** Speech stays on the phone (the on-device recognizer, not just "prefer offline"). */
export function nativeSpeechOnDevice(): boolean {
  return !!plugin && !!useNativeAI.getState().status?.speech.onDevice;
}

/** A `Transcriber` for recordings, on phones whose on-device recognizer accepts audio files (Android 13+). */
export function nativeTranscriber(): Transcriber | null {
  return plugin && useNativeAI.getState().status?.speech.fileInput ? createNativeTranscriber(plugin) : null;
}

export function listenNatively(opts: { language?: string; onPartial?: (text: string) => void }): Promise<NativeListening> {
  if (!plugin) return Promise.reject(new Error('Speech recognition needs the Android app.'));
  return startNativeListening(plugin, opts);
}
