import type { DownloadEvent, NativeAIPlugin, NativeAIStatus } from '../ai/native/plugin.ts';

/**
 * An in-memory stand-in for the Android plugin's AI methods, for unit tests: it records calls,
 * emits events like Capacitor does, and lets a test script each method's behaviour.
 */
export type Listener = (e: any) => void;

export interface FakeNativeAI extends NativeAIPlugin {
  calls: { method: string; args: any }[];
  listeners: Map<string, Set<Listener>>;
  emit(event: string, data: any): void;
  status: NativeAIStatus;
  /** Override per test. Receives the request and an `emit` for deltas. */
  onGenerate: (args: any, delta: (d: string) => void) => Promise<{ text: string }>;
  onTask: (args: any, delta: (d: string) => void) => Promise<{ text: string }>;
  onDownload: (args: any, emit: (e: DownloadEvent) => void) => Promise<{ state: 'available' }>;
}

export function baseStatus(over: Partial<NativeAIStatus> = {}): NativeAIStatus {
  return {
    engines: [{ id: 'gemini-nano', state: 'unavailable' }],
    tasks: { summarize: 'unavailable', proofread: 'unavailable', rewrite: 'unavailable', 'describe-image': 'unavailable' },
    models: [
      { id: 'gemma-4-e2b', label: 'Gemma 4 E2B', bytes: 2_588_147_712, licence: 'Apache-2.0', params: '5B (2B effective)', blurb: 'Open model.', contextTokens: 4096, minRamGb: 7, state: 'downloadable', partialBytes: 0, loaded: false },
      { id: 'qwen3-0.6b', label: 'Qwen3 0.6B', bytes: 497_516_544, licence: 'Apache-2.0', params: '0.6B', blurb: 'Small.', contextTokens: 2048, minRamGb: 3, state: 'downloadable', partialBytes: 0, loaded: false },
    ],
    recommendedModel: 'gemma-4-e2b',
    ramGb: 7.4,
    speech: { available: true, onDevice: true, fileInput: true },
    ...over,
  };
}

export function createFakeNativeAI(status: NativeAIStatus = baseStatus()): FakeNativeAI {
  const listeners = new Map<string, Set<Listener>>();
  const fake: FakeNativeAI = {
    calls: [],
    listeners,
    status,
    emit(event, data) {
      for (const l of listeners.get(event) ?? []) l(data);
    },
    onGenerate: async () => ({ text: '' }),
    onTask: async () => ({ text: '' }),
    onDownload: async () => ({ state: 'available' }),
    async addListener(event: string, cb: Listener) {
      fake.calls.push({ method: 'addListener', args: event });
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(cb);
      return { remove: async () => void listeners.get(event)!.delete(cb) };
    },
    async aiStatus(args) {
      fake.calls.push({ method: 'aiStatus', args });
      return structuredClone(fake.status);
    },
    async aiDownload(args) {
      fake.calls.push({ method: 'aiDownload', args });
      return fake.onDownload(args, (e) => fake.emit('aiDownload', e));
    },
    async aiCancelDownload(args) { fake.calls.push({ method: 'aiCancelDownload', args }); },
    async aiDeleteModel(args) { fake.calls.push({ method: 'aiDeleteModel', args }); },
    async aiUnload() { fake.calls.push({ method: 'aiUnload', args: null }); },
    async aiGenerate(args) {
      fake.calls.push({ method: 'aiGenerate', args });
      return fake.onGenerate(args, (d) => fake.emit('aiDelta', { requestId: args.requestId, delta: d }));
    },
    async aiTask(args) {
      fake.calls.push({ method: 'aiTask', args });
      return fake.onTask(args, (d) => fake.emit('aiDelta', { requestId: args.requestId, delta: d }));
    },
    async aiCancel(args) { fake.calls.push({ method: 'aiCancel', args }); },
    async speechStart(args) {
      fake.calls.push({ method: 'speechStart', args });
      return { onDevice: fake.status.speech.onDevice };
    },
    async speechStop(args) {
      fake.calls.push({ method: 'speechStop', args });
      return { text: ' buy milk ' };
    },
    async speechCancel(args) { fake.calls.push({ method: 'speechCancel', args }); },
    async speechTranscribe(args) {
      fake.calls.push({ method: 'speechTranscribe', args });
      return { text: ' hello there ' };
    },
  } as FakeNativeAI;
  return fake;
}
