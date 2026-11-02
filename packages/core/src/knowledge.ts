/**
 * The vault as a knowledge base: which notes link where, which notes mention each other without a
 * link yet, which tags each note carries (set by hand or written as `#tags`), and which notes are
 * related by what they talk about. Built from the same files as search, in memory, in
 * milliseconds; nothing is stored, so nothing can go stale on disk.
 */
import { pageText } from './export.ts';
import { findMentions, contextLine, noteLinkOccurrences, normalizeTitle, parseTags, resolveWikiTarget, type LinkOccurrence, type LinkSource } from './links.ts';
import type { NoteMeta, NotebookMeta, PageInk } from './model.ts';
import { tokenize } from './search.ts';

/** A note that links here. */
export interface Backlink {
  noteId: string;
  title: string;
  pageIndex: number;
  source: LinkSource;
  /** The line around the link (empty for ink links). */
  snippet: string;
  /** Page of *this* note the link points at, if it named one. */
  targetPage?: number;
}

/** A note that names this one in its text or handwriting, without linking it. */
export interface Mention {
  noteId: string;
  title: string;
  pageIndex: number;
  source: 'text' | 'handwriting';
  /** Text box holding the mention (typed text only). */
  boxId?: string;
  snippet: string;
}

/** Something that can say which notes are about the same things as a note. */
export interface RelatedNotesProvider {
  /** Notes related to [noteId], best first, with a score in 0..1. */
  relatedNotes(noteId: string, opts?: { limit?: number }): Promise<{ id: string; score: number }[]>;
}

interface PageEntry {
  /** Typed text boxes (id + Markdown). */
  boxes: { id: string; text: string }[];
  recognized: string;
}

interface Entry {
  note: NoteMeta;
  pages: PageEntry[];
  links: LinkOccurrence[];
  tags: string[];
  /** Term frequencies for "related" (title and tags weigh more). */
  terms: Map<string, number>;
}

/** Words that say nothing about what a note is about. */
const STOP = new Set(`a an and are as at be but by for from has have he her his i if in into is it its me my no not of on or our she so than that the their them then there these they this to too up us was we were what when where which who why will with you your about after again all also am any because been before being both can could did do does doing down during each few further had here how just more most much must now off once only other out over own same should some such them through under until very would yet page note notes`.split(/\s+/));

function termsOf(note: NoteMeta, tags: string[], text: string): Map<string, number> {
  const m = new Map<string, number>();
  const add = (w: string, k: number) => {
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) return;
    m.set(w, (m.get(w) ?? 0) + k);
  };
  for (const w of tokenize(note.title)) add(w, 3);
  for (const t of tags) m.set(`#${t.toLowerCase()}`, (m.get(`#${t.toLowerCase()}`) ?? 0) + 4);
  for (const w of tokenize(text)) add(w, 1);
  return m;
}

export class KnowledgeIndex {
  private entries = new Map<string, Entry>();
  /** normalized title → note ids, rebuilt lazily after changes. */
  private titles: Map<string, string[]> | null = null;
  private docFreq: Map<string, number> | null = null;
  private norms: Map<string, number> | null = null;
  private notesCache: NoteMeta[] | null = null;
  /** Bumped on every change; the graph and panels use it to know when to rebuild. */
  version = 0;

  get size(): number { return this.entries.size; }

  has(id: string): boolean { return this.entries.has(id); }

  private dirty() {
    this.titles = null;
    this.docFreq = null;
    this.norms = null;
    this.notesCache = null;
    this.version++;
  }

  /** Indexes (or re-indexes) a note. Trashed notes are removed. */
  update(note: NoteMeta, pages: readonly PageInk[]): void {
    if (note.trashedAt != null) return this.remove(note.id);
    const pe: PageEntry[] = pages.map((p) => ({ boxes: (p.texts ?? []).filter((t) => t.text.trim()).map((t) => ({ id: t.id, text: t.text })), recognized: p.recognizedText ?? '' }));
    const text = pages.map((p) => pageText(p)).join('\n\n');
    const tags = this.mergeTags(note.tags, parseTags(text));
    this.entries.set(note.id, { note, pages: pe, links: noteLinkOccurrences(pages), tags, terms: termsOf(note, tags, (note.summary ?? '') + '\n' + text) });
    this.dirty();
  }

