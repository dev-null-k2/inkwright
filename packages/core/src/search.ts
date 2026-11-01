import { pageText } from './export.ts';
import type { NoteMeta, NotebookMeta, PageInk } from './model.ts';

/** Lowercase, accent-free text for matching. */
export function normalizeText(s: string): string {
  return s.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase();
}

export function tokenize(s: string): string[] {
  return normalizeText(s).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Fraction of query tokens found as word prefixes in text (0..1). */
export function matchScore(query: string, text: string): number {
  const q = tokenize(query);
  if (!q.length) return 0;
  const words = tokenize(text);
  return q.filter((t) => words.some((w) => w.startsWith(t))).length / q.length;
}

export interface SearchDoc {
  noteId: string;
  pageIndex: number;
  title: string;
  tags: string[];
  text: string;
  updatedAt: number;
}

export interface SearchHit {
  noteId: string;
  pageIndex: number;
  title: string;
  snippet: string;
  score: number;
}

/**
 * In-memory full-text index over titles, tags, summaries, typed text and recognized handwriting,
 * with prefix matching ("lau bet" finds "launch the beta"), accent folding and field weighting.
 * Rebuilt from the vault in milliseconds for tens of thousands of pages, so there is no separate
 * database to corrupt or migrate.
 */
export class SearchIndex {
  private docs = new Map<string, SearchDoc[]>();
  private words = new Map<string, Set<string>>(); // token → note ids

  indexNote(note: NoteMeta, pages: PageInk[]): void {
    this.remove(note.id);
    if (note.trashedAt != null) return;
    const docs: SearchDoc[] = pages.map((p, i) => ({
      noteId: note.id,
      pageIndex: i,
      title: note.title,
      tags: note.tags,
      text: (i === 0 && note.summary ? note.summary + '\n' : '') + pageText(p),
      updatedAt: note.updatedAt,
    }));
    if (!docs.length) docs.push({ noteId: note.id, pageIndex: 0, title: note.title, tags: note.tags, text: note.summary ?? '', updatedAt: note.updatedAt });
    this.docs.set(note.id, docs);
    const toks = new Set<string>([...tokenize(note.title), ...note.tags.flatMap(tokenize), ...docs.flatMap((d) => tokenize(d.text))]);
    for (const t of toks) {
      let s = this.words.get(t);
      if (!s) this.words.set(t, (s = new Set()));
      s.add(note.id);
    }
  }

  remove(noteId: string): void {
    if (!this.docs.delete(noteId)) return;
    for (const [t, s] of this.words) {
      s.delete(noteId);
      if (!s.size) this.words.delete(t);
    }
  }

  clear(): void {
    this.docs.clear();
    this.words.clear();
  }

  get size(): number {
    return this.docs.size;
  }

  search(query: string, opts: { limit?: number; notebooks?: NotebookMeta[] } = {}): SearchHit[] {
    const q = tokenize(query);
    if (!q.length) return [];
    // Candidate notes: those containing a word with each query token as prefix.
    let candidates: Set<string> | undefined;
    for (const t of q) {
      const match = new Set<string>();
      for (const [w, ids] of this.words) if (w.startsWith(t)) for (const id of ids) match.add(id);
      candidates = candidates ? new Set([...candidates].filter((id: string) => match.has(id))) : match;
      if (!candidates.size) return [];
    }
    const hits: SearchHit[] = [];
    for (const id of candidates ?? []) {
      const docs = this.docs.get(id)!;
      let best: SearchHit | null = null;
      for (const d of docs) {
        const titleScore = matchScore(query, d.title) * 3;
        const tagScore = matchScore(query, d.tags.join(' ')) * 2;
        const textScore = matchScore(query, d.text);
        const exact = normalizeText(d.title + ' ' + d.text).includes(normalizeText(query.trim())) ? 1 : 0;
        const recency = 0.1 / (1 + (Date.now() - d.updatedAt) / (30 * 864e5));
        const score = titleScore + tagScore + textScore + exact + recency;
        if (!best || score > best.score) best = { noteId: id, pageIndex: d.pageIndex, title: d.title, snippet: snippet(d.text, q), score };
      }
      if (best) hits.push(best);
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, opts.limit ?? 50);
  }
}

/** ~140 chars around the first matching token, with «» marking matches. */
export function snippet(text: string, tokens: string[], radius = 70): string {
  if (!text) return '';
  const norm = normalizeText(text);
  let at = -1;
  for (const t of tokens) {
    const re = new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRe(t)}`, 'u');
    const m = re.exec(norm);
    if (m) { at = m.index + m[1]!.length; break; }
  }
  if (at < 0) return text.slice(0, radius * 2).replace(/\s+/g, ' ').trim();
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  let s = text.slice(start, end);
  for (const t of tokens) {
    s = s.replace(new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(t)}[\\p{L}\\p{N}]*)`, 'giu'), (_m, pre, w) => `${pre}«${w}»`);
  }
  return (start > 0 ? '…' : '') + s.replace(/\s+/g, ' ').trim() + (end < text.length ? '…' : '');
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
