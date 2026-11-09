import { newId, type AudioClip, type SideEnergy } from '@inkwright/core';

/**
 * Records lecture/meeting audio while you write. Every stroke carries its wall-clock time, so
 * playback can show the page as it was at any moment and tapping ink jumps to that moment.
 */
export class CallAudioError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CallAudioError';
  }
}

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private stream: MediaStream | null = null;
  /** Every track opened (microphone, the shared call), stopped at the end. */
  private sources: MediaStream[] = [];
  private ctx: AudioContext | null = null;
  private meter: ReturnType<typeof setInterval> | null = null;
  startedAt = 0;
  /** Id of the clip being recorded (known from the start, so its live transcript can name it). */
  clipId = '';
  /** Recording both sides of a call (the microphone and the shared call's sound). */
  call = false;
  /** Loudness of each side every 100 ms while recording a call (who was speaking). */
  energy: SideEnergy[] = [];

  static supported() {
    return typeof MediaRecorder !== 'undefined' && !!navigator.mediaDevices?.getUserMedia;
  }

  /** The browser can capture a tab's or the system's sound (Chrome and Edge on desktop; WebView2). */
  static callSupported() {
    return typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getDisplayMedia && typeof AudioContext !== 'undefined' && !/Android|iPhone|iPad/.test(navigator.userAgent);
  }

  get recording() { return this.rec?.state === 'recording'; }

  /** The stream being recorded (live transcription listens to the same audio: both sides of a call). */
  get mediaStream(): MediaStream | null { return this.stream; }

  /**
   * Starts recording the microphone, or with `call` both the microphone and the sound of a call:
   * the browser asks which tab, window or screen to share (with its audio); the picture is not
   * kept. The two are mixed into one recording, and each side's loudness is measured so the
   * transcript can say who spoke.
   */
  async start(opts: { call?: boolean } = {}): Promise<void> {
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    this.sources = [mic];
    this.energy = [];
    this.call = false;
    this.stream = mic;
    if (opts.call) {
      let shared: MediaStream;
      try {
        shared = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false }, ...({ systemAudio: 'include', selfBrowserSurface: 'exclude', preferCurrentTab: false } as object) } as DisplayMediaStreamOptions);
      } catch (e) {
        mic.getTracks().forEach((t) => t.stop());
        throw new CallAudioError((e as Error).name === 'NotAllowedError' ? 'Sharing was cancelled. Choose the call’s tab or window, with “Share audio” on.' : `The call’s sound can’t be captured here: ${(e as Error).message}`);
      }
      if (!shared.getAudioTracks().length) {
        shared.getTracks().forEach((t) => t.stop());
        mic.getTracks().forEach((t) => t.stop());
        throw new CallAudioError('No sound was shared. Share the call’s tab or window again and turn on “Share tab audio” (or “Share system audio”).');
      }
      shared.getVideoTracks().forEach((t) => t.stop());
      this.sources.push(shared);
      const ctx = new AudioContext();
      this.ctx = ctx;
      const dest = ctx.createMediaStreamDestination();
      const a = ctx.createMediaStreamSource(mic);
      const b = ctx.createMediaStreamSource(new MediaStream(shared.getAudioTracks()));
      const ma = ctx.createAnalyser();
      const mb = ctx.createAnalyser();
      ma.fftSize = mb.fftSize = 1024;
      a.connect(ma); b.connect(mb);
      a.connect(dest); b.connect(dest);
      const buf = new Float32Array(1024);
      const rms = (an: AnalyserNode) => { an.getFloatTimeDomainData(buf); let x = 0; for (let i = 0; i < buf.length; i++) x += buf[i]! * buf[i]!; return Math.sqrt(x / buf.length); };
      this.meter = setInterval(() => { if (this.startedAt) this.energy.push({ t: Date.now() - this.startedAt, me: rms(ma), them: rms(mb) }); }, 100);
      // The call ending (the shared tab closed) ends nothing here: the microphone keeps recording.
      this.stream = dest.stream;
      this.call = true;
    }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg'].find((m) => MediaRecorder.isTypeSupported?.(m)) ?? '';
    this.rec = new MediaRecorder(this.stream, mime ? { mimeType: mime, audioBitsPerSecond: this.call ? 64000 : 48000 } : undefined);
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
    if (this.meter) clearInterval(this.meter);
    this.meter = null;
    for (const src of this.sources) src.getTracks().forEach((t) => t.stop());
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => {});
    this.ctx = null;
    this.sources = [];
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
