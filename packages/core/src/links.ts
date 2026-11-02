/**
 * Links between notes, Obsidian-style. A note links to another by writing its title in double
 * brackets — `[[Biology]]`, `[[Biology#Page 2]]`, `[[Biology|the bio notes]]` — in typed text, in
 * handwriting that was recognized, or by turning lassoed ink into a link (`InkLink`). `#tags`
 * written anywhere in a note become the note's tags.
 *
 * Everything here is pure string/data work so the library, the editor, the graph, the Obsidian
 * exporter and the MCP server agree on exactly what counts as a link or a tag.
 */
import type { InkLink, NoteMeta, NotebookMeta, PageInk } from './model.ts';

export interface WikiLink {
  /** The whole match, brackets included (`![[Note#Page 2|alias]]`). */
  raw: string;
  /** What is linked: title plus optional `#subpath` (no alias). */
  target: string;
  /** The note title part (may be a `Folder/Title` path); empty for a link inside the same note. */
  title: string;
  /** The part after `#`: `Page 2`, or a heading as written. */
  subpath?: string;
  /** 1-based page number when the subpath is `Page N`. */
  page?: number;
  alias?: string;
  /** `![[…]]`: an Obsidian embed. Inkstone treats it as a link. */
  embed: boolean;
  start: number;
  end: number;
}

const WIKI_RE = /(!?)\[\[([^[\]\n]+?)\]\]/g;

/** Splits the inside of `[[…]]` into target, title, subpath, page and alias. */
export function parseWikiTarget(inner: string): Pick<WikiLink, 'target' | 'title' | 'subpath' | 'page' | 'alias'> {
  const bar = inner.indexOf('|');
  const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
  const alias = bar >= 0 ? inner.slice(bar + 1).trim() || undefined : undefined;
  const hash = target.indexOf('#');
  const title = (hash >= 0 ? target.slice(0, hash) : target).trim();
  const subpath = hash >= 0 ? target.slice(hash + 1).trim() || undefined : undefined;
  const pm = subpath ? /^page\s*(\d{1,4})$/i.exec(subpath) : null;
  const page = pm ? Math.max(1, Number(pm[1])) : undefined;
  return { target, title, subpath, page, alias };
}

