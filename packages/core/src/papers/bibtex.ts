import { decodeLatex, encodeLatex } from './latex.ts';
import { normalizeDoi, type RefDate, type RefName, type RefType, type Reference } from './model.ts';

/**
 * A BibTeX / BibLaTeX reader and writer for what Zotero, Better BibTeX, Mendeley, JabRef and
 * publishers export: `@type{key, field = {…} | "…" | 123 | macro # "…"}` entries, `@string`
 * macros (and the standard month macros), `@comment`/`@preamble` skipped, `%` comment lines
 * between entries, nested braces, and LaTeX in values (latex.ts). Names follow BibTeX's own rules
 * ("First von Last", "von Last, First", "von Last, Jr, First"; `{Braced Names}` stay whole).
 *
 * Errors never abort an import: an unreadable entry is reported in `errors` and the rest load.
 */

export interface BibEntry {
  type: string;
  key: string;
  /** Lower-cased field names → raw values (macros expanded, LaTeX not yet decoded). */
  fields: Record<string, string>;
}

export interface BibParseResult {
  entries: BibEntry[];
  errors: { line: number; message: string }[];
}

const MONTHS: Record<string, string> = { jan: '1', feb: '2', mar: '3', apr: '4', may: '5', jun: '6', jul: '7', aug: '8', sep: '9', oct: '10', nov: '11', dec: '12' };

/** Parses BibTeX source into raw entries. */
export function parseBibtexEntries(src: string): BibParseResult {
  const macros: Record<string, string> = { ...MONTHS };
  const entries: BibEntry[] = [];
  const errors: BibParseResult['errors'] = [];
  let i = 0;
  const n = src.length;
  const lineAt = (pos: number) => src.slice(0, pos).split('\n').length;

  while (i < n) {
    const at = src.indexOf('@', i);
    if (at < 0) break;
    i = at + 1;
    const typeMatch = /^\s*([A-Za-z]+)\s*([{(])/.exec(src.slice(i, i + 64));
    if (!typeMatch) continue;
    const type = typeMatch[1]!.toLowerCase();
    const open = typeMatch[2]!;
    const close = open === '{' ? '}' : ')';
    i += typeMatch[0].length;
    const start = at;
    // Find the matching close, respecting nested braces and quoted strings.
    let depth = 1;
    let j = i;
    let inQuote = false;
    for (; j < n && depth > 0; j++) {
      const c = src[j]!;
      if (c === '\\') { j++; continue; }
      if (c === '"' && open === '{' && depth === 1) inQuote = !inQuote;
      else if (!inQuote && c === '{') depth++;
      else if (!inQuote && c === '}') depth--;
      else if (!inQuote && open === '(' && c === ')' && depth === 1) { depth = 0; break; }
      if (depth === 0) break;
    }
    if (depth !== 0 && !(open === '(' && src[j] === ')')) {
      errors.push({ line: lineAt(start), message: `Unclosed @${type} entry` });
      break;
    }
    const body = src.slice(i, j);
    i = j + 1;
    void close;
    if (type === 'comment' || type === 'preamble') continue;
    try {
      if (type === 'string') {
        const [name, value] = splitAssignment(body);
        if (name) macros[name.toLowerCase()] = parseValue(value, macros);
        continue;
      }
      const comma = topLevelIndex(body, ',');
      const key = (comma < 0 ? body : body.slice(0, comma)).trim();
      if (!key) throw new Error('missing citation key');
      const fields: Record<string, string> = {};
      if (comma >= 0) {
        for (const part of splitTopLevel(body.slice(comma + 1), ',')) {
          if (!part.trim()) continue;
          const [name, value] = splitAssignment(part);
          if (!name) throw new Error(`can't read “${part.trim().slice(0, 40)}”`);
          fields[name.toLowerCase()] = parseValue(value, macros);
        }
      }
      entries.push({ type, key, fields });
    } catch (e) {
      errors.push({ line: lineAt(start), message: `@${type}: ${(e as Error).message}` });
    }
  }
  return { entries, errors };
}

function splitAssignment(s: string): [string, string] {
  const eq = topLevelIndex(s, '=');
  if (eq < 0) return ['', ''];
  return [s.slice(0, eq).trim(), s.slice(eq + 1).trim()];
}

/** Index of `ch` outside braces and quotes, or -1. */
function topLevelIndex(s: string, ch: string): number {
  let depth = 0;
  let q = false;
  for (let k = 0; k < s.length; k++) {
    const c = s[k]!;
    if (c === '\\') { k++; continue; }
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '"' && depth === 0) q = !q;
    else if (c === ch && depth === 0 && !q) return k;
  }
  return -1;
}

function splitTopLevel(s: string, ch: string): string[] {
  const out: string[] = [];
  let rest = s;
  for (;;) {
    const k = topLevelIndex(rest, ch);
    if (k < 0) { out.push(rest); return out; }
    out.push(rest.slice(0, k));
    rest = rest.slice(k + 1);
  }
}

/** A field value: `{…}`, `"…"`, a number or a macro, joined with `#`. */
function parseValue(raw: string, macros: Record<string, string>): string {
  return splitTopLevel(raw, '#').map((p) => {
    const t = p.trim();
    if (t.startsWith('{') && t.endsWith('}')) return t.slice(1, -1);
    if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1);
    if (/^\d+$/.test(t)) return t;
    const m = macros[t.toLowerCase()];
    if (m != null) return m;
    if (!t) return '';
    throw new Error(`unknown macro “${t}”`);
  }).join('');
}

