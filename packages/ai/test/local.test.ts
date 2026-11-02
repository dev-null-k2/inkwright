import { describe, expect, it, vi } from 'vitest';
import {
  LOCAL_MODELS,
  LocalEngineClient,
  ThinkFilter,
  buildAskMessages,
  chooseAssistant,
  chooseEmbedder,
  createChromeAIProvider,
  createLocalProvider,
  createMemoryTools,
  detectHardware,
  detectLocalServers,
  deviceTier,
  formatBytes,
  getLocalModel,
  memoryLink,
  modelRef,
  parseAnswerCitations,
  parseMemoryLink,
  pickVariant,
  recommendLocal,
  remoteEmbed,
  runAgent,
  serveLocalEngine,
  stripThinking,
  toLocalMessages,
  truncateEmbedding,
  variantFiles,
  type AssistantSituation,
  type ChromeLanguageModel,
  type DownloadProgress,
  type GenerateRequest,
  type HardwareInfo,
  type LocalEngine,
  type ModelRef,
  type ModelStatus,
  type StreamEvent,
} from '../src/index.ts';
import { jsonResponse, mockFetch } from './helpers.ts';

/** A deterministic stand-in for the transformers.js engine. */
class FakeEngine implements LocalEngine {
  installed = new Set<string>();
  generated: GenerateRequest[] = [];
  reply: string | ((req: GenerateRequest) => string) = 'Hello from the device.';
  async status(m: ModelRef): Promise<ModelStatus> {
    return { installed: this.installed.has(m.id), bytesOnDevice: this.installed.has(m.id) ? m.bytes : 0 };
  }
  async download(m: ModelRef, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal) {
    for (let i = 1; i <= 4; i++) {
      await new Promise((r) => setTimeout(r, 1));
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      onProgress?.({ loaded: (m.bytes * i) / 4, total: m.bytes, file: `part${i}` });
    }
    this.installed.add(m.id);
  }
  async remove(m: ModelRef) { this.installed.delete(m.id); }
  async embed(_m: ModelRef, inputs: string[]) {
    // Bag of letters → a 26-d vector: similar strings get similar vectors.
    return inputs.map((s) => {
      const v = new Float32Array(26);
      for (const ch of s.toLowerCase()) if (ch >= 'a' && ch <= 'z') v[ch.charCodeAt(0) - 97]! += 1;
      return truncateEmbedding(v, 26);
    });
  }
  async generate(_m: ModelRef, req: GenerateRequest, onDelta?: (t: string) => void, signal?: AbortSignal) {
    this.generated.push(req);
    const text = typeof this.reply === 'function' ? this.reply(req) : this.reply;
    for (const piece of text.match(/.{1,4}/gs) ?? []) {
      if (signal?.aborted) throw Object.assign(new Error('Cancelled'), { name: 'AbortError' });
      onDelta?.(piece);
      await new Promise((r) => setTimeout(r, 0));
    }
    return { text, inputTokens: 10, outputTokens: text.length, stopReason: 'stop' as const };
  }
  async unload() {}
}

function connected(engine: LocalEngine) {
  const ch = new MessageChannel();
  const stop = serveLocalEngine(ch.port1 as any, engine);
  const client = new LocalEngineClient(ch.port2 as any);
  return { client, close: () => { stop(); client.dispose(); ch.port1.close(); ch.port2.close(); } };
}

const qwen = getLocalModel('qwen3-1.7b')!;
const ref = modelRef(qwen, pickVariant(qwen, { webgpu: true, shaderF16: true })!);