/** Every `[[wiki link]]` in a piece of text, in order. */
export function parseWikiLinks(text: string): WikiLink[] {
  const out: WikiLink[] = [];
  if (!text || !text.includes('[[')) return out;
  for (const m of text.matchAll(WIKI_RE)) {
    const parts = parseWikiTarget(m[2]!);
    if (!parts.title && !parts.subpath) continue;
    out.push({ raw: m[0], ...parts, embed: m[1] === '!', start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** What a link shows on the page: its alias, else `Title › Page 2`, else the title. */
export function linkLabel(l: Pick<WikiLink, 'title' | 'subpath' | 'alias'>): string {
  if (l.alias) return l.alias;
  if (l.subpath) return l.title ? `${l.title} › ${l.subpath}` : l.subpath;
  return l.title;
}

/** Text with every `[[link]]` replaced by its label (what a reader sees). */
export function stripWikiLinks(text: string): string {
  return text.replace(WIKI_RE, (_m, _bang, inner: string) => linkLabel(parseWikiTarget(inner)));
}

/** Builds link markup for a title (and optional page); falls back to an alias when needed. */
export function formatWikiLink(title: string, opts: { page?: number; subpath?: string; alias?: string } = {}): string {
  const clean = title.replace(/[[\]|#\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  const sub = opts.page ? `#Page ${opts.page}` : opts.subpath ? `#${opts.subpath}` : '';
  const alias = opts.alias ?? (clean !== title.trim() ? title.trim() : undefined);
  return `[[${clean}${sub}${alias && alias !== clean ? `|${alias.replace(/[[\]\n]+/g, ' ')}` : ''}]]`;
}

// ---- Tags ------------------------------------------------------------------------------------

/**
 * Obsidian's tag rule: `#` at the start or after whitespace/punctuation, then letters, digits,
 * `_`, `-` or `/` (nesting), with at least one character that is not a digit (`#2024` is not a
 * tag; `#y2024` is). Headings (`# Title`), links (`[[Note#Page 2]]`), URLs and code are ignored.
 */
const TAG_RE = /(^|[\s(,;:!?"'“‘])#([\p{L}\p{N}_/-]+)/gu;

export function parseTags(text: string): string[] {
  if (!text || !text.includes('#')) return [];
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(WIKI_RE, ' ')
    .replace(/\bhttps?:\/\/\S+/g, ' ');
  const out: string[] = [];
  const seen = new Set<string>();
  for (const m of clean.matchAll(TAG_RE)) {
    const tag = m[2]!.replace(/[/-]+$/, '');
    if (!tag || /^\d+$/.test(tag.replace(/[/_-]/g, ''))) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/**
 * Keeps `meta.tags` in step with the `#tags` written in the note. Tags the user added by hand
 * stay; inline tags that disappeared from the text are dropped. Returns the same object when
 * nothing changed so callers can skip a write.
 */
export function syncInlineTags(meta: NoteMeta, text: string): NoteMeta {
  const inline = parseTags(text);
  const prev = meta.inlineTags ?? [];
  const sameInline = prev.length === inline.length && prev.every((t, i) => t === inline[i]);
  const lower = (xs: string[]) => new Set(xs.map((x) => x.toLowerCase()));
  const prevSet = lower(prev);
  const inlineSet = lower(inline);
  const manual = meta.tags.filter((t) => !prevSet.has(t.toLowerCase()) || inlineSet.has(t.toLowerCase()));
  const have = lower(manual);
  const tags = [...manual, ...inline.filter((t) => !have.has(t.toLowerCase()))];
  const sameTags = tags.length === meta.tags.length && tags.every((t, i) => t === meta.tags[i]);
  if (sameInline && sameTags) return meta;
  const next: NoteMeta = { ...meta, tags };
  if (inline.length) next.inlineTags = inline;
  else delete next.inlineTags;
  return next;
}

// ---- Resolution ------------------------------------------------------------------------------

/** How titles compare: case-insensitive, whitespace-collapsed, `.md` suffix ignored. */
export function normalizeTitle(s: string): string {
  return s.normalize('NFC').replace(/\.md$/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

export interface LinkResolution {
  note: NoteMeta;
  /** 0-based page to open, when the link named one (`#Page 2`). */
  pageIndex?: number;
}

function notebookPath(nb: NotebookMeta | undefined, all: readonly NotebookMeta[]): string[] {
  const out: string[] = [];
  let cur = nb;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur.name);
    cur = cur.parentId ? all.find((n) => n.id === cur!.parentId) : undefined;
  }
  return out;
}

/**
 * Finds the note a link points to. Titles match case-insensitively; a `Folder/Title` path picks
 * the note in that notebook; ties go to the linking note's own notebook, then to the most recently
 * edited note. Trashed notes never match. An empty title is a link within the same note.
 */
export function resolveWikiTarget(
  target: string,
  notes: readonly NoteMeta[],
  opts: { from?: NoteMeta; notebooks?: readonly NotebookMeta[]; noteId?: string } = {},
): LinkResolution | null {
  const { title, page } = parseWikiTarget(target);
  const pageIndex = (n: NoteMeta) => (page ? Math.min(page, Math.max(1, n.pageIds.length)) - 1 : undefined);
  const live = notes.filter((n) => n.trashedAt == null);
  if (opts.noteId) {
    const byId = live.find((n) => n.id === opts.noteId);
    if (byId) return { note: byId, pageIndex: pageIndex(byId) };
  }
  if (!title) return opts.from ? { note: opts.from, pageIndex: pageIndex(opts.from) } : null;
  const want = normalizeTitle(title);
  let candidates = live.filter((n) => normalizeTitle(n.title) === want);
  if (!candidates.length && title.includes('/')) {
    const parts = title.split('/').map((p) => p.trim()).filter(Boolean);
    const last = normalizeTitle(parts[parts.length - 1] ?? '');
    const folders = parts.slice(0, -1).map(normalizeTitle);
    const nbs = opts.notebooks ?? [];
    candidates = live.filter((n) => {
      if (normalizeTitle(n.title) !== last) return false;
      const path = notebookPath(nbs.find((b) => b.id === n.notebookId), nbs).map(normalizeTitle);
      return folders.every((f, i) => path[path.length - folders.length + i] === f);
    });
  }
  if (!candidates.length) return null;
  const from = opts.from;
  candidates.sort((a, b) => {
    const sa = from && a.notebookId === from.notebookId ? 1 : 0;
    const sb = from && b.notebookId === from.notebookId ? 1 : 0;
    return sb - sa || (b.daily ? 1 : 0) - (a.daily ? 1 : 0) || b.updatedAt - a.updatedAt;
  });
  const note = candidates[0]!;
  return { note, pageIndex: pageIndex(note) };
}

// ---- Rename ----------------------------------------------------------------------------------

/** Rewrites `[[Old…]]` links in text to point at a renamed note, keeping `#Page` and aliases. */
export function renameLinksInText(text: string, oldTitle: string, newTitle: string): string {
  if (!text.includes('[[')) return text;
  const old = normalizeTitle(oldTitle);
  const clean = newTitle.replace(/[[\]|#\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!old || !clean) return text;
  return text.replace(WIKI_RE, (m, bang: string, inner: string) => {
    const bar = inner.indexOf('|');
    const target = bar >= 0 ? inner.slice(0, bar) : inner;
    const alias = bar >= 0 ? inner.slice(bar) : '';
    const hash = target.indexOf('#');
    const title = hash >= 0 ? target.slice(0, hash) : target;
    const sub = hash >= 0 ? target.slice(hash) : '';
    const slash = title.lastIndexOf('/');
    const last = slash >= 0 ? title.slice(slash + 1) : title;
    if (normalizeTitle(last) !== old && normalizeTitle(title) !== old) return m;
    const prefix = normalizeTitle(title) === old ? '' : title.slice(0, slash + 1);
    return `${bang}[[${prefix}${clean}${sub.trimEnd()}${alias}]]`;
  });
}

/**
 * Applies a rename to one page: typed text, recognized handwriting and ink links. Returns the
 * same page object when nothing referred to the old title.
 */
export function renameLinksInPage(page: PageInk, oldTitle: string, newTitle: string, renamedNoteId?: string): PageInk {
  let changed = false;
  const texts = page.texts?.map((t) => {
    const text = renameLinksInText(t.text, oldTitle, newTitle);
    if (text === t.text) return t;
    changed = true;
    return { ...t, text };
  });
  let recognizedText = page.recognizedText;
  if (recognizedText) {
    const r = renameLinksInText(recognizedText, oldTitle, newTitle);
    if (r !== recognizedText) { recognizedText = r; changed = true; }
  }
  const links = page.links?.map((l) => {
    const { title, subpath } = parseWikiTarget(l.target);
    const hit = (renamedNoteId && l.noteId === renamedNoteId) || normalizeTitle(title) === normalizeTitle(oldTitle);
    if (!hit) return l;
    const target = `${newTitle.replace(/[[\]|#\n]+/g, ' ').trim()}${subpath ? `#${subpath}` : ''}`;
    if (target === l.target) return l;
    changed = true;
    return { ...l, target };
  });
  if (!changed) return page;
  const next: PageInk = { ...page };
  if (texts) next.texts = texts;
  if (recognizedText !== undefined) next.recognizedText = recognizedText;
  if (links) next.links = links;
  return next;
}

// ---- Occurrences -----------------------------------------------------------------------------

/** Where a link was found. */
export type LinkSource = 'text' | 'handwriting' | 'ink';

export interface LinkOccurrence {
  target: string;
  title: string;
  page?: number;
  /** Page of the linking note (0-based). */
  pageIndex: number;
  source: LinkSource;
  /** The line around the link, links shown as their labels. */
  context: string;
  /** Text box (typed text) or ink link id. */
  itemId?: string;
  /** For ink links: the note the link was made to. */
  noteId?: string;
}

/** The line of `text` containing [at], trimmed to about [max] characters around it. */
export function contextLine(text: string, at: number, max = 160): string {
  const start = text.lastIndexOf('\n', at - 1) + 1;
  const endNl = text.indexOf('\n', at);
  const end = endNl < 0 ? text.length : endNl;
  let line = text.slice(start, end);
  let pos = at - start;
  if (line.length > max) {
    const from = Math.max(0, Math.min(pos - max / 2, line.length - max));
    line = (from > 0 ? '…' : '') + line.slice(from, from + max) + (from + max < line.length ? '…' : '');
    pos = 0;
  }
  return stripWikiLinks(line).replace(/^\s*(#{1,6}\s+|[-*•]\s+(\[[ xX]\]\s+)?)/, '').replace(/\s+/g, ' ').trim();
}

/** Every link a note's pages make: typed `[[…]]`, recognized handwriting `[[…]]` and ink links. */
export function noteLinkOccurrences(pages: readonly PageInk[]): LinkOccurrence[] {
  const out: LinkOccurrence[] = [];
  pages.forEach((p, pageIndex) => {
    for (const t of p.texts ?? []) {
      for (const l of parseWikiLinks(t.text)) out.push({ target: l.target, title: l.title, page: l.page, pageIndex, source: 'text', context: contextLine(t.text, l.start), itemId: t.id });
    }
    if (p.recognizedText) {
      for (const l of parseWikiLinks(p.recognizedText)) out.push({ target: l.target, title: l.title, page: l.page, pageIndex, source: 'handwriting', context: contextLine(p.recognizedText, l.start) });
    }
    const strokeIds = new Set(p.strokes.map((s) => s.id));
    for (const k of p.links ?? []) {
      if (!k.strokeIds.some((id) => strokeIds.has(id))) continue; // its ink was erased
      const parts = parseWikiTarget(k.target);
      out.push({ target: k.target, title: parts.title, page: parts.page, pageIndex, source: 'ink', context: '', itemId: k.id, noteId: k.noteId });
    }
  });
  return out;
}

/** Ink links whose ink is still on the page. */
export function liveInkLinks(page: PageInk): InkLink[] {
  if (!page.links?.length) return [];
  const ids = new Set(page.strokes.map((s) => s.id));
  return page.links.filter((l) => l.strokeIds.some((id) => ids.has(id)));
}

// ---- Mentions --------------------------------------------------------------------------------

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ranges of text covered by `[[links]]`. */
function linkRanges(text: string): [number, number][] {
  return parseWikiLinks(text).map((l) => [l.start, l.end]);
}

/**
 * Where a note title appears as a whole word or phrase (case-insensitive) outside any link.
 * Titles shorter than three characters never count: they would match everywhere.
 */
export function findMentions(text: string, title: string): { start: number; end: number }[] {
  const t = title.trim();
  if (t.length < 3 || !text) return [];
  const re = new RegExp(`(^|[^\\p{L}\\p{N}])(${escapeRe(t).replace(/\s+/g, '\\s+')})(?=$|[^\\p{L}\\p{N}])`, 'giu');
  const ranges = linkRanges(text);
  const out: { start: number; end: number }[] = [];
  for (const m of text.matchAll(re)) {
    const start = m.index! + m[1]!.length;
    const end = start + m[2]!.length;
    if (ranges.some(([a, b]) => start < b && end > a)) continue;
    out.push({ start, end });
  }
  return out;
}

/** Wraps the first unlinked mention of [title] in `[[…]]`. Returns null when there is none. */
export function linkFirstMention(text: string, title: string): string | null {
  const m = findMentions(text, title)[0];
  if (!m) return null;
  const found = text.slice(m.start, m.end);
  const inner = normalizeTitle(found) === normalizeTitle(title) ? found : `${title}|${found}`;
  return `${text.slice(0, m.start)}[[${inner}]]${text.slice(m.end)}`;
}

// ---- Handwriting -----------------------------------------------------------------------------

/** One recognized line of handwriting with the strokes that wrote it. */
export interface RecognizedLine {
  text: string;
  strokeIds: string[];
}

/**
 * Turns recognized handwriting that contains `[[…]]` into ink links over the strokes of that line,
 * so the writing itself becomes tappable. Lines already carrying a link are left alone.
 */
export function inkLinksFromRecognition(page: PageInk, lines: readonly RecognizedLine[], opts: { now: number; newId: () => string; resolve?: (target: string) => string | undefined }): InkLink[] {
  const existing = new Set((page.links ?? []).flatMap((l) => l.strokeIds));
  const out: InkLink[] = [];
  for (const line of lines) {
    const links = parseWikiLinks(line.text);
    if (!links.length || !line.strokeIds.length) continue;
    if (line.strokeIds.some((id) => existing.has(id))) continue;
    // A line with one link carries it; with several, the first wins (the rest stay text links).
    const l = links[0]!;
    out.push({ id: opts.newId(), strokeIds: [...line.strokeIds], target: l.target, noteId: opts.resolve?.(l.target), createdAt: opts.now });
  }
  return out;
}


// ---- Suggestions -----------------------------------------------------------------------------

const fold = (s: string) => s.normalize('NFD').replace(/\p{Mn}+/gu, '').toLowerCase();

/**
 * How well [query] matches [text] for link autocomplete; negative when it doesn't. Substrings win
 * (more at the start or at a word start), then in-order letters ("bio lb" → "Biology lab").
 */
export function fuzzyScore(query: string, text: string): number {
  const q = fold(query).trim();
  const t = fold(text);
  if (!q) return 1;
  const at = t.indexOf(q);
  if (at >= 0) {
    const wordStart = at === 0 || /[^\p{L}\p{N}]/u.test(t[at - 1]!);
    return 100 + (at === 0 ? 40 : wordStart ? 20 : 0) - at * 0.3 - (t.length - q.length) * 0.05;
  }
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    if (ch === ' ') { run = 0; continue; }
    const found = t.indexOf(ch, ti);
    if (found < 0) return -1;
    run = found === ti ? run + 1 : 1;
    const wordStart = found === 0 || /[^\p{L}\p{N}]/u.test(t[found - 1]!);
    score += 1 + run * 0.6 + (wordStart ? 2 : 0) - Math.min(3, (found - ti) * 0.08);
    ti = found + 1;
  }
  return score;
}

/** Notes for `[[…` autocomplete: best fuzzy title matches, ties to the most recently edited. */
export function suggestNotes(query: string, notes: readonly NoteMeta[], opts: { limit?: number; exclude?: string } = {}): NoteMeta[] {
  return notes
    .filter((n) => n.trashedAt == null && n.id !== opts.exclude)
    .map((n) => ({ n, s: fuzzyScore(query, n.title) }))
    .filter((x) => x.s >= 0)
    .sort((a, b) => b.s - a.s || b.n.updatedAt - a.n.updatedAt)
    .slice(0, opts.limit ?? 8)
    .map((x) => x.n);
}

export type LinkTrigger =
  | { kind: 'note'; query: string; start: number }
  | { kind: 'page'; title: string; query: string; start: number }
  | { kind: 'tag'; query: string; start: number };

/**
 * What the user is typing at the caret: an open `[[link` (with the note part and, after `#`, the
 * page part) or a `#tag`. Null when neither.
 */
export function linkTrigger(textBefore: string): LinkTrigger | null {
  const m = /\[\[([^[\]\n|]*)$/.exec(textBefore);
  if (m) {
    const inner = m[1]!;
    const hash = inner.indexOf('#');
    if (hash >= 0) return { kind: 'page', title: inner.slice(0, hash), query: inner.slice(hash + 1), start: m.index };
    return { kind: 'note', query: inner, start: m.index };
  }
  const t = /(^|[\s(,;])#([\p{L}\p{N}_/-]*)$/u.exec(textBefore);
  if (t) return { kind: 'tag', query: t[2]!, start: t.index + t[1]!.length };
  return null;
}
