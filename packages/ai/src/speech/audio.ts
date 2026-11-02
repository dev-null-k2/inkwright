/**
 * Audio plumbing for speech to text: voice activity detection (so silence is never sent to a
 * model), cutting a live recording into ~10–30 s windows at natural pauses, resampling to the
 * 16 kHz mono that Whisper and Moonshine take, and WAV encoding for provider endpoints.
 *
 * All pure and synchronous: the app feeds PCM from an AudioWorklet; tests feed synthetic tones.
 */

export const ASR_SAMPLE_RATE = 16_000;

// ---- Voice activity detection --------------------------------------------------------------------

export interface VadOptions {
  sampleRate?: number;
  /** Analysis frame, ms (default 30). */
  frameMs?: number;
  /** Speech must be this many dB above the running noise floor (default 9). */
  marginDb?: number;
  /** Anything quieter than this is never speech, dBFS (default -55). */
  floorDb?: number;
  /** Speech keeps going this long after the level drops, ms (default 300). */
  hangoverMs?: number;
}

/**
 * An energy detector with an adaptive noise floor and hangover. Lecture rooms have steady
 * background noise (fans, projectors); the floor follows it down quickly and up slowly, so a
 * voice stands out even in a noisy room, and short gaps between words don't end the speech.
 * Not a neural VAD, but needs no download and is predictable — a missed quiet word costs a little
 * accuracy, while sending silence to a model costs time and makes Whisper invent text.
 */
export class EnergyVad {
  readonly frameSamples: number;
  private noiseDb = -60;
  private hang = 0;
  private onRun = 0;
  private readonly margin: number;
  private readonly floor: number;
  private readonly hangFrames: number;
  private frames = 0;

  constructor(opts: VadOptions = {}) {
    const sr = opts.sampleRate ?? ASR_SAMPLE_RATE;
    const frameMs = opts.frameMs ?? 30;
    this.frameSamples = Math.round((sr * frameMs) / 1000);
    this.margin = opts.marginDb ?? 9;
    this.floor = opts.floorDb ?? -55;
    this.hangFrames = Math.ceil((opts.hangoverMs ?? 300) / frameMs);
  }

  /** Level of one frame in dBFS. */
  static levelDb(frame: Float32Array): number {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += frame[i]! * frame[i]!;
    const rms = Math.sqrt(s / Math.max(1, frame.length));
    return 20 * Math.log10(rms + 1e-9);
  }

  /** Classifies one frame (`frameSamples` long). */
  frame(frame: Float32Array): { speech: boolean; db: number } {
    const db = EnergyVad.levelDb(frame);
    this.frames++;
    // Noise floor: falls fast, rises slowly (only while not in speech).
    if (db < this.noiseDb) this.noiseDb = this.noiseDb * 0.7 + db * 0.3;
    else if (this.hang === 0) this.noiseDb = this.noiseDb * 0.995 + db * 0.005;
    const loud = db > this.floor && db > this.noiseDb + this.margin;
    if (loud) {
      this.onRun++;
      // Two loud frames in a row start speech (a click is one frame); once in speech, stay.
      if (this.onRun >= 2 || this.hang > 0) this.hang = this.hangFrames;
    } else {
      this.onRun = 0;
      if (this.hang > 0) this.hang--;
    }
    return { speech: this.hang > 0, db };
  }
}

/** Speech regions (ms, `[start, end)`) in a whole buffer. */
export function speechRegions(audio: Float32Array, opts: VadOptions = {}): Array<[number, number]> {
  const vad = new EnergyVad(opts);
  const n = vad.frameSamples;
  const sr = opts.sampleRate ?? ASR_SAMPLE_RATE;
  const out: Array<[number, number]> = [];
  let start = -1;
  for (let i = 0; i + n <= audio.length; i += n) {
    const { speech } = vad.frame(audio.subarray(i, i + n));
    const t = (i / sr) * 1000;
    if (speech && start < 0) start = t;
    if (!speech && start >= 0) { out.push([start, t]); start = -1; }
  }
  if (start >= 0) out.push([start, (audio.length / sr) * 1000]);
  return out;
}

// ---- Windowing --------------------------------------------------------------------------------------

export interface AudioWindow {
  /** ms from the start of the recording. */
  startMs: number;
  endMs: number;
  /** 16 kHz mono PCM for exactly `[startMs, endMs)`. */
  audio: Float32Array;
  /** Speech inside the window, ms from the start of the recording. */
  speech: Array<[number, number]>;
}

