import { describe, expect, it } from 'vitest';
import {
  ASR_SAMPLE_RATE,
  AudioWindower,
  EnergyVad,
  LOCAL_MODELS,
  chooseTranscriber,
  cleanSummary,
  decodeWav,
  distributeText,
  encodeWav,
  findStampCitations,
  fitLines,
  getLocalModel,
  lectureSummaryMessages,
  linkStampCitations,
  liveTranscriptContext,
  memoryLink,
  pageSummaryMessages,
  parseLectureSummary,
  parseMemoryLink,
  pickVariant,
  recommendAsr,
  resample,
  speechRegions,
  splitSentences,
  timeAlongSpeech,
  variantFiles,
  whereExplanation,
  whereLabel,
  windowSegments,
  windowsOf,
  type AudioWindow,
  type HardwareInfo,
  type SpeechSituation,
} from '../src/index.ts';

const SR = ASR_SAMPLE_RATE;

/** Deterministic noise. */
function rng(seed = 1) {
  let s = seed;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32) * 2 - 1;
}

/**
 * Speech-like audio: voiced harmonics with syllable-rate loudness, over a quiet noise floor.
 * `plan` is a list of [seconds, speaking?].
 */
function speechLike(plan: [number, boolean][]): Float32Array {
  const n = Math.round(plan.reduce((a, [s]) => a + s, 0) * SR);
  const out = new Float32Array(n);
  const noise = rng(7);
  let i = 0;
  for (const [sec, talk] of plan) {
    const len = Math.round(sec * SR);
    for (let k = 0; k < len; k++, i++) {
      const t = i / SR;
      const floor = noise() * 0.001;
      if (!talk) { out[i] = floor; continue; }
      const syllable = 0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t);
      const voice = Math.sin(2 * Math.PI * 140 * t) * 0.5 + Math.sin(2 * Math.PI * 280 * t) * 0.3 + Math.sin(2 * Math.PI * 420 * t) * 0.2;
      out[i] = floor + 0.2 * syllable * voice;
    }
  }
  return out;
}

describe('voice activity', () => {
  it('finds speech and skips silence, with the noise floor adapting', () => {
    const audio = speechLike([[1, false], [2, true], [1.5, false], [1, true], [1, false]]);
    const r = speechRegions(audio);
    expect(r).toHaveLength(2);
    expect(r[0]![0]).toBeGreaterThan(950);
    expect(r[0]![0]).toBeLessThan(1150);
    expect(r[0]![1]).toBeGreaterThan(2950);
    expect(r[0]![1]).toBeLessThan(3400); // hangover
    expect(r[1]![0]).toBeGreaterThan(4450);
  });

  it('ignores a single click', () => {
    const audio = speechLike([[2, false]]);
    for (let k = 0; k < 200; k++) audio[SR + k] = 0.9;
    expect(speechRegions(audio)).toEqual([]);
  });

  it('measures levels in dBFS', () => {
    expect(EnergyVad.levelDb(new Float32Array(480).fill(1))).toBeCloseTo(0, 3);
    expect(EnergyVad.levelDb(new Float32Array(480).fill(0.1))).toBeCloseTo(-20, 1);
  });
});

