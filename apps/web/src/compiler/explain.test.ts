import { describe, expect, it } from 'vitest';
import { attributeAnswer, type Passage } from '@inkwright/core';
import { collectPassages } from './explain.ts';

describe('what the model read becomes the passages an answer is explained with', () => {
  it('collects search_memory hits (with regions and recording moments), opened notes and keyword hits', () => {
    const into: Passage[] = [];
    collectPassages('search_memory', { results: [
      { note_id: 'N1', title: 'Lecture', page: 2, text: 'Fourier transforms decompose signals.', link: '#mem/N1/2/10,20,300,40@clip1:12000' },
    ] }, into);
    collectPassages('read_note', { meta: { id: 'N2', title: 'Plan' }, pages: [{ index: 0, text: 'The demo is on Nov 20.' }, { index: 1, text: '' }] }, into);
    collectPassages('search_notes', { results: [{ note_id: 'N3', title: 'Old', page: 1, snippet: 'Budget is $5k.' }] }, into);
    collectPassages('create_note', { id: 'x' }, into);
    expect(into).toEqual([
      { noteId: 'N1', title: 'Lecture', pageIndex: 1, text: 'Fourier transforms decompose signals.', rect: { minX: 10, minY: 20, maxX: 310, maxY: 60 }, clip: 'clip1', ms: 12000 },
      { noteId: 'N2', title: 'Plan', pageIndex: 0, text: 'The demo is on Nov 20.' },
      { noteId: 'N3', title: 'Old', pageIndex: 0, text: 'Budget is $5k.' },
    ]);
    expect(attributeAnswer('The demo is on Nov 20. Bananas are yellow.', into).map((s) => s.tag)).toEqual(['E', null]);
  });
});