export interface WindowerOptions extends VadOptions {
  /** Cut at the first pause once a window is this long (default 10 s). */
  minWindowMs?: number;
  /** Always cut by this length (default 28 s: under Whisper's 30 s context). */
  maxWindowMs?: number;
  /** A pause this long counts as a place to cut (default 600 ms). */
  pauseMs?: number;
  /** Audio kept around speech when trimming a window, ms (default 250). */
  padMs?: number;
}

/**
 * Cuts a live 16 kHz stream into windows for transcription: at the first natural pause after
 * `minWindowMs`, or at the quietest moment of the last few seconds when `maxWindowMs` is reached.
 * Windows are trimmed to their speech (plus padding); windows without speech are dropped, so
 * silence is never transcribed. Times are exact sample positions from the start of the stream.
 */
export class AudioWindower {
  private readonly sr: number;
  private readonly vad: EnergyVad;
  private readonly frameN: number;
  private readonly o: Required<Omit<WindowerOptions, keyof VadOptions>>;
  /** Samples of the current window (from `winStart`). */
  private buf: Float32Array = new Float32Array(ASR_SAMPLE_RATE * 4);
  private len = 0;
  private winStart = 0;
  /** Samples analysed by the VAD (absolute). */
  private analysed = 0;
  /** Absolute sample index of each analysed frame start in this window, with speech flag and level. */
  private frames: { at: number; speech: boolean; db: number }[] = [];
  private silenceRun = 0;

  constructor(private readonly onWindow: (w: AudioWindow) => void, opts: WindowerOptions = {}) {
    this.sr = opts.sampleRate ?? ASR_SAMPLE_RATE;
    this.vad = new EnergyVad(opts);
    this.frameN = this.vad.frameSamples;
    this.o = { minWindowMs: opts.minWindowMs ?? 10_000, maxWindowMs: opts.maxWindowMs ?? 28_000, pauseMs: opts.pauseMs ?? 600, padMs: opts.padMs ?? 250 };
  }

  /** Total audio received, ms. */
  get receivedMs(): number {
    return ((this.winStart + this.len) / this.sr) * 1000;
  }

  private ms = (samples: number) => (samples / this.sr) * 1000;
  private samples = (ms: number) => Math.round((ms * this.sr) / 1000);

