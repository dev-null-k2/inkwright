/**
 * The paper workbench's reference model: one shape for everything Zotero, BibTeX and CSL-JSON can
 * describe that a citation style needs. It is close to CSL-JSON (the format Zotero, Pandoc and
 * citeproc share), so CSL items round-trip without loss of the fields we format, and BibTeX maps
 * onto it with the usual conventions (see bibtex.ts).
 */

/** A person (or an organisation, as `literal`). */
export interface RefName {
  family?: string;
  given?: string;
  /** "van", "de la" — kept with the family name when sorting is not involved. */
  particle?: string;
  /** "Jr.", "III". */
  suffix?: string;
  /** Institutional or single-field names ("World Health Organization"), never split. */
  literal?: string;
}

export interface RefDate {
  year?: number;
  month?: number;
  day?: number;
  /** Free text when the source gave no parseable date ("in press", "Spring 2021"). */
  literal?: string;
}

/** CSL item types we format specifically; anything else formats like `document`. */
export type RefType =
  | 'article-journal'
  | 'article-magazine'
  | 'article-newspaper'
  | 'book'
  | 'chapter'
  | 'paper-conference'
  | 'thesis'
  | 'report'
  | 'webpage'
  | 'manuscript'
  | 'dataset'
  | 'software'
  | 'document';

export interface Reference {
  /** The citation key (`[@key]`): BibTeX key, Zotero/Better BibTeX key or CSL `id`. */
  id: string;
  type: RefType;
  title?: string;
  author?: RefName[];
  editor?: RefName[];
  issued?: RefDate;
  /** Journal, book (for chapters), proceedings or website name. */
  containerTitle?: string;
  /** Short journal name (IEEE prefers it). */
  containerTitleShort?: string;
  volume?: string;
  issue?: string;
  /** "123-145" or "e1001" (an article number). */
  page?: string;
  edition?: string;
  publisher?: string;
  publisherPlace?: string;
  /** Thesis kind ("Doctoral dissertation", "Master's thesis") or report kind. */
  genre?: string;
  /** Report or standard number. */
  number?: string;
  /** Degree-granting university for theses (when not in `publisher`). */
  institution?: string;
  doi?: string;
  url?: string;
  isbn?: string;
  issn?: string;
  abstract?: string;
  keywords?: string[];
  note?: string;
  accessed?: RefDate;
  language?: string;
}

/** Normalises a DOI from any of its common spellings (URL, `doi:` prefix, upper case). */
export function normalizeDoi(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const m = /10\.\d{4,9}\/\S+/i.exec(decodeURIComponentSafe(raw.trim()));
  return m ? m[0].replace(/[.,;)\]}>]+$/, '').toLowerCase() : undefined;
}

function decodeURIComponentSafe(s: string): string {
  try { return decodeURIComponent(s); } catch { return s; }
}

/** The family name used for sorting and in-text citations ("van Dijk", or the literal name). */
export function familyName(n: RefName): string {
  if (n.literal) return n.literal;
  return [n.particle, n.family].filter(Boolean).join(' ') || n.given || '';
}

/** First author's family name, or the title when there are no authors (in-text label, sorting). */
export function leadName(r: Reference): string {
  const a = r.author?.[0] ?? r.editor?.[0];
  return a ? familyName(a) : (r.title ?? r.id);
}

export function refYear(r: Reference): string {
  return r.issued?.year != null ? String(r.issued.year) : r.issued?.literal ?? 'n.d.';
}
