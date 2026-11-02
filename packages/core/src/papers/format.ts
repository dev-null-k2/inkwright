import { familyName, refYear, type RefDate, type RefName, type Reference } from './model.ts';

/**
 * Reference-list formatting in two styles, written out by hand rather than through a CSL engine
 * so the rules are visible and tested:
 *
 * - **APA 7** (Publication Manual of the APA, 7th ed., ch. 9–10): author–date, "Family, G. G.",
 *   "&" before the last of up to 20 authors (21+: first 19, "…", last), italic journal + volume,
 *   DOIs as https://doi.org/ links, "n.d." without a date. Titles keep the casing they were
 *   entered with (sentence-casing can't know proper nouns; Zotero stores sentence case already).
 * - **IEEE** (IEEE Reference Guide, 2023): numbered in order of first citation, "G. G. Family",
 *   up to six authors (more: first author "et al."), titles in quotes, italic containers,
 *   abbreviated months, "vol."/"no."/"pp.", and "doi:" at the end.
 *
 * A formatted reference is a list of runs (plain or italic), rendered to plain text, Markdown or
 * HTML so the same output feeds the page, the clipboard and exports.
 */

export type CitationStyle = 'apa' | 'ieee';

export interface Run { text: string; italic?: boolean }

export interface FormattedReference {
  id: string;
  runs: Run[];
  text: string;
  markdown: string;
  html: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function render(id: string, runs: Run[]): FormattedReference {
  const merged: Run[] = [];
  for (const r of runs) {
    if (!r.text) continue;
    const last = merged[merged.length - 1];
    if (last && !!last.italic === !!r.italic) last.text += r.text;
    else merged.push({ ...r });
  }
  const tidy = (s: string) => s.replace(/\s+/g, ' ').replace(/\s+([,.;:])/g, '$1').replace(/\.\./g, '.').trim();
  const text = tidy(merged.map((r) => r.text).join(''));
  const markdown = tidy(merged.map((r) => (r.italic ? `*${r.text.trim()}*${/\s$/.test(r.text) ? ' ' : ''}` : r.text)).join(''));
  const html = tidy(merged.map((r) => (r.italic ? `<i>${esc(r.text.trim())}</i>${/\s$/.test(r.text) ? ' ' : ''}` : esc(r.text))).join(''));
  return { id, runs: merged, text, markdown, html };
}

/** Initials of given names: "Jean-Paul Marie" → "J.-P. M."; already-initialled names stay. */
export function initials(given: string): string {
  return given.split(/\s+/).filter(Boolean).map((w) => w.split('-').map((p) => {
    const ch = [...p.replace(/^[^\p{L}]+/u, '')][0];
    return ch ? `${ch.toUpperCase()}.` : '';
  }).filter(Boolean).join('-')).join(' ');
}

const endsWithPunct = (s: string) => /[.?!]$/.test(s.trim());
const period = (s: string) => (endsWithPunct(s) ? s : `${s}.`);

function doiUrl(doi: string): string {
  return `https://doi.org/${doi}`;
}

// ---- APA 7 --------------------------------------------------------------------------------------

function apaName(n: RefName): string {
  if (n.literal) return n.literal;
  const fam = [n.particle, n.family].filter(Boolean).join(' ');
  const g = n.given ? initials(n.given) : '';
  return [fam + (g ? `, ${g}` : ''), n.suffix].filter(Boolean).join(', ');
}

/** "A, B, & C"; 21+ authors: the first 19, an ellipsis, the last. */
export function apaAuthors(names: readonly RefName[]): string {
  const ns = names.map(apaName);
  if (ns.length === 1) return ns[0]!;
  if (ns.length === 2) return `${ns[0]}, & ${ns[1]}`;
  if (ns.length <= 20) return `${ns.slice(0, -1).join(', ')}, & ${ns[ns.length - 1]}`;
  return `${ns.slice(0, 19).join(', ')}, … ${ns[ns.length - 1]}`;
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function apaDate(r: Reference): string {
  const d = r.issued;
  if (!d || (d.year == null && !d.literal)) return '(n.d.)';
  if (d.year == null) return `(${d.literal})`;
  // Magazine, newspaper and web items give month and day.
  if ((r.type === 'article-magazine' || r.type === 'article-newspaper' || r.type === 'webpage') && d.month) {
    return `(${d.year}, ${MONTH_NAMES[d.month - 1]}${d.day ? ` ${d.day}` : ''})`;
  }
  return `(${d.year})`;
}

function apaEditors(eds: readonly RefName[]): string {
  const ns = eds.map((n) => (n.literal ? n.literal : [n.given ? initials(n.given) : '', [n.particle, n.family].filter(Boolean).join(' ')].filter(Boolean).join(' ')));
  const list = ns.length <= 2 ? ns.join(' & ') : `${ns.slice(0, -1).join(', ')}, & ${ns[ns.length - 1]}`;
  return `${list} (${ns.length === 1 ? 'Ed.' : 'Eds.'})`;
}

function apaLink(r: Reference): string {
  return r.doi ? doiUrl(r.doi) : r.url ?? '';
}

/** Formats one reference in APA 7 style. */
export function formatApa(r: Reference): FormattedReference {
  const runs: Run[] = [];
  const add = (text: string, italic = false) => runs.push({ text, italic });
  const title = r.title ?? '[Untitled]';
  const hasAuthor = !!r.author?.length;
  const isPart = r.type === 'article-journal' || r.type === 'article-magazine' || r.type === 'article-newspaper' || r.type === 'chapter' || r.type === 'paper-conference';
  // Author element (title moves here when there is none; an edited book lists its editors).
  if (hasAuthor) add(`${period(apaAuthors(r.author!))} `);
  else if (r.type === 'book' && r.editor?.length) add(`${apaAuthors(r.editor)} (${r.editor.length === 1 ? 'Ed.' : 'Eds.'}). `);
  else if (isPart) add(`${period(title)} `);
  else add(`${period(title)} `, true);
  add(`${apaDate(r)}. `);
  const titleShown = hasAuthor || (r.type === 'book' && !!r.editor?.length);
  switch (r.type) {
    case 'article-journal':
    case 'article-magazine':
    case 'article-newspaper': {
      if (titleShown) add(`${period(title)} `);
      if (r.containerTitle) {
        // The comma between journal and volume is italic too ("*Nature, 521*").
        if (r.volume) add(`${r.containerTitle}, ${r.volume}`, true);
        else add(r.containerTitle, true);
        if (r.issue) add(`(${r.issue})`);
        if (r.page) add(`, ${r.page}`);
        add('. ');
      }
      break;
    }
    case 'chapter':
    case 'paper-conference': {
      if (titleShown) add(`${period(title)} `);
      if (r.containerTitle) {
        add('In ');
        if (r.editor?.length) add(`${apaEditors(r.editor)}, `);
        add(r.containerTitle, true);
        const pp = r.page ? `pp. ${r.page}` : '';
        const ed = r.edition ? `${ordinal(r.edition)} ed.` : '';
        const paren = [ed, pp].filter(Boolean).join(', ');
        add(paren ? ` (${paren}). ` : '. ');
      }
      if (r.publisher && r.publisher !== r.containerTitle) add(`${period(r.publisher)} `);
      break;
    }
    case 'thesis': {
      if (titleShown) add(title, true);
      const kind = r.genre ?? 'Thesis';
      add(` [${kind}${r.publisher ? `, ${r.publisher}` : ''}]. `);
      break;
    }
    case 'report': {
      if (titleShown) add(title, true);
      const no = r.number ? `${r.genre ?? 'Report'} No. ${r.number}` : '';
      add(no ? ` (${no}). ` : '. ');
      if (r.publisher && (!hasAuthor || r.publisher !== familyName(r.author![0]!))) add(`${period(r.publisher)} `);
      break;
    }
    case 'webpage': {
      if (titleShown) add(`${period(title)}`, true);
      add(' ');
      if (r.containerTitle && (!hasAuthor || r.containerTitle !== familyName(r.author![0]!))) add(`${period(r.containerTitle)} `);
      break;
    }
    default: {
      // Books and everything else: italic title, edition, publisher.
      if (titleShown) add(title, true);
      add(r.edition ? ` (${ordinal(r.edition)} ed.). ` : '. ');
      if (r.publisher) add(`${period(r.publisher)} `);
    }
  }
  const link = apaLink(r);
  if (link) add(link);
  return render(r.id, runs);
}

/** APA in-text citation: (Family, Year), (A & B, Year), (A et al., Year). */
export function apaInText(r: Reference, locator?: string): string {
  const a = r.author ?? r.editor ?? [];
  const names = a.length === 0 ? `“${r.title ?? r.id}”` : a.length === 1 ? familyName(a[0]!) : a.length === 2 ? `${familyName(a[0]!)} & ${familyName(a[1]!)}` : `${familyName(a[0]!)} et al.`;
  return `(${names}, ${refYear(r)}${locator ? `, ${locator}` : ''})`;
}

function ordinal(edition: string): string {
  const n = Number(edition);
  if (!Number.isFinite(n) || n <= 0) return edition.replace(/\s*ed(ition)?\.?$/i, '');
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' } as Record<number, string>)[n % 10] ?? 'th';
  return `${n}${s}`;
}

// ---- IEEE ---------------------------------------------------------------------------------------

const IEEE_MONTHS = ['Jan.', 'Feb.', 'Mar.', 'Apr.', 'May', 'Jun.', 'Jul.', 'Aug.', 'Sep.', 'Oct.', 'Nov.', 'Dec.'];

function ieeeName(n: RefName): string {
  if (n.literal) return n.literal;
  return [n.given ? initials(n.given) : '', [n.particle, n.family].filter(Boolean).join(' '), n.suffix ? `, ${n.suffix}` : ''].filter(Boolean).join(' ').replace(/ ,/g, ',');
}

/** "A", "A and B", "A, B, and C"; more than six: "A et al.". */
export function ieeeAuthors(names: readonly RefName[]): string {
  const ns = names.map(ieeeName);
  if (ns.length > 6) return `${ns[0]} et al.`;
  if (ns.length === 1) return ns[0]!;
  if (ns.length === 2) return `${ns[0]} and ${ns[1]}`;
  return `${ns.slice(0, -1).join(', ')}, and ${ns[ns.length - 1]}`;
}

function ieeeDate(d: RefDate | undefined): string {
  if (!d) return '';
  if (d.year == null) return d.literal ?? '';
  return [d.month ? IEEE_MONTHS[d.month - 1] : '', d.month && d.day ? `${d.day},` : '', String(d.year)].filter(Boolean).join(' ');
}

/** Formats one reference in IEEE style, numbered `n`. */
export function formatIeee(r: Reference, n: number): FormattedReference {
  const runs: Run[] = [];
  const add = (text: string, italic = false) => runs.push({ text, italic });
  add(`[${n}] `);
  const who = r.author?.length ? ieeeAuthors(r.author) : r.editor?.length ? `${ieeeAuthors(r.editor)}, ${r.editor.length === 1 ? 'Ed.' : 'Eds.'}` : '';
  if (who) add(`${who}, `);
  const title = r.title ?? 'Untitled';
  const quoted = (t: string) => `“${t.replace(/[.,]$/, '')},” `;
  const date = ieeeDate(r.issued);
  const tail: string[] = [];
  switch (r.type) {
    case 'article-journal':
    case 'article-magazine':
    case 'article-newspaper': {
      add(quoted(title));
      if (r.containerTitleShort ?? r.containerTitle) { add(r.containerTitleShort ?? r.containerTitle!, true); add(', '); }
      if (r.volume) tail.push(`vol. ${r.volume}`);
      if (r.issue) tail.push(`no. ${r.issue}`);
      if (r.page) tail.push(/[–-]/.test(r.page) ? `pp. ${r.page}` : `Art. no. ${r.page}`);
      if (date) tail.push(date);
      if (r.doi) tail.push(`doi: ${r.doi}`);
      break;
    }
    case 'paper-conference': {
      add(quoted(title));
      if (r.containerTitle) { add('in '); add(r.containerTitle, true); add(', '); }
      if (r.publisherPlace) tail.push(r.publisherPlace);
      if (date) tail.push(date);
      if (r.page) tail.push(`pp. ${r.page}`);
      if (r.doi) tail.push(`doi: ${r.doi}`);
      break;
    }
    case 'chapter': {
      add(quoted(title));
      if (r.containerTitle) { add('in '); add(r.containerTitle, true); }
      if (r.editor?.length) add(`, ${ieeeAuthors(r.editor)}, ${r.editor.length === 1 ? 'Ed.' : 'Eds.'}`);
      if (r.edition) add(`, ${ordinal(r.edition)} ed`);
      add('. ');
      const pub = [r.publisherPlace, r.publisher].filter(Boolean).join(': ');
      if (pub) tail.push(pub);
      if (date) tail.push(date);
      if (r.page) tail.push(`pp. ${r.page}`);
      if (r.doi) tail.push(`doi: ${r.doi}`);
      break;
    }
    case 'thesis': {
      add(quoted(title));
      const kind = /master/i.test(r.genre ?? '') ? 'M.S. thesis' : /doct|ph\.?d/i.test(r.genre ?? 'Doctoral') ? 'Ph.D. dissertation' : r.genre ?? 'Thesis';
      tail.push(kind);
      if (r.publisher) tail.push(r.publisher);
      if (r.publisherPlace) tail.push(r.publisherPlace);
      if (date) tail.push(date);
      break;
    }
    case 'report': {
      add(quoted(title));
      if (r.publisher) tail.push(r.publisher);
      if (r.publisherPlace) tail.push(r.publisherPlace);
      if (r.number) tail.push(`${r.genre ? r.genre : 'Rep.'} ${r.number}`);
      if (date) tail.push(date);
      if (r.doi) tail.push(`doi: ${r.doi}`);
      break;
    }
    case 'webpage': {
      add(quoted(title));
      if (r.containerTitle) add(`${r.containerTitle}. `);
      if (r.accessed?.year) add(`Accessed: ${ieeeDate(r.accessed)}. `);
      if (r.url) add(`[Online]. Available: ${r.url}`);
      return render(r.id, runs);
    }
    default: {
      // Books and other stand-alone works: italic title, edition, place: publisher, year.
      add(title, true);
      add(r.edition ? `, ${ordinal(r.edition)} ed. ` : '. ');
      const pub = [r.publisherPlace, r.publisher].filter(Boolean).join(': ');
      if (pub) tail.push(pub);
      if (date) tail.push(date);
      if (r.doi) tail.push(`doi: ${r.doi}`);
    }
  }
  if (tail.length) add(`${tail.join(', ')}.`);
  if (!r.doi && r.url) add(` [Online]. Available: ${r.url}`);
  return render(r.id, runs);
}

/** Formats a reference list: APA sorted by author then year; IEEE in citation order. */
export function formatBibliography(refs: readonly Reference[], style: CitationStyle): FormattedReference[] {
  if (style === 'ieee') return refs.map((r, i) => formatIeee(r, i + 1));
  const sorted = [...refs].sort((a, b) => sortKey(a).localeCompare(sortKey(b), 'en', { sensitivity: 'base' }) || refYear(a).localeCompare(refYear(b)));
  // Same author(s) and year: 2020a, 2020b (APA 9.47).
  const out: FormattedReference[] = [];
  const groups = new Map<string, number>();
  for (const r of sorted) {
    const g = `${(r.author ?? []).map(familyName).join('|')}#${refYear(r)}`;
    groups.set(g, (groups.get(g) ?? 0) + 1);
  }
  const seen = new Map<string, number>();
  for (const r of sorted) {
    const g = `${(r.author ?? []).map(familyName).join('|')}#${refYear(r)}`;
    if ((groups.get(g) ?? 0) > 1 && r.issued?.year != null) {
      const k = seen.get(g) ?? 0;
      seen.set(g, k + 1);
      const f = formatApa(r);
      const suffix = String.fromCharCode(97 + k);
      const year = r.issued.year;
      const fix = (s: string) => s.replace(`(${year}`, `(${year}${suffix}`);
      out.push({ ...f, text: fix(f.text), markdown: fix(f.markdown), html: fix(f.html), runs: f.runs.map((x) => ({ ...x, text: fix(x.text) })) });
    } else out.push(formatApa(r));
  }
  return out;
}

function sortKey(r: Reference): string {
  return r.author?.length ? r.author.map((a) => `${familyName(a)} ${a.given ?? ''}`).join(' ') : r.title ?? r.id;
}
