/**
 * The on-device AI worker: runs open models with transformers.js (ONNX Runtime Web) on the GPU via
 * WebGPU, or on the CPU via WebAssembly, off the main thread so writing never stutters. Models are
 * downloaded once into OPFS (resumable) and served to transformers.js through a custom cache, so
 * after the first download everything works offline. The app talks to this file only through the
 * `LocalEngine` protocol in @inkstone/ai.
 */
import * as T from '@huggingface/transformers';
import ortWasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.wasm?url';
import ortMjsUrl from 'onnxruntime-web/ort-wasm-simd-threaded.asyncify.mjs?url';
import { normalize, serveLocalEngine, truncateEmbedding, type DownloadProgress, type GenerateRequest, type GenerateResult, type LocalEngine, type ModelRef, type ModelStatus, type PortLike, type TranscribeRequest, type TranscribeResult } from '@inkstone/ai';
import { HF_HOST, fileHandle, filesFor, opfsAvailable, parseCacheKey, readIndex, readStored, removeStored, repoDir, storedSize, storedStatus, writeManifest } from './model-files.ts';

const env = T.env as any;
const scope = self as unknown as PortLike & { location: Location; crossOriginIsolated?: boolean };

// The ONNX Runtime WebAssembly files ship with the app (never a CDN): works offline and under CSP.
env.allowLocalModels = false;
env.useWasmCache = false;
env.backends.onnx.wasm.wasmPaths = { wasm: new URL(ortWasmUrl, scope.location.href).href, mjs: new URL(ortMjsUrl, scope.location.href).href };
env.backends.onnx.wasm.numThreads = scope.crossOriginIsolated ? Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 2) - 1)) : 1;

/** Synchronous access handles (workers only) make in-place, resumable writes possible. */
const hasOpfsApi = opfsAvailable() && typeof FileSystemFileHandle !== 'undefined' && 'createSyncAccessHandle' in FileSystemFileHandle.prototype;

/**
 * Whether OPFS really opens here. Feature detection is not enough: WebKit exposes the API in
 * Safari private windows and ephemeral sessions but rejects getDirectory() ("UnknownError"), which
 * used to surface as "null is not an object (evaluating 'e.getFileHandle')" when downloading a
 * model. Probed once; when it fails, models go through transformers.js's own cache instead.
 */
let opfsProbe: Promise<boolean> | null = null;
function canWriteOpfs(): Promise<boolean> {
  opfsProbe ??= hasOpfsApi
    ? navigator.storage.getDirectory().then(() => true, () => false).then((ok) => {
      if (ok) {
        env.useBrowserCache = false;
        env.useCustomCache = true;
        env.customCache = opfsCache;
      }
      return ok;
    })
    : Promise.resolve(false);
  return opfsProbe;
}

function abortError(): Error {
  return Object.assign(new Error('Cancelled'), { name: 'AbortError' });
}

// ---- Storage -----------------------------------------------------------------------------------

let indexLock: Promise<void> = Promise.resolve();

/** Serialized read-modify-write of a repository's size index. */
function updateIndex(dir: FileSystemDirectoryHandle, fn: (idx: Record<string, number>) => void): Promise<void> {
  const run = indexLock.then(async () => {
    const idx = await readIndex(dir);
    fn(idx);
    const h = await dir.getFileHandle('.index.json', { create: true });
    const a = await (h as any).createSyncAccessHandle();
    try {
      const bytes = new TextEncoder().encode(JSON.stringify(idx));
      a.truncate(0);
      a.write(bytes, { at: 0 });
      a.flush();
    } finally {
      a.close();
    }
  });
  indexLock = run.catch(() => {});
  return run;
}

async function writeWhole(repo: string, path: string, data: Uint8Array): Promise<void> {
  const dir = (await repoDir(repo))!;
  const h = (await fileHandle(dir, path, true))!;
  const a = await (h as any).createSyncAccessHandle();
  try {
    a.truncate(0);
    a.write(data, { at: 0 });
    a.flush();
  } finally {
    a.close();
  }
  await updateIndex(dir, (idx) => { idx[path] = data.byteLength; });
}

