import { referenceToCsl, cslToReference, type CslItem } from './csl.ts';
import { familyName, normalizeDoi, refYear, type Reference } from './model.ts';

/**
 * Citations in typed text, Pandoc style — `[@smith2020]`, `[@smith2020, p. 4; @lee2019]`,
 * `[-@smith2020]` (suppress author) — and what the editor needs around them: where they are,
 * which references a note cites in order of first use, autocomplete while typing `[@`, and the
 * metadata a paper note keeps in its front matter (`NoteMeta.properties`).
 */

export interface CitationItem {
  key: string;
  /** Text after the key inside the item ("p. 4", "chap. 2"). */
  locator?: string;
  suppressAuthor?: boolean;
}

export interface Citation {
  /** Offsets of the whole `[...]` group in the text. */
  start: number;
  end: number;
  items: CitationItem[];
}

/** Citation keys: Pandoc's rule — a letter, digit or `_` first, then word characters and `:.#$%&-+?<>~/` not at the end. */
const KEY = String.raw`[\p{L}\p{N}_](?:[\p{L}\p{N}_:.#$%&\-+?<>~/]*[\p{L}\p{N}_])?`;
const GROUP = new RegExp(String.raw`\[((?:[^\[\]]*?-?@${KEY}[^\[\]]*?)+)\]`, 'gu');
const ITEM = new RegExp(String.raw`(-?)@(${KEY})`, 'u');

/** All bracketed citation groups in `text`. Email addresses and `[[wiki links]]` are not citations. */
export function parseCitations(text: string): Citation[] {
  const out: Citation[] = [];
  for (const m of text.matchAll(GROUP)) {
    const start = m.index!;
    if (text[start - 1] === '[' || text[start + m[0].length] === ']') continue; // [[…]]
    const items: CitationItem[] = [];
    for (const part of m[1]!.split(';')) {
      const im = ITEM.exec(part);
      if (!im) continue;
      // `name@host` inside brackets is an email, not a citation.
      const before = part.slice(0, im.index);
      if (/[\p{L}\p{N}]$/u.test(before)) continue;
      const locator = part.slice(im.index + im[0].length).replace(/^\s*,\s*/, '').trim();
      items.push({ key: im[2]!, ...(locator ? { locator } : {}), ...(im[1] ? { suppressAuthor: true } : {}) });
    }
    if (items.length) out.push({ start, end: start + m[0].length, items });
  }
  return out;
}

/** Keys cited in these texts, in order of first citation (IEEE numbering), without repeats. */
export function citedKeys(texts: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of texts) for (const c of parseCitations(t)) for (const it of c.items) if (!seen.has(it.key)) { seen.add(it.key); out.push(it.key); }
  return out;
}

export interface CiteTrigger {
  /** Offset of the `@` being completed. */
  at: number;
  query: string;
}

/**
 * Whether the caret is completing a citation key: inside `[@…` or after `; @` within an open
 * citation bracket. `textBefore` is the text up to the caret.
 */
export function citeTrigger(textBefore: string): CiteTrigger | null {
  const open = textBefore.lastIndexOf('[');
  if (open < 0 || textBefore.lastIndexOf(']') > open || textBefore[open - 1] === '[') return null;
  const inside = textBefore.slice(open + 1);
  const m = /(?:^|;\s*|\s)-?@([\p{L}\p{N}_:.#$%&\-+?<>~/]*)$/u.exec(inside);
  if (!m) return null;
  return { at: textBefore.length - m[1]!.length - 1, query: m[1]! };
}

/** References matching a partial key, author or title (best first). */
export function suggestReferences(query: string, refs: readonly Reference[], limit = 8): Reference[] {
  const q = query.trim().toLowerCase();
  if (!q) return refs.slice(0, limit);
  const scored = refs.map((r) => {
    const key = r.id.toLowerCase();
    const authors = (r.author ?? []).map((a) => familyName(a).toLowerCase());
    const title = (r.title ?? '').toLowerCase();
    let s = 0;
    if (key === q) s = 100;
    else if (key.startsWith(q)) s = 80 - key.length / 100;
    else if (authors.some((a) => a.startsWith(q))) s = 60;
    else if (key.includes(q)) s = 40;
    else if (title.split(/\W+/).some((w) => w.startsWith(q))) s = 30;
    else if (refYear(r) === q) s = 20;
    return { r, s };
  }).filter((x) => x.s > 0);
  return scored.sort((a, b) => b.s - a.s || a.r.id.localeCompare(b.r.id)).slice(0, limit).map((x) => x.r);
}

/** A short label for menus and hover cards: "Smith & Lee (2020) — Title". */
export function referenceLabel(r: Reference): string {
  const a = r.author ?? [];
  const who = a.length === 0 ? '' : a.length === 1 ? familyName(a[0]!) : a.length === 2 ? `${familyName(a[0]!)} & ${familyName(a[1]!)}` : `${familyName(a[0]!)} et al.`;
  return `${who ? `${who} ` : ''}(${refYear(r)})${r.title ? ` — ${r.title}` : ''}`;
}

// ---- Paper notes ---------------------------------------------------------------------------------

/** Tag every paper note carries (the "Library of papers" is this tag plus the Papers notebook). */
export const PAPER_TAG = 'paper';

/**
 * Front matter of a paper note: flat, readable fields (they become YAML properties on Obsidian
 * export) plus the full CSL item, so nothing from the import is lost.
 */
export function referenceProperties(r: Reference): Record<string, unknown> {
  const p: Record<string, unknown> = { citekey: r.id, 'reference-type': r.type };
  if (r.author?.length) p.authors = r.author.map((a) => (a.literal ? a.literal : [a.given, a.particle, a.family, a.suffix].filter(Boolean).join(' ')));
  if (r.issued?.year != null) p.year = r.issued.year;
  if (r.containerTitle) p.container = r.containerTitle;
  if (r.doi) p.doi = r.doi;
  if (r.url) p.url = r.url;
  p.csl = referenceToCsl(r);
  return p;
}

/** The reference stored in a paper note's properties, if it has one. */
export function referenceFromProperties(props: Record<string, unknown> | undefined): Reference | null {
  if (!props || typeof props !== 'object') return null;
  const csl = props.csl as CslItem | undefined;
  if (csl && typeof csl === 'object') return cslToReference(csl, String(props.citekey ?? csl.id ?? 'ref'));
  return null;
}

/** Makes citation keys unique against existing ones ("smith2020" → "smith2020a"), like Better BibTeX. */
export function uniqueKey(key: string, taken: ReadonlySet<string>): string {
  if (!taken.has(key)) return key;
  for (let i = 0; i < 26 * 27; i++) {
    const suffix = i < 26 ? String.fromCharCode(97 + i) : `${String.fromCharCode(97 + Math.floor(i / 26) - 1)}${String.fromCharCode(97 + (i % 26))}`;
    if (!taken.has(key + suffix)) return key + suffix;
  }
  return `${key}-${taken.size}`;
}

/** Whether two references are the same work (same DOI, or same normalized title and year). */
export function sameWork(a: Reference, b: Reference): boolean {
  if (a.doi && b.doi) return normalizeDoi(a.doi) === normalizeDoi(b.doi);
  const t = (r: Reference) => (r.title ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return !!t(a) && t(a) === t(b) && refYear(a) === refYear(b);
}
