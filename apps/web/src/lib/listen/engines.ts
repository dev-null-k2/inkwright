/**
 * The speech-to-text engines behind live transcripts and dictation, and the choice between them.
 *
 * - **On this device**: 16 kHz PCM is cut into ~10–30 s windows at pauses (`AudioWindower`, with
 *   voice activity detection so silence is skipped) and each window is transcribed by Whisper or
 *   Moonshine in the on-device AI worker. Nothing leaves the device.
 * - **Browser speech service**: the Web Speech API's continuous recognition, which gives live
 *   captions as you speak (most browsers process this on their maker's servers).
 * - **AI provider**: the same windows, sent as WAV to the provider's transcription endpoint.
 * - **Native** (hook only): the phone's own on-device recognizer (platform/native-speech.ts).
 *
 * Every engine reports segments with times from the start of the recording, so the transcript
 * lines up with ink no matter which engine produced it.
 */
import { create } from 'zustand';
import {
  AudioWindower,
  chooseTranscriber,
  encodeWav,
  formatBytes,
  segmentId,
  whereLabel,
  windowSegments,
  windowsOf,
  type AudioWindow,
  type ModelChoice,
  type SpeechChoice,
  type SpeechPreference,
  type Transcriber,
  type WindowerOptions,
} from '@inkstone/ai';
import type { SpeechWhere, TranscriptSegment } from '@inkstone/core';
import { safeStorage } from '../../platform/env.ts';
import { nativeSpeech, nativeSpeechReady } from '../../platform/native-speech.ts';
import { asrChoice, initLocalAI, isInstalled, localAISupported, localEngine, refOf } from '../localai.ts';
import { providerTranscriber } from '../agent/voice.ts';
import { startPcmCapture } from './capture.ts';

declare const __E2E__: boolean;
const E2E_BUILD = typeof __E2E__ !== 'undefined' && __E2E__;

// ---- Preferences ---------------------------------------------------------------------------------

export interface SpeechPrefs {
  /** Who transcribes (Settings › AI › Speech to text). */
  engine: SpeechPreference;
  /** Speech language (BCP-47); empty = the device's language. */
  language: string;
  /** Open the transcript panel when a recording starts. */
  autoOpen: boolean;
  /** Summarize each page and the whole recording when a recording ends. */
  autoSummary: boolean;
  /** Also add each page's summary to the page as a text note. */
  pageNotes: boolean;
}

const KEY = 'inkstone.speech.v1';
const DEFAULTS: SpeechPrefs = { engine: 'auto', language: '', autoOpen: true, autoSummary: true, pageNotes: false };

function loadPrefs(): SpeechPrefs {
  try {
    return { ...DEFAULTS, ...(JSON.parse(safeStorage.get(KEY) ?? '{}') as Partial<SpeechPrefs>) };
  } catch {
    return DEFAULTS;
  }
}

export const useSpeechPrefs = create<SpeechPrefs & { set: (p: Partial<SpeechPrefs>) => void }>((set, get) => ({
  ...loadPrefs(),
  set: (p) => {
    set(p);
    const { set: _s, ...rest } = get();
    safeStorage.set(KEY, JSON.stringify(rest));
  },
}));

export function speechLanguage(): string {
  return useSpeechPrefs.getState().language || (typeof navigator !== 'undefined' && navigator.language) || 'en-US';
}

const lang2 = (l: string) => l.toLowerCase().split(/[-_]/)[0] || 'en';

/** Window sizes; end-to-end tests shorten them (test builds only). */
function windowOptions(kind: 'live' | 'dictation'): WindowerOptions {
  const tuning = E2E_BUILD ? ((globalThis as any).__inkstoneSpeechTuning as WindowerOptions | undefined) : undefined;
  const base: WindowerOptions = kind === 'dictation' ? { minWindowMs: 4000, maxWindowMs: 20_000, pauseMs: 700 } : { minWindowMs: 10_000, maxWindowMs: 28_000, pauseMs: 600 };
  return { ...base, ...tuning };
}

// ---- Who transcribes -------------------------------------------------------------------------------

export interface ResolvedSpeech {
  choice: SpeechChoice;
  where?: SpeechWhere;
  /** "On this device · Moonshine Base", "Browser speech service", "Sent to OpenAI". */
  label: string;
  /** Stored with the transcript. */
  engineId: string;
  /** The on-device model (chosen or recommended), downloaded or not. */
  asr: ModelChoice | null;
  provider: Transcriber | null;
  /** Provider display name (privacy text). */
  providerName?: string;
}

