import { afterEach, describe, expect, it } from 'vitest';
import { baseStatus, createFakeNativeAI } from '../test/fake-native-ai.ts';
import { describeImages, nativeLLM, nativeLLMReady, nativeLLMs } from '../platform/native-llm.ts';
import {
  chosenModel, downloadNative, initNativeAI, nativeEngineReady, nativeProofread, nativeSummary, nativeTranscriber, refreshNativeAI, setNativeAIPluginForTests, useNativeAI,
} from './native-ai.ts';
import { localActiveAI, pickAssistant, useLocalAI } from './localai.ts';

afterEach(() => {
  setNativeAIPluginForTests(null);
  useLocalAI.getState().setPrefs({ assistant: 'auto' });
  try { localStorage.clear(); } catch { /* no storage */ }
});

const nanoReady = () => baseStatus({
  engines: [{ id: 'gemini-nano', state: 'available', contextTokens: 4000, model: 'gemini-nano-v3' }],
  tasks: { summarize: 'available', proofread: 'available', rewrite: 'downloadable', 'describe-image': 'available' },
});

describe('native AI registration', () => {
  it('registers nothing off Android', async () => {
    await initNativeAI();
    expect(nativeLLMs()).toHaveLength(0);
    expect(await nativeLLMReady()).toBe(false);
  });

  it('registers Gemini Nano first, then the recommended open model', async () => {
    setNativeAIPluginForTests(createFakeNativeAI(nanoReady()));
    await initNativeAI();
    expect(nativeLLMs().map((l) => l.id)).toEqual(['gemini-nano', 'litert:gemma-4-e2b']);
    expect(nativeLLMs()[0]!.contextTokens).toBe(4000);
    expect(await nativeLLMReady()).toBe(true);
    expect(nativeLLM()!.id).toBe('gemini-nano');
    expect(nativeEngineReady()).toBe(true);
  });

  it('answers with the open model when Nano is missing and the model is downloaded', async () => {
    const st = baseStatus();
    st.models[0]!.state = 'available';
    setNativeAIPluginForTests(createFakeNativeAI(st));
    await initNativeAI();
    expect(nativeLLMs().map((l) => l.id)).toEqual(['litert:gemma-4-e2b']);
    expect(await nativeLLMReady()).toBe(true);
    expect(nativeLLM()!.label).toBe('Gemma 4 E2B (on this phone)');
  });

  it('a downloadable engine is registered but not ready', async () => {
    setNativeAIPluginForTests(createFakeNativeAI(baseStatus({ engines: [{ id: 'gemini-nano', state: 'downloadable' }] })));
    await initNativeAI();
    expect(nativeLLMs().map((l) => l.id)).toEqual(['gemini-nano', 'litert:gemma-4-e2b']);
    expect(await nativeLLMReady()).toBe(false);
    expect(nativeEngineReady()).toBe(false);
  });

  it('follows the person’s engine and model choice', async () => {
    const st = nanoReady();
    st.models[1]!.state = 'available';
    setNativeAIPluginForTests(createFakeNativeAI(st));
    await initNativeAI();
    useNativeAI.getState().setPrefs({ engine: 'litert', modelId: 'qwen3-0.6b' });
    expect(chosenModel()!.id).toBe('qwen3-0.6b');
    expect(nativeLLMs().map((l) => l.id)).toEqual(['litert:qwen3-0.6b', 'gemini-nano']);
    expect(await nativeLLMReady()).toBe(true);
    expect(nativeLLM()!.id).toBe('litert:qwen3-0.6b');
  });

  it('ignores a chosen model this phone cannot run', async () => {
    const st = baseStatus();
    st.models[0]!.state = 'unavailable';
    st.recommendedModel = 'qwen3-0.6b';
    setNativeAIPluginForTests(createFakeNativeAI(st));
    await initNativeAI();
    useNativeAI.getState().setPrefs({ modelId: 'gemma-4-e2b' });
    expect(chosenModel()!.id).toBe('qwen3-0.6b');
  });
});

describe('who answers on Android', () => {
  it('prefers a ready native engine over the in-WebView model, even when the person chose this device', async () => {
    setNativeAIPluginForTests(createFakeNativeAI(nanoReady()));
    expect(await pickAssistant({ providerConfigured: false, builtinClaude: false })).toEqual({ kind: 'native' });
    useLocalAI.getState().setPrefs({ assistant: 'device' });
    expect(await pickAssistant({ providerConfigured: false, builtinClaude: false })).toEqual({ kind: 'native' });
    const ai = localActiveAI('native')!;
    expect(ai.label).toBe('Gemini Nano (on this phone)');
    expect(ai.model).toBe('gemini-nano');
  });

  it('a configured provider still wins in automatic mode', async () => {
    setNativeAIPluginForTests(createFakeNativeAI(nanoReady()));
    expect(await pickAssistant({ providerConfigured: true, builtinClaude: false })).toEqual({ kind: 'provider' });
  });

  it('streams a chat answer through the native provider', async () => {
    const fake = createFakeNativeAI(nanoReady());
    fake.onGenerate = async (_args, delta) => { delta('Two '); delta('notes.'); return { text: 'Two notes.' }; };
    setNativeAIPluginForTests(fake);
    await pickAssistant({ providerConfigured: false, builtinClaude: false });
    const ai = localActiveAI('native')!;
    const deltas: string[] = [];
    const r = await ai.provider.chat({ model: ai.model, messages: [{ role: 'system', content: 'Answer from notes.' }, { role: 'user', content: 'How many?' }] }, (e) => { if (e.type === 'text') deltas.push(e.delta); });
    expect(r.text).toBe('Two notes.');
    expect(deltas.join('')).toBe('Two notes.');
    expect(fake.calls.find((c) => c.method === 'aiGenerate')!.args.engine).toBe('gemini-nano');
  });
});

