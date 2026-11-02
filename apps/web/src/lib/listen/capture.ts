import { ASR_SAMPLE_RATE, resample } from '@inkwright/ai';

/**
 * Taps a microphone stream for 16 kHz mono PCM, alongside the MediaRecorder that saves the clip.
 * An AudioWorklet copies the samples off the audio thread in ~0.25 s batches; the worklet's code
 * is a Blob URL so it works in every build (the CSP allows `blob:` scripts). Browsers without
 * AudioWorklet fall back to a ScriptProcessorNode. When the AudioContext can't run at 16 kHz,
 * audio is resampled here.
 */
export interface PcmCapture {
  /** Actual capture rate before resampling (for diagnostics). */
  readonly contextRate: number;
  stop(): Promise<void>;
}

const WORKLET = `
class InkwrightPcm extends AudioWorkletProcessor {
  constructor() {
    super(); this.buf = new Float32Array(4096); this.n = 0;
    this.port.onmessage = () => { if (this.n) this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; this.port.postMessage('done'); };
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch) {
      if (this.n + ch.length > this.buf.length) { this.port.postMessage(this.buf.slice(0, this.n)); this.n = 0; }
      this.buf.set(ch, this.n); this.n += ch.length;
    }
    return true;
  }
}
registerProcessor('inkwright-pcm', InkwrightPcm);
`;

export async function startPcmCapture(stream: MediaStream, onPcm: (samples: Float32Array) => void): Promise<PcmCapture> {
  const Ctx: typeof AudioContext = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
  if (!Ctx) throw new Error('This browser can’t read microphone audio for transcription.');
  let ctx: AudioContext;
  try {
    ctx = new Ctx({ sampleRate: ASR_SAMPLE_RATE });
  } catch {
    ctx = new Ctx();
  }
  const rate = ctx.sampleRate;
  const emit = (x: Float32Array) => onPcm(rate === ASR_SAMPLE_RATE ? x : resample(x, rate, ASR_SAMPLE_RATE));
  const source = ctx.createMediaStreamSource(stream);
  // Silent sink: keeps the graph pulling audio without playing the microphone back.
  const mute = ctx.createGain();
  mute.gain.value = 0;
  mute.connect(ctx.destination);
  let node: AudioNode;
  let url: string | null = null;
  let flushed: (() => void) | null = null;
  if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
    url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    await ctx.audioWorklet.addModule(url);
    const w = new AudioWorkletNode(ctx, 'inkwright-pcm', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1, channelCountMode: 'explicit' });
    w.port.onmessage = (e) => { if (e.data instanceof Float32Array) emit(e.data); else flushed?.(); };
    node = w;
  } else {
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = (e) => emit(new Float32Array(e.inputBuffer.getChannelData(0)));
    node = sp;
  }
  source.connect(node);
  node.connect(mute);
  if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
  return {
    contextRate: rate,
    async stop() {
      try { source.disconnect(); } catch { /* already */ }
      if (node instanceof AudioWorkletNode) {
        // Collect the last fraction of a second still in the worklet's buffer.
        const w = node;
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, 400);
          flushed = () => { clearTimeout(t); resolve(); };
          w.port.postMessage('flush');
        });
        w.port.onmessage = null;
      }
      try { node.disconnect(); } catch { /* already */ }
      if (url) URL.revokeObjectURL(url);
      await ctx.close().catch(() => {});
    },
  };
}

/** Decodes a saved recording to 16 kHz mono (re-transcribing a clip after the fact). */
export async function decodeToPcm(bytes: Uint8Array): Promise<Float32Array> {
  const Ctx: typeof AudioContext = (globalThis as any).AudioContext ?? (globalThis as any).webkitAudioContext;
  if (!Ctx) throw new Error('This browser can’t decode audio.');
  const ctx = new Ctx();
  try {
    const buf = await ctx.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    const chans: Float32Array[] = [];
    for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
    const n = Math.min(...chans.map((c) => c.length));
    const mono = new Float32Array(n);
    for (const c of chans) for (let i = 0; i < n; i++) mono[i]! += c[i]! / chans.length;
    return resample(mono, buf.sampleRate, ASR_SAMPLE_RATE);
  } finally {
    await ctx.close().catch(() => {});
  }
}
