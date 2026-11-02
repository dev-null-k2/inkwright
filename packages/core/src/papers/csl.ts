import { normalizeDoi, type RefDate, type RefName, type RefType, type Reference } from './model.ts';

/**
 * CSL-JSON (Zotero "Export → CSL JSON", Better CSL JSON, Pandoc `--to csljson`) ↔ references.
 * CSL is already our model's shape, so this is mostly renaming; dates accept `date-parts`, `raw`
 * and `literal`, and unknown CSL types fall back to `document`.
 */

type CslName = { family?: string; given?: string; literal?: string; 'non-dropping-particle'?: string; 'dropping-particle'?: string; suffix?: string };
type CslDate = { 'date-parts'?: (number | string)[][]; raw?: string; literal?: string; season?: string };
export type CslItem = Record<string, unknown> & { id?: string | number; type?: string };

const KNOWN: ReadonlySet<string> = new Set<RefType>(['article-journal', 'article-magazine', 'article-newspaper', 'book', 'chapter', 'paper-conference', 'thesis', 'report', 'webpage', 'manuscript', 'dataset', 'software', 'document']);
const ALIAS: Record<string, RefType> = { article: 'article-journal', 'post-weblog': 'webpage', post: 'webpage', 'entry-encyclopedia': 'chapter', 'entry-dictionary': 'chapter', 'entry': 'chapter', speech: 'paper-conference', standard: 'report', patent: 'report', 'review-book': 'article-journal', review: 'article-journal', interview: 'document', 'personal_communication': 'document', legislation: 'document', legal_case: 'document' };

function str(v: unknown): string | undefined {
  if (v == null) return undefined;
  if (typeof v === 'string') return v.trim() || undefined;
  if (typeof v === 'number') return String(v);
  return undefined;
}

function cslName(n: CslName): RefName {
  const out: RefName = {};
  if (n.literal) out.literal = n.literal;
  if (n.family) out.family = n.family;
  if (n.given) out.given = n.given;
  const particle = [n['dropping-particle'], n['non-dropping-particle']].filter(Boolean).join(' ');
  if (particle) out.particle = particle;
  if (n.suffix) out.suffix = n.suffix;
  return out;
}

function cslDate(d: CslDate | undefined): RefDate | undefined {
  if (!d || typeof d !== 'object') return undefined;
  const parts = d['date-parts']?.[0];
  if (parts?.length && parts[0] != null && parts[0] !== '') {
    const out: RefDate = { year: Number(parts[0]) };
    if (parts[1] != null && parts[1] !== '') out.month = Number(parts[1]);
    if (parts[2] != null && parts[2] !== '') out.day = Number(parts[2]);
    return out;
  }
  const raw = d.raw ?? d.literal;
  if (!raw) return undefined;
  const iso = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(raw);
  if (iso) return { year: Number(iso[1]), ...(iso[2] ? { month: Number(iso[2]) } : {}), ...(iso[3] ? { day: Number(iso[3]) } : {}) };
  return { literal: raw };
}

/** One CSL-JSON item → a reference. */
export function cslToReference(item: CslItem, fallbackId: string): Reference {
  const t = String(item.type ?? 'document');
  const type: RefType = KNOWN.has(t) ? (t as RefType) : ALIAS[t] ?? 'document';
  const id = str(item['citation-key']) ?? str(item.citationKey) ?? str(item.id) ?? fallbackId;
  const r: Reference = { id, type };
  const set = <K extends keyof Reference>(k: K, v: Reference[K] | undefined) => { if (v !== undefined && v !== '') r[k] = v; };
  set('title', str(item.title));
  if (Array.isArray(item.author)) r.author = (item.author as CslName[]).map(cslName);
  if (Array.isArray(item.editor)) r.editor = (item.editor as CslName[]).map(cslName);
  set('issued', cslDate(item.issued as CslDate));
  set('accessed', cslDate(item.accessed as CslDate));
  set('containerTitle', str(item['container-title']));
  set('containerTitleShort', str(item['container-title-short']) ?? str(item['journalAbbreviation']));
  set('volume', str(item.volume));
  set('issue', str(item.issue));
  set('page', str(item.page)?.replace(/\s*[–—-]+\s*/g, '–'));
  set('edition', str(item.edition));
  set('publisher', str(item.publisher));
  set('publisherPlace', str(item['publisher-place']));
  set('genre', str(item.genre));
  set('number', str(item.number));
  set('doi', normalizeDoi(str(item.DOI) ?? str(item.doi)));
  set('url', str(item.URL) ?? str(item.url));
  set('isbn', str(item.ISBN));
  set('issn', str(item.ISSN));
  set('abstract', str(item.abstract));
  const kw = str(item.keyword);
  if (kw) r.keywords = kw.split(/[;,]\s*/).filter(Boolean);
  set('note', str(item.note));
  set('language', str(item.language));
  return r;
}

