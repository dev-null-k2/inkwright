import { describe, expect, it } from 'vitest';
import { newNote, type NoteMeta } from '@inkwright/core';
import { mergeNote } from '../src/merge.ts';

const note = (extra: Partial<NoteMeta> = {}): NoteMeta => ({ ...newNote({ id: 'N1', title: 'Form', pageId: 'P01', now: 100 }), ...extra });

describe('mergeNote: PDF form values', () => {
  it('keeps fields filled on different devices', () => {
    const base = note({ forms: { 'a.pdf': { name: 'Ada' } } });
    const local = note({ updatedAt: 200, forms: { 'a.pdf': { name: 'Ada', agree: true } } });
    const remote = note({ updatedAt: 300, forms: { 'a.pdf': { name: 'Ada', state: 'NJ' } } });
    expect(mergeNote(base, local, remote).forms).toEqual({ 'a.pdf': { name: 'Ada', agree: true, state: 'NJ' } });
  });

  it('the newer note wins a field both sides changed; a one-sided clear is honoured', () => {
    const base = note({ forms: { 'a.pdf': { name: 'Ada', city: 'Austin' } } });
    const local = note({ updatedAt: 200, forms: { 'a.pdf': { name: 'Ada L' } } });
    const remote = note({ updatedAt: 300, forms: { 'a.pdf': { name: 'Ada Lovelace', city: 'Austin' } } });
    expect(mergeNote(base, local, remote).forms).toEqual({ 'a.pdf': { name: 'Ada Lovelace' } });
  });

  it('notes without forms stay without', () => {
    expect(mergeNote(note(), note({ updatedAt: 200 }), note({ updatedAt: 300 })).forms).toBeUndefined();
  });
});