  push(chunk: Float32Array): void {
    if (this.len + chunk.length > this.buf.length) {
      const next = new Float32Array(Math.max(this.buf.length * 2, this.len + chunk.length));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    // Analyse whole frames.
    while (this.analysed + this.frameN <= this.winStart + this.len) {
      const off = this.analysed - this.winStart;
      const { speech, db } = this.vad.frame(this.buf.subarray(off, off + this.frameN));
      this.frames.push({ at: this.analysed, speech, db });
      this.analysed += this.frameN;
      this.silenceRun = speech ? 0 : this.silenceRun + this.frameN;
      this.maybeCut();
    }
  }

  private hasSpeech(): boolean {
    return this.frames.some((f) => f.speech);
  }

  private maybeCut() {
    const length = this.analysed - this.winStart;
    const speech = this.hasSpeech();
    if (!speech) {
      // Pure silence so far: keep only a little of it (leading context), never grow unbounded.
      const keep = this.samples(this.o.padMs);
      if (length > this.samples(this.o.pauseMs) * 2 + keep) this.cutAt(this.analysed - keep, false);
      return;
    }
    if (length >= this.samples(this.o.minWindowMs) && this.silenceRun >= this.samples(this.o.pauseMs)) {
      this.cutAt(this.analysed - Math.floor(this.silenceRun / 2), true);
      return;
    }
    if (length >= this.samples(this.o.maxWindowMs)) {
      // Cut at the quietest frame of the last 3 seconds.
      const from = this.analysed - this.samples(3000);
      let best = this.frames[this.frames.length - 1]!;
      for (const f of this.frames) if (f.at >= from && f.db < best.db) best = f;
      this.cutAt(best.at + Math.floor(this.frameN / 2), true);
    }
  }

  /** Emits `[winStart, at)` (when `emit`), keeps the rest as the start of the next window. */
  private cutAt(at: number, emit: boolean) {
    at = Math.max(this.winStart, Math.min(at, this.winStart + this.len));
    if (emit) this.emit(this.winStart, at);
    const drop = at - this.winStart;
    this.buf.copyWithin(0, drop, this.len);
    this.len -= drop;
    this.winStart = at;
    this.frames = this.frames.filter((f) => f.at >= at);
  }

  private emit(from: number, to: number) {
    const regions: Array<[number, number]> = [];
    let start = -1;
    for (const f of this.frames) {
      if (f.at >= to) break;
      if (f.speech && start < 0) start = f.at;
      if (!f.speech && start >= 0) { regions.push([start, f.at]); start = -1; }
    }
    if (start >= 0) regions.push([start, Math.min(to, this.analysed)]);
    if (!regions.length) return;
    const pad = this.samples(this.o.padMs);
    const a = Math.max(from, regions[0]![0] - pad);
    const b = Math.min(to, regions[regions.length - 1]![1] + pad);
    if (b - a < this.samples(150)) return;
    const audio = this.buf.slice(a - this.winStart, b - this.winStart);
    this.onWindow({ startMs: this.ms(a), endMs: this.ms(b), audio, speech: regions.map(([s, e]) => [this.ms(s), this.ms(e)]) });
  }

  /** Emits whatever speech is buffered (the recording stopped). */
  flush(): void {
    // Analyse the last partial frame too.
    const rest = this.winStart + this.len - this.analysed;
    if (rest > 0) {
      const off = this.analysed - this.winStart;
      const frame = new Float32Array(this.frameN);
      frame.set(this.buf.subarray(off, off + rest));
      const { speech, db } = this.vad.frame(frame);
      this.frames.push({ at: this.analysed, speech, db });
      this.analysed += rest;
    }
    if (this.len) this.cutAt(this.winStart + this.len, true);
  }
}

/**
 * Cuts a whole recording (decoded after the fact) into windows, exactly as live transcription
 * would have, so "transcribe this recording" and live transcripts line up the same way.
 */
export function windowsOf(audio: Float32Array, opts: WindowerOptions = {}): AudioWindow[] {
  const out: AudioWindow[] = [];
  const w = new AudioWindower((x) => out.push(x), opts);
  const step = 16_384;
  for (let i = 0; i < audio.length; i += step) w.push(audio.subarray(i, Math.min(audio.length, i + step)));
  w.flush();
  return out;
}

// ---- Resampling and WAV ------------------------------------------------------------------------------

/** Linear-interpolation resampling to `to` Hz (with a box pre-filter when downsampling). */
export function resample(input: Float32Array, from: number, to = ASR_SAMPLE_RATE): Float32Array {
  if (from === to) return input;
  const ratio = from / to;
  const n = Math.floor(input.length / ratio);
  const out = new Float32Array(n);
  const box = ratio > 1 ? Math.floor(ratio) : 1;
  for (let i = 0; i < n; i++) {
    const x = i * ratio;
    const i0 = Math.floor(x);
    if (box > 1) {
      let s = 0, c = 0;
      for (let k = i0; k < i0 + box && k < input.length; k++) { s += input[k]!; c++; }
      out[i] = c ? s / c : 0;
    } else {
      const f = x - i0;
      out[i] = (input[i0] ?? 0) * (1 - f) + (input[i0 + 1] ?? input[i0] ?? 0) * f;
    }
  }
  return out;
}

/** Mixes interleaved or planar channels down to mono. */
export function toMono(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0]!;
  const n = Math.min(...channels.map((c) => c.length));
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < n; i++) out[i]! += c[i]! / channels.length;
  return out;
}

/** 16-bit PCM WAV bytes (what every transcription endpoint accepts). */
export function encodeWav(audio: Float32Array, sampleRate = ASR_SAMPLE_RATE): Uint8Array {
  const bytes = new Uint8Array(44 + audio.length * 2);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF');
  v.setUint32(4, 36 + audio.length * 2, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, 'data');
  v.setUint32(40, audio.length * 2, true);
  for (let i = 0; i < audio.length; i++) {
    const s = Math.max(-1, Math.min(1, audio[i]!));
    v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}

/** Reads a 16-bit PCM WAV (tests and fixtures). */
export function decodeWav(bytes: Uint8Array): { audio: Float32Array; sampleRate: number } {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 12, sampleRate = 0, channels = 1, bits = 16;
  while (o + 8 <= bytes.length) {
    const id = String.fromCharCode(bytes[o]!, bytes[o + 1]!, bytes[o + 2]!, bytes[o + 3]!);
    const size = v.getUint32(o + 4, true);
    if (id === 'fmt ') { channels = v.getUint16(o + 10, true); sampleRate = v.getUint32(o + 12, true); bits = v.getUint16(o + 22, true); }
    if (id === 'data') {
      if (bits !== 16) throw new Error('Only 16-bit WAV is supported');
      const frames = Math.floor(size / 2 / channels);
      const out = new Float32Array(frames);
      for (let i = 0; i < frames; i++) {
        let s = 0;
        for (let c = 0; c < channels; c++) s += v.getInt16(o + 8 + (i * channels + c) * 2, true) / 0x8000;
        out[i] = s / channels;
      }
      return { audio: out, sampleRate };
    }
    o += 8 + size + (size % 2);
  }
  throw new Error('No audio data in WAV');
}
