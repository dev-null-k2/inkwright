import type { ChromeAIAvailability } from './chrome-ai.ts';

/**
 * Which AI answers. Most people will never add an API key, so with no provider configured the
 * assistant runs privately on the device — after a one-time, clearly sized download — and only
 * people who added a key (or a local server) choose between that and the on-device model.
 */
export type AssistantPreference = 'auto' | 'provider' | 'device' | 'chrome';

export interface AssistantSituation {
  preference: AssistantPreference;
  /** A provider from Settings › AI (API key, local server) is active. */
  providerConfigured: boolean;
  /** Running as a claude.ai preview with Claude available without a key. */
  builtinClaude: boolean;
  /** A native on-device model (e.g. Gemini Nano through the Android app) is ready. */
  nativeReady: boolean;
  /** The chosen on-device chat model is downloaded. */
  deviceInstalled: boolean;
  /** This device can run some on-device chat model (it may still need downloading). */
  deviceRunnable: boolean;
  chrome: ChromeAIAvailability;
}

export type AssistantChoice =
  | { kind: 'provider' }
  | { kind: 'claude-builtin' }
  | { kind: 'native' }
  | { kind: 'device' }
  | { kind: 'chrome' }
  /** Nothing ready, but the on-device model can be downloaded: ask once, showing its size. */
  | { kind: 'offer-download' }
  | { kind: 'none' };

export function chooseAssistant(s: AssistantSituation): AssistantChoice {
  const chromeReady = s.chrome === 'available';
  switch (s.preference) {
    case 'provider':
      if (s.providerConfigured) return { kind: 'provider' };
      if (s.builtinClaude) return { kind: 'claude-builtin' };
      break;
    case 'device':
      if (s.deviceInstalled) return { kind: 'device' };
      if (s.nativeReady) return { kind: 'native' };
      if (s.deviceRunnable) return { kind: 'offer-download' };
      break;
    case 'chrome':
      if (chromeReady || s.chrome === 'downloadable' || s.chrome === 'downloading') return { kind: 'chrome' };
      break;
    case 'auto':
      break;
  }
  if (s.providerConfigured) return { kind: 'provider' };
  if (s.builtinClaude) return { kind: 'claude-builtin' };
  if (s.nativeReady) return { kind: 'native' };
  if (s.deviceInstalled) return { kind: 'device' };
  if (chromeReady) return { kind: 'chrome' };
  if (s.deviceRunnable) return { kind: 'offer-download' };
  if (s.chrome === 'downloadable' || s.chrome === 'downloading') return { kind: 'chrome' };
  return { kind: 'none' };
}

/** Where passage embeddings for semantic search come from. */
export type EmbeddingPreference = 'device' | 'provider' | 'off';

export type EmbedderChoice = { kind: 'device' } | { kind: 'provider' } | { kind: 'offer-download' } | { kind: 'keyword-only' };

/**
 * Semantic search always degrades to keyword search rather than failing: without vectors the
 * hybrid ranker simply has one list fewer.
 */
export function chooseEmbedder(s: { preference: EmbeddingPreference; deviceInstalled: boolean; providerEmbeddings: boolean }): EmbedderChoice {
  if (s.preference === 'off') return { kind: 'keyword-only' };
  if (s.preference === 'provider' && s.providerEmbeddings) return { kind: 'provider' };
  if (s.deviceInstalled) return { kind: 'device' };
  if (s.preference === 'provider') return { kind: 'keyword-only' };
  return { kind: 'offer-download' };
}
