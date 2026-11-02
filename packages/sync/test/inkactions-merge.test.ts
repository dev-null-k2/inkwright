import { describe, expect, it } from 'vitest';
import type { PageInk, StickyObject, TableObject } from '@inkwright/core';
import { mergePage } from '../src/index.ts';

/** The fields ink actions add (docs/VAULT_FORMAT.md) merge like the rest of a page. */
describe('ink actions merge', () => {
  const base: PageInk = { id: 'p', strokes: [], formatVersion: 2 };

  it('keeps a photo underlay added on one device while the other writes', () => {
    const underlay = { asset: 'photo.png', width: 800, height: 1100, kind: 'photo' as const };
    const local: PageInk = { ...base, underlay };
    const remote: PageInk = { ...base, strokes: [{ id: 's', pen: 'ballpoint', color: '#FF000000', size: 2, points: [], createdAt: 5 }] };
    const m = mergePage(base, local, remote);
    expect(m.underlay).toEqual(underlay);
    expect(m.strokes.map((s) => s.id)).toEqual(['s']);
  });

  it('unions data tables and canvas result stickies by id, keeping their data and origin', () => {
    const table: TableObject = { id: 't', type: 'table', x: 0, y: 0, createdAt: 1, cols: [80], rows: [24, 24], cells: [[{ text: 'a' }], [{ text: '1' }]], color: '#FF000000', lineWidth: 1, header: true, origin: 'import', data: { asset: 'sales.csv', table: 'sales', rowCount: 120, columns: [{ name: 'a', type: 'integer' }] } };
    const sticky: StickyObject = { id: 'r', type: 'sticky', x: 10, y: 10, createdAt: 2, width: 180, height: 120, color: '#FFFCE58A', text: '42', origin: 'ai' };
    const m = mergePage(base, { ...base, objects: [table] }, { ...base, objects: [sticky] });
    expect(m.objects).toEqual([table, sticky]);
  });
});
