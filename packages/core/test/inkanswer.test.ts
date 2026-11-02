import { describe, expect, it } from 'vitest';
import { NoteDocument, classifyPage, findFreeSpace, inkAnswerHeight, isFree, layoutInkAnswer, newNote, newPage, occupiedRects, plainForHandwriting, readingSegments, speakableText, unreadHandwriting, writeOnFrame, type InkStroke, type PageInk } from '../src/index.ts';
import { makeStroke } from './fixtures/sketches.ts';

const page = (strokes: InkStroke[] = []): PageInk => ({ ...newPage('p'), strokes });

describe('AI answers in ink', () => {
  it('turns Markdown into writable plain text', () => {
    expect(plainForHandwriting('## Answer\n**x = 2** because *2x = 4* — see [the note](http://a) and [[Algebra|algebra]].\n- one\n* two')).toBe('Answer\nx = 2 because 2x = 4 - see the note and algebra.\n- one\n- two');
  });

  it('places the answer below the selection, beside it when blocked, else below everything', () => {
    const sel = { minX: 60, minY: 100, maxX: 300, maxY: 140 };
    const P = { page: { width: 794, height: 1123 } };
    const h = () => 60;
    const below = findFreeSpace([sel], sel, h, P)!;
    expect(below.minY).toBeGreaterThan(140);
    expect(below.minX).toBe(60);
    const blocker = { minX: 40, minY: 150, maxX: 290, maxY: 1000 };
    const beside = findFreeSpace([sel, blocker], sel, h, P)!;
    expect(beside.minX).toBeGreaterThan(300);
    expect(isFree(beside, [sel, blocker])).toBe(true);
    expect(findFreeSpace([{ minX: 0, minY: 0, maxX: 794, maxY: 1100 }], sel, h, P)).toBeNull();
    const board = findFreeSpace([], null, h, { page: { width: 0, height: 0 } })!;
    expect(board.maxX - board.minX).toBe(520);
  });

  it('lays out AI ink that wraps and shrinks to fit, and authorship never counts it as handwriting', () => {
    const text = 'The derivative of x squared is two x, because the slope grows linearly.';
    const r = layoutInkAnswer(text, { x: 50, y: 200, width: 260 }, { color: '#FF2F6FB5', seed: 3 });
    expect(r.strokes.length).toBeGreaterThan(30);
    expect(r.strokes.every((s) => s.origin === 'ai' && s.color === '#FF2F6FB5')).toBe(true);
    expect(r.rect.maxX).toBeLessThan(50 + 260 + 14);
    expect(layoutInkAnswer(text, { x: 50, y: 200, width: 260 }, { maxHeight: 40 }).xHeight).toBeLessThan(8.5);
    expect(inkAnswerHeight(text, 600)).toBeLessThan(inkAnswerHeight(text, 200));
    // Through the document, as the app commits it: one undo step, classified as AI ink.
    const doc = new NoteDocument(newNote({ id: 'n', title: 'T', pageId: 'p', now: 0 }), [newPage('p')]);
    doc.commit(0, { label: 'AI answer in ink', strokes: { removed: [], added: r.strokes.map((item, index) => ({ index, item })) } });
    const { counts, handwritten } = classifyPage(doc.page(0));
    expect(counts.aiInk).toBe(r.strokes.length);
    expect(handwritten).toHaveLength(0);
    doc.undo();
    expect(doc.page(0).strokes).toHaveLength(0);
  });

  it('animates by ink length, keeping finished strokes as the same objects', () => {
    const strokes = [makeStroke('a', [[0, 0], [10, 0]]), makeStroke('b', [[0, 5], [30, 5], [60, 5]])];
    expect(writeOnFrame(strokes, 0)).toEqual([]);
    const half = writeOnFrame(strokes, 0.6);
    expect(half[0]).toBe(strokes[0]);
    expect(half[1]!.points.length).toBe(2);
    expect(writeOnFrame(strokes, 1)).toEqual(strokes);
  });

  it('counts strokes, text and objects as occupied', () => {
    const p: PageInk = { ...page([makeStroke('a', [[10, 10], [20, 20]])]), texts: [{ id: 't', x: 100, y: 100, width: 200, text: 'hello', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }] };
    expect(occupiedRects(p)).toHaveLength(2);
  });
});

describe('read aloud', () => {
  const p: PageInk = {
    ...page([makeStroke('w1', [[50, 300], [200, 300]]), makeStroke('w2', [[50, 60], [200, 60]])]),
    texts: [{ id: 't', x: 50, y: 120, width: 400, text: '# Title\n\nFirst **para**.\n\nSecond [[Link|link]] [@smith2020].', fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }],
    recognizedLines: [{ text: 'bottom line', strokeIds: ['w1'], bounds: { minX: 50, minY: 290, maxX: 200, maxY: 310 } }, { text: 'top line', strokeIds: ['w2'], bounds: { minX: 50, minY: 50, maxX: 200, maxY: 70 } }],
  };
  it('reads typed paragraphs and handwriting lines in reading order, with the strokes to highlight', () => {
    expect(readingSegments(p).map((s) => s.text)).toEqual(['top line', 'Title', 'First para.', 'Second link (smith2020).', 'bottom line']);
    expect(readingSegments(p)[0]!.strokeIds).toEqual(['w2']);
  });
  it('reads only the selection, and knows when handwriting is not read yet', () => {
    expect(readingSegments(p, { strokeIds: new Set(['w1']), textIds: new Set() }).map((s) => s.text)).toEqual(['bottom line']);
    expect(speakableText('- [ ] buy *milk*')).toBe('buy milk');
    expect(unreadHandwriting(page([makeStroke('x', [[0, 0], [1, 1]])]))).toBe(true);
    expect(unreadHandwriting(p)).toBe(false);
  });
});