describe('worker protocol', () => {
  it('reports progress, results and transfers embeddings across the port', async () => {
    const engine = new FakeEngine();
    const { client, close } = connected(engine);
    try {
      expect(await client.status(ref)).toEqual({ installed: false, bytesOnDevice: 0 });
      const progress: DownloadProgress[] = [];
      await client.download(ref, (p) => progress.push(p));
      expect(progress.map((p) => p.loaded / p.total)).toEqual([0.25, 0.5, 0.75, 1]);
      expect((await client.status(ref)).installed).toBe(true);
      const [a, b] = await client.embed(ref, ['fourier', 'fourier transform']);
      expect(a).toBeInstanceOf(Float32Array);
      expect(a!.length).toBe(26);
      expect(Math.hypot(...a!)).toBeCloseTo(1, 5);
      expect(b![5]).toBeGreaterThan(0);
    } finally {
      close();
    }
  });

  it('streams generated text and cancels a running call', async () => {
    const engine = new FakeEngine();
    engine.reply = 'x'.repeat(400);
    const { client, close } = connected(engine);
    try {
      const deltas: string[] = [];
      const ok = await client.generate(ref, { messages: [{ role: 'user', content: 'hi' }] }, (d) => deltas.push(d));
      expect(deltas.join('')).toBe(ok.text);
      const ac = new AbortController();
      const run = client.generate(ref, { messages: [{ role: 'user', content: 'hi' }] }, () => ac.abort(), ac.signal);
      await expect(run).rejects.toMatchObject({ name: 'AbortError' });
      const dl = new AbortController();
      const d = client.download({ ...ref, id: 'other' }, undefined, dl.signal);
      dl.abort();
      await expect(d).rejects.toMatchObject({ name: 'AbortError' });
      expect(engine.installed.has('other')).toBe(false);
    } finally {
      close();
    }
  });

  it('passes engine errors through with their message', async () => {
    const engine = new FakeEngine();
    engine.generate = async () => { throw new Error('Out of GPU memory'); };
    const { client, close } = connected(engine);
    try {
      await expect(client.generate(ref, { messages: [] })).rejects.toThrow('Out of GPU memory');
    } finally {
      close();
    }
  });
});

describe('on-device provider', () => {
  it('streams text, hides reasoning blocks and reports usage', async () => {
    const engine = new FakeEngine();
    engine.reply = '<think>\nlet me think</think>\n\nThe answer is 4.';
    const p = createLocalProvider(engine, ref);
    const events: StreamEvent[] = [];
    const r = await p.chat({ model: ref.id, messages: [{ role: 'system', content: 'Be brief.' }, { role: 'user', content: '2+2?' }] }, (e) => events.push(e));
    expect(r.text).toBe('The answer is 4.');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('The answer is 4.');
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: engine.reply.length });
    expect(engine.generated[0]!.messages[0]).toEqual({ role: 'system', content: 'Be brief.' });
  });

  it('calls tools through the text protocol (the format Qwen3 is trained on)', async () => {
    const engine = new FakeEngine();
    engine.reply = (req) =>
      req.messages.some((m) => m.role === 'user' && m.content.includes('<tool_result name='))
        ? 'Your lecture says it is linear [Lecture 3].'
        : '<tool_call>\n{"name": "search_memory", "arguments": {"query": "fourier"}}\n</tool_call>';
    const host = { searchMemory: vi.fn(async () => [{ noteId: 'n1', title: 'Lecture 3', pageIndex: 1, source: 'handwriting' as const, text: 'Fourier transform is linear', rect: { x: 10, y: 20, width: 100, height: 30 }, score: 1 }]) };
    const res = await runAgent({ provider: createLocalProvider(engine, ref), model: ref.id, messages: [{ role: 'user', content: 'What about Fourier?' }], tools: createMemoryTools(host) });
    expect(host.searchMemory).toHaveBeenCalledWith('fourier', { limit: 8, noteId: undefined });
    expect(res.text).toContain('linear');
    // The system prompt carried the tool description.
    expect(engine.generated[0]!.messages[0]!.content).toContain('search_memory');
    expect(JSON.stringify(engine.generated[1]!.messages)).toContain('#mem/n1/2/10,20,100,30');
  });

  it('fits long conversations into the context budget, keeping the system prompt and latest turn', () => {
    const msgs = [
      { role: 'system' as const, content: 'S' },
      ...Array.from({ length: 20 }, (_, i) => ({ role: (i % 2 ? 'assistant' : 'user') as 'user' | 'assistant', content: `turn ${i} ` + 'x'.repeat(700) })),
      { role: 'user' as const, content: 'latest question' },
    ];
    const out = toLocalMessages(msgs, { budgetTokens: 1000 });
    expect(out[0]).toEqual({ role: 'system', content: 'S' });
    expect(out[1]!.role).toBe('user');
    expect(out[out.length - 1]!.content).toContain('latest question');
    const est = out.reduce((a, m) => a + m.content.length / 3.5, 0);
    expect(est).toBeLessThanOrEqual(1000 + 300);
  });

  it('ThinkFilter copes with tags split across deltas', () => {
    let out = '';
    const f = new ThinkFilter((s) => (out += s));
    for (const d of ['<thi', 'nk>secret', ' stuff</th', 'ink>\n\nVisible', ' text']) f.push(d);
    f.end();
    expect(out).toBe('Visible text');
    expect(stripThinking('<think>a</think> b')).toBe('b');
    expect(stripThinking('answer <think>unterminated')).toBe('answer ');
  });
});

