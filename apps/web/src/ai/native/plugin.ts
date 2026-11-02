import type { PluginListenerHandle } from '@capacitor/core';
import type { NativeLLMAvailability } from '../../platform/native-llm.ts';

/**
 * The on-device AI methods of the Android InkwrightNativePlugin (Kotlin: app/inkwright/ai/AiBridge.kt,
 * which documents each one). Kept apart from native.ts's plugin interface so the bridge can be
 * tested against a fake, and so the haptics/recognition interface stays readable.
 */
export type EngineState = NativeLLMAvailability;

export type NativeTask = 'summarize' | 'proofread' | 'rewrite' | 'describe-image';

export interface NativeModelInfo {
  id: string;
  label: string;
  bytes: number;
  licence: string;
  params: string;
  blurb: string;
  contextTokens: number;
  minRamGb: number;
  /** `unavailable` = too big for this phone's memory. */
  state: EngineState;
  /** Bytes already on the phone (all of them once downloaded; part of them after an interruption). */
  partialBytes: number;
  /** Loaded in memory now, and on which backend (`gpu` / `cpu`). */
  loaded: boolean;
  backend?: string;
}

export interface NativeAIStatus {
  engines: { id: 'gemini-nano'; state: EngineState; contextTokens?: number; model?: string }[];
  tasks: Record<NativeTask, EngineState>;
  models: NativeModelInfo[];
  recommendedModel?: string | null;
  ramGb: number;
  speech: { available: boolean; onDevice: boolean; fileInput: boolean };
}

export interface WireMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface DownloadEvent {
  target: string;
  phase: 'started' | 'download' | 'verify' | 'done' | 'failed' | 'cancelled';
  loaded?: number;
  total?: number;
  error?: string;
  code?: string;
}

export interface NativeAIPlugin {
  aiStatus(opts: { language?: string }): Promise<NativeAIStatus>;
  aiDownload(opts: { target: string; language?: string }): Promise<{ state: EngineState }>;
  aiCancelDownload(opts: { target: string }): Promise<void>;
  aiDeleteModel(opts: { modelId: string }): Promise<void>;
  aiUnload(): Promise<void>;
  aiGenerate(opts: { requestId: string; engine: 'gemini-nano' | 'litert'; modelId?: string; messages: WireMessage[]; maxTokens?: number; temperature?: number }): Promise<{ text: string }>;
  aiTask(opts: { requestId: string; task: NativeTask; language?: string; text?: string; image?: string; style?: string; tone?: string; inputKind?: string }): Promise<{ text: string }>;
  aiCancel(opts: { requestId: string }): Promise<void>;
  speechStart(opts: { sessionId: string; language?: string }): Promise<{ onDevice: boolean }>;
  speechStop(opts: { sessionId: string }): Promise<{ text: string }>;
  speechCancel(opts: { sessionId: string }): Promise<void>;
  speechTranscribe(opts: { pcm: string; sampleRate: number; language?: string }): Promise<{ text: string }>;
  addListener(event: 'aiDelta', cb: (e: { requestId: string; delta: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: 'aiDownload', cb: (e: DownloadEvent) => void): Promise<PluginListenerHandle>;
  addListener(event: 'speechPartial', cb: (e: { sessionId: string; text: string }) => void): Promise<PluginListenerHandle>;
}
