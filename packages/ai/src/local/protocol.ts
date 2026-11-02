/**
 * The contract between the app and the on-device model runtime, and the message protocol that
 * carries it across a Web Worker boundary. Models run in a worker so tokenizing, matrix maths and
 * multi-hundred-megabyte downloads never block the pen; the UI talks to a `LocalEngineClient`
 * that looks exactly like the engine itself. The engine is injected, so tests drive the whole
 * protocol with a fake model and the real one (transformers.js) lives only in the app's worker.
 */
import type { LocalDevice, LocalLoader, LocalModelSpec, LocalModelVariant } from './catalog.ts';

/** Everything the worker needs to know about a model (plain data: it crosses postMessage). */
export interface ModelRef {
  id: string;
  repo: string;
  onnxBase: string;
  loader: LocalLoader;
  device: LocalDevice;
  dtype: LocalModelVariant['dtype'];
  /** Expected download size, bytes (shown before downloading; the worker re-checks live). */
  bytes: number;
  embed?: { dims: number; truncate?: boolean; pooling: 'mean' | 'cls' };
  thinkingToggle?: boolean;
}

export function modelRef(spec: LocalModelSpec, variant: LocalModelVariant & { device: LocalDevice }): ModelRef {
  const ref: ModelRef = { id: spec.id, repo: spec.repo, onnxBase: spec.onnxBase, loader: spec.loader, device: variant.device, dtype: variant.dtype, bytes: variant.bytes };
  if (spec.embed) ref.embed = { dims: spec.embed.dims, truncate: spec.embed.truncate, pooling: spec.embed.pooling };
  if (spec.thinkingToggle) ref.thinkingToggle = true;
  return ref;
}

export interface DownloadProgress {
  /** Bytes on this device so far (resumed bytes included). */
  loaded: number;
  total: number;
  file?: string;
}

export interface LocalChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateRequest {
  messages: LocalChatMessage[];
  maxTokens?: number;
  temperature?: number;
  /** Let hybrid-thinking models reason before answering (slower). Default off. */
  thinking?: boolean;
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  stopReason: 'stop' | 'length';
}

export interface ModelStatus {
  installed: boolean;
  /** Bytes already on the device (complete or partial). */
  bytesOnDevice: number;
}

/** The on-device model runtime. */
export interface LocalEngine {
  status(model: ModelRef): Promise<ModelStatus>;
  /** Downloads (resuming a partial download) and verifies a model. */
  download(model: ModelRef, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal): Promise<void>;
  remove(model: ModelRef): Promise<void>;
  /** L2-normalized embeddings, one per input. */
  embed(model: ModelRef, inputs: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  generate(model: ModelRef, req: GenerateRequest, onDelta?: (text: string) => void, signal?: AbortSignal): Promise<GenerateResult>;
  /** Frees memory held by a loaded model (all models without an id). */
  unload(modelId?: string): Promise<void>;
}

// ---- Wire format ------------------------------------------------------------------------------

type Method = 'status' | 'download' | 'remove' | 'embed' | 'generate' | 'unload';

export type ClientMessage =
  | { kind: 'call'; id: number; method: Method; args: unknown[] }
  | { kind: 'cancel'; id: number };

export type EngineMessage =
  | { kind: 'progress'; id: number; progress: DownloadProgress }
  | { kind: 'delta'; id: number; text: string }
  | { kind: 'result'; id: number; value: unknown }
  | { kind: 'error'; id: number; error: { name: string; message: string } };

/** A worker, a worker's `self`, or a MessagePort. */
export interface PortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (e: { data: any }) => void): void;
  removeEventListener?(type: 'message', listener: (e: { data: any }) => void): void;
  start?(): void;
}

function abortError(): Error {
  const e = new Error('Cancelled');
  e.name = 'AbortError';
  return e;
}

