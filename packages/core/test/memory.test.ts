import { describe, expect, it } from 'vitest';
import {
  MemoryCorpus,
  NoteDocument,
  SearchIndex,
  chunkNote,
  handwritingLines,
  hashText,
  hybridSearch,
  newNote,
  newPage,
  pdfPieces,
  queryTerms,
  reciprocalRankFusion,
  vectorRank,
  type MemoryChunk,
  type NoteMeta,
  type PageInk,
  type TextBox,
} from '../src/index.ts';
import { stroke, word } from './helpers.ts';

const note = (id: string, title: string, extra: Partial<NoteMeta> = {}): NoteMeta => ({ ...newNote({ id, title, pageId: `${id}-p1`, now: 1_000 }), ...extra });
const box = (id: string, y: number, text: string, x = 64): TextBox => ({ id, x, y, width: 600, text, fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 });

/** Three lines of handwriting, 40 units apart, two words each. */
function handwrittenPage(id: string): PageInk {
  const strokes = [0, 1, 2].flatMap((row) => [stroke(`${id}-s${row}a`, word(100, 200 + row * 40, 80)), stroke(`${id}-s${row}b`, word(200, 200 + row * 40, 80))]);
  return { ...newPage(id), strokes };
}

describe('chunkNote', () => {
  it('anchors typed text to its box and keeps title, tags and summary as note-level memory', () => {
    const n = note('n1', 'Signals lecture', { tags: ['ee201'], summary: 'Fourier series and transforms' });
    const page = { ...newPage('n1-p1'), texts: [box('t1', 100, 'The Fourier transform turns a signal into its frequencies.')] };
    const chunks = chunkNote(n, [page]);
    const meta = chunks.find((c) => c.source === 'meta')!;
    expect(meta.text).toContain('Signals lecture');
    expect(meta.text).toContain('#ee201');
    expect(meta.text).toContain('Fourier series');
    expect(meta.rect).toBeUndefined();
    const t = chunks.find((c) => c.source === 'text')!;
    expect(t).toMatchObject({ noteId: 'n1', pageIndex: 0, textId: 't1' });
    expect(t.rect!.minX).toBe(64);
    expect(t.rect!.minY).toBe(100);
    expect(t.rect!.maxY).toBeGreaterThan(100);
  });

  it('uses the recognizer\'s per-line anchors (strokes and bounds) for handwriting', () => {
    const page: PageInk = {
      ...handwrittenPage('p'),
      recognizedText: 'fourier transform\nis linear\nhomework friday',
      recognizedLines: [
        { text: 'fourier transform', strokeIds: ['p-s0a', 'p-s0b'], bounds: { minX: 100, minY: 190, maxX: 280, maxY: 210 } },
        { text: 'is linear', strokeIds: ['p-s1a', 'p-s1b'], bounds: { minX: 100, minY: 230, maxX: 280, maxY: 250 } },
        // A big gap starts a new paragraph → its own passage.
        { text: 'homework friday', strokeIds: ['p-s2a', 'p-s2b'], bounds: { minX: 100, minY: 400, maxX: 280, maxY: 420 } },
      ],
    };
    const hw = chunkNote(note('n', 'Lecture 3'), [page], { maxChars: 30 }).filter((c) => c.source === 'handwriting');
    expect(hw.map((c) => c.text)).toEqual(['fourier transform\nis linear', 'homework friday']);
    expect(hw[0]!.strokeIds).toEqual(['p-s0a', 'p-s0b', 'p-s1a', 'p-s1b']);
    expect(hw[0]!.rect).toEqual({ minX: 100, minY: 190, maxX: 280, maxY: 250 });
    expect(hw[1]!.rect!.minY).toBe(400);
  });

  it('never merges short handwriting lines that are far apart on the page', () => {
    const page: PageInk = {
      ...newPage('p'),
      recognizedText: 'shopping list\nnyquist rate',
      recognizedLines: [
        { text: 'shopping list', strokeIds: ['a'], bounds: { minX: 100, minY: 160, maxX: 260, maxY: 178 } },
        { text: 'nyquist rate', strokeIds: ['b'], bounds: { minX: 100, minY: 410, maxX: 280, maxY: 428 } },
      ],
    };
    const hw = chunkNote(note('n', 'Mixed'), [page]).filter((c) => c.source === 'handwriting');
    expect(hw.map((c) => c.strokeIds)).toEqual([['a'], ['b']]);
    expect(hw[1]!.rect!.minY).toBe(410);
  });

  it('lines recognized text up with the writing lines when no anchors were stored', () => {
    const page: PageInk = { ...handwrittenPage('p'), recognizedText: 'one two\nthree four\nfive six' };
    const lines = handwritingLines(page);
    expect(lines.map((l) => l.text)).toEqual(['one two', 'three four', 'five six']);
    expect(lines[1]!.strokeIds.sort()).toEqual(['p-s1a', 'p-s1b']);
    expect(lines[1]!.bounds.minY).toBeGreaterThan(lines[0]!.bounds.maxY - 12);
  });

  it('anchors the whole text to all handwriting when line counts disagree', () => {
    const page: PageInk = { ...handwrittenPage('p'), recognizedText: 'a single transcription paragraph' };
    const [line] = handwritingLines(page);
    expect(line!.strokeIds).toHaveLength(6);
    expect(line!.bounds.minY).toBeLessThan(200);
    expect(line!.bounds.maxY).toBeGreaterThan(280);
  });

  it('chunks the PDF text layer in reading order with line rectangles', () => {
    const items = [
      { str: 'Chapter 2', rect: { minX: 50, minY: 40, maxX: 150, maxY: 60 } },
      { str: 'transforms', rect: { minX: 160, minY: 101, maxX: 240, maxY: 115 } },
      { str: 'Fourier', rect: { minX: 50, minY: 100, maxX: 150, maxY: 114 } },
    ];
    const pieces = pdfPieces(items);
    expect(pieces.map((p) => p.text)).toEqual(['Chapter 2', 'Fourier transforms']);
    const chunks = chunkNote(note('pdf', 'Textbook'), [newPage('a'), newPage('b')], { pdfText: new Map([[1, items]]) });
    const pdf = chunks.filter((c) => c.source === 'pdf');
    expect(pdf).toHaveLength(1);
    expect(pdf[0]!.pageIndex).toBe(1);
    expect(pdf[0]!.text).toBe('Chapter 2\nFourier transforms');
    expect(pdf[0]!.rect).toEqual({ minX: 50, minY: 40, maxX: 240, maxY: 115 });
  });

  it('splits long text into bounded passages and keeps hashes stable for unchanged text', () => {
    const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} talks about sampling.`).join(' ');
    const n = note('n', 'Long');
    const a = chunkNote(n, [{ ...newPage('p'), texts: [box('t', 80, long), box('u', 900, 'Unrelated footer')] }], { maxChars: 300 });
    const text = a.filter((c) => c.source === 'text');
    expect(text.length).toBeGreaterThan(4);
    for (const c of text) expect(c.text.length).toBeLessThanOrEqual(320);
    const b = chunkNote({ ...n, updatedAt: 99 }, [{ ...newPage('p'), texts: [box('t', 80, long), box('u', 900, 'Changed footer')] }], { maxChars: 300 });
    const same = (cs: MemoryChunk[]) => cs.filter((c) => c.textId === 't').map((c) => c.hash);
    expect(same(b)).toEqual(same(a));
    expect(b.find((c) => c.textId === 'u')!.hash).not.toBe(a.find((c) => c.textId === 'u')!.hash);
  });

  it('skips trashed notes and blank pages', () => {
    expect(chunkNote(note('t', 'Gone', { trashedAt: 5 }), [newPage('x')])).toEqual([]);
    expect(chunkNote(note('b', ''), [newPage('x')])).toEqual([]);
  });
});

describe('recognized line anchors in the document', () => {
  it('stores and clears line anchors with the recognized text', () => {
    const n = note('d', 'Doc');
    const doc = new NoteDocument(n, [newPage('d-p1')]);
    const lines = [{ text: 'hello', strokeIds: ['s1'], bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 } }];
    doc.setRecognizedText('d-p1', 'hello', 'test', lines);
    expect(doc.page(0).recognizedLines).toEqual(lines);
    doc.setRecognizedText('d-p1', 'hello world', 'ai');
    expect(doc.page(0).recognizedLines).toBeUndefined();
    expect(doc.page(0).recognizedText).toBe('hello world');
  });
});

describe('ranking', () => {
  function corpusOf(notes: Array<[NoteMeta, PageInk[]]>) {
    const corpus = new MemoryCorpus();
    const index = new SearchIndex();
    for (const [n, p] of notes) {
      corpus.setNote(n.id, chunkNote(n, p));
      index.indexNote(n, p);
    }
    return { corpus, index };
  }
  const lecture = (id: string, title: string, text: string) => [note(id, title), [{ ...newPage(`${id}-p`), texts: [box(`${id}-t`, 100, text)] }]] as [NoteMeta, PageInk[]];

  it('drops question words so natural questions rank like keywords', () => {
    expect(queryTerms('What did the professor say about Fourier transforms?')).toEqual(['professor', 'fourier', 'transforms']);
    expect(queryTerms('the')).toEqual(['the']);
  });

  it('BM25 prefers rarer, denser matches and supports prefixes', () => {
    const { corpus } = corpusOf([
      lecture('a', 'Week 1', 'Fourier transforms decompose signals. Fourier analysis is everywhere.'),
      lecture('b', 'Week 2', 'Laplace transforms generalize the idea.'),
      lecture('c', 'Groceries', 'milk eggs bread'),
    ]);
    const r = corpus.lexical('fourier transform');
    expect(r[0]!.id.startsWith('a:')).toBe(true);
    expect(r.some((x) => x.id.startsWith('b:'))).toBe(true);
    expect(r.some((x) => x.id.startsWith('c:'))).toBe(false);
    expect(corpus.lexical('four')[0]!.id.startsWith('a:')).toBe(true);
  });

  it('updates incrementally when a note changes or is removed', () => {
    const { corpus } = corpusOf([lecture('a', 'Week 1', 'convolution theorem')]);
    expect(corpus.lexical('convolution')).toHaveLength(1);
    const [n, p] = lecture('a', 'Week 1', 'sampling theorem');
    corpus.setNote('a', chunkNote(n, p));
    expect(corpus.lexical('convolution')).toHaveLength(0);
    expect(corpus.lexical('sampling')).toHaveLength(1);
    corpus.removeNote('a');
    expect(corpus.size).toBe(0);
    expect(corpus.lexical('sampling')).toHaveLength(0);
  });

  it('reciprocal rank fusion rewards agreement between lists', () => {
    const f = reciprocalRankFusion([{ ids: ['x', 'y', 'z'] }, { ids: ['y', 'x'] }, { ids: ['y'] }]);
    const order = [...f].sort((a, b) => b[1] - a[1]).map(([id]) => id);
    expect(order).toEqual(['y', 'x', 'z']);
    // A missing list changes nothing for the others.
    const g = reciprocalRankFusion([{ ids: ['x', 'y'] }, { ids: [] }]);
    expect(g.get('x')!).toBeGreaterThan(g.get('y')!);
  });

  it('vector ranking finds paraphrases keyword search misses, and fusion keeps both', () => {
    const { corpus, index } = corpusOf([
      lecture('a', 'Week 1', 'Fourier transforms decompose signals into frequencies.'),
      lecture('b', 'Week 4', 'Spectral analysis: any periodic wave is a sum of sines.'),
      lecture('c', 'Groceries', 'milk eggs bread'),
    ]);
    // A toy embedding space: [frequency-ness, food-ness].
    const vec: Record<string, number[]> = { a: [0.9, 0.1], b: [0.95, 0.05], c: [0.05, 0.99] };
    const vectorOf = (c: MemoryChunk) => (c.source === 'meta' ? undefined : vec[c.noteId]);
    const q = 'Fourier transforms';
    const v = vectorRank([1, 0], corpus.all(), vectorOf, { minScore: 0.5 });
    expect(v.map((r) => r.id[0])).toEqual(['b', 'a']);
    const r = hybridSearch(corpus, q, { queryVector: [1, 0], vectorOf, noteHits: index.search(q) });
    const notes = r.map((x) => x.chunk.noteId);
    expect(notes[0]).toBe('a'); // keyword + note index + vector agree
    expect(notes).toContain('b'); // only the vector list knows this one
    expect(notes).not.toContain('c');
    const top = r[0]!;
    expect(top.ranks.keyword).toBeDefined();
    expect(top.ranks.vector).toBeDefined();
    expect(top.snippet).toContain('«Fourier»');
  });

  it('keyword-only hybrid search works when no embedding model is available', () => {
    const { corpus, index } = corpusOf([lecture('a', 'Week 1', 'Nyquist rate and aliasing'), lecture('b', 'Week 2', 'Aliasing in images')]);
    const r = hybridSearch(corpus, 'nyquist aliasing', { noteHits: index.search('nyquist aliasing') });
    expect(r[0]!.chunk.noteId).toBe('a');
    expect(r[0]!.ranks.note).toBe(1);
  });

  it('caps passages per note so one long note does not crowd out the others', () => {
    const many = Array.from({ length: 6 }, (_, i) => box(`t${i}`, 100 + i * 120, `entropy entropy note ${i}`));
    const big: [NoteMeta, PageInk[]] = [note('big', 'Big'), [{ ...newPage('bp'), texts: many }]];
    const { corpus } = corpusOf([big, lecture('small', 'Small', 'entropy once')]);
    const r = hybridSearch(corpus, 'entropy', { perNote: 2 });
    expect(r.filter((x) => x.chunk.noteId === 'big')).toHaveLength(2);
    expect(r.some((x) => x.chunk.noteId === 'small')).toBe(true);
  });

  it('hashText is deterministic and sensitive to content', () => {
    expect(hashText('abc')).toBe(hashText('abc'));
    expect(hashText('abc')).not.toBe(hashText('abd'));
  });
});
