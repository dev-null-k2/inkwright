import { describe, expect, it } from 'vitest';
import { NoteDocument, copyPagesForNewNote, decodeNote, encodeNote, newNote, newPage, normalizeQuarter, rotatePageQuarter, type PageInk } from '../src/index.ts';
import { stroke } from './helpers.ts';

const size = { name: 'Letter', width: 800, height: 1000 };

function pdfPage(): PageInk {
  return {
    ...newPage('p1'),
    strokes: [stroke('s', [[10, 20], [30, 40]])],
    texts: [{ id: 't', x: 100, y: 100, width: 200, text: 'Hi', fontSize: 20, color: '#FF000000', font: 'sans', createdAt: 0 }],
    images: [{ id: 'i', x: 0, y: 0, width: 100, height: 50, asset: 'sig.png', rotation: 0, createdAt: 0 }],
    background: { kind: 'pdf', asset: 'doc.pdf', pageNumber: 2 },
    size,
  };
}

describe('rotatePageQuarter', () => {
  it('turns the page, its ink and its background clockwise', () => {
    const { page, size: s } = rotatePageQuarter(pdfPage(), size);
    expect(s).toEqual({ name: 'Letter', width: 1000, height: 800 });
    expect(page.size).toEqual(s);
    // (x, y) → (H − y, x)
    expect(page.strokes[0]!.points.map((p) => [p.x, p.y])).toEqual([[980, 10], [960, 30]]);
    expect(page.background).toEqual({ kind: 'pdf', asset: 'doc.pdf', pageNumber: 2, rotation: 90 });
    expect(page.images![0]!.rotation).toBeCloseTo(Math.PI / 2);
    // Image centre (50, 25) → (975, 50)
    expect(page.images![0]!.x + 50).toBeCloseTo(975);
    expect(page.images![0]!.y + 25).toBeCloseTo(50);
    expect(page.texts![0]!.width).toBe(200);
  });

  it('four turns come back to the start; counter-clockwise undoes clockwise', () => {
    let p = pdfPage();
    let s = size;
    for (let i = 0; i < 4; i++) ({ page: p, size: s } = rotatePageQuarter(p, s));
    expect(s).toEqual(size);
    expect(p.background!.rotation).toBe(0);
    expect(p.strokes[0]!.points[0]!.x).toBeCloseTo(10);
    const once = rotatePageQuarter(pdfPage(), size);
    const back = rotatePageQuarter(once.page, once.size, false);
    expect(back.page.strokes[0]!.points[1]!.x).toBeCloseTo(30);
    expect(back.page.strokes[0]!.points[1]!.y).toBeCloseTo(40);
    expect(back.page.texts![0]!.x).toBeCloseTo(100);
    expect(back.page.background!.rotation).toBe(0);
  });

  it('normalizes angles', () => {
    expect(normalizeQuarter(-90)).toBe(270);
    expect(normalizeQuarter(450)).toBe(90);
  });

  it('NoteDocument.replacePage keeps the id and drops that page’s undo history', () => {
    const meta = newNote({ id: 'n', title: 'T', pageId: 'p1', now: 0 });
    const d = new NoteDocument(meta, [newPage('p1')], () => 5, () => 'x');
    d.addStroke(0, stroke('a', [[1, 1], [2, 2]]));
    expect(d.canUndo).toBe(true);
    const r = rotatePageQuarter(d.page(0), size);
    d.replacePage(0, { ...r.page, id: 'other' });
    expect(d.page(0).id).toBe('p1');
    expect(d.page(0).size).toEqual(r.size);
    expect(d.canUndo).toBe(false);
    expect(d.dirtyPageIds.has('p1')).toBe(true);
  });
});

describe('copyPagesForNewNote', () => {
  it('gives fresh ids, keeps page size and brings the PDF’s form values', () => {
    let n = 0;
    const meta = { ...newNote({ id: 'n', title: 'T', pageId: 'p1', now: 0 }), forms: { 'doc.pdf': { name: 'Ada' }, 'other.pdf': { x: 'y' } } };
    const res = copyPagesForNewNote(meta, [pdfPage()], () => `new${n++}`);
    expect(res.pages[0]!.id).toBe('new0');
    expect(res.pages[0]!.strokes[0]!.id).not.toBe('s');
    expect(res.pages[0]!.size).toEqual(size);
    expect(res.assets.sort()).toEqual(['doc.pdf', 'sig.png']);
    expect(res.forms).toEqual({ 'doc.pdf': { name: 'Ada' } });
  });
});

describe('form values in note.json', () => {
  it('round-trip through the codec', () => {
    const meta = { ...newNote({ id: 'n', title: 'T', pageId: 'p1', now: 0 }), forms: { 'doc.pdf': { name: 'Ada', agree: true, langs: ['en', 'fr'], color: 'red' } } };
    expect(decodeNote(encodeNote(meta)).forms).toEqual(meta.forms);
  });
});