/** Parses CSL-JSON text: an array of items, or `{ items: [...] }`. */
export function parseCslJson(text: string): { references: Reference[]; errors: { line: number; message: string }[] } {
  let data: unknown;
  try { data = JSON.parse(text); } catch (e) { return { references: [], errors: [{ line: 1, message: `Not valid JSON: ${(e as Error).message}` }] }; }
  const items = Array.isArray(data) ? data : Array.isArray((data as { items?: unknown })?.items) ? (data as { items: unknown[] }).items : null;
  if (!items) return { references: [], errors: [{ line: 1, message: 'Expected a CSL-JSON array of items' }] };
  const errors: { line: number; message: string }[] = [];
  const references: Reference[] = [];
  items.forEach((it, i) => {
    if (!it || typeof it !== 'object') { errors.push({ line: 1, message: `Item ${i + 1} is not an object` }); return; }
    references.push(cslToReference(it as CslItem, `ref${i + 1}`));
  });
  return { references, errors };
}

function toCslName(n: RefName): CslName {
  const out: CslName = {};
  if (n.literal) out.literal = n.literal;
  if (n.family) out.family = n.family;
  if (n.given) out.given = n.given;
  if (n.particle) out['non-dropping-particle'] = n.particle;
  if (n.suffix) out.suffix = n.suffix;
  return out;
}

function toCslDate(d: RefDate | undefined): CslDate | undefined {
  if (!d) return undefined;
  if (d.year == null) return d.literal ? { literal: d.literal } : undefined;
  return { 'date-parts': [[d.year, ...(d.month != null ? [d.month, ...(d.day != null ? [d.day] : [])] : [])]] };
}

/** A reference → a CSL-JSON item (for frontmatter and export). */
export function referenceToCsl(r: Reference): CslItem {
  const item: CslItem = { id: r.id, type: r.type };
  const put = (k: string, v: unknown) => { if (v !== undefined && v !== '' && !(Array.isArray(v) && !v.length)) item[k] = v; };
  put('title', r.title);
  put('author', r.author?.map(toCslName));
  put('editor', r.editor?.map(toCslName));
  put('issued', toCslDate(r.issued));
  put('accessed', toCslDate(r.accessed));
  put('container-title', r.containerTitle);
  put('container-title-short', r.containerTitleShort);
  put('volume', r.volume);
  put('issue', r.issue);
  put('page', r.page);
  put('edition', r.edition);
  put('publisher', r.publisher);
  put('publisher-place', r.publisherPlace);
  put('genre', r.genre);
  put('number', r.number);
  put('DOI', r.doi);
  put('URL', r.url);
  put('ISBN', r.isbn);
  put('ISSN', r.issn);
  put('abstract', r.abstract);
  put('keyword', r.keywords?.join(', '));
  put('note', r.note);
  put('language', r.language);
  return item;
}

/** Detects the format of an import file from its text. */
export function detectReferenceFormat(text: string): 'bibtex' | 'csl-json' | null {
  const t = text.trimStart();
  if (t.startsWith('[') || t.startsWith('{')) return 'csl-json';
  if (/@[A-Za-z]+\s*[{(]/.test(t)) return 'bibtex';
  return null;
}