const hw = (p: Partial<HardwareInfo>): HardwareInfo => ({ webgpu: true, shaderF16: true, maxBufferSize: 2 ** 31, maxStorageBufferBindingSize: 2 ** 30, fallbackAdapter: false, cores: 8, mobile: false, os: 'windows', crossOriginIsolated: false, ...p });

describe('hardware tiers', () => {
  it('detects WebGPU limits and device hints from the navigator', async () => {
    const adapter = { features: new Set(['shader-f16']), limits: { maxBufferSize: 4294967292, maxStorageBufferBindingSize: 2147483644 }, info: { vendor: 'apple', architecture: 'metal-3' } };
    const info = await detectHardware({ gpu: { requestAdapter: async () => adapter }, deviceMemory: 8, hardwareConcurrency: 10, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' }, { crossOriginIsolated: false });
    expect(info).toMatchObject({ webgpu: true, shaderF16: true, maxBufferSize: 4294967292, memoryGB: 8, cores: 10, os: 'mac', mobile: false });
    expect(deviceTier(info)).toBe('gpu-large');
    const none = await detectHardware({ userAgent: 'Mozilla/5.0 (Linux; Android 15; Pixel 9)', deviceMemory: 4 });
    expect(none).toMatchObject({ webgpu: false, os: 'android', mobile: true });
    const broken = await detectHardware({ gpu: { requestAdapter: async () => { throw new Error('GPU process crashed'); } } });
    expect(broken.webgpu).toBe(false);
    const soft = await detectHardware({ gpu: { requestAdapter: async () => ({ ...adapter, isFallbackAdapter: true }) } });
    expect(soft.webgpu).toBe(false);
  });

  it('picks a model tier per device class', () => {
    expect(recommendLocal(hw({ webgpu: false, memoryGB: 8 }))).toMatchObject({ tier: 'cpu', chat: { spec: { id: 'granite-4.0-350m' }, variant: { device: 'wasm' } }, embed: { spec: { id: 'granite-embedding-97m' } } });
    expect(recommendLocal(hw({ webgpu: false, memoryGB: 2 })).chat).toBeNull();
    expect(recommendLocal(hw({ memoryGB: 8, maxBufferSize: 2 ** 31 })).chat!.spec.id).toBe('qwen3-1.7b');
    expect(recommendLocal(hw({ memoryGB: 8, maxBufferSize: 4294967292 })).chat!.spec.id).toBe('qwen3-4b-2507');
    expect(recommendLocal(hw({ os: 'android', mobile: true, memoryGB: 4 })).chat!.spec.id).toBe('qwen3-0.6b');
    expect(recommendLocal(hw({ os: 'android', mobile: true, memoryGB: 8 })).chat!.spec.id).toBe('qwen3-1.7b');
    expect(recommendLocal(hw({ os: 'ios', mobile: true })).chat!.spec.id).toBe('qwen3-0.6b');
    const r = recommendLocal(hw({ memoryGB: 8 }));
    expect(r.embed.spec.id).toBe('embeddinggemma-2');
    expect(r.embed.variant).toMatchObject({ device: 'webgpu', dtype: 'q4f16' });
  });

  it('avoids half-precision builds on GPUs without shader-f16', () => {
    expect(pickVariant(qwen, { webgpu: true, shaderF16: false })).toMatchObject({ device: 'webgpu', dtype: 'q4' });
    expect(pickVariant(getLocalModel('qwen3-4b-2507')!, { webgpu: false, shaderF16: false })).toBeNull();
    expect(pickVariant(qwen, { webgpu: false, shaderF16: false })).toMatchObject({ device: 'wasm', dtype: 'q4' });
  });

  it('ships only commercially usable licences', () => {
    for (const m of LOCAL_MODELS) expect(['Apache-2.0', 'MIT']).toContain(m.licence);
  });
});

describe('model files', () => {
  it('lists weights, shards and side files for a variant from the repository tree', () => {
    const tree = [
      { path: 'config.json', size: 900 }, { path: 'tokenizer.json', size: 9e6 }, { path: 'tokenizer_config.json', size: 1e4 }, { path: 'README.md', size: 10 },
      { path: 'merges.txt', size: 1e6 }, { path: 'onnx/model_q4f16.onnx', size: 1e5 }, { path: 'onnx/model_q4f16.onnx_data', size: 2e9 },
      { path: 'onnx/model_q4f16.onnx_data_1', size: 8e8 }, { path: 'onnx/model_q4.onnx', size: 2e9 }, { path: 'onnx/model_q4f16.onnx_data_x', size: 1 },
    ];
    const files = variantFiles(qwen, { device: 'webgpu', dtype: 'q4f16', bytes: 0 }, tree).map((f) => f.path);
    expect(files).toEqual(['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_q4f16.onnx', 'onnx/model_q4f16.onnx_data', 'onnx/model_q4f16.onnx_data_1']);
    expect(() => variantFiles(qwen, { device: 'webgpu', dtype: 'fp16', bytes: 0 }, tree)).toThrow(/missing/);
    expect(formatBytes(1_439_651_791)).toBe('1.4 GB');
    expect(formatBytes(189_539_831)).toBe('190 MB');
  });
});

describe('choosing who answers', () => {
  const base: AssistantSituation = { preference: 'auto', providerConfigured: false, builtinClaude: false, nativeReady: false, deviceInstalled: false, deviceRunnable: true, chrome: 'unavailable' };
  it('defaults to the private on-device model when no provider is configured', () => {
    expect(chooseAssistant(base)).toEqual({ kind: 'offer-download' });
    expect(chooseAssistant({ ...base, deviceInstalled: true })).toEqual({ kind: 'device' });
    expect(chooseAssistant({ ...base, chrome: 'available' })).toEqual({ kind: 'chrome' });
    expect(chooseAssistant({ ...base, nativeReady: true, deviceInstalled: true })).toEqual({ kind: 'native' });
    expect(chooseAssistant({ ...base, deviceRunnable: false })).toEqual({ kind: 'none' });
    expect(chooseAssistant({ ...base, deviceRunnable: false, chrome: 'downloadable' })).toEqual({ kind: 'chrome' });
  });
  it('keeps the built-in Claude preview path and lets key holders choose', () => {
    expect(chooseAssistant({ ...base, builtinClaude: true })).toEqual({ kind: 'claude-builtin' });
    expect(chooseAssistant({ ...base, providerConfigured: true, deviceInstalled: true })).toEqual({ kind: 'provider' });
    expect(chooseAssistant({ ...base, preference: 'device', providerConfigured: true, deviceInstalled: true })).toEqual({ kind: 'device' });
    expect(chooseAssistant({ ...base, preference: 'device', providerConfigured: true })).toEqual({ kind: 'offer-download' });
    expect(chooseAssistant({ ...base, preference: 'chrome', providerConfigured: true, chrome: 'available' })).toEqual({ kind: 'chrome' });
    expect(chooseAssistant({ ...base, preference: 'chrome', providerConfigured: true })).toEqual({ kind: 'provider' });
    expect(chooseAssistant({ ...base, preference: 'provider' })).toEqual({ kind: 'offer-download' });
  });
  it('prefers a ready native engine on Android even when the person chose this device', () => {
    // Without preferNative (desktop, web) a downloaded in-browser model keeps its place.
    expect(chooseAssistant({ ...base, preference: 'device', nativeReady: true, deviceInstalled: true })).toEqual({ kind: 'device' });
    expect(chooseAssistant({ ...base, preference: 'device', nativeReady: true, deviceInstalled: true, preferNative: true })).toEqual({ kind: 'native' });
    expect(chooseAssistant({ ...base, preference: 'device', nativeReady: false, deviceInstalled: true, preferNative: true })).toEqual({ kind: 'device' });
    expect(chooseAssistant({ ...base, preference: 'auto', nativeReady: true, deviceInstalled: true, preferNative: true })).toEqual({ kind: 'native' });
    // A provider the person chose still wins.
    expect(chooseAssistant({ ...base, preference: 'provider', providerConfigured: true, nativeReady: true, preferNative: true })).toEqual({ kind: 'provider' });
  });
  it('falls back to keyword search instead of failing when no embedder is available', () => {
    expect(chooseEmbedder({ preference: 'device', deviceInstalled: false, providerEmbeddings: false })).toEqual({ kind: 'offer-download' });
    expect(chooseEmbedder({ preference: 'device', deviceInstalled: true, providerEmbeddings: true })).toEqual({ kind: 'device' });
    expect(chooseEmbedder({ preference: 'provider', deviceInstalled: false, providerEmbeddings: true })).toEqual({ kind: 'provider' });
    expect(chooseEmbedder({ preference: 'provider', deviceInstalled: false, providerEmbeddings: false })).toEqual({ kind: 'keyword-only' });
    expect(chooseEmbedder({ preference: 'off', deviceInstalled: true, providerEmbeddings: true })).toEqual({ kind: 'keyword-only' });
  });
});

describe('ask with citations', () => {
  it('numbers passages and parses [n] citations, ignoring invented numbers', () => {
    const msgs = buildAskMessages('What is linear?', [
      { n: 1, title: 'Lecture 3', page: 2, kind: 'handwriting', text: 'The Fourier transform is linear.' },
      { n: 2, title: 'Lecture 4', page: 1, kind: 'typed text', text: 'Convolution becomes multiplication.' },
    ]);
    expect(msgs[1]!.content).toContain('[1] "Lecture 3", page 2 (handwriting)');
    const { segments, cited } = parseAnswerCitations('It is linear [1]. Also [1, 2] and 【2】 but not [7].', 2);
    expect(cited).toEqual([1, 2]);
    expect(segments).toEqual([
      { type: 'text', text: 'It is linear ' }, { type: 'cite', n: 1 }, { type: 'text', text: '. Also ' }, { type: 'cite', n: 1 }, { type: 'cite', n: 2 },
      { type: 'text', text: ' and ' }, { type: 'cite', n: 2 }, { type: 'text', text: ' but not [7].' },
    ]);
  });

  it('memory links round-trip note, page and region', () => {
    const href = memoryLink({ noteId: 'abc/1', pageIndex: 2, rect: { x: 10.4, y: 20, width: 300, height: 44.6 } });
    expect(href).toBe('#mem/abc%2F1/3/10,20,300,45');
    expect(parseMemoryLink(href)).toEqual({ noteId: 'abc/1', pageIndex: 2, rect: { x: 10, y: 20, width: 300, height: 45 } });
    expect(parseMemoryLink('#mem/n/1')).toEqual({ noteId: 'n', pageIndex: 0 });
    expect(parseMemoryLink('#note/x')).toBeNull();
  });
});

describe('Chrome built-in AI', () => {
  it('seeds a session with the system prompt and history and streams the answer', async () => {
    const created: any[] = [];
    const lm: ChromeLanguageModel = {
      availability: async () => 'available',
      create: async (opts) => {
        created.push(opts);
        return {
          prompt: async () => '',
          promptStreaming: () => new ReadableStream<string>({ start(c) { c.enqueue('Hi '); c.enqueue('there'); c.close(); } }),
          destroy: vi.fn(),
        };
      },
    };
    const p = createChromeAIProvider(lm);
    const events: StreamEvent[] = [];
    const r = await p.chat({ model: 'nano', messages: [{ role: 'system', content: 'Be kind.' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }, { role: 'user', content: 'hello' }] }, (e) => events.push(e));
    expect(r.text).toBe('Hi there');
    expect(created[0].initialPrompts).toEqual([{ role: 'system', content: 'Be kind.' }, { role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }]);
    expect(events.filter((e) => e.type === 'text')).toHaveLength(2);
  });
});

describe('local server detection', () => {
  it('finds running servers, their models, and servers blocked by CORS', async () => {
    const f = mockFetch((req) => {
      if (req.url === 'http://localhost:11434/v1/models') return jsonResponse({ data: [{ id: 'qwen3:4b' }, { id: 'nomic-embed-text' }] });
      if (req.url.startsWith('http://localhost:1234/')) {
        // LM Studio without CORS: the real request fails, an opaque one gets through.
        if ((req as any).mode === 'no-cors') return new Response(null, { status: 200 });
        throw new TypeError('Failed to fetch');
      }
      throw new TypeError('Failed to fetch');
    });
    // mockFetch does not record `mode`; wrap to pass it through.
    const fetchWithMode = (async (url: string, init: RequestInit = {}) => {
      if (init.mode === 'no-cors' && url.startsWith('http://localhost:1234/')) return new Response(null, { status: 200 });
      return f(url, init);
    }) as typeof f;
    const found = await detectLocalServers({ fetch: fetchWithMode, timeoutMs: 200 });
    expect(found.map((d) => [d.server.id, d.status, d.models])).toEqual([
      ['ollama', 'ready', ['qwen3:4b']],
      ['lmstudio', 'blocked', []],
    ]);
    expect(found[0]!.baseUrl).toBe('http://localhost:11434/v1');
  });
});

describe('provider embeddings', () => {
  it('batches requests and normalizes vectors', async () => {
    const f = mockFetch((req) => jsonResponse({ data: req.body.input.map((_: string, i: number) => ({ index: i, embedding: [3, 4] })) }));
    const out = await remoteEmbed({ baseUrl: 'http://localhost:11434/v1', model: 'nomic-embed-text', fetch: f, batch: 2 }, ['a', 'b', 'c']);
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]!.url).toBe('http://localhost:11434/v1/embeddings');
    expect(Array.from(out[2]!)).toEqual([expect.closeTo(0.6, 5), expect.closeTo(0.8, 5)]);
  });
});
