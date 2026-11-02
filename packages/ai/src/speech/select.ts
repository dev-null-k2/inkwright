/**
 * Who turns speech into text. Private by default: a downloaded on-device model (or the phone's
 * own on-device recognizer through the native app) is used first; otherwise the browser's live
 * captions (Web Speech API); otherwise the configured AI provider's transcription endpoint.
 * Choosing "on this device" explicitly never falls back to anything that uploads audio — it offers
 * the download instead.
 */
import type { SpeechWhere } from '@inkwright/core';

export type SpeechPreference = 'auto' | 'device' | 'browser' | 'provider' | 'off';

export interface SpeechSituation {
  preference: SpeechPreference;
  /** The chosen on-device speech model is downloaded. */
  deviceInstalled: boolean;
  /** Some on-device speech model can run here (it may need downloading). */
  deviceRunnable: boolean;
  /** A native on-device recognizer (Android SpeechRecognizer on-device) is ready. */
  nativeReady: boolean;
  /** The browser has speech recognition (Web Speech API). */
  browserSpeech: boolean;
  /** The active AI provider has a transcription endpoint. */
  providerTranscription: boolean;
}

export type SpeechChoice =
  | { kind: 'device' }
  | { kind: 'native' }
  | { kind: 'browser' }
  | { kind: 'provider' }
  /** Nothing private is ready but a model can be downloaded: offer it, showing its size. */
  | { kind: 'offer-download' }
  | { kind: 'off' }
  | { kind: 'none'; reason: string };

export function chooseTranscriber(s: SpeechSituation): SpeechChoice {
  switch (s.preference) {
    case 'off':
      return { kind: 'off' };
    case 'device':
      if (s.deviceInstalled) return { kind: 'device' };
      if (s.nativeReady) return { kind: 'native' };
      if (s.deviceRunnable) return { kind: 'offer-download' };
      return { kind: 'none', reason: 'This device can’t run a speech model in the app.' };
    case 'browser':
      return s.browserSpeech ? { kind: 'browser' } : { kind: 'none', reason: 'This browser has no speech recognition.' };
    case 'provider':
      return s.providerTranscription ? { kind: 'provider' } : { kind: 'none', reason: 'The AI provider in Settings can’t transcribe audio (OpenAI, Groq and Gemini can).' };
    case 'auto':
      break;
  }
  if (s.deviceInstalled) return { kind: 'device' };
  if (s.nativeReady) return { kind: 'native' };
  if (s.browserSpeech) return { kind: 'browser' };
  if (s.providerTranscription) return { kind: 'provider' };
  if (s.deviceRunnable) return { kind: 'offer-download' };
  return { kind: 'none', reason: 'No speech recognition is available. Download an on-device speech model in Settings › AI.' };
}

export function whereOf(kind: 'device' | 'native' | 'browser' | 'provider'): SpeechWhere {
  return kind === 'native' ? 'device' : kind;
}

/** Plain-language label for the privacy indicator. */
export function whereLabel(where: SpeechWhere, detail?: string): string {
  if (where === 'device') return 'On this device';
  if (where === 'browser') return 'Browser speech service';
  return detail ? `Sent to ${detail}` : 'Sent to your AI provider';
}

/** One sentence on what leaves the device. */
export function whereExplanation(where: SpeechWhere, detail?: string): string {
  if (where === 'device') return 'Audio is transcribed on this device. Nothing is uploaded.';
  if (where === 'browser') return 'Your browser’s speech recognition hears the audio; most browsers send it to their maker’s servers (Google, Apple or Microsoft).';
  return `Audio is sent to ${detail ?? 'your AI provider'} to be transcribed, in short pieces as you record.`;
}