/** transformers.js reads model files from here (and stores any extra file it fetched itself). */
const opfsCache = {
  async match(key: string | Request) {
    const p = parseCacheKey(typeof key === 'string' ? key : key.url);
    if (!p) return undefined;
    const f = await readStored(p.repo, p.path);
    return f ? new Response(f, { headers: { 'content-length': String(f.size) } }) : undefined;
  },
  async put(key: string | Request, res: Response) {
    const p = parseCacheKey(typeof key === 'string' ? key : key.url);
    if (!p) return;
    await writeWhole(p.repo, p.path, new Uint8Array(await res.arrayBuffer()));
  },
  async delete() {
    return false;
  },
};


/** Streams one file into OPFS from `have` bytes on (HTTP Range), reporting each chunk. */
async function fetchInto(dir: FileSystemDirectoryHandle, repo: string, file: { path: string; size: number }, report: (delta: number) => void, signal?: AbortSignal): Promise<void> {
  const h = (await fileHandle(dir, file.path, true))!;
  const a = await (h as any).createSyncAccessHandle();
  try {
    let at: number = a.getSize();
    if (at > file.size) { a.truncate(0); report(-at); at = 0; }
    if (at === file.size) return;
    const res = await fetch(`${HF_HOST}/${repo}/resolve/main/${file.path}`, { headers: at ? { Range: `bytes=${at}-` } : undefined, signal, cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`Download of ${file.path} failed (HTTP ${res.status}).`);
    if (at && res.status !== 206) { a.truncate(0); report(-at); at = 0; } // server ignored the range: start over
    const reader = res.body.getReader();
    let sinceFlush = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      a.write(value, { at });
      at += value.byteLength;
      sinceFlush += value.byteLength;
      report(value.byteLength);
      if (sinceFlush > 32 << 20) { a.flush(); sinceFlush = 0; }
    }
    a.flush();
    if (at !== file.size) throw new Error(`Download of ${file.path} was cut short; it will resume next time.`);
  } finally {
    a.close();
  }
}

async function ensureSpace(needed: number) {
  try {
    const est = await navigator.storage.estimate();
    if (est.quota != null && est.usage != null && est.quota - est.usage < needed * 1.05) {
      const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
      throw new Error(`Not enough storage for this model: it needs ${gb(needed)} more and the browser allows ${gb(Math.max(0, est.quota - est.usage))}. Free up space or choose a smaller model.`);
    }
  } catch (e) {
    if ((e as Error).message?.startsWith('Not enough storage')) throw e;
  }
}

// ---- Loaded models -----------------------------------------------------------------------------

type Loaded =
  | { kind: 'pipe'; pipe: any }
  | { kind: 'asr'; pipe: any }
  | { kind: 'encoder'; model: any; tokenizer: any }
  | { kind: 'causal'; model: any; tokenizer: any };

const loaded = new Map<string, Promise<Loaded>>();

async function disposeLoaded(id: string) {
  const p = loaded.get(id);
  loaded.delete(id);
  try {
    const m = await p;
    await (m?.kind === 'pipe' || m?.kind === 'asr' ? m.pipe.dispose?.() : m?.model.dispose?.());
  } catch {
    /* already gone */
  }
}

function load(ref: ModelRef): Promise<Loaded> {
  const key = `${ref.id}:${ref.device}:${ref.dtype}`;
  let p = loaded.get(key);
  if (p) return p;
  p = (async (): Promise<Loaded> => {
    // One chat model at a time: GPU memory is the scarce resource on phones.
    if (ref.loader === 'causal-lm') for (const k of [...loaded.keys()]) if (k !== key && loaded.has(k)) { const other = await loaded.get(k)!.catch(() => null); if (other?.kind === 'causal') await disposeLoaded(k); }
    const opts = { device: ref.device, dtype: ref.dtype };
    if (ref.loader === 'feature-extraction') return { kind: 'pipe', pipe: await T.pipeline('feature-extraction', ref.repo, opts as any) };
    // Speech models: per-file dtypes (e.g. a full-precision audio encoder with a 4-bit decoder).
    if (ref.loader === 'speech-to-text') return { kind: 'asr', pipe: await T.pipeline('automatic-speech-recognition', ref.repo, { device: ref.device, dtype: ref.moduleDtypes ?? ref.dtype } as any) };
    const tokenizer = await T.AutoTokenizer.from_pretrained(ref.repo);
    if (ref.loader === 'text-embedding-multimodal') {
      const config: any = await T.AutoConfig.from_pretrained(ref.repo);
      config.vision_config = null; // text only: leave the image and audio encoders out
      config.audio_config = null;
      return { kind: 'encoder', model: await T.AutoModel.from_pretrained(ref.repo, { ...opts, config } as any), tokenizer };
    }
    return { kind: 'causal', model: await T.AutoModelForCausalLM.from_pretrained(ref.repo, opts as any), tokenizer };
  })();
  loaded.set(key, p);
  p.catch(() => loaded.delete(key));
  return p;
}

