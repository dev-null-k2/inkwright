import { describe, expect, it } from 'vitest';
import {
  ASR_SAMPLE_RATE,
  LocalEngineClient,
  getLocalModel,
  modelRef,
  pickVariant,
  serveLocalEngine,
  windowSegments,
  windowsOf,
  type LocalEngine,
  type ModelRef,
  type TranscribeRequest,
  type TranscribeResult,
} from '../src/index.ts';

/**
 * A fake speech model for the worker protocol: "hears" how long each burst of tone is, so a
 * window with two bursts becomes two timestamped sentences (Whisper-like) or plain text.
 */
class FakeAsr implements LocalEngine {
  calls: { model: ModelRef; samples: number; language?: string }[] = [];
  async status() { return { installed: true, bytesOnDevice: 1 }; }
  async download() {}
  async remove() {}
  async embed() { return []; }
  async generate() { return { text: '', inputTokens: 0, outputTokens: 0, stopReason: 'stop' as const }; }
  async unload() {}
  async transcribe(model: ModelRef, req: TranscribeRequest, signal?: AbortSignal): Promise<TranscribeResult> {
    this.calls.push({ model, samples: req.audio.length, language: req.language });
    await new Promise((r) => setTimeout(r, 5));
    if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
    // Find bursts (|x| > 0.05) and name each by its length.
    const bursts: [number, number][] = [];
    let start = -1, quiet = 0;
    for (let i = 0; i < req.audio.length; i++) {
      const loud = Math.abs(req.audio[i]!) > 0.05;
      if (loud) { if (start < 0) start = i; quiet = 0; }
      else if (start >= 0 && ++quiet > 1600) { bursts.push([start, i - quiet]); start = -1; quiet = 0; }
    }
    if (start >= 0) bursts.push([start, req.audio.length]);
    const sec = (n: number) => Math.round((n / ASR_SAMPLE_RATE) * 10) / 10;
    const chunks = bursts.map(([a, b]) => ({ text: ` A burst of ${sec(b - a)} seconds.`, start: sec(a), end: sec(b) }));
    return model.asr?.timestamps ? { text: chunks.map((c) => c.text).join(''), chunks } : { text: chunks.map((c) => c.text).join('') };
  }
}

function connected(engine: LocalEngine) {
  const ch = new MessageChannel();
  const stop = serveLocalEngine(ch.port1 as any, engine);
  const client = new LocalEngineClient(ch.port2 as any);
  return { client, close: () => { stop(); client.dispose(); ch.port1.close(); ch.port2.close(); } };
}

const ref = (id: string) => { const s = getLocalModel(id)!; return modelRef(s, pickVariant(s, { webgpu: false, shaderF16: false })!); };

function tone(plan: [number, boolean][]): Float32Array {
  const out = new Float32Array(Math.round(plan.reduce((a, [s]) => a + s, 0) * ASR_SAMPLE_RATE));
  let i = 0;
  for (const [s, on] of plan) for (let k = 0; k < Math.round(s * ASR_SAMPLE_RATE); k++, i++) out[i] = on ? 0.3 * Math.sin((2 * Math.PI * 200 * i) / ASR_SAMPLE_RATE) * (0.6 + 0.4 * Math.sin((2 * Math.PI * 4 * i) / ASR_SAMPLE_RATE)) : 0.0005 * Math.sin(i);
  return out;
}

describe('speech over the worker protocol', () => {
  it('carries module dtypes and the model family to the worker', () => {
    const webgpu = modelRef(getLocalModel('whisper-base')!, pickVariant(getLocalModel('whisper-base')!, { webgpu: true, shaderF16: true })!);
    expect(webgpu.moduleDtypes).toEqual({ encoder_model: 'fp32', decoder_model_merged: 'q4' });
    expect(webgpu.asr).toEqual({ family: 'whisper', timestamps: true });
    expect(ref('moonshine-tiny').asr).toEqual({ family: 'moonshine', timestamps: false });
  });

  it('transcribes windows, transferring the audio, with timestamps from the model', async () => {
    const asr = new FakeAsr();
    const { client, close } = connected(asr);
    const audio = tone([[0.5, false], [2, true], [1, false], [3, true], [0.5, false]]);
    const req = { audio: audio.slice(), language: 'de' };
    const res = await client.transcribe(ref('whisper-base'), req);
    expect(req.audio.length).toBe(0); // transferred, not copied
    expect(asr.calls[0]).toMatchObject({ samples: audio.length, language: 'de' });
    expect(res.chunks?.map((c) => c.text.trim())).toEqual(['A burst of 2 seconds.', 'A burst of 3 seconds.']);
    expect(res.chunks?.[1]!.start).toBeCloseTo(3.5, 1);
    close();
  });

  it('copies a view instead of detaching the caller’s whole buffer', async () => {
    const { client, close } = connected(new FakeAsr());
    const big = tone([[2, true], [2, true]]);
    const view = big.subarray(0, ASR_SAMPLE_RATE);
    await client.transcribe(ref('moonshine-tiny'), { audio: view });
    expect(big.length).toBe(4 * ASR_SAMPLE_RATE);
    close();
  });

  it('a whole recording becomes segments on the recording’s clock', async () => {
    const { client, close } = connected(new FakeAsr());
    const audio = tone([[1, false], [3, true], [1.2, false], [4, true], [2, false], [2, true], [1, false]]);
    const windows = windowsOf(audio, { minWindowMs: 3000 });
    expect(windows.length).toBeGreaterThanOrEqual(2);
    const segs = [];
    for (const w of windows) {
      const r = await client.transcribe(ref('whisper-base'), { audio: w.audio.slice() });
      segs.push(...windowSegments(w, r.text, r.chunks));
    }
    expect(segs.map((s) => s.text)).toEqual(['A burst of 3 seconds.', 'A burst of 4 seconds.', 'A burst of 2 seconds.']);
    expect(segs[0]!.startMs).toBeGreaterThan(900);
    expect(segs[0]!.startMs).toBeLessThan(1100);
    expect(segs[1]!.startMs).toBeGreaterThan(5100);
    expect(segs[1]!.startMs).toBeLessThan(5300);
    expect(segs[2]!.startMs).toBeGreaterThan(11_100);
    // Plain-text models get times from the speech regions instead.
    const w = windows[0]!;
    const plain = await client.transcribe(ref('moonshine-tiny'), { audio: w.audio.slice() });
    expect(plain.chunks).toBeUndefined();
    expect(windowSegments(w, plain.text)[0]!.startMs).toBeCloseTo(w.speech[0]![0], -2);
    close();
  });

  it('cancels, and reports engines that cannot transcribe', async () => {
    const { client, close } = connected(new FakeAsr());
    const ac = new AbortController();
    const p = client.transcribe(ref('moonshine-tiny'), { audio: tone([[1, true]]) }, ac.signal);
    ac.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    close();
    const plain = { ...new FakeAsr(), transcribe: undefined } as unknown as LocalEngine;
    const c2 = connected(plain);
    await expect(c2.client.transcribe(ref('moonshine-tiny'), { audio: new Float32Array(10) })).rejects.toThrow(/cannot transcribe/);
    c2.close();
  });
});