type SpeechRecognitionLike = {
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

function speechRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  const w = globalThis as { SpeechRecognition?: new () => SpeechRecognitionLike; webkitSpeechRecognition?: new () => SpeechRecognitionLike };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** Works out which engine transcribes right now (no side effects; never starts the worker). */
export async function resolveSpeech(pref: SpeechPreference = useSpeechPrefs.getState().engine): Promise<ResolvedSpeech> {
  await initLocalAI();
  const asr = localAISupported() ? asrChoice(speechLanguage()) : null;
  const provider = await providerTranscriber().catch(() => null);
  const choice = chooseTranscriber({
    preference: pref,
    deviceInstalled: !!asr && isInstalled(asr),
    deviceRunnable: !!asr,
    nativeReady: await nativeSpeechReady(),
    browserSpeech: !!speechRecognitionCtor(),
    providerTranscription: !!provider,
  });
  const providerName = provider?.label.split(' · ')[0];
  const out: ResolvedSpeech = { choice, asr, provider, providerName, label: '', engineId: '' };
  switch (choice.kind) {
    case 'device':
      out.where = 'device';
      out.label = `${whereLabel('device')} · ${asr!.spec.label}`;
      out.engineId = `device:${asr!.spec.id}`;
      break;
    case 'native':
      out.where = 'device';
      out.label = `${whereLabel('device')} · ${nativeSpeech()?.label ?? 'system speech'}`;
      out.engineId = `native:${nativeSpeech()?.id ?? 'speech'}`;
      break;
    case 'browser':
      out.where = 'browser';
      out.label = whereLabel('browser');
      out.engineId = 'browser';
      break;
    case 'provider':
      out.where = 'provider';
      out.label = whereLabel('provider', providerName);
      out.engineId = `provider:${provider!.id}`;
      break;
    case 'offer-download':
      out.label = `Download ${asr!.spec.label} (${formatBytes(asr!.variant.bytes)}) to transcribe on this device`;
      break;
    case 'off':
      out.label = 'Speech to text is off';
      break;
    case 'none':
      out.label = choice.reason;
      break;
  }
  return out;
}

/** Transcribes one window with the device model or the provider. */
function windowTranscriber(r: ResolvedSpeech): ((w: AudioWindow, signal?: AbortSignal) => Promise<TranscriptSegment[]>) | null {
  const language = speechLanguage();
  if (r.choice.kind === 'device' && r.asr) {
    const ref = refOf(r.asr);
    const whisper = r.asr.spec.asr?.family === 'whisper';
    return async (w, signal) => {
      const res = await localEngine().transcribe!(ref, { audio: w.audio.slice(), ...(whisper ? { language: lang2(language) } : {}) }, signal);
      return windowSegments(w, res.text, res.chunks);
    };
  }
  if (r.choice.kind === 'provider' && r.provider) {
    const t = r.provider;
    return async (w, signal) => {
      const text = await t.transcribe(new Blob([encodeWav(w.audio) as BlobPart], { type: 'audio/wav' }), { language, signal });
      return windowSegments(w, text);
    };
  }
  return null;
}

// ---- Live sessions -------------------------------------------------------------------------------------

export interface LiveHandlers {
  /** New final segments (times from the start of the recording). */
  onSegments(segs: TranscriptSegment[]): void;
  /** Words not final yet (browser captions), or '' when none. */
  onPartial(text: string): void;
  /** A window is being transcribed (on-device / provider). */
  onWorking(busy: boolean): void;
  onError(message: string): void;
}

export interface LiveTranscription {
  readonly where: SpeechWhere;
  readonly label: string;
  readonly engineId: string;
  /** Stops listening and resolves once everything heard so far is transcribed. */
  stop(): Promise<void>;
  /** Stops at once, dropping work in flight. */
  cancel(): void;
}

/**
 * Starts transcribing `stream` live. `startedAt` is the recording's start (epoch ms); segment
 * times are relative to it. Throws when the resolved choice can't transcribe.
 */
export async function startLiveTranscription(stream: MediaStream, startedAt: number, r: ResolvedSpeech, h: LiveHandlers, kind: 'live' | 'dictation' = 'live'): Promise<LiveTranscription> {
  const meta = { where: r.where!, label: r.label, engineId: r.engineId };
  if (r.choice.kind === 'browser') return startBrowser(startedAt, h, meta);
  if (r.choice.kind === 'native') return startNative(startedAt, h, meta);
  const run = windowTranscriber(r);
  if (!run) throw new Error(r.label || 'No speech recognition is available.');
  const ac = new AbortController();
  let queue: Promise<void> = Promise.resolve();
  let pending = 0;
  const onWindow = (w: AudioWindow) => {
    pending++;
    h.onWorking(true);
    queue = queue.then(async () => {
      if (ac.signal.aborted) return;
      try {
        const segs = await run(w, ac.signal);
        if (segs.length && !ac.signal.aborted) h.onSegments(segs);
      } catch (e) {
        if (!ac.signal.aborted) h.onError((e as Error).message);
      } finally {
        if (--pending === 0) h.onWorking(false);
      }
    });
  };
  const windower = new AudioWindower(onWindow, windowOptions(kind));
  // Audio before capture starts (a few ms) is accounted for so times stay on the recording's clock.
  const lead = Math.max(0, Date.now() - startedAt);
  if (lead > 20) windower.push(new Float32Array(Math.round((lead / 1000) * 16_000)));
  const capture = await startPcmCapture(stream, (x) => windower.push(x));
  return {
    ...meta,
    async stop() {
      await capture.stop();
      windower.flush();
      await queue;
    },
    cancel() {
      ac.abort();
      void capture.stop();
    },
  };
}

/** Web Speech API: live captions; each final result becomes a segment timed by when it was heard. */
function startBrowser(startedAt: number, h: LiveHandlers, meta: Pick<LiveTranscription, 'where' | 'label' | 'engineId'>): LiveTranscription {
  const SR = speechRecognitionCtor()!;
  let active = true;
  let rec: SpeechRecognitionLike | null = null;
  let firstHeard = new Map<number, number>();
  let ended: (() => void) | null = null;
  let n = 0;
  const begin = () => {
    const r = new SR();
    r.lang = speechLanguage();
    r.continuous = true;
    r.interimResults = true;
    firstHeard = new Map();
    r.onresult = (e) => {
      const now = Date.now() - startedAt;
      let interim = '';
      const finals: TranscriptSegment[] = [];
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i]!;
        if (!firstHeard.has(i)) firstHeard.set(i, Math.max(0, now - 1200));
        const text = res[0].transcript.trim();
        if (res.isFinal) {
          if (text) {
            const startMs = firstHeard.get(i)!;
            finals.push({ id: segmentId(startMs, n++), startMs, endMs: Math.max(startMs, now), text: text[0]!.toUpperCase() + text.slice(1) });
          }
        } else interim += `${text} `;
      }
      if (finals.length) h.onSegments(finals);
      h.onPartial(interim.trim());
    };
    r.onerror = (e) => {
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      h.onError(e.error === 'not-allowed' ? 'The browser blocked speech recognition. Allow the microphone in site settings.' : e.error === 'network' ? 'The browser’s speech service could not be reached.' : `Speech recognition stopped (${e.error}).`);
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') active = false;
    };
    // Browsers end recognition after a pause or a minute; keep it going while recording.
    r.onend = () => {
      h.onPartial('');
      if (active) setTimeout(() => { if (active) begin(); }, 150);
      else ended?.();
    };
    rec = r;
    try { r.start(); } catch (e) { h.onError((e as Error).message); }
  };
  begin();
  return {
    ...meta,
    stop() {
      active = false;
      const done = new Promise<void>((res) => { ended = res; setTimeout(res, 2500); });
      try { rec?.stop(); } catch { ended?.(); }
      return done;
    },
    cancel() {
      active = false;
      try { rec?.abort(); } catch { /* already */ }
    },
  };
}

