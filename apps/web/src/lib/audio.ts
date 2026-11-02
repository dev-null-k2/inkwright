import { newId, type AudioClip } from '@inkstone/core';

/**
 * Records lecture/meeting audio while you write. Every stroke carries its wall-clock time, so
 * playback can show the page as it was at any moment and tapping ink jumps to that moment.
 */
export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  startedAt = 0;
  /** Id of the clip being recorded (known from the start, so its live transcript can name it). */
  clipId = '';

  static supported() {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  get recording() { return this.rec?.state === 'recording'; }

  /** The microphone stream while recording (live transcription listens to the same audio). */
  get mediaStream(): MediaStream | null { return this.stream; }

  async start(): Promise<void> {
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: 48000 } : undefined);
    this.chunks = [];
    this.rec.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.startedAt = Date.now();
    this.clipId = newId();
  }

  async stop(): Promise<{ blob: Blob; clip: Omit<AudioClip, 'asset'> } | null> {
    const rec = this.rec;
    if (!rec) return null;
    const done = new Promise<void>((r) => (rec.onstop = () => r()));
    rec.stop();
    await done;
    this.stream?.getTracks().forEach((t) => t.stop());
    const type = rec.mimeType || 'audio/webm';
    const blob = new Blob(this.chunks, { type });
    this.rec = null;
    this.stream = null;
    return { blob, clip: { id: this.clipId || newId(), startedAt: this.startedAt, durationMs: Date.now() - this.startedAt, mimeType: type, title: `Recording ${new Date(this.startedAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}` } };
  }
}

export const audioExt = (mime: string) => (mime.includes('mp4') ? 'm4a' : mime.includes('ogg') ? 'ogg' : 'webm');

export function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), r = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`;
}
