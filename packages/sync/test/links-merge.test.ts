import { describe, expect, it } from 'vitest';
import type { PageInk } from '@inkwright/core';
import { mergePage } from '../src/index.ts';

describe('ink links merge', () => {
  it('unions links made on two devices and honours removals', () => {
    const link = (id: string, t = 1) => ({ id, strokeIds: ['s'], target: id, createdAt: t });
    const base: PageInk = { id: 'p', strokes: [], links: [link('keep'), link('drop')], formatVersion: 2 };
    const local: PageInk = { ...base, links: [link('keep'), link('mine', 2)] };
    const remote: PageInk = { ...base, links: [link('keep'), link('drop'), link('theirs', 3)] };
    expect(mergePage(base, local, remote).links!.map((l) => l.id)).toEqual(['keep', 'mine', 'theirs']);
  });
});
