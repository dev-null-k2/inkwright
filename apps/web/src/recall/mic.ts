/**
 * Optional microphone transcription for the memory timeline, reusing the app's speech pipeline
 * (lib/listen/engines.ts: voice activity detection, ~10–30 s windows, Whisper or Moonshine in the
 * on-device AI worker, or the phone's own recognizer). Only engines that run on this device are
 * allowed: the browser speech service and AI providers would send audio away, so the timeline
 * refuses them rather than quietly falling back. No audio is kept — only the redacted text.
 */
import type { TranscriptSegment } from '@inkwright/core';

export interface MicSession {
  label: string;
  stop(): Promise<void>;
}

export class MicNotOnDeviceError extends Error {
  constructor(label: string) {
    super(`The memory timeline only transcribes on this device. ${label ? `${label}. ` : ''}Download an on-device speech model in Settings › AI › On-device AI.`);
    this.name = 'MicNotOnDeviceError';
  }
}

export async function startMicTranscription(onText: (segments: Array<{ at: number; end: number; text: string; engine: string }>) => void, onError: (message: string) => void): Promise<MicSession> {
  const { resolveSpeech, startLiveTranscription } = await import('../lib/listen/engines.ts');
  const r = await resolveSpeech('device');
  if (r.choice.kind !== 'device' && r.choice.kind !== 'native') throw new MicNotOnDeviceError(r.label);
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  const startedAt = Date.now();
  try {
    const live = await startLiveTranscription(stream, startedAt, r, {
      onSegments: (segs: TranscriptSegment[]) => onText(segs.filter((s) => s.text.trim()).map((s) => ({ at: startedAt + s.startMs, end: startedAt + s.endMs, text: s.text.trim(), engine: r.engineId }))),
      onPartial: () => {},
      onWorking: () => {},
      onError,
    });
    return {
      label: r.label,
      async stop() {
        await live.stop().catch(() => {});
        for (const t of stream.getTracks()) t.stop();
      },
    };
  } catch (e) {
    for (const t of stream.getTracks()) t.stop();
    throw e;
  }
}