// ---- Names -------------------------------------------------------------------------------------

/** Splits a BibTeX name list on top-level " and ". */
export function splitBibNames(value: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  const words = value.split(/(\s+)/);
  for (const w of words) {
    for (const c of w) { if (c === '{') depth++; else if (c === '}') depth--; }
    if (depth === 0 && /^and$/i.test(w)) { out.push(cur.trim()); cur = ''; continue; }
    cur += w;
  }
  if (cur.trim()) out.push(cur.trim());
  return out.filter(Boolean);
}

/** Words at brace depth 0 (a braced group is one word). */
function nameWords(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const c of s) {
    if (c === '{') depth++;
    if (c === '}') depth--;
    if (/\s/.test(c) && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += c;
  }
  if (cur) out.push(cur);
  return out;
}

/** A word starts lower case (BibTeX's "von" test), looking through braces and accent commands. */
function isLowerWord(w: string): boolean {
  if (w.startsWith('{') && !w.startsWith('{\\')) return false; // {Braced} words are never "von"
  const plain = decodeLatex(w);
  const first = [...plain].find((c) => /\p{L}/u.test(c));
  return !!first && first === first.toLowerCase() && first !== first.toUpperCase();
}

/** `{…}` where the first brace closes at the very end: a name BibTeX must not split. */
function isSingleGroup(s: string): boolean {
  if (!s.startsWith('{')) return false;
  let depth = 0;
  for (let k = 0; k < s.length; k++) {
    if (s[k] === '\\') { k++; continue; }
    if (s[k] === '{') depth++;
    else if (s[k] === '}' && --depth === 0) return k === s.length - 1;
  }
  return false;
}

/** Parses one BibTeX name into its parts. */
export function parseBibName(raw: string): RefName {
  const s = raw.trim();
  if (isSingleGroup(s)) return { literal: decodeLatex(s.slice(1, -1)) };
  const parts = splitTopLevel(s, ',').map((p) => p.trim());
  let first: string[] = [], von: string[] = [], last: string[] = [], jr: string[] = [];
  if (parts.length === 1) {
    const w = nameWords(parts[0]!);
    if (w.length === 1) return /^\{.*\}$/.test(w[0]!) ? { literal: decodeLatex(w[0]!) } : { family: decodeLatex(w[0]!) };
    // First = up to the first lower-case word (but the last word is always Last).
    let k = 0;
    while (k < w.length - 1 && !isLowerWord(w[k]!)) k++;
    first = w.slice(0, k);
    let v = k;
    // von = the lower-case run; Last = the rest (the last lower-case word ends von).
    let lastLower = -1;
    for (let m = k; m < w.length - 1; m++) if (isLowerWord(w[m]!)) lastLower = m;
    if (lastLower >= k) { von = w.slice(k, lastLower + 1); v = lastLower + 1; }
    last = w.slice(v);
  } else {
    const vl = nameWords(parts[0]!);
    let lastLower = -1;
    for (let m = 0; m < vl.length - 1; m++) if (isLowerWord(vl[m]!)) lastLower = m;
    von = vl.slice(0, lastLower + 1);
    last = vl.slice(lastLower + 1);
    if (parts.length === 2) first = nameWords(parts[1]!);
    else { jr = nameWords(parts[1]!); first = nameWords(parts.slice(2).join(' ')); }
  }
  const out: RefName = {};
  const j = (ws: string[]) => decodeLatex(ws.join(' '));
  if (last.length) out.family = j(last);
  if (first.length) out.given = j(first);
  if (von.length) out.particle = j(von);
  if (jr.length) out.suffix = j(jr);
  return out;
}

