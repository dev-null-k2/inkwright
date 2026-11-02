import { describe, expect, it } from 'vitest';
import { decodeNote, decodePage, encodeNote, encodeNotebook, encodePage, newNote, newPage, point, type InkStroke, type NoteMeta, type NotebookMeta, type PageInk, type TextBox } from '@inkwright/core';
import { isDerivedPath, mergeById, mergeFileBytes, mergeKindOf, mergeNote, mergeNotebook, mergeOrder, mergePage, mergeSet, stableStringify } from '../src/merge.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

function stroke(id: string, createdAt: number, color = '#FF000000'): InkStroke {
  return { id, pen: 'fountain', color, size: 2, createdAt, points: [point(createdAt, 1, 0, 0.5), point(createdAt + 5, 2, 8, 0.6)] };
}

function text(id: string, t: string, createdAt = 1): TextBox {
  return { id, x: 0, y: 0, width: 100, text: t, fontSize: 16, color: '#FF000000', font: 'sans', createdAt };
}

function page(strokes: InkStroke[], extra: Partial<PageInk> = {}): PageInk {
  return { ...newPage('P1'), strokes, ...extra };
}

function note(extra: Partial<NoteMeta> = {}): NoteMeta {
  return { ...newNote({ id: 'N1', title: 'Title', pageId: 'P01', now: 100 }), ...extra };
}

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe('stableStringify', () => {
  it('ignores key order and undefined members', () => {
    expect(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe(stableStringify({ a: [1, { d: 2 }], b: 1 }));
    expect(stableStringify({ a: 1 })).not.toBe(stableStringify({ a: 2 }));
  });
});

describe('mergeOrder', () => {
  const all = (...xs: string[][]) => new Set(xs.flat());

  it('keeps identical orders', () => {
    expect(mergeOrder(['a', 'b'], ['a', 'b'], ['a', 'b'], all(['a', 'b']))).toEqual(['a', 'b']);
  });

  it('places inserts after the element they followed on their side', () => {
    expect(mergeOrder(['a', 'b', 'c'], ['a', 'x', 'b', 'c'], ['a', 'b', 'c', 'y'], all(['a', 'b', 'c', 'x', 'y']))).toEqual(['a', 'x', 'b', 'c', 'y']);
    expect(mergeOrder(['a'], ['z', 'a'], ['a'], all(['a', 'z']))).toEqual(['z', 'a']);
  });

  it('interleaves concurrent inserts at the same spot with the comparator, symmetrically', () => {
    const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
    const keep = all(['a', 'b1', 'b3', 'b2', 'b4']);
    const r1 = mergeOrder(['a'], ['a', 'b1', 'b3'], ['a', 'b2', 'b4'], keep, { compare: cmp });
    const r2 = mergeOrder(['a'], ['a', 'b2', 'b4'], ['a', 'b1', 'b3'], keep, { compare: cmp });
    expect(r1).toEqual(['a', 'b1', 'b2', 'b3', 'b4']);
    expect(r2).toEqual(r1);
  });

  it('without a comparator puts the preferred side first', () => {
    expect(mergeOrder(['a'], ['a', 'x'], ['a', 'y'], all(['a', 'x', 'y']))).toEqual(['a', 'x', 'y']);
    expect(mergeOrder(['a'], ['a', 'x'], ['a', 'y'], all(['a', 'x', 'y']), { prefer: 'b' })).toEqual(['a', 'y', 'x']);
  });

  it('drops ids outside keep', () => {
    expect(mergeOrder(['a', 'b', 'c'], ['a', 'c'], ['a', 'b', 'c'], new Set(['a', 'c']))).toEqual(['a', 'c']);
  });

  it('takes the reordering side for shared ids', () => {
    const keep = all(['a', 'b', 'c', 'n']);
    expect(mergeOrder(['a', 'b', 'c'], ['a', 'b', 'c', 'n'], ['c', 'a', 'b'], keep)).toEqual(['c', 'a', 'b', 'n']);
    expect(mergeOrder(['a', 'b', 'c'], ['c', 'b', 'a'], ['a', 'b', 'c'], all(['a', 'b', 'c']))).toEqual(['c', 'b', 'a']);
    // Both reordered: preferred side wins.
    expect(mergeOrder(['a', 'b', 'c'], ['b', 'a', 'c'], ['c', 'b', 'a'], all(['a', 'b', 'c']), { prefer: 'b' })).toEqual(['c', 'b', 'a']);
  });

  it('keeps prepended and appended items at the ends when the other side reordered', () => {
    const keep = all(['a', 'b', 'c', 'first', 'last']);
    expect(mergeOrder(['a', 'b', 'c'], ['first', 'a', 'b', 'c', 'last'], ['c', 'a', 'b'], keep)).toEqual(['first', 'c', 'a', 'b', 'last']);
  });

  it('two-way (no base) keeps everything from both sides', () => {
    expect(mergeOrder(null, ['a', 'b'], ['a', 'c'], all(['a', 'b', 'c']))).toEqual(['a', 'b', 'c']);
  });
});

describe('mergeSet / mergeById', () => {
  it('unions sets minus deletions', () => {
    expect(mergeSet(['a', 'b'], ['a', 'b', 'c'], ['b', 'd'])).toEqual(['b', 'c', 'd']);
    expect(mergeSet(null, ['a'], ['b', 'a'])).toEqual(['a', 'b']);
  });

  it('keeps an item edited on one side and deleted on the other', () => {
    const base = [{ id: 'a', v: 1 }];
    expect(mergeById(base, [], [{ id: 'a', v: 2 }])).toEqual([{ id: 'a', v: 2 }]);
    expect(mergeById(base, [], [{ id: 'a', v: 1 }])).toEqual([]);
  });
});

describe('mergePage', () => {
  const s1 = stroke('S1', 10);
  const s2 = stroke('S2', 20);

  it('unions concurrent strokes from two devices in time order (no lost strokes)', () => {
    const base = page([s1, s2]);
    const local = page([s1, s2, stroke('A1', 40), stroke('A2', 60)]);
    const remote = page([s1, s2, stroke('B1', 30), stroke('B2', 50)]);
    const m = mergePage(base, local, remote);
    expect(ids(m.strokes)).toEqual(['S1', 'S2', 'B1', 'A1', 'B2', 'A2']);
    expect(ids(mergePage(base, remote, local).strokes)).toEqual(ids(m.strokes));
  });

  it('deletes a stroke erased on one side and untouched on the other', () => {
    const m = mergePage(page([s1, s2]), page([s2]), page([s1, s2, stroke('B1', 30)]));
    expect(ids(m.strokes)).toEqual(['S2', 'B1']);
  });

  it('delete vs edit: the edit survives', () => {
    const recolored = { ...s1, color: '#FFFF0000' };
    const m = mergePage(page([s1, s2]), page([s2]), page([recolored, s2]));
    expect(m.strokes).toEqual([recolored, s2]);
  });

  it('takes one-sided edits and resolves double edits by preference', () => {
    const red = { ...s2, color: '#FFFF0000' };
    const blue = { ...s2, color: '#FF0000FF' };
    expect(mergePage(page([s1, s2]), page([s1, s2]), page([s1, red])).strokes[1]).toEqual(red);
    expect(mergePage(page([s1, s2]), page([s1, blue]), page([s1, red])).strokes[1]).toEqual(blue);
    expect(mergePage(page([s1, s2]), page([s1, blue]), page([s1, red]), { prefer: 'remote' }).strokes[1]).toEqual(red);
  });

  it('merges texts and images by id', () => {
    const base = page([], { texts: [text('T1', 'hello')] });
    const local = page([], { texts: [text('T1', 'hello world')] });
    const remote = page([], {
      texts: [text('T1', 'hello'), text('T2', 'new', 5)],
      images: [{ id: 'I1', x: 0, y: 0, width: 10, height: 10, asset: 'a.png', rotation: 0, createdAt: 3 }],
    });
    const m = mergePage(base, local, remote);
    expect(m.texts!.map((t) => t.text)).toEqual(['hello world', 'new']);
    expect(ids(m.images!)).toEqual(['I1']);
    expect('images' in mergePage(page([]), page([]), page([]))).toBe(false);
  });

  it('recognizedText follows the newer recognizedAt', () => {
    const base = page([s1]);
    const local = page([s1], { recognizedText: 'helo', recognizedAt: 100, recognizedBy: 'mlkit' });
    const remote = page([s1], { recognizedText: 'hello', recognizedAt: 200, recognizedBy: 'gemini-2.5-flash' });
    expect(mergePage(base, local, remote)).toMatchObject({ recognizedText: 'hello', recognizedAt: 200, recognizedBy: 'gemini-2.5-flash' });
    expect(mergePage(base, remote, local)).toMatchObject({ recognizedText: 'hello', recognizedAt: 200 });
    expect(mergePage(base, page([s1]), local)).toMatchObject({ recognizedText: 'helo' });
  });

  it('merges page-level fields independently and keeps unknown fields', () => {
    const base = page([]);
    const local = page([], { paper: { style: 'dot_grid', tint: 'white', texture: 'smooth', spacing: 0 } });
    const remote = { ...page([], { background: { kind: 'pdf' as const, asset: 'doc.pdf', pageNumber: 2 } }), futureField: { x: 1 } } as PageInk;
    const m = mergePage(base, local, remote) as PageInk & { futureField?: unknown };
    expect(m.paper?.style).toBe('dot_grid');
    expect(m.background).toEqual({ kind: 'pdf', asset: 'doc.pdf', pageNumber: 2 });
    expect(m.futureField).toEqual({ x: 1 });
  });

  it('two-way merge (no base) unions everything', () => {
    const m = mergePage(null, page([s1]), page([s2, stroke('B', 5)]));
    expect(ids(m.strokes).sort()).toEqual(['B', 'S1', 'S2']);
  });
});

describe('mergeNote', () => {
  it('adds pages from both sides, keeping each side’s placement', () => {
    const base = note({ pageIds: ['P01', 'P02'] });
    const local = note({ pageIds: ['P01', 'P05', 'P02'], updatedAt: 200 }); // inserted after P01
    const remote = note({ pageIds: ['P01', 'P02', 'P04'], updatedAt: 150 }); // appended
    expect(mergeNote(base, local, remote).pageIds).toEqual(['P01', 'P05', 'P02', 'P04']);
  });

  it('interleaves pages appended on both sides by (time-sortable) id', () => {
    const base = note({ pageIds: ['P01'] });
    const m = mergeNote(base, note({ pageIds: ['P01', 'P03'] }), note({ pageIds: ['P01', 'P02', 'P04'] }));
    expect(m.pageIds).toEqual(['P01', 'P02', 'P03', 'P04']);
  });

  it('honours page deletions and reorders', () => {
    const base = note({ pageIds: ['P01', 'P02', 'P03'] });
    const local = note({ pageIds: ['P01', 'P03'] }); // deleted P02
    const remote = note({ pageIds: ['P03', 'P01', 'P02', 'P09'] }); // reordered, added P09
    expect(mergeNote(base, local, remote).pageIds).toEqual(['P03', 'P01', 'P09']);
  });

  it('title changed on both sides: newer updatedAt wins; one-sided changes always win', () => {
    const base = note({ title: 'Base', pinned: false, updatedAt: 100 });
    const local = note({ title: 'Local title', pinned: true, updatedAt: 300 });
    const remote = note({ title: 'Remote title', updatedAt: 200, color: '#FF112233' });
    const m = mergeNote(base, local, remote);
    expect(m.title).toBe('Local title');
    expect(m.pinned).toBe(true);
    expect(m.color).toBe('#FF112233');
    expect(m.updatedAt).toBe(300);
    expect(mergeNote(base, { ...local, updatedAt: 150 }, remote).title).toBe('Remote title');
    // Remote's change is older than local's unrelated change, but local didn't touch the title.
    expect(mergeNote(base, { ...base, pinned: true, updatedAt: 999 }, remote).title).toBe('Remote title');
  });

  it('merges tags as a set with deletions', () => {
    const base = note({ tags: ['work', 'old'] });
    const m = mergeNote(base, note({ tags: ['work', 'urgent'] }), note({ tags: ['work', 'old', 'meeting'] }));
    expect(m.tags).toEqual(['work', 'urgent', 'meeting']);
  });

  it('honours trashedAt from either side, even against newer edits', () => {
    const base = note({ updatedAt: 100 });
    const trashed = { ...base, trashedAt: 500 }; // trashNote does not bump updatedAt
    const renamed = note({ title: 'Renamed', updatedAt: 400 });
    const m = mergeNote(base, renamed, trashed);
    expect(m.trashedAt).toBe(500);
    expect(m.title).toBe('Renamed');
    // Restore on one side, untouched on the other → restored.
    const r = mergeNote(trashed, { ...base, updatedAt: 600 }, trashed);
    expect(r.trashedAt).toBeUndefined();
    // No base: trashing wins.
    expect(mergeNote(null, renamed, trashed).trashedAt).toBe(500);
    expect('trashedAt' in mergeNote(null, renamed, renamed)).toBe(false);
  });

  it('unions recordings and keeps timestamps sane', () => {
    const clip = (id: string, startedAt: number) => ({ id, asset: `${id}.webm`, startedAt, durationMs: 1000, mimeType: 'audio/webm' });
    const base = note({ recordings: [clip('R1', 1)], createdAt: 50 });
    const m = mergeNote(base, note({ recordings: [clip('R1', 1), clip('R3', 3)], createdAt: 50 }), note({ recordings: [clip('R1', 1), clip('R2', 2)], createdAt: 60 }));
    expect(ids(m.recordings!)).toEqual(['R1', 'R2', 'R3']);
    expect(m.createdAt).toBe(50);
  });
});

describe('mergeNotebook', () => {
  const nb = (extra: Partial<NotebookMeta> & { updatedAt?: number } = {}): NotebookMeta => ({ id: 'B1', name: 'Work', color: '#FF000000', createdAt: 10, formatVersion: 2, ...extra });

  it('newer wins wholesale without a base', () => {
    expect(mergeNotebook(null, nb({ name: 'L', updatedAt: 5 } as never), nb({ name: 'R', updatedAt: 9 } as never)).name).toBe('R');
    expect(mergeNotebook(null, nb({ name: 'L' }), nb({ name: 'R' })).name).toBe('L');
  });

  it('merges independent field changes against the base; newer wins on clashes', () => {
    const m = mergeNotebook(nb(), nb({ name: 'Renamed' }), nb({ color: '#FFFF0000', parentId: 'B0' }));
    expect(m).toMatchObject({ name: 'Renamed', color: '#FFFF0000', parentId: 'B0' });
    const clash = mergeNotebook(nb(), nb({ name: 'L', updatedAt: 1 } as never), nb({ name: 'R', updatedAt: 2 } as never));
    expect(clash.name).toBe('R');
  });
});

describe('mergeFileBytes', () => {
  it('classifies vault paths', () => {
    expect(mergeKindOf('notes/n/pages/p.ink.json')).toBe('page');
    expect(mergeKindOf('notes/n/note.json')).toBe('note');
    expect(mergeKindOf('notebooks/b/notebook.json')).toBe('notebook');
    expect(mergeKindOf('notes/n/note.md')).toBeNull();
    expect(mergeKindOf('inkwright.json')).toBeNull();
    expect(isDerivedPath('notes/n/pages/p.svg')).toBe(true);
    expect(isDerivedPath('notes/n/note.md')).toBe(true);
    expect(isDerivedPath('notes/n/note.json')).toBe(false);
  });

  it('merges encoded pages and notes', () => {
    const b = page([stroke('S1', 1)]);
    const l = page([stroke('S1', 1), stroke('L', 2)]);
    const r = page([stroke('R', 3)]);
    const out = mergeFileBytes('notes/n/pages/P1.ink.json', enc.encode(encodePage(b)), enc.encode(encodePage(l)), enc.encode(encodePage(r)))!;
    expect(ids(decodePage(dec.decode(out)).strokes)).toEqual(['L', 'R']);
    const nOut = mergeFileBytes('notes/N1/note.json', null, enc.encode(encodeNote(note({ tags: ['a'] }))), enc.encode(encodeNote(note({ tags: ['b'] }))))!;
    expect(decodeNote(dec.decode(nOut)).tags).toEqual(['a', 'b']);
    const nb = { id: 'B', name: 'x', color: '#FF000000', createdAt: 1, formatVersion: 2 };
    expect(mergeFileBytes('notebooks/B/notebook.json', null, enc.encode(encodeNotebook(nb)), enc.encode(encodeNotebook({ ...nb, createdAt: 2, name: 'y' })))).not.toBeNull();
  });

  it('returns null for unmergeable or corrupt inputs; a corrupt base degrades to two-way', () => {
    expect(mergeFileBytes('notes/n/assets/a.png', null, enc.encode('a'), enc.encode('b'))).toBeNull();
    expect(mergeFileBytes('notes/n/note.json', null, enc.encode('{oops'), enc.encode(encodeNote(note())))).toBeNull();
    const out = mergeFileBytes('notes/n/pages/P1.ink.json', enc.encode('garbage'), enc.encode(encodePage(page([stroke('A', 1)]))), enc.encode(encodePage(page([stroke('B', 2)]))))!;
    expect(ids(decodePage(dec.decode(out)).strokes)).toEqual(['A', 'B']);
  });
});
