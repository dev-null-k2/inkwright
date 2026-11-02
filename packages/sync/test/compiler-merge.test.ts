import { describe, expect, it } from 'vitest';
import { decodeDeck, decodeProvenance, emptyProvenance, encodeDeck, encodeProvenance, newCard, reviewCard, setItem, type StudyDeck } from '@inkstone/core';
import { mergeFileBytes, mergeKindOf } from '../src/index.ts';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array | null) => new TextDecoder().decode(b!);

describe('context compiler files in sync', () => {
  it('recognises provenance files and study decks as mergeable', () => {
    expect(mergeKindOf('notes/N1/assets/provenance.json')).toBe('provenance');
    expect(mergeKindOf('ai/study/deck1.json')).toBe('study-deck');
    expect(mergeKindOf('ai/compiler/state.json')).toBeNull();
  });

  it('merges provenance edited on two devices item by item', () => {
    const base = emptyProvenance();
    setItem(base, 'text:a', { by: 'm', prompt: 'p', at: 1 }, [{ s: 'A.', t: 'E', src: [] }], 1);
    const local = structuredClone(base);
    const remote = structuredClone(base);
    setItem(local, 'text:b', { by: 'm', prompt: 'p', at: 2 }, [{ s: 'B.', t: 'I', src: [] }], 2);
    setItem(remote, 'summary', { by: 'n', prompt: 'q', at: 3 }, [{ s: 'S.', t: 'I', src: [] }], 3);
    const out = decodeProvenance(dec(mergeFileBytes('notes/N1/assets/provenance.json', enc(encodeProvenance(base)), enc(encodeProvenance(local)), enc(encodeProvenance(remote)))));
    expect(Object.keys(out.items).sort()).toEqual(['summary', 'text:a', 'text:b']);
  });

  it('keeps reviews of different cards made offline on two devices', () => {
    const T = 1_700_000_000_000;
    const c1 = newCard({ id: 'c1', q: 'Q1', a: 'A1', from: 'note', origin: 'ai' }, T);
    const c2 = newCard({ id: 'c2', q: 'Q2', a: 'A2', from: 'note', origin: 'ai' }, T);
    const base: StudyDeck = { formatVersion: 1, id: 'd', title: 'D', updatedAt: T, cards: [c1, c2], reviews: [] };
    const local: StudyDeck = { ...base, updatedAt: T + 1, cards: [reviewCard(c1, 3, T + 1), c2], reviews: [{ card: 'c1', at: T + 1, rating: 3 }] };
    const remote: StudyDeck = { ...base, updatedAt: T + 2, cards: [c1, reviewCard(c2, 4, T + 2)], reviews: [{ card: 'c2', at: T + 2, rating: 4 }] };
    const out = decodeDeck(dec(mergeFileBytes('ai/study/d.json', enc(encodeDeck(base)), enc(encodeDeck(local)), enc(encodeDeck(remote)))));
    expect(out.cards.map((c) => c.mem.reps)).toEqual([1, 1]);
    expect(out.reviews.map((r) => r.card)).toEqual(['c1', 'c2']);
  });
});
