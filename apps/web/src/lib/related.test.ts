import { describe, expect, it } from 'vitest';
import { MemoryRelatedNotes } from './related.ts';

/** A stand-in for the semantic memory: fixed note vectors. */
function fakeMemory(vectors: Record<string, number[] | null>) {
  return {
    status: () => ({ version: 1, passages: 0, embedded: Object.keys(vectors).length, embedder: 'test', indexing: false, error: null }),
    noteVector: (id: string) => (vectors[id] ? Float32Array.from(vectors[id]!) : null),
    corpus: { noteIds: () => Object.keys(vectors)[Symbol.iterator]() },
  };
}

const norm = (v: number[]) => { const n = Math.hypot(...v); return v.map((x) => x / n); };

describe('related notes from the semantic memory', () => {
  it('ranks by meaning and spreads scores over the vault', async () => {
    const mem = fakeMemory({ a: norm([1, 0, 0]), b: norm([0.9, 0.1, 0]), c: norm([0, 1, 0]), d: norm([0.5, 0.5, 0.1]), e: null });
    const p = new MemoryRelatedNotes(mem as never, { relatedNotes: async () => [{ id: 'kw', score: 1 }] });
    const r = await p.relatedNotes('a');
    expect(r[0]).toEqual({ id: 'b', score: 1 });
    expect(r.map((x) => x.id)).not.toContain('c');
    expect(r.every((x) => x.score > 0 && x.score <= 1)).toBe(true);
  });

  it('falls back to keywords for notes not embedded yet', async () => {
    const mem = fakeMemory({ a: null, b: norm([1, 0]) });
    const p = new MemoryRelatedNotes(mem as never, { relatedNotes: async () => [{ id: 'kw', score: 0.4 }] });
    expect(await p.relatedNotes('a')).toEqual([{ id: 'kw', score: 0.4 }]);
  });
});