describe('windowing', () => {
  const collect = (audio: Float32Array, opts = {}, chunk = 4000) => {
    const out: AudioWindow[] = [];
    const w = new AudioWindower((x) => out.push(x), opts);
    for (let i = 0; i < audio.length; i += chunk) w.push(audio.subarray(i, Math.min(audio.length, i + chunk)));
    return { out, w };
  };

  it('cuts at the first pause after the minimum length, trimmed to speech with exact times', () => {
    // 4 s talk, 0.3 s gap (too short), 4 s talk, 1 s pause, 3 s talk, 1 s silence
    const audio = speechLike([[0.5, false], [4, true], [0.3, false], [4, true], [1, false], [3, true], [1, false]]);
    const { out, w } = collect(audio, { minWindowMs: 6000, pauseMs: 600 });
    expect(out).toHaveLength(1); // the 1 s pause after 8.8 s
    expect(out[0]!.startMs).toBeGreaterThan(200);
    expect(out[0]!.startMs).toBeLessThan(500);
    expect(out[0]!.endMs).toBeGreaterThan(8800);
    expect(out[0]!.endMs).toBeLessThan(9500);
    expect(out[0]!.audio.length).toBe(Math.round(((out[0]!.endMs - out[0]!.startMs) / 1000) * SR));
    expect(out[0]!.speech.length).toBeGreaterThanOrEqual(1);
    w.flush();
    expect(out).toHaveLength(2);
    expect(out[1]!.startMs).toBeGreaterThan(9500);
    expect(out[1]!.endMs).toBeGreaterThan(12_800);
    // The window's samples are the stream's samples at those times.
    const k = Math.round((out[1]!.startMs / 1000) * SR);
    expect(out[1]!.audio[1000]).toBe(audio[k + 1000]);
  });

  it('forces a cut at the maximum length, at a quiet moment', () => {
    const audio = speechLike([[12, true], [0.2, false], [10, true]]);
    const { out, w } = collect(audio, { minWindowMs: 3000, maxWindowMs: 14_000, pauseMs: 600 });
    w.flush();
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0]!.endMs - out[0]!.startMs).toBeLessThanOrEqual(14_100);
    for (let i = 1; i < out.length; i++) expect(out[i]!.startMs).toBeGreaterThanOrEqual(out[i - 1]!.endMs);
  });

  it('never emits silence and keeps memory bounded during long silences', () => {
    const { out, w } = collect(speechLike([[60, false]]));
    w.flush();
    expect(out).toEqual([]);
    expect((w as any).len).toBeLessThan(SR * 2);
    expect(w.receivedMs).toBeCloseTo(60_000, -1);
  });

  it('windowsOf matches live windowing of a whole recording', () => {
    const audio = speechLike([[3, true], [1, false], [3, true]]);
    const ws = windowsOf(audio, { minWindowMs: 2000 });
    expect(ws).toHaveLength(2);
    const { out, w } = collect(audio, { minWindowMs: 2000 }, 777);
    w.flush();
    expect(out.map((x) => [Math.round(x.startMs), Math.round(x.endMs)])).toEqual(ws.map((x) => [Math.round(x.startMs), Math.round(x.endMs)]));
  });
});

describe('audio formats', () => {
  it('resamples 48 kHz to 16 kHz keeping duration and tone', () => {
    const src = new Float32Array(48_000).map((_, i) => Math.sin((2 * Math.PI * 440 * i) / 48_000));
    const out = resample(src, 48_000);
    expect(out.length).toBe(16_000);
    let crossings = 0;
    for (let i = 1; i < out.length; i++) if (out[i - 1]! < 0 && out[i]! >= 0) crossings++;
    expect(crossings).toBeGreaterThan(430);
    expect(crossings).toBeLessThan(450);
    expect(resample(src, 16_000, 16_000)).toBe(src);
  });

  it('WAV round-trips', () => {
    const a = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const { audio, sampleRate } = decodeWav(encodeWav(a));
    expect(sampleRate).toBe(16_000);
    audio.forEach((v, i) => expect(v).toBeCloseTo(a[i]!, 3));
  });
});

describe('timestamped segments', () => {
  it('splits sentences and folds fragments', () => {
    expect(splitSentences('OK. So today we talk about convolution. It is linear! Right?')).toEqual(['OK. So today we talk about convolution.', 'It is linear!', 'Right?']);
    const long = splitSentences(`${'word '.repeat(80)}end`, 100);
    expect(long.every((s) => s.length <= 100)).toBe(true);
    expect(splitSentences('   ')).toEqual([]);
  });

  it('lays text over speech regions, skipping the silences', () => {
    expect(timeAlongSpeech([[0, 1000], [3000, 4000]], 0.75)).toBe(3500);
    const segs = distributeText('First part here. Second part here.', [[1000, 3000], [6000, 8000]], [0, 9000]);
    expect(segs).toHaveLength(2);
    expect(segs[0]!.startMs).toBe(1000);
    expect(segs[1]!.startMs).toBeGreaterThanOrEqual(2900);
    expect(segs[1]!.endMs).toBe(8000);
  });

  it('uses model timestamps when given (Whisper), relative to the window', () => {
    const w = { startMs: 20_000, endMs: 30_000, speech: [[20_000, 30_000]] as [number, number][] };
    const s = windowSegments(w, 'ignored', [{ text: ' Hello there.', start: 0.5, end: 2 }, { text: ' [Music]', start: 2, end: 3 }, { text: ' Bye.', start: 4, end: null }]);
    expect(s.map((x) => [x.startMs, x.endMs, x.text])).toEqual([[20_500, 22_000, 'Hello there.'], [24_000, 30_000, 'Bye.']]);
    expect(new Set(s.map((x) => x.id)).size).toBe(2);
  });

  it('spreads plain text (Moonshine, providers) and drops noise-only output', () => {
    const w = { startMs: 0, endMs: 5000, speech: [[500, 4500]] as [number, number][] };
    const s = windowSegments(w, 'We start with signals. Then systems follow.');
    expect(s).toHaveLength(2);
    expect(s[0]!.startMs).toBe(500);
    expect(windowSegments(w, '(applause)')).toEqual([]);
  });
});

