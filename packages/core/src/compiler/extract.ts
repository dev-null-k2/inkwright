/**
 * Deterministic extraction — the first stage of the context compiler, and the only one that
 * always runs. A note (typed text, recognized handwriting with its line anchors, the text layer of
 * imported PDFs, and transcripts of recordings with their timings) becomes a list of *source
 * units*: single sentences that each know exactly where they are (note, page, rectangle, strokes,
 * text box, recording moment) and carry a content hash. Headings, `[[links]]`, `#tags`, dates,
 * people/projects/concepts and action items are pulled out with rules, so the AI that runs later
 * only has to write prose over facts that are already located — and every sentence it writes can
 * be checked against these units.
 *
 * Nothing here calls a model; it is cheap enough to run on every save.
 */
import { textBoxHeight, wrapText } from '../export.ts';
import { rectIsEmpty, rectUnion, type Rect } from '../geometry.ts';
import { parseTags, parseWikiLinks } from '../links.ts';
import { handwritingLines, pdfPieces, type PdfTextItem } from '../memory.ts';
import type { NoteMeta, PageInk, TextBox } from '../model.ts';
import { bucketSegmentsByPage, inkForSegment, type RecordingTranscript } from '../transcript.ts';
import { formatAnchor, type SourceAnchor } from './provenance.ts';
import { sentenceHash, splitSentences, stripMarkdown } from './text.ts';
import { hashText } from '../memory.ts';
import { isReadableLine } from '../textquality.ts';

export type UnitKind = 'text' | 'handwriting' | 'pdf' | 'speech';

/** One located sentence of a source note. */
export interface SourceUnit {
  /** `<noteId>:<page>:<kind>:<n>` — positional, unique within an extraction. */
  id: string;
  noteId: string;
  title: string;
  pageIndex: number;
  kind: UnitKind;
  /** The sentence (Markdown markers kept, e.g. "- [ ] Call Sam"). */
  text: string;
  /** `sentenceHash(text)`: the same sentence anywhere hashes the same. */
  hash: string;
  rect?: Rect;
  strokeIds?: string[];
  textId?: string;
  /** Speech: the recording and the segment's time span (ms from the recording's start). */
  clip?: string;
  startMs?: number;
  endMs?: number;
  /** The nearest Markdown heading above the sentence in its text box, if any. */
  heading?: string;
}

/** A note after extraction. */
export interface SourceDoc {
  noteId: string;
  title: string;
  notebookId?: string;
  tags: string[];
  createdAt: number;
  updatedAt: number;
  /** Daily notes: the day (`YYYY-MM-DD`). */
  daily?: string;
  units: SourceUnit[];
  /** Markdown headings, in order. */
  headings: string[];
  /** `[[link]]` titles, in order of first appearance. */
  links: string[];
  /** Hash of all unit hashes: equal fingerprints mean nothing a compiled page could cite changed. */
  fingerprint: string;
}

export interface ExtractOptions {
  /** Text layer of PDF-backed pages, by page index. */
  pdfText?: ReadonlyMap<number, readonly PdfTextItem[]>;
  /** Transcripts of the note's recordings. */
  transcripts?: readonly RecordingTranscript[];
}

const HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/;

/** Lines of a text box with the vertical slice of the box each occupies (wrapping-aware). */
function textBoxLines(t: TextBox): Array<{ text: string; rect: Rect }> {
  const height = textBoxHeight(t);
  const paras = t.text.split('\n');
  const counts = paras.map((p) => Math.max(1, wrapText(p, t.width, t.fontSize).length));
  const total = counts.reduce((a, b) => a + b, 0) || 1;
  const out: Array<{ text: string; rect: Rect }> = [];
  let before = 0;
  paras.forEach((para, i) => {
    const y0 = t.y + (height * before) / total;
    before += counts[i]!;
    const y1 = t.y + (height * before) / total;
    out.push({ text: para, rect: { minX: t.x, minY: y0, maxX: t.x + t.width, maxY: y1 } });
  });
  return out;
}

const round = (r: Rect): Rect => ({ minX: Math.round(r.minX * 10) / 10, minY: Math.round(r.minY * 10) / 10, maxX: Math.round(r.maxX * 10) / 10, maxY: Math.round(r.maxY * 10) / 10 });

/**
 * Cuts a note into located sentences. Locked or trashed notes yield nothing (the compiler never
 * reads them). Order: per page, typed text top to bottom, then handwriting, then PDF text; speech
 * last, each segment on the page it was assigned to while recording.
 */