// ---- Entries → references ---------------------------------------------------------------------

const TYPE_MAP: Record<string, RefType> = {
  article: 'article-journal', book: 'book', booklet: 'book', inbook: 'chapter', incollection: 'chapter',
  inproceedings: 'paper-conference', conference: 'paper-conference', proceedings: 'book', manual: 'report',
  mastersthesis: 'thesis', phdthesis: 'thesis', thesis: 'thesis', techreport: 'report', report: 'report',
  unpublished: 'manuscript', online: 'webpage', electronic: 'webpage', www: 'webpage', dataset: 'dataset',
  software: 'software', misc: 'document',
};

function parseBibDate(f: Record<string, string>): RefDate | undefined {
  const date = f.date ? decodeLatex(f.date) : '';
  const iso = /^(\d{4})(?:-(\d{1,2}))?(?:-(\d{1,2}))?/.exec(date);
  if (iso) return clean({ year: Number(iso[1]), month: iso[2] ? Number(iso[2]) : undefined, day: iso[3] ? Number(iso[3]) : undefined });
  const y = f.year ? decodeLatex(f.year) : '';
  const ym = /\d{4}/.exec(y);
  if (!ym && !y) return undefined;
  if (!ym) return { literal: y };
  let month: number | undefined;
  if (f.month) {
    const m = decodeLatex(f.month).trim().toLowerCase();
    month = /^\d+$/.test(m) ? Number(m) : (Number(MONTHS[m.slice(0, 3)]) || undefined);
  }
  return clean({ year: Number(ym[0]), month, day: f.day ? Number(decodeLatex(f.day)) || undefined : undefined });
}

function clean<T extends object>(o: T): T {
  for (const k of Object.keys(o) as (keyof T)[]) if (o[k] === undefined || o[k] === '') delete o[k];
  return o;
}

/** A raw entry → a reference (LaTeX decoded, names parsed, types mapped). */
export function bibEntryToReference(e: BibEntry): Reference {
  const f = e.fields;
  const d = (k: string) => (f[k] != null ? decodeLatex(f[k]!) : undefined);
  let type: RefType = TYPE_MAP[e.type] ?? 'document';
  if (type === 'document' && f.url && !f.journal && !f.booktitle) type = 'webpage';
  const r: Reference = { id: e.key, type };
  r.title = d('title');
  if (f.author) r.author = splitBibNames(f.author).map(parseBibName);
  if (f.editor) r.editor = splitBibNames(f.editor).map(parseBibName);
  r.issued = parseBibDate(f);
  r.containerTitle = d('journal') ?? d('journaltitle') ?? d('booktitle') ?? (type === 'webpage' ? d('organization') ?? d('howpublished') : undefined);
  r.containerTitleShort = d('shortjournal') ?? d('journalabbreviation');
  r.volume = d('volume');
  r.issue = d('number') && type !== 'report' ? d('number') : d('issue');
  if (type === 'report') r.number = d('number');
  r.page = d('pages')?.replace(/\s*[–—-]+\s*/g, '–');
  r.edition = d('edition');
  r.publisher = d('publisher') ?? (type === 'thesis' ? d('school') ?? d('institution') : type === 'report' ? d('institution') ?? d('organization') : undefined);
  r.publisherPlace = d('address') ?? d('location');
  if (e.type === 'phdthesis') r.genre = 'Doctoral dissertation';
  else if (e.type === 'mastersthesis') r.genre = "Master's thesis";
  else if (f.type) r.genre = d('type');
  r.doi = normalizeDoi(d('doi'));
  r.url = d('url');
  r.isbn = d('isbn');
  r.issn = d('issn');
  r.abstract = d('abstract');
  const kw = d('keywords');
  if (kw) r.keywords = kw.split(/[;,]\s*/).map((k) => k.trim()).filter(Boolean);
  r.note = d('note');
  r.language = d('language') ?? d('langid');
  const urldate = f.urldate ? decodeLatex(f.urldate) : undefined;
  if (urldate) { const m = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(urldate); if (m) r.accessed = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) }; }
  return clean(r);
}

