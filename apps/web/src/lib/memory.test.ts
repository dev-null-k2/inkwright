import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SearchIndex, newNote, newPage, type NoteMeta, type PageInk } from '@inkwright/core';
import type { Embedder } from './localai.ts';

// A deterministic embedder: a bag of letters, so related words land near each other.
const embedCalls: string[][] = [];
const fakeEmbedder: Embedder = {
  key: 'test:letters',
  label: 'Letters (test)',
  embedDocuments: async (items) => { embedCalls.push(items.map((i) => i.text)); return items.map((i) => vec(i.text)); },
  embedQuery: async (q) => vec(q),
};
let embedderOn = true;
vi.mock('./localai.ts', () => ({
  currentEmbedder: async () => (embedderOn ? fakeEmbedder : null),
  onLocalAIChange: () => () => {},
}));
vi.mock('../canvas/assets.ts', () => ({ loadPdfJs: async () => { throw new Error('no pdf.js in unit tests'); } }));

function vec(s: string): Float32Array {
  const v = new Float32Array(26);
  for (const ch of s.toLowerCase()) if (ch >= 'a' && ch <= 'z') v[ch.charCodeAt(0) - 97]! += 1;
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

const { attachMemory, toHit } = await import('./memory.ts');
const { askNotes } = await import('./ask.ts');

function fakeVault() {
  const notes = new Map<string, { note: NoteMeta; pages: PageInk[] }>();
  return {
    search: new SearchIndex(),
    vault: {
      readNote: async (id: string) => notes.get(id)?.note ?? null,
      readPages: async (n: NoteMeta) => notes.get(n.id)?.pages ?? [],
      readAsset: async () => null,
    },
    put(note: NoteMeta, pages: PageInk[]) { notes.set(note.id, { note, pages }); this.search.indexNote(note, pages); },
  };
}

const note = (id: string, title: string): NoteMeta => newNote({ id, title, pageId: `${id}p`, now: Date.now() });
const typed = (id: string, text: string): PageInk => ({ ...newPage(id), texts: [{ id: `${id}t`, x: 50, y: 100, width: 500, text, fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }] });
const until = async (fn: () => boolean) => { for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 5)); expect(fn()).toBe(true); };

describe('AppMemory', () => {
  beforeEach(() => { embedCalls.length = 0; embedderOn = true; });

  it('follows the keyword index, embeds in the background and only re-embeds changed passages', async () => {
    const v = fakeVault();
    const mem = attachMemory(v as any);
    v.put(note('a', 'Signals'), [typed('a1', 'Fourier transforms map signals to frequencies.\n\nHomework is due Friday.')]);
    v.put(note('b', 'Groceries'), [typed('b1', 'milk eggs bread')]);
    expect(mem.corpus.size).toBeGreaterThan(2);
    await until(() => mem.status().embedded === mem.corpus.size && !mem.status().indexing);
    expect(mem.status().embedder).toBe('Letters (test)');
    const before = embedCalls.flat().length;
    // Edit one paragraph: only the changed passage is embedded again.
    v.put(note('a', 'Signals'), [typed('a1', 'Fourier transforms map signals to frequencies.\n\nHomework is due Monday.')]);
    await until(() => mem.status().embedded === mem.corpus.size && !mem.status().indexing);
    const after = embedCalls.flat().slice(before);
    expect(after.length).toBe(1);
    expect(after[0]).toContain('Monday');

    const { results, semantic } = await mem.search('fourier frequencies');
    expect(semantic).toBe(true);
    expect(results[0]!.chunk.noteId).toBe('a');
    const hit = toHit(results[0]!);
    expect(hit.rect).toMatchObject({ x: 50, width: 500 });
    expect(hit.rect!.y).toBeGreaterThanOrEqual(100);

    // Trash/remove reaches the memory through the keyword index.
    v.search.remove('b');
    expect(mem.corpus.chunksOf('b')).toHaveLength(0);
    v.search.clear();
    expect(mem.corpus.size).toBe(0);
  });

  it('ask: passes numbered passages to the model and returns anchored sources', async () => {
    const v = fakeVault();
    const mem = attachMemory(v as any);
    v.put(note('lec', 'Lecture 3'), [typed('l1', 'The professor said the Fourier transform is linear.')]);
    const seen: any[] = [];
    const provider = {
      id: 'fake', label: 'Fake', capabilities: { vision: false, tools: false, streaming: true, listModels: false, json: false },
      async chat(req: any, onEvent?: (e: any) => void) {
        seen.push(req);
        for (const d of ['It is ', 'linear [1].']) onEvent?.({ type: 'text', delta: d });
        return { text: 'It is linear [1].', toolCalls: [], stopReason: 'stop' as const };
      },
    };
    const deltas: string[] = [];
    const r = await askNotes('What did the professor say about Fourier?', { search: (q, o) => mem.search(q, o), ai: { provider, model: 'm', label: 'Fake model' } }, { onDelta: (t) => deltas.push(t) });
    expect(r.answer).toBe('It is linear [1].');
    expect(r.label).toBe('Fake model');
    expect(deltas.at(-1)).toBe('It is linear [1].');
    expect(r.sources[0]).toMatchObject({ n: 1, noteId: 'lec', title: 'Lecture 3', pageIndex: 0, source: 'text' });
    expect(r.sources[0]!.rect).toBeDefined();
    expect(seen[0].messages[1].content).toContain('[1] "Lecture 3", page 1 (typed text');
    expect(seen[0].messages[1].content).toContain('Fourier transform is linear');
  });
});
