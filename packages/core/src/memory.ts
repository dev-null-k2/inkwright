/**
 * Notes as one searchable memory. Everything a person can search for — typed text, recognized
 * handwriting, the text layer of imported PDFs, titles, tags and summaries — is cut into small
 * passages ("chunks") that remember exactly where they came from: note, page, a page-space
 * rectangle and, for handwriting, the stroke ids. Search results and AI citations can then open
 * the note at the right page and point at the very words, not just "somewhere in this note".
 *
 * Retrieval is hybrid: a BM25 keyword ranking over chunks, the app's existing note-level keyword
 * index, and (when an embedding model is available) vector similarity, combined with reciprocal
 * rank fusion. Fusion uses ranks, not raw scores, so lists with incomparable scales (BM25 vs.
 * cosine) mix fairly and any one of them can be missing (no embedding model yet, offline).
 */
import { textBoxHeight, wrapText } from './export.ts';
import { boundsOfStrokes, segmentLines } from './gestures.ts';
import { rectIsEmpty, rectUnion, type Rect } from './geometry.ts';
import { PEN_INFO, type NoteMeta, type PageInk, type RecognizedLine } from './model.ts';
import { normalizeText, snippet, tokenize, type SearchHit } from './search.ts';

export type ChunkSource = 'meta' | 'text' | 'handwriting' | 'pdf';

export interface MemoryChunk {
  /** Stable for a position in a note (`noteId:page:source:n`); the content may change. */
  id: string;
  noteId: string;
  pageIndex: number;
  source: ChunkSource;
  text: string;
  /** The note's title (context for embeddings and result lists). */
  title: string;
  /** Where the passage is on the page, in page units. Absent for note-level metadata. */
  rect?: Rect;
  /** Handwriting strokes the passage was recognized from. */
  strokeIds?: string[];
  /** The text box the passage comes from. */
  textId?: string;
  /** Hash of what gets embedded; unchanged passages keep their vectors across edits. */
  hash: string;
  updatedAt: number;
}

/** A positioned run of text from a PDF page's text layer, in page units. */
export interface PdfTextItem {
  str: string;
  rect: Rect;
}

export interface ChunkOptions {
  /** Text layer of PDF-backed pages, by page index. */
  pdfText?: ReadonlyMap<number, readonly PdfTextItem[]>;
  /** Soft upper bound for a chunk's length (default 600 characters). */
  maxChars?: number;
}

/** 32-bit FNV-1a, hex. Only used to notice that a passage changed. */
export function hashText(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0') + s.length.toString(36);
}

interface Piece {
  text: string;
  rect?: Rect;
  strokeIds?: string[];
  textId?: string;
  /** Starts a new paragraph (a vertical gap or a new block): prefer to break before it. */
  breakBefore?: boolean;
}