describe('downloads', () => {
  it('tracks progress from events and refreshes when done', async () => {
    const fake = createFakeNativeAI(baseStatus());
    let midway: unknown;
    fake.onDownload = async (args, emit) => {
      emit({ target: args.target, phase: 'started', loaded: 0, total: 0 });
      emit({ target: args.target, phase: 'download', loaded: 100, total: 400 });
      midway = useNativeAI.getState().downloads[args.target];
      emit({ target: args.target, phase: 'done', loaded: 1, total: 1 });
      fake.status.models[0]!.state = 'available';
      return { state: 'available' };
    };
    setNativeAIPluginForTests(fake);
    await initNativeAI();
    expect(await downloadNative('litert:gemma-4-e2b')).toBe(true);
    expect(midway).toMatchObject({ phase: 'download', loaded: 100, total: 400 });
    expect(useNativeAI.getState().downloads['litert:gemma-4-e2b']).toBeUndefined();
    expect(chosenModel()!.state).toBe('available');
    expect(await nativeLLMReady()).toBe(true);
  });

  it('keeps a failure to show, and forgets a cancellation', async () => {
    const fake = createFakeNativeAI(baseStatus());
    fake.onDownload = async () => { throw Object.assign(new Error('Not enough free storage.'), { code: 'disk' }); };
    setNativeAIPluginForTests(fake);
    await initNativeAI();
    expect(await downloadNative('litert:gemma-4-e2b')).toBe(false);
    expect(useNativeAI.getState().downloads['litert:gemma-4-e2b']).toMatchObject({ phase: 'failed', error: 'Not enough free storage.' });
    fake.onDownload = async () => { throw Object.assign(new Error('Download cancelled.'), { code: 'cancelled' }); };
    expect(await downloadNative('litert:gemma-4-e2b')).toBe(false);
    expect(useNativeAI.getState().downloads['litert:gemma-4-e2b']).toBeUndefined();
  });
});

describe('task APIs in app features', () => {
  it('summarizes with the summarization API only when Gemini Nano answers', async () => {
    const fake = createFakeNativeAI(nanoReady());
    fake.onTask = async (_a, delta) => { delta('- One'); return { text: '- One\n- Two' }; };
    setNativeAIPluginForTests(fake);
    await initNativeAI();
    const live: string[] = [];
    expect(await nativeSummary({ model: 'gemini-nano' }, 'Long note', 'bullets', (s) => live.push(s))).toBe('- One\n- Two');
    expect(live).toEqual(['- One']);
    expect(await nativeSummary({ model: 'gpt-5-mini' }, 'Long note', 'bullets')).toBeNull();
  });

  it('falls back (null) when the task fails, e.g. for another language', async () => {
    const fake = createFakeNativeAI(nanoReady());
    fake.onTask = async () => { throw Object.assign(new Error('Not in your language.'), { code: 'unsupported' }); };
    setNativeAIPluginForTests(fake);
    await initNativeAI();
    expect(await nativeSummary({ model: 'gemini-nano' }, 'Notiz', 'bullets')).toBeNull();
    expect(await nativeProofread('teh note')).toBe('teh note');
  });

  it('proofreads recognized handwriting when the feature is ready, else leaves it', async () => {
    const fake = createFakeNativeAI(nanoReady());
    fake.onTask = async (args) => ({ text: args.task === 'proofread' ? 'The note.' : '' });
    setNativeAIPluginForTests(fake);
    await initNativeAI();
    expect(await nativeProofread('teh note')).toBe('The note.');
    fake.status = baseStatus();
    await refreshNativeAI();
    expect(await nativeProofread('teh note')).toBe('teh note');
  });

  it('describes attached images for a text-only native model', async () => {
    const fake = createFakeNativeAI(nanoReady());
    fake.onTask = async (args) => ({ text: args.task === 'describe-image' ? 'A hand-drawn graph with two axes.' : '' });
    setNativeAIPluginForTests(fake);
    await initNativeAI();
    const nano = nativeLLMs()[0]!;
    expect(nano.describeImage).toBeTypeOf('function');
    const out = await describeImages([{ role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', mediaType: 'image/png', data: 'AAAA' }] }], nano.describeImage!);
    expect(out[0]!.content).toEqual([{ type: 'text', text: 'What is this?' }, { type: 'text', text: '[Attached image, described on this phone: A hand-drawn graph with two axes.]' }]);
    expect(fake.calls.find((c) => c.method === 'aiTask')!.args).toMatchObject({ task: 'describe-image', image: 'AAAA' });
  });

  it('offers the on-device transcriber only where recordings can be recognized', async () => {
    setNativeAIPluginForTests(createFakeNativeAI(baseStatus()));
    await initNativeAI();
    expect(nativeTranscriber()?.onDevice).toBe(true);
    setNativeAIPluginForTests(createFakeNativeAI(baseStatus({ speech: { available: true, onDevice: false, fileInput: false } })));
    await initNativeAI();
    expect(nativeTranscriber()).toBeNull();
  });
});
