import { KeywordRelatedNotes, dot, type RelatedNotesProvider } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { appMemory, type AppMemory } from './memory.ts';

/**
 * Where "related notes" come from, best available first:
 *  1. a provider registered with `setRelatedNotesProvider` (e.g. a future cross-device index);
 *  2. the on-device semantic memory (lib/memory.ts): notes compared by the mean of their passage
 *     embeddings, once an embedding model has indexed them;
 *  3. shared tags and keywords from the knowledge index (KeywordRelatedNotes) — always there.
 * The Links panel and the graph only ever call `relatedNotesProvider()`.
 */
let custom: RelatedNotesProvider | null = null;
const listeners = new Set<() => void>();

export function setRelatedNotesProvider(p: RelatedNotesProvider | null): void {
  custom = p;
  for (const l of [...listeners]) l();
}

/** Notified when the provider changes (the graph rebuilds its "related" edges). */
export function onRelatedProviderChange(l: () => void): () => void {
  listeners.add(l);
  const unsub = appMemory()?.subscribe(() => l());
  return () => { listeners.delete(l); unsub?.(); };
}

/** True when related notes come from meaning (embeddings), not just shared words. */
export const hasSemanticProvider = () => custom != null || (appMemory()?.status().embedder != null && (appMemory()?.status().embedded ?? 0) > 0);

/**
 * Related notes from the semantic memory. Note vectors are cached per memory version; scores are
 * cosine similarities spread to 0..1 over this vault (embedding cosines of unrelated texts are
 * rarely near 0, so raw values would make every note look related).
 */
export class MemoryRelatedNotes implements RelatedNotesProvider {
  private cache = new Map<string, Float32Array | null>();
  private at = -1;
  constructor(private memory: AppMemory, private fallback: RelatedNotesProvider) {}

  private vector(id: string): Float32Array | null {
    const v = this.memory.status().version * 1e6 + this.memory.status().embedded;
    if (v !== this.at) { this.cache.clear(); this.at = v; }
    if (!this.cache.has(id)) this.cache.set(id, this.memory.noteVector(id));
    return this.cache.get(id)!;
  }

  async relatedNotes(noteId: string, opts: { limit?: number } = {}): Promise<{ id: string; score: number }[]> {
    const q = this.vector(noteId);
    if (!q) return this.fallback.relatedNotes(noteId, opts);
    const raw: { id: string; cos: number }[] = [];
    for (const id of this.memory.corpus.noteIds()) {
      if (id === noteId) continue;
      const v = this.vector(id);
      if (v && v.length === q.length) raw.push({ id, cos: dot(q, v) });
    }
    if (!raw.length) return this.fallback.relatedNotes(noteId, opts);
    const mean = raw.reduce((s, r) => s + r.cos, 0) / raw.length;
    const max = Math.max(...raw.map((r) => r.cos));
    const span = max - mean || 1;
    return raw
      .map((r) => ({ id: r.id, score: Math.max(0, Math.min(1, raw.length < 3 ? r.cos : (r.cos - mean) / span)) }))
      .filter((r) => r.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, opts.limit ?? 8);
  }
}

let memoryProvider: { memory: AppMemory; provider: MemoryRelatedNotes } | null = null;

export function relatedNotesProvider(): RelatedNotesProvider | null {
  if (custom) return custom;
  const v = useApp.getState().vault;
  if (!v) return null;
  const keywords = new KeywordRelatedNotes(v.knowledge);
  const mem = appMemory();
  if (!mem || mem.status().embedder == null) return keywords;
  if (memoryProvider?.memory !== mem) memoryProvider = { memory: mem, provider: new MemoryRelatedNotes(mem, keywords) };
  return memoryProvider.provider;
}

/** Related notes for many notes at once (the graph), falling back to keywords on errors. */
export async function relatedForAll(ids: readonly string[], limit = 4): Promise<Map<string, { id: string; score: number }[]>> {
  const p = relatedNotesProvider();
  const out = new Map<string, { id: string; score: number }[]>();
  if (!p) return out;
  const v = useApp.getState().vault;
  const fallback = v ? new KeywordRelatedNotes(v.knowledge) : null;
  for (const id of ids) {
    try {
      out.set(id, await p.relatedNotes(id, { limit }));
    } catch {
      if (fallback) out.set(id, await fallback.relatedNotes(id, { limit }));
    }
  }
  return out;
}