  /** Metadata changed without the pages (rename, move, pin, trash): keeps the indexed content. */
  updateMeta(note: NoteMeta): void {
    if (note.trashedAt != null) return this.remove(note.id);
    const e = this.entries.get(note.id);
    if (!e) return;
    const text = e.pages.map((p) => [...p.boxes.map((b) => b.text), p.recognized].join('\n')).join('\n\n');
    const tags = this.mergeTags(note.tags, parseTags(text));
    this.entries.set(note.id, { ...e, note, tags, terms: termsOf(note, tags, (note.summary ?? '') + '\n' + text) });
    this.dirty();
  }

  private mergeTags(a: readonly string[], b: readonly string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [...a, ...b]) {
      const k = t.toLowerCase();
      if (!t.trim() || seen.has(k)) continue;
      seen.add(k);
      out.push(t);
    }
    return out;
  }

  remove(id: string): void {
    if (this.entries.delete(id)) this.dirty();
  }

  clear(): void {
    this.entries.clear();
    this.dirty();
  }

  /** Every indexed (live) note. */
  notes(): NoteMeta[] {
    return (this.notesCache ??= [...this.entries.values()].map((e) => e.note));
  }

  note(id: string): NoteMeta | undefined {
    return this.entries.get(id)?.note;
  }

  /** The note's tags: set by hand plus `#tags` written in it. */
  tagsOf(id: string): string[] {
    return this.entries.get(id)?.tags ?? [];
  }

  /** Every tag in the vault with how many notes carry it. */
  allTags(): { tag: string; count: number }[] {
    const m = new Map<string, { tag: string; count: number }>();
    for (const e of this.entries.values()) for (const t of e.tags) {
      const k = t.toLowerCase();
      const cur = m.get(k);
      if (cur) cur.count++;
      else m.set(k, { tag: t, count: 1 });
    }
    return [...m.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
  }

  private titleMap(): Map<string, string[]> {
    if (this.titles) return this.titles;
    const m = new Map<string, string[]>();
    for (const e of this.entries.values()) {
      const k = normalizeTitle(e.note.title);
      const list = m.get(k);
      if (list) list.push(e.note.id);
      else m.set(k, [e.note.id]);
    }
    return (this.titles = m);
  }

  /** The note a link occurrence from [fromId] points at, or null when it is unresolved. */
  resolve(occ: Pick<LinkOccurrence, 'target' | 'title' | 'noteId'>, fromId: string, notebooks: readonly NotebookMeta[] = []): NoteMeta | null {
    if (occ.noteId) {
      const byId = this.entries.get(occ.noteId);
      if (byId) return byId.note;
    }
    const from = this.entries.get(fromId)?.note;
    if (!occ.title) return from ?? null;
    // Fast path: the title names exactly one note.
    const ids = this.titleMap().get(normalizeTitle(occ.title));
    if (ids?.length === 1) return this.entries.get(ids[0]!)!.note;
    return resolveWikiTarget(occ.target, this.notes(), { from, notebooks })?.note ?? null;
  }

  /** Links out of a note, each with the note it reaches (null: no such note yet). */
  outgoing(id: string, notebooks: readonly NotebookMeta[] = []): { occ: LinkOccurrence; note: NoteMeta | null }[] {
    const e = this.entries.get(id);
    if (!e) return [];
    return e.links.map((occ) => ({ occ, note: this.resolve(occ, id, notebooks) }));
  }

  /** Notes that link to [id], with the line around each link. One entry per linking line. */
  backlinks(id: string, notebooks: readonly NotebookMeta[] = []): Backlink[] {
    const target = this.entries.get(id);
    if (!target) return [];
    const out: Backlink[] = [];
    for (const e of this.entries.values()) {
      if (e.note.id === id) continue;
      const seen = new Set<string>();
      for (const occ of e.links) {
        if (this.resolve(occ, e.note.id, notebooks)?.id !== id) continue;
        const key = `${occ.pageIndex}|${occ.source}|${occ.context}|${occ.itemId ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ noteId: e.note.id, title: e.note.title, pageIndex: occ.pageIndex, source: occ.source, snippet: occ.context, targetPage: occ.page });
      }
    }
    return out.sort((a, b) => (this.entries.get(b.noteId)!.note.updatedAt - this.entries.get(a.noteId)!.note.updatedAt) || a.pageIndex - b.pageIndex);
  }

  /**
   * Notes whose typed text or recognized handwriting names [id]'s title without linking to it.
   * Notes that already link to it elsewhere are still listed for their other, unlinked mentions.
   */
  unlinkedMentions(id: string): Mention[] {
    const target = this.entries.get(id);
    if (!target) return [];
    const title = target.note.title;
    if (normalizeTitle(title) === 'untitled') return [];
    const out: Mention[] = [];
    for (const e of this.entries.values()) {
      if (e.note.id === id) continue;
      e.pages.forEach((p, pageIndex) => {
        for (const b of p.boxes) {
          const m = findMentions(b.text, title)[0];
          if (m) out.push({ noteId: e.note.id, title: e.note.title, pageIndex, source: 'text', boxId: b.id, snippet: contextLine(b.text, m.start) });
        }
        if (p.recognized) {
          const m = findMentions(p.recognized, title)[0];
          if (m) out.push({ noteId: e.note.id, title: e.note.title, pageIndex, source: 'handwriting', snippet: contextLine(p.recognized, m.start) });
        }
      });
    }
    return out;
  }

  /** Resolved note-to-note links (deduplicated, self-links dropped) with how often each occurs. */
  linkPairs(notebooks: readonly NotebookMeta[] = []): { source: string; target: string; count: number }[] {
    const m = new Map<string, { source: string; target: string; count: number }>();
    for (const e of this.entries.values()) {
      for (const occ of e.links) {
        const to = this.resolve(occ, e.note.id, notebooks);
        if (!to || to.id === e.note.id) continue;
        const k = `${e.note.id}>${to.id}`;
        const cur = m.get(k);
        if (cur) cur.count++;
        else m.set(k, { source: e.note.id, target: to.id, count: 1 });
      }
    }
    return [...m.values()];
  }

  /**
   * Keyword relatedness (the fallback when no embedding index is available): TF-IDF cosine over
   * title, tags and text, through an inverted lookup so it stays fast on large vaults.
   */
  relatedByKeywords(id: string, limit = 8): { id: string; score: number }[] {
    const e = this.entries.get(id);
    if (!e || !e.terms.size) return [];
    const df = this.documentFrequencies();
    const n = this.entries.size;
    const idf = (t: string) => Math.log(1 + n / (1 + (df.get(t) ?? 0)));
    const weigh = (terms: Map<string, number>) => {
      const w = new Map<string, number>();
      let norm = 0;
      for (const [t, f] of terms) {
        const v = (1 + Math.log(f)) * idf(t);
        w.set(t, v);
        norm += v * v;
      }
      return { w, norm: Math.sqrt(norm) || 1 };
    };
    const q = weigh(e.terms);
    const scores = new Map<string, number>();
    for (const other of this.entries.values()) {
      if (other.note.id === id) continue;
      let dot = 0;
      for (const [t, f] of other.terms) {
        const qv = q.w.get(t);
        if (qv) dot += qv * (1 + Math.log(f)) * idf(t);
      }
      if (dot <= 0) continue;
      const norms = (this.norms ??= new Map());
      let on = norms.get(other.note.id);
      if (on == null) norms.set(other.note.id, (on = weigh(other.terms).norm));
      scores.set(other.note.id, dot / (q.norm * on));
    }
    return [...scores].map(([id, score]) => ({ id, score: Math.min(1, score) })).sort((a, b) => b.score - a.score).slice(0, limit);
  }

  private documentFrequencies(): Map<string, number> {
    if (this.docFreq) return this.docFreq;
    const df = new Map<string, number>();
    for (const e of this.entries.values()) for (const t of e.terms.keys()) df.set(t, (df.get(t) ?? 0) + 1);
    return (this.docFreq = df);
  }
}

/**
 * The default `RelatedNotesProvider`: shared tags and keywords from the knowledge index. An
 * embedding-based provider (semantic index) can replace it without changing any caller.
 */
export class KeywordRelatedNotes implements RelatedNotesProvider {
  constructor(private index: KnowledgeIndex) {}
  async relatedNotes(noteId: string, opts: { limit?: number } = {}): Promise<{ id: string; score: number }[]> {
    return this.index.relatedByKeywords(noteId, opts.limit ?? 8);
  }
}
