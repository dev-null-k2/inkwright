import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getLocalModel, type GenerateRequest, type GenerateResult, type LocalEngine, type ModelRef } from '../src/index.ts';

/**
 * The app's on-device chat engine (apps/web/src/ai/local-worker.ts) in Node, for evals with real
 * weights: the same transformers.js calls (chat template with thinking off, streamed generation,
 * control tokens removed) on the CPU through onnxruntime-node. Weights are downloaded from Hugging
 * Face once into `INKWRIGHT_MODEL_CACHE` (default: the OS temp folder), never into the repository.
 */
const CONTROL = /<\|[^|>]{1,40}\|>/g;

export function evalModelCache(): string {
  return process.env.INKWRIGHT_MODEL_CACHE || join(tmpdir(), 'inkwright-models');
}

export function nodeModelRef(id: string): ModelRef {
  const spec = getLocalModel(id);
  if (!spec) throw new Error(`Unknown model ${id}`);
  const v = spec.variants.find((x) => x.device === 'wasm') ?? spec.variants[0]!;
  return { id: spec.id, repo: spec.repo, onnxBase: spec.onnxBase, loader: spec.loader, device: 'wasm', dtype: v.dtype, bytes: v.bytes, ...(spec.thinkingToggle ? { thinkingToggle: true } : {}) };
}

export interface NodeEngine extends LocalEngine {
  /** Tokens per second of the last generation (for the report). */
  lastSpeed(): number;
}

export async function createNodeEngine(): Promise<NodeEngine> {
  const T: any = await import('@huggingface/transformers');
  T.env.cacheDir = evalModelCache();
  const loaded = new Map<string, Promise<{ model: any; tokenizer: any }>>();
  let speed = 0;
  const load = (ref: ModelRef) => {
    let p = loaded.get(ref.id);
    if (!p) {
      p = (async () => ({ tokenizer: await T.AutoTokenizer.from_pretrained(ref.repo), model: await T.AutoModelForCausalLM.from_pretrained(ref.repo, {
        dtype: ref.dtype,
        // No arena (ONNX Runtime's CPU arena keeps the largest activation ever allocated) and no
        // weight prepacking (it keeps a second, repacked copy of the 4-bit weights): Qwen3 1.7B
        // then needs 2.8 GB instead of 4.1 GB, which fits beside other work on an 8 GB machine.
        session_options: { enableCpuMemArena: false, enableMemPattern: false, extra: { session: { disable_prepacking: '1' } } },
      }) }))();
      loaded.set(ref.id, p);
    }
    return p;
  };
  return {
    lastSpeed: () => speed,
    async status() { return { installed: true, bytesOnDevice: 0 }; },
    async download() {},
    async remove() {},
    async embed() { throw new Error('not used in evals'); },
    async unload() {
      for (const p of loaded.values()) (await p).model.dispose?.();
      loaded.clear();
    },
    async generate(ref: ModelRef, req: GenerateRequest, onDelta?: (t: string) => void): Promise<GenerateResult> {
      const m = await load(ref);
      const inputs = m.tokenizer.apply_chat_template(req.messages, { add_generation_prompt: true, return_dict: true, ...(ref.thinkingToggle ? { enable_thinking: !!req.thinking } : {}) });
      const prompt: bigint[] = Array.from(inputs.input_ids.data as BigInt64Array);
      const maxTokens = req.maxTokens ?? 512;
      const eosIds = [m.model.generation_config?.eos_token_id ?? m.model.config?.eos_token_id].flat().filter((x: unknown) => typeof x === 'number') as number[];
      const eos = new Set<number>(eosIds);
      // Chat turns also end at the template's end-of-turn token, whatever the config lists.
      for (const t of ['<|im_end|>', '<end_of_turn>', '<turn|>', '<|endoftext|>', '<|eot_id|>']) { const id = m.tokenizer.model?.tokens_to_ids?.get(t); if (typeof id === 'number') eos.add(id); }
      const t0 = Date.now();
      const out: number[] = [];
      let shown = '';
      await greedy(T, m.model, prompt, maxTokens, eos, (id) => {
        out.push(id);
        const text = (m.tokenizer.decode(out, { skip_special_tokens: false }) as string).replace(CONTROL, '');
        // Hold back a partly decoded multi-byte character.
        if (!text.endsWith('\uFFFD') && text.length > shown.length) {
          onDelta?.(text.slice(shown.length));
          shown = text;
        }
      });
      speed = out.length / Math.max(0.001, (Date.now() - t0) / 1000);
      if (process.env.INKWRIGHT_EVAL_DEBUG) console.log(`  generate: ${prompt.length} prompt tokens, ${out.length} out, ${speed.toFixed(1)} tok/s, rss ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
      const text = (m.tokenizer.decode(out, { skip_special_tokens: false }) as string).replace(CONTROL, '').trim();
      return { text, inputTokens: prompt.length, outputTokens: out.length, stopReason: out.length >= maxTokens ? 'length' : 'stop' };
    },
  };
}

/**
 * Greedy decoding with the prompt fed in chunks. transformers.js computes logits for every prompt
 * position (these ONNX exports have no `num_logits_to_keep`): for a 3,000-token prompt and Qwen's
 * 152k vocabulary that is 1.8 GB of float32 at once, which is what killed the first eval runs on an
 * 8 GB machine. Feeding 256 tokens at a time through the KV cache keeps it to ~150 MB. Greedy
 * decoding with a light repetition penalty (1.05, as in the app) keeps runs reproducible.
 */
async function greedy(T: any, model: any, prompt: bigint[], maxNew: number, eos: Set<number>, onToken: (id: number) => void, chunk = 256): Promise<void> {
  let past: Record<string, any> | null = null;
  let total = 0;
  const seen = new Set<number>();
  const step = async (ids: bigint[]): Promise<number> => {
    total += ids.length;
    const feeds: Record<string, unknown> = {
      input_ids: new T.Tensor('int64', BigInt64Array.from(ids), [1, ids.length]),
      attention_mask: new T.Tensor('int64', new BigInt64Array(total).fill(1n), [1, total]),
    };
    if (past) feeds.past_key_values = past;
    const res = await model.forward(feeds);
    const next: Record<string, any> = {};
    for (const k of Object.keys(res)) if (k.startsWith('present')) next[k.replace('present', 'past_key_values')] = res[k];
    past = next;
    const [, len, vocab] = res.logits.dims as number[];
    const row = (res.logits.data as Float32Array).subarray((len! - 1) * vocab!, len! * vocab!);
    let best = 0;
    let bestScore = -Infinity;
    for (let i = 0; i < row.length; i++) {
      let v = row[i]!;
      if (seen.has(i)) v = v > 0 ? v / 1.05 : v * 1.05;
      if (v > bestScore) { bestScore = v; best = i; }
    }
    return best;
  };
  let next = -1;
  for (let i = 0; i < prompt.length; i += chunk) next = await step(prompt.slice(i, i + chunk));
  for (let n = 0; n < maxNew; n++) {
    if (eos.has(next)) return;
    onToken(next);
    seen.add(next);
    next = await step([BigInt(next)]);
  }
}