/** The phone's own recognizer through the native hook. */
async function startNative(startedAt: number, h: LiveHandlers, meta: Pick<LiveTranscription, 'where' | 'label' | 'engineId'>): Promise<LiveTranscription> {
  const ns = nativeSpeech();
  if (!ns) throw new Error('The system speech recognizer is not available.');
  const offset = Date.now() - startedAt;
  let n = 0;
  const session = await ns.start({ language: speechLanguage() }, (r) => {
    if (!r.final) return h.onPartial(r.text);
    h.onPartial('');
    const startMs = r.startMs + offset;
    if (r.text.trim()) h.onSegments([{ id: segmentId(startMs, n++), startMs, endMs: Math.max(startMs, r.endMs + offset), text: r.text.trim() }]);
  });
  return { ...meta, stop: () => session.stop(), cancel: () => void session.stop() };
}

// ---- Whole recordings ------------------------------------------------------------------------------

/**
 * Transcribes a saved recording (16 kHz PCM) window by window. The browser's speech service
 * can't take files, so "transcribe this recording" uses the device model or the provider.
 */
export async function transcribePcm(pcm: Float32Array, r: ResolvedSpeech, onProgress?: (done: number, total: number, segs: TranscriptSegment[]) => void, signal?: AbortSignal): Promise<TranscriptSegment[]> {
  const run = windowTranscriber(r);
  if (!run) throw new Error(r.choice.kind === 'browser' ? 'The browser’s speech service only transcribes live. Download an on-device speech model in Settings › AI to transcribe recordings.' : r.label || 'No speech recognition is available.');
  const windows = windowsOf(pcm, windowOptions('live'));
  const out: TranscriptSegment[] = [];
  for (let i = 0; i < windows.length; i++) {
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    out.push(...(await run(windows[i]!, signal)));
    onProgress?.(i + 1, windows.length, out);
  }
  return out;
}

/** For whole recordings the browser engine can't help: prefer the device, then the provider. */
export async function resolveForFiles(): Promise<ResolvedSpeech> {
  const r = await resolveSpeech();
  if (r.choice.kind !== 'browser' && r.choice.kind !== 'native') return r;
  const device = await resolveSpeech('device');
  if (device.choice.kind === 'device') return device;
  const provider = await resolveSpeech('provider');
  return provider.choice.kind === 'provider' ? provider : device;
}
