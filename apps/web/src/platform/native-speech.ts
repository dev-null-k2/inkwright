/**
 * Hook for the host app's own on-device speech recognizer — on Android, `SpeechRecognizer` with
 * `createOnDeviceSpeechRecognizer` (Android 12+) or `EXTRA_PREFER_OFFLINE`; on iOS,
 * `SFSpeechRecognizer` with `requiresOnDeviceRecognition`. A native recognizer uses the phone's
 * DSP/NPU and needs no download, so when it is ready it counts as "on this device" in
 * `chooseTranscriber` (packages/ai/src/speech/select.ts), right after a downloaded web model.
 *
 * Only the interface lives here: the Android shell does not implement it yet. To add it, give
 * `InkwrightNativePlugin` (native.ts) `speechAvailability`, `speechStart` and `speechStop` methods
 * plus a `speechResult` listener, and register an adapter at startup:
 *
 * ```ts
 * registerNativeSpeech({
 *   id: 'android-ondevice', label: 'Android speech (on this phone)',
 *   availability: () => InkwrightNative.speechAvailability().then((r) => r.state),
 *   start: (opts, onResult) => … InkwrightNative.speechStart(opts) + 'speechResult' listener …,
 * });
 * ```
 *
 * Results are reported with times relative to `start`, so the app aligns them with ink exactly as
 * it does for its own transcribers.
 */
export type NativeSpeechAvailability = 'available' | 'downloadable' | 'unavailable';

export interface NativeSpeechResult {
  text: string;
  /** Final (true) or still changing (false). */
  final: boolean;
  /** ms since `start` was called. */
  startMs: number;
  endMs: number;
}

export interface NativeSpeechSession {
  /** Stops listening; resolves after the last final result was delivered. */
  stop(): Promise<void>;
}

export interface NativeSpeech {
  readonly id: string;
  /** Shown in the privacy indicator, e.g. "Android speech (on this phone)". */
  readonly label: string;
  availability(): Promise<NativeSpeechAvailability>;
  /** Starts continuous on-device recognition of the microphone. */
  start(opts: { language?: string }, onResult: (r: NativeSpeechResult) => void): Promise<NativeSpeechSession>;
}

let registered: NativeSpeech | null = null;

/** Called once by the native shell at startup. */
export function registerNativeSpeech(s: NativeSpeech | null): void {
  registered = s;
}

export function nativeSpeech(): NativeSpeech | null {
  return registered;
}

export async function nativeSpeechReady(): Promise<boolean> {
  if (!registered) return false;
  try {
    return (await registered.availability()) === 'available';
  } catch {
    return false;
  }
}
