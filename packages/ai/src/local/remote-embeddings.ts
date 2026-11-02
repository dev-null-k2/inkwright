import { httpError, networkError } from '../errors.ts';
import { joinUrl } from '../http.ts';
import type { FetchLike } from '../types.ts';

/** L2-normalizes in place (so a dot product is cosine similarity) and returns the vector. */
export function normalize(v: Float32Array): Float32Array {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  const n = Math.sqrt(s) || 1;
  for (let i = 0; i < v.length; i++) v[i]! /= n;
  return v;
}

/** Matryoshka truncation: keep the first `dims` values and re-normalize. */
export function truncateEmbedding(v: Float32Array, dims: number): Float32Array {
  return v.length <= dims ? normalize(v) : normalize(v.slice(0, dims));
}

export interface RemoteEmbeddingConfig {
  /** OpenAI-compatible base URL (…/v1): OpenAI, Mistral, Together, Ollama, LM Studio, llama.cpp… */
  baseUrl: string;
  apiKey?: string;
  model: string;
  /** Provider id for error messages. */
  provider?: string;
  fetch?: FetchLike;
  /** Inputs per request (default 64). */
  batch?: number;
}

/**
 * Embeddings from the user's own provider through the OpenAI `/embeddings` API — for people who
 * prefer their provider over the on-device model (for example nomic-embed-text in Ollama).
 */
export async function remoteEmbed(cfg: RemoteEmbeddingConfig, inputs: string[], signal?: AbortSignal): Promise<Float32Array[]> {
  const f = cfg.fetch ?? ((u, i) => fetch(u, i));
  const url = joinUrl(cfg.baseUrl, 'embeddings');
  const provider = cfg.provider ?? 'embeddings';
  const out: Float32Array[] = [];
  const size = cfg.batch ?? 64;
  for (let i = 0; i < inputs.length; i += size) {
    const batch = inputs.slice(i, i + size);
    let res: Response;
    try {
      res = await f(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(cfg.apiKey ? { authorization: `Bearer ${cfg.apiKey}` } : {}) },
        body: JSON.stringify({ model: cfg.model, input: batch }),
        signal,
      });
    } catch (e) {
      throw networkError(provider, provider, url, e);
    }
    if (!res.ok) {
      let body: unknown = null;
      try { body = await res.json(); } catch { /* not JSON */ }
      throw httpError({ provider, label: provider, status: res.status, body, headers: res.headers });
    }
    const json = (await res.json()) as { data?: { index?: number; embedding: number[] }[] };
    const rows = [...(json.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    if (rows.length !== batch.length) throw new Error(`${provider} returned ${rows.length} embeddings for ${batch.length} inputs.`);
    for (const r of rows) out.push(normalize(Float32Array.from(r.embedding)));
  }
  return out;
}
