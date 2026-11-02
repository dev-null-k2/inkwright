/**
 * Small, deterministic text helpers shared by the context compiler: sentence splitting that
 * understands Markdown bullets and abbreviations, a stable content hash for "has this sentence
 * changed", word sets with light stemming, and overlap measures used to check that an AI-written
 * sentence is really supported by the sources it cites.
 *
 * Everything here is pure and locale-light on purpose: it runs on every save, in the background,
 * on phones, so it must be cheap and must never need a model.
 */
import { hashText } from '../memory.ts';
import { normalizeText, tokenize } from '../search.ts';

/** Words that carry no topic. Superset of the memory index's list (modal verbs, comparators). */
export const STOP = new Set(
  ('a an and are as at be been being but by can could did do does for from had has have how i in into is it its me my of on or our ' +
    'say said says should so than that the their them then there these they this those to was we were what when where which who whom why ' +
    'will with would you your about across all any also just not no yes must may might shall need needs needed very more most less least ' +
    'under over below above up down out new old per via vs each every some such only own same other into onto than too us he she his her ' +
    'him one two three get got make made let lets use used using now today tomorrow yesterday week month year am pm stay stays keep kept ' +
    'average averages averaged around about approx approximately roughly nearly almost least most max min maximum minimum within').split(/\s+/),
);

/** A stable short hash of a sentence after normalisation (case, spacing, Markdown markers). */
export function sentenceHash(s: string): string {
  return hashText(normalizeSentence(s));
}

/** Lowercase, accent-free, Markdown-free, single-spaced text: what "the same sentence" compares. */
export function normalizeSentence(s: string): string {
  return normalizeText(stripMarkdown(s)).replace(/\s+/g, ' ').trim();
}

/** Removes Markdown block and inline markers but keeps the words (and [[link]] titles). */
export function stripMarkdown(s: string): string {
  return s
    .replace(/^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '')
    .replace(/!?\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|([^\]]+))?\]\]/g, (_m, t: string, alias?: string) => alias ?? t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|\*|_|`|~~)/g, '')
    .trim();
}

const ABBREV = /(?:\b(?:e\.g|i\.e|etc|vs|approx|fig|jr|sr|inc|ltd|dept|est)\.)$/i;
/** Titles only count capitalised ("Ms. Rao"), so "50 ms. Then" still ends a sentence. */
const TITLE_ABBREV = /\b(?:Dr|Mr|Mrs|Ms|Mx|Prof|St|No|Co)\.$/;

/**
 * Splits text into sentences. Each line of a Markdown list or a heading is its own sentence;
 * prose is split after `.`, `!`, `?` (and CJK full stops) unless the dot ends a known
 * abbreviation or sits inside a number ("3.5 ms"). Returns trimmed, non-empty sentences with the
 * character offset of each in the input (so callers can map back to positions).
 */
export function splitSentences(text: string): Array<{ text: string; start: number }> {
  const out: Array<{ text: string; start: number }> = [];
  let lineStart = 0;
  for (const line of text.split('\n')) {
    const base = lineStart;
    lineStart += line.length + 1;
    if (!line.trim()) continue;
    let from = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]!;
      if (ch === '。' || ch === '！' || ch === '？') {
        push(line.slice(from, i + 1), base + from);
        from = i + 1;
        continue;
      }
      if (ch !== '.' && ch !== '!' && ch !== '?') continue;
      const next = line[i + 1];
      if (next !== undefined && !/\s/.test(next)) continue; // "3.5", "v1.2", "e.g.x"
      if (ch === '.' && (ABBREV.test(line.slice(Math.max(0, i - 6), i + 1)) || TITLE_ABBREV.test(line.slice(Math.max(0, i - 5), i + 1)))) continue;
      // Don't end at "." directly after a single capital initial ("J. Smith").
      if (ch === '.' && /(?:^|\s)[A-Z]$/.test(line.slice(Math.max(0, i - 2), i))) continue;
      // Only break before what looks like the start of a new sentence.
      const rest = line.slice(i + 1).trimStart();
      if (rest && !/^[\p{Lu}\p{N}"“'‘(\[#*-]/u.test(rest)) continue;
      push(line.slice(from, i + 1), base + from);
      from = i + 1;
    }
    push(line.slice(from), base + from);
  }
  return out;

  function push(s: string, start: number) {
    const lead = s.length - s.trimStart().length;
    const t = s.trim();
    if (t && /[\p{L}\p{N}]/u.test(t)) out.push({ text: t, start: start + lead });
  }
}

/** Very light English stemming: enough that "latencies"/"latency" and "decided"/"decide" meet. */
export function stem(w: string): string {
  if (w.length <= 3 || /\d/.test(w)) return w;
  if (w.endsWith('ies') && w.length > 4) return w.slice(0, -3) + 'y';
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length > 5) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length > 4) return w.slice(0, -2).replace(/(.)\1$/, '$1');
  if (w.endsWith('es') && /(ch|sh|x|ss|z)es$/.test(w)) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}

/** Content words of a text, stemmed, without stopwords or pure numbers. */
export function contentWords(text: string): string[] {
  return tokenize(stripMarkdown(text)).filter((t) => !STOP.has(t) && !/^\d+([.,]\d+)?$/.test(t)).map(stem).filter((t) => t.length > 1);
}

export function wordSet(text: string): Set<string> {
  return new Set(contentWords(text));
}

/** |a ∩ b| / |a|: how much of `a` is found in `b` (support of a sentence by its sources). */
export function containment(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / a.size;
}

/** Jaccard similarity of two word sets. */
export function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (!a.size && !b.size) return 0;
  let n = 0;
  for (const w of a) if (b.has(w)) n++;
  return n / (a.size + b.size - n);
}

/** Numbers written in a text (digits, with decimal points or commas as thousands separators). */
export function numbersIn(text: string): number[] {
  return [...stripMarkdown(text).matchAll(/(?<![\w.])-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|(?<![\w.])-?\d+(?:\.\d+)?/g)].map((m) => Number(m[0].replace(/,/g, ''))).filter(Number.isFinite);
}

/** URL- and file-safe slug: "Project Atlas" → "project-atlas". */
export function slugify(s: string): string {
  return normalizeText(s).replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'page';
}
