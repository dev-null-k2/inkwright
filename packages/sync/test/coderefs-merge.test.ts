import { describe, expect, it } from 'vitest';
import { newNote, type CodeRefBaseline, type NoteMeta } from '@inkstone/core';
import { mergeNote } from '../src/merge.ts';

const note = (extra: Partial<NoteMeta> = {}): NoteMeta => ({ ...newNote({ id: 'N1', title: 'Auth', pageId: 'P01', now: 100 }), ...extra });
const ref = (hash: string, reviewedAt?: number): CodeRefBaseline => ({ hash, signature: `f(${hash})`, linkedAt: 1, ...(reviewedAt ? { reviewedAt } : {}) });

describe('mergeNote: code-link baselines', () => {
  it('keeps reviews of different links made on different devices', () => {
    const base = note({ codeRefs: { 'a.ts#f': ref('1'), 'b.ts#g': ref('2') } });
    const local = note({ updatedAt: 200, codeRefs: { 'a.ts#f': ref('1b', 200), 'b.ts#g': ref('2') } });
    const remote = note({ updatedAt: 300, codeRefs: { 'a.ts#f': ref('1'), 'b.ts#g': ref('2b', 300), 'c.ts#h': ref('3') } });
    expect(mergeNote(base, local, remote).codeRefs).toEqual({ 'a.ts#f': ref('1b', 200), 'b.ts#g': ref('2b', 300), 'c.ts#h': ref('3') });
  });

  it('the newer note wins a link both reviewed; a one-sided removal is honoured', () => {
    const base = note({ codeRefs: { 'a.ts#f': ref('1'), 'b.ts#g': ref('2') } });
    const local = note({ updatedAt: 200, codeRefs: { 'a.ts#f': ref('L', 200) } });
    const remote = note({ updatedAt: 300, codeRefs: { 'a.ts#f': ref('R', 300), 'b.ts#g': ref('2') } });
    expect(mergeNote(base, local, remote).codeRefs).toEqual({ 'a.ts#f': ref('R', 300) });
  });

  it('notes without code links stay without', () => {
    expect(mergeNote(note(), note({ updatedAt: 200 }), note({ updatedAt: 300 })).codeRefs).toBeUndefined();
  });
});
