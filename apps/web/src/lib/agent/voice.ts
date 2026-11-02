/**
 * Talking to the assistant: push-to-talk speech input and optional spoken replies.
 *
 * Input uses the browser's speech recognition (Web Speech API) when it exists, otherwise records
 * audio and sends it to the configured provider's transcription endpoint (`Transcriber` from
 * @inkstone/ai — an on-device engine can be added by implementing that interface). Spoken replies
 * use the system voices (speechSynthesis) and are off by default.
 */
import { create } from 'zustand';
import { getProviderInfo, transcriberForProvider, type Transcriber } from '@inkstone/ai';
import { safeStorage } from '../../platform/env.ts';
import { useSettings } from '../../state/settings.ts';
import { getSecret } from '../secrets.ts';

export interface VoicePrefs {
  /** Read the assistant's replies aloud. */
  speakReplies: boolean;
  /** `auto`: browser recognition when available, else the AI provider. */
  input: 'auto' | 'browser' | 'provider';
}

const KEY = 'inkstone.voice.v1';

function loadPrefs(): VoicePrefs {
  try {
    return { speakReplies: false, input: 'auto', ...JSON.parse(safeStorage.get(KEY) ?? '{}') };
  } catch {
    return { speakReplies: false, input: 'auto' };
  }
}

export const useVoicePrefs = create<VoicePrefs & { set: (p: Partial<VoicePrefs>) => void }>((set, get) => ({
  ...loadPrefs(),
  set: (p) => {
    set(p);
    const { set: _s, ...rest } = get();
    safeStorage.set(KEY, JSON.stringify(rest));
  },
}));

type SpeechRecognitionCtor = new () => {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};

function speechRecognition(): SpeechRecognitionCtor | null {
  const w = globalThis as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export const browserSpeechSupported = () => !!speechRecognition();

/** The configured provider's transcriber, if it has one. */
export async function providerTranscriber(): Promise<Transcriber | null> {
  const s = useSettings.getState().ai;
  const cfg = s.providers.find((p) => p.id === s.activeId);
  if (!cfg) return null;
  const info = getProviderInfo(cfg.providerId);
  const apiKey = cfg.hasKey ? (await getSecret(`ai-key:${cfg.id}`)) ?? undefined : undefined;
  return transcriberForProvider({ providerId: cfg.providerId, label: info?.label ?? cfg.label, baseUrl: cfg.baseUrl || info?.defaultBaseUrl || '', apiKey });
}

export interface Listening {
  engine: 'browser' | 'provider';
  /** Stops listening and resolves with the transcript. */
  stop(): Promise<string>;
  cancel(): void;
}

/** Can the assistant hear you here at all? */
export async function voiceInputAvailable(): Promise<boolean> {
  const p = useVoicePrefs.getState().input;
  if (p !== 'provider' && browserSpeechSupported()) return true;
  return typeof MediaRecorder !== 'undefined' && !!(await providerTranscriber());
}

/** Starts push-to-talk. `onPartial` receives live text where the engine provides it. */
export async function startListening(opts: { language?: string; onPartial?: (text: string) => void } = {}): Promise<Listening> {
  const pref = useVoicePrefs.getState().input;
  const SR = speechRecognition();
  if (SR && pref !== 'provider') {
    const rec = new SR();
    rec.lang = opts.language || navigator.language || 'en-US';
    rec.continuous = true;
    rec.interimResults = true;
    let finalText = '';
    let error: string | null = null;
    let ended!: () => void;
    const done = new Promise<void>((r) => (ended = r));
    rec.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i]!;
        if (r.isFinal) finalText += r[0].transcript;
        else interim += r[0].transcript;
      }
      opts.onPartial?.((finalText + interim).trim());
    };
    rec.onerror = (e) => { error = e.error; };
    rec.onend = () => ended();
    rec.start();
    return {
      engine: 'browser',
      async stop() {
        rec.stop();
        await done;
        if (error && error !== 'no-speech' && error !== 'aborted') throw new Error(error === 'not-allowed' ? 'Microphone access was blocked. Allow it in your browser’s site settings.' : `Speech recognition failed (${error}).`);
        return finalText.trim();
      },
      cancel() { rec.abort(); },
    };
  }
  const t = await providerTranscriber();
  if (!t || typeof MediaRecorder === 'undefined') throw new Error('Voice input needs a browser with speech recognition, or an AI provider that can transcribe (OpenAI, Groq or Gemini).');
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
  const mr = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const chunks: Blob[] = [];
  mr.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  mr.start(250);
  const release = () => stream.getTracks().forEach((x) => x.stop());
  return {
    engine: 'provider',
    async stop() {
      const stopped = new Promise<void>((r) => (mr.onstop = () => r()));
      mr.stop();
      await stopped;
      release();
      const blob = new Blob(chunks, { type: mr.mimeType || 'audio/webm' });
      if (blob.size < 800) return '';
      return t.transcribe(blob, { language: opts.language || navigator.language });
    },
    cancel() { try { mr.stop(); } catch { /* already stopped */ } release(); },
  };
}

/** Markdown → something pleasant to hear. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/^\s*[-*•]\s+\[[ xX]\]\s*/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/[*_~]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function speak(text: string, language?: string) {
  const synth = (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === 'undefined') return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(speakable(text).slice(0, 2000));
  u.lang = language || navigator.language || 'en-US';
  synth.speak(u);
}

export function stopSpeaking() {
  (globalThis as { speechSynthesis?: SpeechSynthesis }).speechSynthesis?.cancel();
}

export const speechOutputSupported = () => typeof (globalThis as { speechSynthesis?: unknown }).speechSynthesis !== 'undefined';