/** Packs consecutive pieces into chunks of at most ~maxChars, breaking at paragraph gaps when it can. */
function pack(pieces: Piece[], maxChars: number): Piece[] {
  const out: Piece[] = [];
  let cur: Piece | null = null;
  for (const p of pieces) {
    if (!p.text.trim()) continue;
    const wouldBe = (cur?.text.length ?? 0) + p.text.length + 1;
    const sameBlock = cur && cur.textId === p.textId;
    if (cur && (wouldBe > maxChars || (p.breakBefore && cur.text.length > maxChars / 3) || !sameBlock)) {
      out.push(cur);
      cur = null;
    }
    if (!cur) cur = { text: p.text, rect: p.rect, strokeIds: p.strokeIds ? [...p.strokeIds] : undefined, textId: p.textId };
    else {
      cur.text += '\n' + p.text;
      if (p.rect) cur.rect = cur.rect ? rectUnion(cur.rect, p.rect) : p.rect;
      if (p.strokeIds) cur.strokeIds = [...(cur.strokeIds ?? []), ...p.strokeIds];
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Splits an over-long line at sentence (then word) boundaries. */
function splitLong(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const sentences = text.match(/[^.!?。！？]+[.!?。！？]*\s*/g) ?? [text];
  const out: string[] = [];
  let cur = '';
  for (const s of sentences) {
    if (s.length > maxChars) {
      if (cur) { out.push(cur.trim()); cur = ''; }
      for (let i = 0; i < s.length; i += maxChars) out.push(s.slice(i, i + maxChars).trim());
      continue;
    }
    if ((cur + s).length > maxChars && cur) { out.push(cur.trim()); cur = ''; }
    cur += s;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** Lines of a typed text box with the vertical slice of the box each occupies. */
function textBoxPieces(t: NonNullable<PageInk['texts']>[number], maxChars: number): Piece[] {
  const height = textBoxHeight(t);
  const paras = t.text.split('\n');
  const lineCounts = paras.map((p) => Math.max(1, wrapText(p, t.width, t.fontSize).length));
  const total = lineCounts.reduce((a, b) => a + b, 0) || 1;
  const pieces: Piece[] = [];
  let before = 0;
  let gap = false;
  paras.forEach((para, i) => {
    const y0 = t.y + (height * before) / total;
    before += lineCounts[i]!;
    const y1 = t.y + (height * before) / total;
    if (!para.trim()) { gap = true; return; }
    for (const part of splitLong(para.trim(), maxChars)) {
      pieces.push({ text: part, rect: { minX: t.x, minY: y0, maxX: t.x + t.width, maxY: y1 }, textId: t.id, breakBefore: gap || /^#{1,6}\s/.test(part) });
      gap = false;
    }
  });
  return pieces;
}

/**
 * The lines of recognized handwriting with their strokes and bounds. Uses the recognizer's own
 * line anchors when it stored them; otherwise lines up the recognized text with the page's
 * writing lines (same count → one-to-one), or anchors the whole text to all the handwriting.
 */
export function handwritingLines(page: PageInk): RecognizedLine[] {
  if (page.recognizedLines?.length) return page.recognizedLines.filter((l) => l.text.trim());
  const text = page.recognizedText?.trim();
  if (!text) return [];
  const textLines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const ink = page.strokes.filter((s) => s.points.length && !PEN_INFO[s.pen]?.isHighlighter);
  const segs = segmentLines(ink);
  if (segs.length && segs.length === textLines.length) {
    return segs.map((g, i) => ({ text: textLines[i]!, strokeIds: g.strokes.map((s) => s.id), bounds: g.bounds }));
  }
  const all = boundsOfStrokes(ink);
  if (rectIsEmpty(all)) return textLines.map((t) => ({ text: t, strokeIds: [], bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 } }));
  return [{ text: textLines.join('\n'), strokeIds: ink.map((s) => s.id), bounds: all }];
}

function handwritingPieces(page: PageInk, maxChars: number): Piece[] {
  const lines = handwritingLines(page);
  const heights = lines.map((l) => l.bounds.maxY - l.bounds.minY).filter((h) => h > 0).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] ?? 0;
  const pieces: Piece[] = [];
  let prevBottom = -Infinity;
  for (const l of lines) {
    const hasRect = l.bounds.maxX > l.bounds.minX || l.bounds.maxY > l.bounds.minY;
    const gap = typical > 0 && hasRect && l.bounds.minY - prevBottom > typical * 1.6;
    for (const part of splitLong(l.text.trim(), maxChars)) {
      pieces.push({ text: part, rect: hasRect ? l.bounds : undefined, strokeIds: l.strokeIds.length ? l.strokeIds : undefined, breakBefore: gap });
    }
    if (hasRect) prevBottom = l.bounds.maxY;
  }
  return pieces;
}

/** Groups a PDF page's text runs into reading-order lines, then into pieces. */
export function pdfPieces(items: readonly PdfTextItem[], maxChars = 600): Piece[] {
  const runs = items.filter((it) => it.str.trim() && !rectIsEmpty(it.rect));
  const lines: { rect: Rect; runs: PdfTextItem[] }[] = [];
  for (const it of [...runs].sort((a, b) => a.rect.minY - b.rect.minY || a.rect.minX - b.rect.minX)) {
    const cy = (it.rect.minY + it.rect.maxY) / 2;
    const h = it.rect.maxY - it.rect.minY;
    const line = lines.find((l) => Math.abs((l.rect.minY + l.rect.maxY) / 2 - cy) < Math.max(2, h * 0.5));
    if (line) { line.runs.push(it); line.rect = rectUnion(line.rect, it.rect); }
    else lines.push({ rect: it.rect, runs: [it] });
  }
  lines.sort((a, b) => a.rect.minY - b.rect.minY);
  const heights = lines.map((l) => l.rect.maxY - l.rect.minY).sort((a, b) => a - b);
  const typical = heights[Math.floor(heights.length / 2)] ?? 0;
  const pieces: Piece[] = [];
  let prevBottom = -Infinity;
  for (const l of lines) {
    const text = l.runs.sort((a, b) => a.rect.minX - b.rect.minX).map((r) => r.str).join(' ').replace(/\s+/g, ' ').trim();
    const gap = typical > 0 && l.rect.minY - prevBottom > typical * 1.2;
    for (const part of splitLong(text, maxChars)) pieces.push({ text: part, rect: l.rect, breakBefore: gap });
    prevBottom = l.rect.maxY;
  }
  return pieces;
}

/** Cuts a note into anchored passages. Trashed notes have none. */
export function chunkNote(note: NoteMeta, pages: readonly PageInk[], opts: ChunkOptions = {}): MemoryChunk[] {
  if (note.trashedAt != null) return [];
  const maxChars = opts.maxChars ?? 600;
  const title = note.title.trim() || 'Untitled';
  const out: MemoryChunk[] = [];
  const add = (pageIndex: number, source: ChunkSource, n: number, p: Piece) => {
    const text = p.text.trim();
    if (!text) return;
    const c: MemoryChunk = { id: `${note.id}:${pageIndex}:${source}:${n}`, noteId: note.id, pageIndex, source, text, title, hash: hashText(`${title}\n${text}`), updatedAt: note.updatedAt };
    if (p.rect && !rectIsEmpty(p.rect)) c.rect = roundRect(p.rect);
    if (p.strokeIds?.length) c.strokeIds = p.strokeIds;
    if (p.textId) c.textId = p.textId;
    out.push(c);
  };
  const meta = [note.title.trim(), note.tags.length ? note.tags.map((t) => `#${t}`).join(' ') : '', note.summary?.trim() ?? ''].filter(Boolean).join('\n');
  if (meta) add(0, 'meta', 0, { text: meta });
  pages.forEach((page, i) => {
    const texts = [...(page.texts ?? [])].sort((a, b) => a.y - b.y || a.x - b.x);
    pack(texts.flatMap((t) => textBoxPieces(t, maxChars)), maxChars).forEach((p, n) => add(i, 'text', n, p));
    pack(handwritingPieces(page, maxChars), maxChars).forEach((p, n) => add(i, 'handwriting', n, p));
    const pdf = opts.pdfText?.get(i);
    if (pdf?.length) pack(pdfPieces(pdf, maxChars), maxChars).forEach((p, n) => add(i, 'pdf', n, p));
  });
  return out;
}

const roundRect = (r: Rect): Rect => ({ minX: Math.round(r.minX * 10) / 10, minY: Math.round(r.minY * 10) / 10, maxX: Math.round(r.maxX * 10) / 10, maxY: Math.round(r.maxY * 10) / 10 });

// ---- Keyword ranking over chunks -----------------------------------------------------------------

/**
 * Words that carry no topic in natural-language questions ("what did the professor say about…").
 * Dropped from keyword ranking when the query has other words, so questions rank like keywords.
 */
const STOPWORDS = new Set(
  'a an and are as at be but by can could did do does for from had has have how i in into is it its me my of on or our say said says should so than that the their them then there these they this those to was we were what when where which who whom why will with would you your about across all any'.split(' '),
);

export function queryTerms(query: string): string[] {
  const toks = tokenize(query);
  const content = toks.filter((t) => !STOPWORDS.has(t));
  return [...new Set(content.length ? content : toks)];
}

export interface RankedId {
  id: string;
  score: number;
}

/**
 * The chunks of all notes plus an inverted index for BM25 keyword ranking with prefix matching
 * ("four" finds "fourier"). Updated per note, so re-indexing a saved note is cheap.
 */
export class MemoryCorpus {
  private byId = new Map<string, MemoryChunk>();
  private byNote = new Map<string, string[]>();
  private lengths = new Map<string, number>();
  private postings = new Map<string, Map<string, number>>(); // word → chunk id → term frequency
  private totalLength = 0;

  setNote(noteId: string, chunks: readonly MemoryChunk[]): void {
    this.removeNote(noteId);
    const ids: string[] = [];
    for (const c of chunks) {
      this.byId.set(c.id, c);
      ids.push(c.id);
      const toks = tokenize(c.source === 'meta' ? c.text : `${c.text}`);
      this.lengths.set(c.id, toks.length);
      this.totalLength += toks.length;
      for (const t of toks) {
        let m = this.postings.get(t);
        if (!m) this.postings.set(t, (m = new Map()));
        m.set(c.id, (m.get(c.id) ?? 0) + 1);
      }
    }
    if (ids.length) this.byNote.set(noteId, ids);
  }

  removeNote(noteId: string): void {
    const ids = this.byNote.get(noteId);
    if (!ids) return;
    this.byNote.delete(noteId);
    const gone = new Set(ids);
    for (const id of ids) {
      this.totalLength -= this.lengths.get(id) ?? 0;
      this.lengths.delete(id);
      this.byId.delete(id);
    }
    for (const [w, m] of this.postings) {
      for (const id of gone) m.delete(id);
      if (!m.size) this.postings.delete(w);
    }
  }

  clear(): void {
    this.byId.clear();
    this.byNote.clear();
    this.lengths.clear();
    this.postings.clear();
    this.totalLength = 0;
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): MemoryChunk | undefined {
    return this.byId.get(id);
  }

  chunksOf(noteId: string): MemoryChunk[] {
    return (this.byNote.get(noteId) ?? []).map((id) => this.byId.get(id)!);
  }

  all(): IterableIterator<MemoryChunk> {
    return this.byId.values();
  }

  noteIds(): IterableIterator<string> {
    return this.byNote.keys();
  }

  /** BM25 (k1 1.2, b 0.75). Exact word matches count fully, prefix-only matches 0.7. */
  lexical(query: string, opts: { limit?: number; noteId?: string } = {}): RankedId[] {
    const terms = queryTerms(query);
    if (!terms.length || !this.byId.size) return [];
    const N = this.byId.size;
    const avg = this.totalLength / Math.max(1, N) || 1;
    const scores = new Map<string, number>();
    for (const t of terms) {
      const tf = new Map<string, number>();
      for (const [w, m] of this.postings) {
        if (!w.startsWith(t)) continue;
        const weight = w === t ? 1 : 0.7;
        for (const [id, n] of m) tf.set(id, (tf.get(id) ?? 0) + n * weight);
      }
      if (!tf.size) continue;
      const idf = Math.log(1 + (N - tf.size + 0.5) / (tf.size + 0.5));
      for (const [id, f] of tf) {
        if (opts.noteId && this.byId.get(id)!.noteId !== opts.noteId) continue;
        const len = this.lengths.get(id) ?? avg;
        const s = (idf * f * 2.2) / (f + 1.2 * (0.25 + (0.75 * len) / avg));
        scores.set(id, (scores.get(id) ?? 0) + s);
      }
    }
    const phrase = normalizeText(query.trim());
    const out: RankedId[] = [];
    for (const [id, s] of scores) {
      const c = this.byId.get(id)!;
      // Whole-phrase and title matches are what people usually mean.
      const bonus = (phrase.length > 3 && normalizeText(c.text).includes(phrase) ? 1 : 0) + (c.source === 'meta' ? 0.3 : 0);
      out.push({ id, score: s + bonus });
    }
    return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, opts.limit ?? 50);
  }
}

// ---- Vectors and fusion -------------------------------------------------------------------------

/** Dot product; embeddings are L2-normalized, so this is cosine similarity. */
export function dot(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}

/** Brute-force nearest chunks. Fast enough for hundreds of thousands of passages. */
export function vectorRank(query: ArrayLike<number>, chunks: Iterable<MemoryChunk>, vectorOf: (c: MemoryChunk) => ArrayLike<number> | undefined, opts: { limit?: number; minScore?: number } = {}): RankedId[] {
  const out: RankedId[] = [];
  const min = opts.minScore ?? 0.2;
  for (const c of chunks) {
    const v = vectorOf(c);
    if (!v) continue;
    const s = dot(query, v);
    if (s >= min) out.push({ id: c.id, score: s });
  }
  return out.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, opts.limit ?? 50);
}

/**
 * Reciprocal rank fusion: each list adds weight / (k + rank) for every id it ranks. Robust to
 * lists with different score scales and to missing lists; k=60 is the value from the RRF paper.
 */
export function reciprocalRankFusion(lists: ReadonlyArray<{ ids: readonly string[]; weight?: number }>, k = 60): Map<string, number> {
  const out = new Map<string, number>();
  for (const l of lists) {
    const w = l.weight ?? 1;
    l.ids.forEach((id, rank) => out.set(id, (out.get(id) ?? 0) + w / (k + rank + 1)));
  }
  return out;
}

export interface RankedChunk {
  chunk: MemoryChunk;
  score: number;
  /** 1-based rank in each list that found it. */
  ranks: { keyword?: number; note?: number; vector?: number };
  /** ~140 characters around the match, «» marking matched words. */
  snippet: string;
}

export interface HybridSearchOptions {
  limit?: number;
  /** Query embedding (same model as the chunk vectors). */
  queryVector?: ArrayLike<number>;
  vectorOf?: (c: MemoryChunk) => ArrayLike<number> | undefined;
  /** Hits from the app's note-level keyword index (`SearchIndex.search`). */
  noteHits?: readonly SearchHit[];
  /** At most this many passages per note (default 3), so one long note can't crowd out the rest. */
  perNote?: number;
  /** Only passages from this note. */
  noteId?: string;
  weights?: { keyword?: number; note?: number; vector?: number };
}

/**
 * Hybrid retrieval: chunk-level BM25 + the note-level keyword index (each note hit stands in as
 * its best-matching passage on the matching page) + vector similarity, fused with RRF.
 */
export function hybridSearch(corpus: MemoryCorpus, query: string, opts: HybridSearchOptions = {}): RankedChunk[] {
  const limit = opts.limit ?? 20;
  const depth = Math.max(50, limit * 4);
  const keyword = corpus.lexical(query, { limit: depth, noteId: opts.noteId });
  const keywordScore = new Map(keyword.map((r) => [r.id, r.score]));
  const noteIds: string[] = [];
  for (const h of opts.noteHits ?? []) {
    if (opts.noteId && h.noteId !== opts.noteId) continue;
    const chunks = corpus.chunksOf(h.noteId);
    if (!chunks.length) continue;
    const onPage = chunks.filter((c) => c.pageIndex === h.pageIndex && c.source !== 'meta');
    const pool = onPage.length ? onPage : chunks;
    const best = [...pool].sort((a, b) => (keywordScore.get(b.id) ?? 0) - (keywordScore.get(a.id) ?? 0))[0]!;
    if (!noteIds.includes(best.id)) noteIds.push(best.id);
  }
  let vector: RankedId[] = [];
  if (opts.queryVector && opts.vectorOf) {
    const pool = opts.noteId ? corpus.chunksOf(opts.noteId) : corpus.all();
    vector = vectorRank(opts.queryVector, pool, opts.vectorOf, { limit: depth });
  }
  const w = opts.weights ?? {};
  const fused = reciprocalRankFusion([
    { ids: keyword.map((r) => r.id), weight: w.keyword ?? 1 },
    { ids: noteIds, weight: w.note ?? 0.5 },
    { ids: vector.map((r) => r.id), weight: w.vector ?? 1 },
  ]);
  const rankOf = (list: readonly { id: string }[] | readonly string[], id: string) => {
    const i = (list as readonly (string | { id: string })[]).findIndex((x) => (typeof x === 'string' ? x : x.id) === id);
    return i < 0 ? undefined : i + 1;
  };
  const terms = queryTerms(query);
  const perNote = opts.perNote ?? 3;
  const counts = new Map<string, number>();
  const out: RankedChunk[] = [];
  for (const [id, score] of [...fused].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    const chunk = corpus.get(id);
    if (!chunk) continue;
    const n = counts.get(chunk.noteId) ?? 0;
    if (n >= perNote) continue;
    counts.set(chunk.noteId, n + 1);
    const ranks: RankedChunk['ranks'] = {};
    const k = rankOf(keyword, id), nr = rankOf(noteIds, id), v = rankOf(vector, id);
    if (k) ranks.keyword = k;
    if (nr) ranks.note = nr;
    if (v) ranks.vector = v;
    out.push({ chunk, score, ranks, snippet: snippet(chunk.text, terms) });
    if (out.length >= limit) break;
  }
  return out;
}

/** The text an embedding model sees for a passage (title gives short passages context). */
export function chunkEmbeddingText(c: MemoryChunk): string {
  return c.source === 'meta' ? c.text : `${c.title}\n${c.text}`;
}