/** BibTeX source → references, plus anything that could not be read. */
export function parseBibtex(src: string): { references: Reference[]; errors: BibParseResult['errors'] } {
  const { entries, errors } = parseBibtexEntries(src);
  return { references: entries.map(bibEntryToReference), errors };
}

// ---- References → BibTeX ----------------------------------------------------------------------

const EXPORT_TYPE: Record<RefType, string> = {
  'article-journal': 'article', 'article-magazine': 'article', 'article-newspaper': 'article', book: 'book',
  chapter: 'incollection', 'paper-conference': 'inproceedings', thesis: 'phdthesis', report: 'techreport',
  webpage: 'online', manuscript: 'unpublished', dataset: 'misc', software: 'misc', document: 'misc',
};

/** One name as BibTeX writes it unambiguously: "von Last, Jr, First" or `{Literal}`. */
export function formatBibName(n: RefName): string {
  if (n.literal) return `{${encodeLatex(n.literal)}}`;
  const last = [n.particle, n.family].filter(Boolean).map((x) => encodeLatex(x!)).join(' ');
  if (!n.given && !n.suffix) return last;
  return [last, n.suffix ? encodeLatex(n.suffix) : null, n.given ? encodeLatex(n.given) : ''].filter((x) => x != null).join(', ');
}

/** Writes references as BibTeX (one entry per reference, fields in a conventional order). */
export function toBibtex(refs: readonly Reference[]): string {
  return refs.map((r) => {
    let type = EXPORT_TYPE[r.type] ?? 'misc';
    if (r.type === 'thesis' && r.genre && /master/i.test(r.genre)) type = 'mastersthesis';
    const f: [string, string | undefined][] = [
      ['author', r.author?.map(formatBibName).join(' and ')],
      ['editor', r.editor?.map(formatBibName).join(' and ')],
      ['title', r.title ? `{${encodeLatex(r.title)}}` : undefined],
      [r.type === 'article-journal' || r.type === 'article-magazine' || r.type === 'article-newspaper' ? 'journal' : type === 'online' ? 'organization' : 'booktitle', r.containerTitle ? encodeLatex(r.containerTitle) : undefined],
      ['year', r.issued?.year != null ? String(r.issued.year) : r.issued?.literal],
      ['month', r.issued?.month != null ? String(r.issued.month) : undefined],
      ['volume', r.volume],
      ['number', r.type === 'report' ? r.number : r.issue],
      ['pages', r.page?.replace(/–/g, '--')],
      ['edition', r.edition],
      [type.endsWith('thesis') ? 'school' : type === 'techreport' ? 'institution' : 'publisher', r.publisher ? encodeLatex(r.publisher) : undefined],
      ['address', r.publisherPlace ? encodeLatex(r.publisherPlace) : undefined],
      ['type', r.type === 'thesis' || r.type === 'report' ? (r.genre && !/^(doctoral dissertation|master's thesis)$/i.test(r.genre) ? encodeLatex(r.genre) : undefined) : undefined],
      ['doi', r.doi],
      ['url', r.url],
      ['urldate', r.accessed?.year ? `${r.accessed.year}-${String(r.accessed.month ?? 1).padStart(2, '0')}-${String(r.accessed.day ?? 1).padStart(2, '0')}` : undefined],
      ['isbn', r.isbn],
      ['issn', r.issn],
      ['keywords', r.keywords?.length ? encodeLatex(r.keywords.join(', ')) : undefined],
      ['abstract', r.abstract ? encodeLatex(r.abstract) : undefined],
      ['note', r.note ? encodeLatex(r.note) : undefined],
    ];
    const body = f.filter(([, v]) => v != null && v !== '').map(([k, v]) => `  ${k} = {${v}}`).join(',\n');
    return `@${type}{${safeKey(r.id)}${body ? `,\n${body}` : ''}\n}`;
  }).join('\n\n') + (refs.length ? '\n' : '');
}

function safeKey(k: string): string {
  return k.replace(/[\s,{}"#%'()=\\]/g, '_') || 'ref';
}
