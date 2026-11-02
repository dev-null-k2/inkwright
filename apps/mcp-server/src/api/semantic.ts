/**
 * Search for the REST API: keyword (the same index MCP's search_notes uses), and semantic or
 * hybrid when the server is started with an embedding provider (`--embeddings-model`, any
 * OpenAI-compatible `/embeddings` endpoint: OpenAI, Mistral, Ollama's nomic-embed-text, …).
 *
 * Passages come from core's `chunkNote` (typed text, recognized handwriting, transcripts), the
 * same chunks the app's on-device semantic memory uses, and `hybridSearch` fuses BM25, the
 * note-level index and vector similarity. Vectors are cached in memory by passage hash, so only
 * new or changed passages are embedded again.
 */
import { MemoryCorpus, chunkEmbeddingText, chunkNote, hybridSearch, type MemoryChunk, type RankedChunk } from '@inkwright/core';
import { remoteEmbed, type RemoteEmbeddingConfig } from '@inkwright/ai';
import type { ServerContext } from '../context.ts';

export interface EmbeddingSettings {
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
}

export class SemanticSearch {
  private corpus = new MemoryCorpus();
  private sigs = new Map<string, number>();
  private vectors = new Map<string, Float32Array>();
  private building: Promise<void> | null = null;

  constructor(private ctx: ServerContext, private embed: (inputs: string[]) => Promise<Float32Array[]>) {}

  static fromSettings(ctx: ServerContext, s: EmbeddingSettings, env: NodeJS.ProcessEnv = process.env, fetchFn?: typeof fetch): SemanticSearch {
    const cfg: RemoteEmbeddingConfig = { baseUrl: s.baseUrl, model: s.model, provider: 'embeddings', ...(s.apiKeyEnv && env[s.apiKeyEnv] ? { apiKey: env[s.apiKeyEnv] } : {}), ...(fetchFn ? { fetch: fetchFn } : {}) };
    return new SemanticSearch(ctx, (inputs) => remoteEmbed(cfg, inputs));
  }

  /** Brings the passage corpus (and vectors) up to date with the vault. */
  private refresh(): Promise<void> {
    this.building ??= (async () => {
      await this.ctx.refresh();
      const notes = await this.ctx.vault.listNotes();
      const live = new Set(notes.map((n) => n.id));
      for (const id of [...this.sigs.keys()]) {
        if (!live.has(id)) {
          this.corpus.removeNote(id);
          this.sigs.delete(id);
        }
      }
      const fresh: MemoryChunk[] = [];
      for (const n of notes) {
        if (n.lock || this.sigs.get(n.id) === n.updatedAt) continue;
        const chunks = chunkNote(n, await this.ctx.vault.readPages(n));
        this.corpus.setNote(n.id, chunks);
        this.sigs.set(n.id, n.updatedAt);
        fresh.push(...chunks);
      }
      const todo = fresh.filter((c) => !this.vectors.has(c.hash));
      for (let i = 0; i < todo.length; i += 64) {
        const batch = todo.slice(i, i + 64);
        const vecs = await this.embed(batch.map(chunkEmbeddingText));
        batch.forEach((c, j) => { if (vecs[j]) this.vectors.set(c.hash, vecs[j]!); });
      }
    })().finally(() => {
      this.building = null;
    });
    return this.building;
  }

  async search(query: string, mode: 'semantic' | 'hybrid', limit: number, noteId?: string): Promise<RankedChunk[]> {
    await this.refresh();
    const [q] = await this.embed([query]);
    return hybridSearch(this.corpus, query, {
      limit,
      ...(noteId ? { noteId } : {}),
      queryVector: q,
      vectorOf: (c) => this.vectors.get(c.hash),
      // Semantic: rank by meaning alone; hybrid: words and meaning together.
      weights: mode === 'semantic' ? { keyword: 0, note: 0, vector: 1 } : undefined,
    });
  }
}