/** Worker side: answers calls on `port` with `engine`. Returns a function that stops serving. */
export function serveLocalEngine(port: PortLike, engine: LocalEngine): () => void {
  const running = new Map<number, AbortController>();
  const send = (m: EngineMessage, transfer?: Transferable[]) => port.postMessage(m, transfer);
  const onMessage = async (e: { data: ClientMessage }) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.kind === 'cancel') {
      running.get(m.id)?.abort();
      return;
    }
    if (m.kind !== 'call') return;
    const ac = new AbortController();
    running.set(m.id, ac);
    try {
      const [model, extra] = m.args as [ModelRef, unknown];
      let value: unknown;
      let transfer: Transferable[] | undefined;
      switch (m.method) {
        case 'status': value = await engine.status(model); break;
        case 'download': value = await engine.download(model, (progress) => send({ kind: 'progress', id: m.id, progress }), ac.signal); break;
        case 'remove': value = await engine.remove(model); break;
        case 'embed': {
          const vecs = await engine.embed(model, extra as string[], ac.signal);
          value = vecs;
          transfer = vecs.map((v) => v.buffer as ArrayBuffer).filter((b, i, all) => all.indexOf(b) === i);
          break;
        }
        case 'generate': value = await engine.generate(model, extra as GenerateRequest, (text) => send({ kind: 'delta', id: m.id, text }), ac.signal); break;
        case 'unload': value = await engine.unload(m.args[0] as string | undefined); break;
        default: throw new Error(`Unknown method ${(m as { method: string }).method}`);
      }
      if (ac.signal.aborted) throw abortError();
      send({ kind: 'result', id: m.id, value }, transfer);
    } catch (err) {
      const e = err as Error;
      send({ kind: 'error', id: m.id, error: { name: ac.signal.aborted ? 'AbortError' : e?.name || 'Error', message: e?.message || String(err) } });
    } finally {
      running.delete(m.id);
    }
  };
  port.addEventListener('message', onMessage as (e: { data: any }) => void);
  port.start?.();
  return () => port.removeEventListener?.('message', onMessage as (e: { data: any }) => void);
}

interface Pending {
  resolve: (v: any) => void;
  reject: (e: Error) => void;
  onProgress?: (p: DownloadProgress) => void;
  onDelta?: (t: string) => void;
}

/** App side: a LocalEngine whose work happens behind `port` (usually a Worker). */
export class LocalEngineClient implements LocalEngine {
  private seq = 0;
  private pending = new Map<number, Pending>();
  private listener = (e: { data: EngineMessage }) => this.onMessage(e.data);

  constructor(private port: PortLike) {
    port.addEventListener('message', this.listener as (e: { data: any }) => void);
    port.start?.();
  }

  private onMessage(m: EngineMessage) {
    const p = m && this.pending.get(m.id);
    if (!p) return;
    if (m.kind === 'progress') p.onProgress?.(m.progress);
    else if (m.kind === 'delta') p.onDelta?.(m.text);
    else if (m.kind === 'result') { this.pending.delete(m.id); p.resolve(m.value); }
    else if (m.kind === 'error') {
      this.pending.delete(m.id);
      const e = new Error(m.error.message);
      e.name = m.error.name;
      p.reject(e);
    }
  }

  private call<T>(method: Method, args: unknown[], hooks: Omit<Pending, 'resolve' | 'reject'> = {}, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) return Promise.reject(abortError());
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => this.port.postMessage({ kind: 'cancel', id } satisfies ClientMessage);
      signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => signal?.removeEventListener('abort', onAbort);
      this.pending.set(id, { ...hooks, resolve: (v) => { done(); resolve(v); }, reject: (e) => { done(); reject(e); } });
      this.port.postMessage({ kind: 'call', id, method, args } satisfies ClientMessage);
    });
  }

  status(model: ModelRef) { return this.call<ModelStatus>('status', [model]); }
  download(model: ModelRef, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal) { return this.call<void>('download', [model], { onProgress }, signal); }
  remove(model: ModelRef) { return this.call<void>('remove', [model]); }
  embed(model: ModelRef, inputs: string[], signal?: AbortSignal) { return this.call<Float32Array[]>('embed', [model, inputs], {}, signal); }
  generate(model: ModelRef, req: GenerateRequest, onDelta?: (text: string) => void, signal?: AbortSignal) { return this.call<GenerateResult>('generate', [model, req], { onDelta }, signal); }
  unload(modelId?: string) { return this.call<void>('unload', [modelId]); }

  /** Rejects everything in flight (the worker died or the app is shutting the runtime down). */
  dispose(reason = 'The on-device AI runtime stopped.') {
    this.port.removeEventListener?.('message', this.listener as (e: { data: any }) => void);
    for (const p of this.pending.values()) p.reject(new Error(reason));
    this.pending.clear();
  }
}
