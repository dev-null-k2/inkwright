import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decodeWav, getLocalModel, resample, windowSegments, windowsOf } from '../src/index.ts';

/**
 * Opt-in (INKSTONE_REAL_MODELS=1 or =asr): runs the real on-device speech models with the same
 * transformers.js calls the app's worker makes (pipeline, per-file dtypes, Whisper timestamps),
 * in Node, on a public-domain clip (President Kennedy's 1961 inaugural address, from the
 * transformers.js docs dataset), cut into windows by our VAD exactly as a live recording is.
 */
const ENABLED = !!process.env.INKSTONE_REAL_MODELS;
const CLIP = 'https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav';

async function clip16k(): Promise<Float32Array> {
  const res = await fetch(CLIP);
  expect(res.ok).toBe(true);
  const { audio, sampleRate } = decodeWav(new Uint8Array(await res.arrayBuffer()));
  return resample(audio, sampleRate);
}

async function transcribeWith(id: string) {
  const T = await import('@huggingface/transformers');
  (T.env as any).cacheDir = join(tmpdir(), 'inkstone-asr-models');
  const spec = getLocalModel(id)!;
  const variant = spec.variants.find((v) => v.device === 'wasm')!;
  const pipe: any = await T.pipeline('automatic-speech-recognition', spec.repo, { dtype: (variant.moduleDtypes ?? variant.dtype) as any });
  const audio = await clip16k();
  const windows = windowsOf(audio, { minWindowMs: 4000 });
  const segs = [];
  for (const w of windows) {
    const whisper = spec.asr!.family === 'whisper';
    const out = await pipe(w.audio, whisper ? { return_timestamps: true, task: 'transcribe', language: 'en' } : { max_new_tokens: Math.ceil((w.audio.length / 16_000) * 6.5) + 8 });
    const chunks = out.chunks?.map((c: any) => ({ text: c.text, start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? null }));
    segs.push(...windowSegments(w, out.text, chunks));
  }
  await pipe.dispose?.();
  return { windows, segs, text: segs.map((s) => s.text).join(' ').toLowerCase() };
}

describe.skipIf(!ENABLED)('real speech models (Node)', () => {
  it('Moonshine Tiny transcribes the clip, window by window, with times', async () => {
    const { windows, segs, text } = await transcribeWith('moonshine-tiny');
    console.log(`moonshine-tiny: ${windows.length} windows → ${segs.map((s) => `[${(s.startMs / 1000).toFixed(1)}s] ${s.text}`).join(' | ')}`);
    expect(text).toMatch(/ask not what your country can do for you/);
    expect(segs[0]!.startMs).toBeLessThan(1500);
    expect(segs.at(-1)!.endMs).toBeGreaterThan(8000);
    for (let i = 1; i < segs.length; i++) expect(segs[i]!.startMs).toBeGreaterThanOrEqual(segs[i - 1]!.startMs);
  }, 300_000);

  it('Whisper Base transcribes with its own timestamps', async () => {
    const { segs, text } = await transcribeWith('whisper-base');
    console.log(`whisper-base: ${segs.map((s) => `[${(s.startMs / 1000).toFixed(1)}s] ${s.text}`).join(' | ')}`);
    expect(text).toMatch(/ask not what your country can do for you/);
    expect(segs.length).toBeGreaterThanOrEqual(2);
  }, 300_000);
});