describe('choosing the transcriber', () => {
  const base: SpeechSituation = { preference: 'auto', deviceInstalled: false, deviceRunnable: true, nativeReady: false, browserSpeech: true, providerTranscription: true };
  it('automatic: device, native, browser, provider, then offer the download', () => {
    expect(chooseTranscriber({ ...base, deviceInstalled: true }).kind).toBe('device');
    expect(chooseTranscriber({ ...base, nativeReady: true }).kind).toBe('native');
    expect(chooseTranscriber(base).kind).toBe('browser');
    expect(chooseTranscriber({ ...base, browserSpeech: false }).kind).toBe('provider');
    expect(chooseTranscriber({ ...base, browserSpeech: false, providerTranscription: false }).kind).toBe('offer-download');
    expect(chooseTranscriber({ ...base, browserSpeech: false, providerTranscription: false, deviceRunnable: false }).kind).toBe('none');
  });
  it('"this device" never falls back to anything that uploads audio', () => {
    expect(chooseTranscriber({ ...base, preference: 'device' }).kind).toBe('offer-download');
    expect(chooseTranscriber({ ...base, preference: 'device', nativeReady: true }).kind).toBe('native');
    expect(chooseTranscriber({ ...base, preference: 'device', deviceRunnable: false }).kind).toBe('none');
  });
  it('explicit browser / provider / off', () => {
    expect(chooseTranscriber({ ...base, preference: 'browser', deviceInstalled: true }).kind).toBe('browser');
    expect(chooseTranscriber({ ...base, preference: 'browser', browserSpeech: false }).kind).toBe('none');
    expect(chooseTranscriber({ ...base, preference: 'provider', deviceInstalled: true }).kind).toBe('provider');
    expect(chooseTranscriber({ ...base, preference: 'off', deviceInstalled: true }).kind).toBe('off');
  });
  it('labels where audio goes', () => {
    expect(whereLabel('device')).toBe('On this device');
    expect(whereLabel('provider', 'OpenAI')).toBe('Sent to OpenAI');
    expect(whereExplanation('device')).toMatch(/Nothing is uploaded/);
  });
});

describe('speech models in the catalog', () => {
  const hw = (p: Partial<HardwareInfo>): HardwareInfo => ({ webgpu: true, shaderF16: true, maxBufferSize: 2e9, maxStorageBufferBindingSize: 1e9, fallbackAdapter: false, memoryGB: 8, cores: 8, mobile: false, os: 'windows', crossOriginIsolated: false, ...p });
  it('are permissively licensed speech models with an encoder and a decoder', () => {
    const asr = LOCAL_MODELS.filter((m) => m.role === 'asr');
    expect(asr.map((m) => m.id)).toEqual(['moonshine-tiny', 'moonshine-base', 'whisper-base', 'whisper-large-v3-turbo']);
    for (const m of asr) {
      expect(['MIT', 'Apache-2.0']).toContain(m.licence);
      expect(m.loader).toBe('speech-to-text');
      expect(m.onnxModules).toEqual(['encoder_model', 'decoder_model_merged']);
    }
  });

  it('lists per-module files with their own dtypes', () => {
    const spec = getLocalModel('moonshine-base')!;
    const v = spec.variants.find((x) => x.device === 'webgpu')!;
    const tree = ['config.json', 'tokenizer.json', 'preprocessor_config.json', 'onnx/encoder_model.onnx', 'onnx/encoder_model_q4.onnx', 'onnx/decoder_model_merged_q4.onnx', 'onnx/decoder_model_merged.onnx'].map((path, i) => ({ path, size: i + 1 }));
    expect(variantFiles(spec, v, tree).map((f) => f.path)).toEqual(['config.json', 'tokenizer.json', 'preprocessor_config.json', 'onnx/decoder_model_merged_q4.onnx', 'onnx/encoder_model.onnx']);
    expect(() => variantFiles(spec, spec.variants[1]!, tree)).toThrow(/encoder_model_quantized/);
  });

  it('defaults by tier and language', () => {
    expect(recommendAsr(hw({ webgpu: false }), 'en-US')?.spec.id).toBe('moonshine-tiny');
    expect(recommendAsr(hw({ webgpu: false }), 'de-DE')?.spec.id).toBe('whisper-base');
    expect(recommendAsr(hw({}), 'en-GB')?.spec.id).toBe('moonshine-base');
    expect(recommendAsr(hw({ mobile: true, os: 'android', memoryGB: 4 }), 'en')?.spec.id).toBe('moonshine-base');
    expect(recommendAsr(hw({ maxBufferSize: 4.2e9, memoryGB: 16 }), 'fr')?.spec.id).toBe('whisper-large-v3-turbo');
    // Without f16 a GPU is not "large"; chosen by hand, turbo runs its 4-bit float32 build.
    expect(recommendAsr(hw({ maxBufferSize: 4.2e9, memoryGB: 16, shaderF16: false }), 'en')!.spec.id).toBe('moonshine-base');
    expect(pickVariant(getLocalModel('whisper-large-v3-turbo')!, { webgpu: true, shaderF16: false })?.dtype).toBe('q4');
    expect(pickVariant(getLocalModel('whisper-large-v3-turbo')!, { webgpu: false, shaderF16: false })).toBeNull();
  });
});