async function requireInstalled(ref: ModelRef) {
  if (!(await canWriteOpfs())) return; // transformers.js manages its own cache here
  if (!(await storedStatus(ref)).installed) throw new Error('This on-device model is not downloaded yet. Download it in Settings › AI.');
}

/** `<|…|>` control tokens; tool-call and reasoning tags stay so the app can parse them. */
const CONTROL = /<\|[^|>]{1,40}\|>/g;

// ---- Engine ------------------------------------------------------------------------------------

const engine: LocalEngine = {
  async status(ref: ModelRef): Promise<ModelStatus> {
    if (await canWriteOpfs()) return storedStatus(ref);
    const installed = await (T as any).ModelRegistry.is_cached(ref.repo, { dtype: ref.dtype, device: ref.device }).catch(() => false);
    return { installed, bytesOnDevice: installed ? ref.bytes : 0 };
  },

  async download(ref: ModelRef, onProgress?: (p: DownloadProgress) => void, signal?: AbortSignal) {
    if (!(await canWriteOpfs())) {
      // No OPFS writes (e.g. a private window): let transformers.js fetch into Cache Storage.
      const m = await load({ ...ref });
      void m;
      onProgress?.({ loaded: ref.bytes, total: ref.bytes });
      return;
    }
    const files = await filesFor(ref, signal);
    const dir = (await repoDir(ref.repo))!;
    await updateIndex(dir, (idx) => { for (const f of files) idx[f.path] = f.size; });
    const total = files.reduce((a, f) => a + f.size, 0);
    let have = 0;
    for (const f of files) have += Math.min(f.size, await storedSize(dir, f.path));
    await ensureSpace(total - have);
    let last = 0;
    let current = '';
    const report = (delta: number) => {
      have += delta;
      const now = Date.now();
      if (now - last > 120) { last = now; onProgress?.({ loaded: have, total, file: current }); }
    };
    onProgress?.({ loaded: have, total });
    for (const f of files) {
      if (signal?.aborted) throw abortError();
      current = f.path;
      if ((await storedSize(dir, f.path)) === f.size) continue;
      await fetchInto(dir, ref.repo, f, report, signal);
    }
    for (const f of files) if ((await storedSize(dir, f.path)) !== f.size) throw new Error(`${f.path} did not download completely. Try again to resume.`);
    await writeManifest(dir, ref, files);
    onProgress?.({ loaded: total, total });
  },

  async remove(ref: ModelRef) {
    for (const k of [...loaded.keys()]) if (k.startsWith(`${ref.id}:`)) await disposeLoaded(k);
    if (await canWriteOpfs()) await removeStored(ref);
    else await (T as any).ModelRegistry.clear_cache(ref.repo, { dtype: ref.dtype, device: ref.device }).catch(() => {});
  },

  async embed(ref: ModelRef, inputs: string[], signal?: AbortSignal) {
    await requireInstalled(ref);
    const m = await load(ref);
    const dims = ref.embed?.dims ?? 384;
    const out: Float32Array[] = [];
    for (let i = 0; i < inputs.length; i += 16) {
      if (signal?.aborted) throw abortError();
      const batch = inputs.slice(i, i + 16);
      let rows: number[][];
      if (m.kind === 'pipe') {
        rows = (await m.pipe(batch, { pooling: ref.embed?.pooling ?? 'mean', normalize: true })).tolist();
      } else if (m.kind === 'encoder') {
        const enc = await m.tokenizer(batch, { padding: true, truncation: true, max_length: 2048 });
        const res = await m.model(enc);
        rows = (res.sentence_embedding ?? res.last_hidden_state.mean(1)).tolist();
      } else throw new Error(`${ref.id} is not an embedding model.`);
      for (const r of rows) out.push(ref.embed?.truncate ? truncateEmbedding(Float32Array.from(r), dims) : normalize(Float32Array.from(r)));
    }
    return out;
  },

  async generate(ref: ModelRef, req: GenerateRequest, onDelta?: (text: string) => void, signal?: AbortSignal): Promise<GenerateResult> {
    await requireInstalled(ref);
    const m = await load(ref);
    if (m.kind !== 'causal') throw new Error(`${ref.id} is not a chat model.`);
    if (signal?.aborted) throw abortError();
    const inputs = m.tokenizer.apply_chat_template(req.messages, { add_generation_prompt: true, return_dict: true, ...(ref.thinkingToggle ? { enable_thinking: !!req.thinking } : {}) });
    const stop = new (T as any).InterruptableStoppingCriteria();
    const onAbort = () => stop.interrupt();
    signal?.addEventListener('abort', onAbort, { once: true });
    const streamer = new (T as any).TextStreamer(m.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: false,
      callback_function: (t: string) => { const s = t.replace(CONTROL, ''); if (s) onDelta?.(s); },
    });
    const maxTokens = req.maxTokens ?? 1024;
    const temperature = req.temperature ?? 0.3;
    try {
      const out = await m.model.generate({
        ...inputs,
        max_new_tokens: maxTokens,
        do_sample: temperature > 0,
        ...(temperature > 0 ? { temperature, top_p: 0.9, top_k: 40 } : {}),
        repetition_penalty: 1.05,
        streamer,
        stopping_criteria: stop,
        return_dict_in_generate: true,
      });
      if (signal?.aborted) throw abortError();
      const seq = out.sequences ?? out;
      const promptLen = inputs.input_ids.dims.at(-1) as number;
      const outputTokens = (seq.dims.at(-1) as number) - promptLen;
      const text = (m.tokenizer.batch_decode(seq.slice(null, [promptLen, null]), { skip_special_tokens: false })[0] as string).replace(CONTROL, '').trim();
      return { text, inputTokens: promptLen, outputTokens, stopReason: outputTokens >= maxTokens ? 'length' : 'stop' };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  },

  async transcribe(ref: ModelRef, req: TranscribeRequest, signal?: AbortSignal): Promise<TranscribeResult> {
    await requireInstalled(ref);
    const m = await load(ref);
    if (m.kind !== 'asr') throw new Error(`${ref.id} is not a speech model.`);
    if (signal?.aborted) throw abortError();
    const whisper = ref.asr?.family === 'whisper';
    const opts: Record<string, unknown> = whisper
      ? { return_timestamps: true, task: 'transcribe', ...(req.language ? { language: req.language } : {}) }
      // Moonshine: ~6.5 tokens per second of speech is plenty; the cap stops runaway repetition.
      : { max_new_tokens: Math.max(16, Math.ceil((req.audio.length / 16_000) * 6.5) + 8) };
    const out = await m.pipe(req.audio, opts);
    if (signal?.aborted) throw abortError();
    const r = (Array.isArray(out) ? out[0] : out) as { text?: string; chunks?: { text: string; timestamp: [number, number | null] }[] };
    const result: TranscribeResult = { text: (r?.text ?? '').trim() };
    if (r?.chunks?.length) result.chunks = r.chunks.map((c) => ({ text: c.text, start: c.timestamp[0] ?? 0, end: c.timestamp[1] ?? null }));
    return result;
  },

  async unload(modelId?: string) {
    for (const k of [...loaded.keys()]) if (!modelId || k.startsWith(`${modelId}:`)) await disposeLoaded(k);
  },
};

serveLocalEngine(scope, engine);
