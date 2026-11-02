import { describe, expect, it } from 'vitest';
import { createFakeNativeAI } from '../../test/fake-native-ai.ts';
import { NativeAIError, createNativeLLM, createNativeTranscriber, runNativeTask, startNativeListening, toNativeError } from './bridge.ts';
import { downmix, floatToPcm16, pcm16ToBase64 } from './pcm.ts';

const spec = { engine: 'gemini-nano' as const, id: 'gemini-nano', label: 'Gemini Nano (on this phone)', contextTokens: 4096, availability: async () => 'available' as const };

describe('native LLM bridge', () => {
  it('streams deltas of its own request and resolves with the answer', async () => {
    const fake = createFakeNativeAI();
    fake.onGenerate = async (args, delta) => {
      // Another request's delta arriving at the same time must not leak in.
      fake.emit('aiDelta', { requestId: 'someone-else', delta: 'XX' });
      delta('Hello');
      delta(', world');
      return { text: 'Hello, world' };
    };
    const llm = createNativeLLM(fake, spec);
    const seen: string[] = [];
    const r = await llm.generate({ messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'Hi' }], maxTokens: 64, temperature: 0.2 }, (d) => seen.push(d));
    expect(r.text).toBe('Hello, world');
    expect(seen).toEqual(['Hello', ', world']);
    const call = fake.calls.find((c) => c.method === 'aiGenerate')!.args;
    expect(call).toMatchObject({ engine: 'gemini-nano', maxTokens: 64, temperature: 0.2, messages: [{ role: 'system', content: 'Be brief' }, { role: 'user', content: 'Hi' }] });
    expect(fake.listeners.get('aiDelta')!.size).toBe(0); // listener removed
  });

  it('passes the LiteRT model id', async () => {
    const fake = createFakeNativeAI();
    fake.onGenerate = async () => ({ text: 'ok' });
    await createNativeLLM(fake, { ...spec, engine: 'litert', modelId: 'qwen3-0.6b', id: 'litert:qwen3-0.6b' }).generate({ messages: [{ role: 'user', content: 'Hi' }] }, () => {});
    expect(fake.calls.find((c) => c.method === 'aiGenerate')!.args).toMatchObject({ engine: 'litert', modelId: 'qwen3-0.6b' });
  });

  it('cancels natively when the signal aborts and rejects with an AbortError', async () => {
    const fake = createFakeNativeAI();
    const ac = new AbortController();
    fake.onGenerate = (args, delta) => new Promise((_, reject) => {
      delta('Partial');
      ac.abort();
      // Kotlin rejects the pending call with code `cancelled` once aiCancel arrives.
      setTimeout(() => reject(Object.assign(new Error('Stopped.'), { code: 'cancelled' })), 0);
    });
    const llm = createNativeLLM(fake, spec);
    await expect(llm.generate({ messages: [{ role: 'user', content: 'Long answer please' }] }, () => {}, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    const gen = fake.calls.find((c) => c.method === 'aiGenerate')!.args;
    expect(fake.calls.find((c) => c.method === 'aiCancel')!.args).toEqual({ requestId: gen.requestId });
    expect(fake.listeners.get('aiDelta')!.size).toBe(0);
  });

  it('does not start when already aborted', async () => {
    const fake = createFakeNativeAI();
    const ac = new AbortController();
    ac.abort();
    await expect(createNativeLLM(fake, spec).generate({ messages: [{ role: 'user', content: 'x' }] }, () => {}, ac.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fake.calls.some((c) => c.method === 'aiGenerate')).toBe(false);
  });

  it('keeps the stable error code and the plain message', async () => {
    const fake = createFakeNativeAI();
    fake.onGenerate = async () => { throw Object.assign(new Error('Gemini Nano is busy with another app. Try again in a moment.'), { code: 'busy' }); };
    const err = await createNativeLLM(fake, spec).generate({ messages: [{ role: 'user', content: 'x' }] }, () => {}).catch((e) => e);
    expect(err).toBeInstanceOf(NativeAIError);
    expect(err.code).toBe('busy');
    expect(err.message).toMatch(/busy/);
    expect(toNativeError({})).toMatchObject({ code: 'failed', message: 'On-device AI failed.' });
  });
});

describe('native tasks', () => {
  it('runs a task with its options and streams', async () => {
    const fake = createFakeNativeAI();
    fake.onTask = async (args, delta) => {
      delta('- Point');
      return { text: ' - Point one \n' };
    };
    const seen: string[] = [];
    const r = await runNativeTask(fake, { task: 'summarize', text: 'Long note', style: 'bullets', language: 'en-US' }, (d) => seen.push(d));
    expect(r).toBe('- Point one');
    expect(seen).toEqual(['- Point']);
    expect(fake.calls.find((c) => c.method === 'aiTask')!.args).toMatchObject({ task: 'summarize', text: 'Long note', style: 'bullets', language: 'en-US' });
  });
});

describe('native speech', () => {
  it('transcribes a recording as 16 kHz PCM through the on-device recognizer', async () => {
    const fake = createFakeNativeAI();
    const t = createNativeTranscriber(fake, async () => new Int16Array([0, 1000, -1000]));
    expect(t.onDevice).toBe(true);
    expect(await t.transcribe(new Blob(['x']), { language: 'en-GB' })).toBe('hello there');
    const args = fake.calls.find((c) => c.method === 'speechTranscribe')!.args;
    expect(args).toMatchObject({ sampleRate: 16000, language: 'en-GB' });
    expect(args.pcm).toBe(pcm16ToBase64(new Int16Array([0, 1000, -1000])));
  });

  it('returns nothing for empty audio without calling the recognizer', async () => {
    const fake = createFakeNativeAI();
    const t = createNativeTranscriber(fake, async () => new Int16Array(0));
    expect(await t.transcribe(new Blob([]))).toBe('');
    expect(fake.calls.some((c) => c.method === 'speechTranscribe')).toBe(false);
  });

  it('runs a live session with partials and stops with the transcript', async () => {
    const fake = createFakeNativeAI();
    const partials: string[] = [];
    const l = await startNativeListening(fake, { language: 'en-US', onPartial: (t) => partials.push(t) });
    const sessionId = fake.calls.find((c) => c.method === 'speechStart')!.args.sessionId;
    fake.emit('speechPartial', { sessionId, text: 'buy' });
    fake.emit('speechPartial', { sessionId: 'other', text: 'nope' });
    fake.emit('speechPartial', { sessionId, text: 'buy milk' });
    expect(partials).toEqual(['buy', 'buy milk']);
    expect(l.onDevice).toBe(true);
    expect(await l.stop()).toBe('buy milk');
    expect(fake.listeners.get('speechPartial')!.size).toBe(0);
  });

  it('cancels a live session', async () => {
    const fake = createFakeNativeAI();
    const l = await startNativeListening(fake);
    l.cancel();
    expect(fake.calls.some((c) => c.method === 'speechCancel')).toBe(true);
    expect(fake.listeners.get('speechPartial')!.size).toBe(0);
  });

  it('cleans up when the microphone is refused', async () => {
    const fake = createFakeNativeAI();
    fake.speechStart = async () => { throw Object.assign(new Error('Inkstone needs microphone access for voice input.'), { code: 'permission' }); };
    await expect(startNativeListening(fake)).rejects.toMatchObject({ code: 'permission' });
    expect(fake.listeners.get('speechPartial')!.size).toBe(0);
  });
});

describe('pcm', () => {
  it('downmixes, clips and converts to little-endian 16-bit', () => {
    expect(Array.from(downmix([new Float32Array([1, 0]), new Float32Array([0, -1])]))).toEqual([0.5, -0.5]);
    expect(Array.from(floatToPcm16(new Float32Array([0, 1, -1, 2, -2, 0.5])))).toEqual([0, 32767, -32768, 32767, -32768, 16384]);
    // 1 → 0x0001 → bytes 01 00
    expect(pcm16ToBase64(new Int16Array([1]))).toBe(btoa(String.fromCharCode(1, 0)));
    expect(pcm16ToBase64(new Int16Array([-2]))).toBe(btoa(String.fromCharCode(0xfe, 0xff)));
  });
});