describe('prompts and citations', () => {
  const segs = [{ id: 'a', startMs: 0, endMs: 4000, text: 'Today: convolution.' }, { id: 'b', startMs: 62_000, endMs: 66_000, text: 'Convolution in time is multiplication in frequency.' }, { id: 'c', startMs: 125_000, endMs: 128_000, text: 'Homework is due Friday.' }];

  it('keeps the newest lines (live) or a spread (summaries) within budget', () => {
    const lines = Array.from({ length: 100 }, (_, i) => ({ ms: i * 1000, text: `line ${i} ${'x'.repeat(40)}` }));
    const newest = fitLines(lines, 600, 'newest');
    expect(newest.at(-1)!.ms).toBe(99_000);
    expect(newest.reduce((a, l) => a + l.text.length + 8, 0)).toBeLessThanOrEqual(600);
    const spread = fitLines(lines, 600, 'spread');
    expect(spread[0]!.ms).toBe(0);
    expect(spread.at(-1)!.ms).toBeGreaterThan(80_000);
  });

  it('builds page and lecture prompts with stamped lines', () => {
    const m = pageSummaryMessages({ title: 'Signals', pageNumber: 2, pageText: 'conv = flip+slide', said: [{ ms: 62_000, text: 'Convolution…' }] });
    expect(m[1]!.content).toContain('[1:02] Convolution…');
    expect(m[1]!.content).toContain('page 2');
    expect(pageSummaryMessages({ title: '', pageNumber: 1, pageText: '', said: [] })[1]!.content).toContain('Nothing was recorded');
    expect(lectureSummaryMessages({ title: 'Signals', transcript: [{ ms: 0, text: 'hi' }], notesText: '' })[0]!.content).toContain('"keyTerms"');
  });

  it('cleans summaries and parses lecture JSON leniently', () => {
    expect(cleanSummary('<think>hmm</think>Here you go:\n* one\n- two\nThanks')).toBe('- one\n- two');
    expect(cleanSummary('Just a sentence.')).toBe('Just a sentence.');
    expect(parseLectureSummary('```json\n{"summary":"S","keyTerms":["a"],"todos":["Do HW"]}\n```')).toEqual({ summary: 'S', keyTerms: ['a'], todos: ['Do HW'] });
    expect(parseLectureSummary('Not JSON at all')).toEqual({ summary: 'Not JSON at all', keyTerms: [], todos: [] });
  });

  it('gives the assistant the live transcript with times', () => {
    const c = liveTranscriptContext({ elapsedMs: 130_000, segments: segs, pageNumber: 3, pageText: 'notes' });
    expect(c).toContain('2:10 so far');
    expect(c).toContain('[1:02] Convolution in time');
    expect(c).toContain('page 3');
    expect(c).toMatch(/\[12:03\]/);
  });

  it('links only citations that match the transcript', () => {
    const text = 'She said it [1:03] and assigned homework [2:05]; also [9:59].';
    const found = findStampCitations(text, segs);
    expect(found.map((f) => f.segment?.id ?? null)).toEqual(['b', 'c', null]);
    const linked = linkStampCitations(text, segs, (s) => `#said/n/c/${s.startMs}`);
    expect(linked).toBe('She said it [1:03](#said/n/c/62000) and assigned homework [2:05](#said/n/c/125000); also [9:59].');
    expect(linkStampCitations(linked, segs, () => 'x')).toBe(linked);
  });

  it('memory links carry the moment of a recording', () => {
    const href = memoryLink({ noteId: 'n1', pageIndex: 1, rect: { x: 1, y: 2, width: 3, height: 4 }, said: { clipId: 'C1', startMs: 62_000, endMs: 66_000 } });
    expect(href).toBe('#mem/n1/2/1,2,3,4@C1:62000');
    expect(parseMemoryLink(href)).toEqual({ noteId: 'n1', pageIndex: 1, rect: { x: 1, y: 2, width: 3, height: 4 }, seek: { clipId: 'C1', ms: 62_000 } });
    expect(parseMemoryLink('#mem/n1/2')).toEqual({ noteId: 'n1', pageIndex: 1 });
  });
});