export function extractSource(note: NoteMeta, pages: readonly PageInk[], opts: ExtractOptions = {}): SourceDoc {
  const units: SourceUnit[] = [];
  const headings: string[] = [];
  const links: string[] = [];
  const counters = new Map<string, number>();
  const title = note.title.trim() || 'Untitled';
  const add = (u: Omit<SourceUnit, 'id' | 'noteId' | 'title' | 'hash'>) => {
    const text = u.text.trim();
    if (!text || !/[\p{L}\p{N}]/u.test(stripMarkdown(text))) return;
    const key = `${u.pageIndex}:${u.kind}`;
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    const unit: SourceUnit = { ...u, text, id: `${note.id}:${u.pageIndex}:${u.kind}:${n}`, noteId: note.id, title, hash: sentenceHash(text) };
    if (unit.rect) unit.rect = rectIsEmpty(unit.rect) ? undefined : round(unit.rect);
    if (!unit.rect) delete unit.rect;
    units.push(unit);
    for (const l of parseWikiLinks(text)) if (l.title && !links.includes(l.title)) links.push(l.title);
  };
  if (note.lock || note.trashedAt != null) return finish();

  pages.forEach((page, pageIndex) => {
    for (const t of [...(page.texts ?? [])].sort((a, b) => a.y - b.y || a.x - b.x)) {
      let heading: string | undefined;
      for (const line of textBoxLines(t)) {
        const h = HEADING.exec(line.text);
        if (h) {
          heading = stripMarkdown(h[1]!);
          if (heading && !headings.includes(heading)) headings.push(heading);
          continue;
        }
        for (const s of splitSentences(line.text)) add({ pageIndex, kind: 'text', text: s.text, rect: line.rect, textId: t.id, ...(heading ? { heading } : {}) });
      }
    }
    for (const l of handwritingLines(page)) {
      // Scribbles the recognizer turned into symbol soup are not sentences anyone wrote.
      if (!isReadableLine(l.text)) continue;
      const hasRect = l.bounds.maxX > l.bounds.minX || l.bounds.maxY > l.bounds.minY;
      for (const s of splitSentences(l.text)) add({ pageIndex, kind: 'handwriting', text: s.text, ...(hasRect ? { rect: l.bounds } : {}), ...(l.strokeIds.length ? { strokeIds: l.strokeIds } : {}) });
    }
    const pdf = opts.pdfText?.get(pageIndex);
    if (pdf?.length) {
      // PDF lines break mid-sentence: join each paragraph, then split it into sentences.
      let para: { text: string; rect?: Rect } | null = null;
      const flush = () => {
        if (para) for (const s of splitSentences(para.text)) add({ pageIndex, kind: 'pdf', text: s.text, ...(para.rect ? { rect: para.rect } : {}) });
        para = null;
      };
      for (const p of pdfPieces(pdf)) {
        if (para && (p.breakBefore || p.hard)) flush();
        if (!para) para = { text: p.text, rect: p.rect };
        else {
          para.text = para.text.endsWith('-') ? para.text.slice(0, -1) + p.text : `${para.text} ${p.text}`;
          if (p.rect) para.rect = para.rect ? rectUnion(para.rect, p.rect) : p.rect;
        }
      }
      flush();
    }
  });

  if (opts.transcripts?.length) {
    const buckets = bucketSegmentsByPage(pages, opts.transcripts);
    for (const [pageIndex, list] of [...buckets].sort((a, b) => a[0] - b[0])) {
      for (const { clip, segment } of list) {
        const ink = inkForSegment(pages, clip, segment).find((m) => m.pageIndex === pageIndex);
        for (const s of splitSentences(segment.text)) {
          add({ pageIndex, kind: 'speech', text: s.text, clip: clip.id, startMs: segment.startMs, endMs: segment.endMs, ...(ink && !rectIsEmpty(ink.bounds) ? { rect: ink.bounds } : {}), ...(ink?.strokeIds.length ? { strokeIds: ink.strokeIds } : {}) });
        }
      }
    }
  }
  return finish();

  function finish(): SourceDoc {
    const doc: SourceDoc = {
      noteId: note.id,
      title,
      tags: [...new Set([...note.tags, ...units.flatMap((u) => parseTags(u.text))])],
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      units,
      headings,
      links,
      fingerprint: hashText(`${title}\n${units.map((u) => u.hash).join(',')}`),
    };
    if (note.notebookId) doc.notebookId = note.notebookId;
    if (note.daily) doc.daily = note.daily;
    return doc;
  }
}

/** The anchor a claim citing this unit stores. */
export function anchorOf(u: SourceUnit): SourceAnchor {
  const a: SourceAnchor = { noteId: u.noteId, page: u.pageIndex, h: u.hash };
  if (u.rect) a.rect = u.rect;
  if (u.clip) { a.clip = u.clip; a.ms = u.startMs ?? 0; }
  return a;
}

export const unitAnchor = (u: SourceUnit): string => formatAnchor(anchorOf(u));

/** Every sentence hash of a source (for staleness checks), plus the title's. */
export function sourceHashes(doc: SourceDoc): Set<string> {
  return new Set(doc.units.map((u) => u.hash));
}
