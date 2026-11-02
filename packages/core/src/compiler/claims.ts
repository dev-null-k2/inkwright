/**
 * The epistemic ledger: atomic claims with numbers, units, dates and decisions, and conflicts
 * between them across notes ("latency must stay under 50 ms" vs "the new pipeline averages
 * 110 ms").
 *
 * The design goal is *never noisy*. Every comparison that can be made deterministically is:
 * quantities are parsed with their units and normalised to a base unit (ms and s compare; ms and
 * MB never do), comparators are read from the words ("under", "at least", "no more than"), dates
 * are resolved, and decisions carry a polarity. A conflict is reported only when
 *   1. the two claims are about the same thing — shared subject words, or the same measured
 *      concept (a time in milliseconds "averages"/"p95"/"latency" is a latency) — scored 0..1, and
 *   2. their values are actually incompatible under the comparator,
 * and the combined confidence clears a threshold (0.6 by default; the evals in
 * packages/core/evals/compiler.eval.ts hold precision at that threshold). Pairs in the grey zone
 * below it can be handed to an on-device model to adjudicate (packages/ai compiler/ledger.ts);
 * they are never shown on their own.
 */
import { hashText } from '../memory.ts';
import type { SourceDoc, SourceUnit } from './extract.ts';
import { extractDates } from './entities.ts';
import { contentWords, jaccard, stripMarkdown } from './text.ts';

export type Dimension = 'time' | 'data' | 'money' | 'percent' | 'rate' | 'length' | 'mass' | 'temperature' | 'count';
export type Comparator = 'lt' | 'le' | 'gt' | 'ge' | 'eq' | 'approx';

export interface Quantity {
  value: number;
  /** The unit as written (lowercased), e.g. `ms`, `gb`, `usd`, `%`, or a counted noun. */
  unit: string;
  dim: Dimension;
  /** Value in the dimension's base unit (seconds, bytes, currency unit, percent, per second…). */
  base: number;
  /** Currency code, for money (only the same currency compares). */
  currency?: string;
}

export type ClaimKind = 'constraint' | 'measurement' | 'date' | 'decision';

export interface Claim {
  /** `<unitId>#<n>`. */
  id: string;
  unitId: string;
  noteId: string;
  /** Hash of the unit's sentence: conflicts keep their id while both sentences stay the same. */
  hash: string;
  text: string;
  kind: ClaimKind;
  /** Content words of the sentence, minus numbers, units and comparator words. */
  subject: string[];
  /** Measured concepts inferred from units and words (`latency`, `cost`, `memory`…). */
  concepts: string[];
  cmp?: Comparator;
  qty?: Quantity;
  /** `YYYY-MM-DD` for date claims. */
  date?: string;
  /** Decisions: +1 for "we will use X", -1 for "we dropped X". */
  polarity?: 1 | -1;
  /** Words like "moved to", "now", "instead": a newer value replacing an older one on purpose. */
  supersedes?: boolean;
  /** The note's last edit (newer claims win supersessions). */
  at: number;
  /** Tags, notebook and links of the note: shared context raises confidence. */
  context: string[];
}

// ---- Units ----------------------------------------------------------------------------------------

interface UnitDef { dim: Dimension; factor: number; currency?: string }

const UNITS: Record<string, UnitDef> = {
  ns: { dim: 'time', factor: 1e-9 }, 'µs': { dim: 'time', factor: 1e-6 }, us: { dim: 'time', factor: 1e-6 },
  ms: { dim: 'time', factor: 1e-3 }, msec: { dim: 'time', factor: 1e-3 }, millisecond: { dim: 'time', factor: 1e-3 }, milliseconds: { dim: 'time', factor: 1e-3 },
  s: { dim: 'time', factor: 1 }, sec: { dim: 'time', factor: 1 }, secs: { dim: 'time', factor: 1 }, second: { dim: 'time', factor: 1 }, seconds: { dim: 'time', factor: 1 },
  min: { dim: 'time', factor: 60 }, mins: { dim: 'time', factor: 60 }, minute: { dim: 'time', factor: 60 }, minutes: { dim: 'time', factor: 60 },
  h: { dim: 'time', factor: 3600 }, hr: { dim: 'time', factor: 3600 }, hrs: { dim: 'time', factor: 3600 }, hour: { dim: 'time', factor: 3600 }, hours: { dim: 'time', factor: 3600 },
  day: { dim: 'time', factor: 86400 }, days: { dim: 'time', factor: 86400 }, week: { dim: 'time', factor: 604800 }, weeks: { dim: 'time', factor: 604800 },
  b: { dim: 'data', factor: 1 }, byte: { dim: 'data', factor: 1 }, bytes: { dim: 'data', factor: 1 },
  kb: { dim: 'data', factor: 1e3 }, mb: { dim: 'data', factor: 1e6 }, gb: { dim: 'data', factor: 1e9 }, tb: { dim: 'data', factor: 1e12 },
  kib: { dim: 'data', factor: 1024 }, mib: { dim: 'data', factor: 1024 ** 2 }, gib: { dim: 'data', factor: 1024 ** 3 }, tib: { dim: 'data', factor: 1024 ** 4 },
  '%': { dim: 'percent', factor: 1 }, percent: { dim: 'percent', factor: 1 }, pct: { dim: 'percent', factor: 1 },
  rps: { dim: 'rate', factor: 1 }, qps: { dim: 'rate', factor: 1 }, 'req/s': { dim: 'rate', factor: 1 }, 'requests/s': { dim: 'rate', factor: 1 }, fps: { dim: 'rate', factor: 1 }, hz: { dim: 'rate', factor: 1 },
  mm: { dim: 'length', factor: 1e-3 }, cm: { dim: 'length', factor: 1e-2 }, km: { dim: 'length', factor: 1e3 }, metres: { dim: 'length', factor: 1 }, meters: { dim: 'length', factor: 1 }, miles: { dim: 'length', factor: 1609.34 },
  g: { dim: 'mass', factor: 1 }, kg: { dim: 'mass', factor: 1e3 }, lb: { dim: 'mass', factor: 453.6 }, lbs: { dim: 'mass', factor: 453.6 },
  '°c': { dim: 'temperature', factor: 1 }, '°f': { dim: 'temperature', factor: 1 },
  usd: { dim: 'money', factor: 1, currency: 'usd' }, dollars: { dim: 'money', factor: 1, currency: 'usd' }, eur: { dim: 'money', factor: 1, currency: 'eur' }, euros: { dim: 'money', factor: 1, currency: 'eur' },
  gbp: { dim: 'money', factor: 1, currency: 'gbp' }, pounds: { dim: 'money', factor: 1, currency: 'gbp' }, inr: { dim: 'money', factor: 1, currency: 'inr' }, rupees: { dim: 'money', factor: 1, currency: 'inr' },
};
const SYMBOLS: Record<string, string> = { $: 'usd', '€': 'eur', '£': 'gbp', '₹': 'inr', '¥': 'jpy' };
const SCALE: Record<string, number> = { k: 1e3, K: 1e3, m: 1e6, M: 1e6, mm: 1e6, b: 1e9, B: 1e9, bn: 1e9 };

/** Units as written: lowercase, UPPERCASE and Capitalised ("ms", "GB", "Hz"), longest first. */
const UNIT_ALT = [...new Set(Object.keys(UNITS).flatMap((u) => [u, u.toUpperCase(), u[0]!.toUpperCase() + u.slice(1)]))]
  .sort((a, b) => b.length - a.length).map((u) => u.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')).join('|');
const NUM = '(\\d{1,3}(?:,\\d{3})+(?:\\.\\d+)?|\\d+(?:\\.\\d+)?)';
const QTY_RE = new RegExp(`([$€£₹¥])?\\s?${NUM}\\s?(k|K|M|bn|B)?\\s?(${UNIT_ALT})?(?![\\p{L}\\p{N}])`, 'gu');

/** Every quantity with a unit (or currency) in a sentence, in order. Bare numbers are skipped. */
export function parseQuantities(text: string): Array<Quantity & { index: number; raw: string }> {
  const out: Array<Quantity & { index: number; raw: string }> = [];
  const s = stripMarkdown(text);
  for (const m of s.matchAll(QTY_RE)) {
    const [raw, sym, num, scale, unitRaw] = m;
    const value = Number(num!.replace(/,/g, '')) * (scale ? SCALE[scale] ?? 1 : 1);
    if (!Number.isFinite(value)) continue;
    if (sym) {
      const currency = SYMBOLS[sym]!;
      out.push({ value, unit: currency, dim: 'money', base: value, currency, index: m.index!, raw: raw.trim() });
      continue;
    }
    if (!unitRaw) continue;
    const key = unitRaw.toLowerCase();
    // "s"/"h"/"g"/"b" alone are only units right after a number ("50s", "3 h"), not words ("3 big").
    const def = UNITS[key] ?? UNITS[unitRaw];
    if (!def) continue;
    if (/^\d{4}$/.test(num!) && def.dim === 'time' && key === 's') continue; // "1990s"
    out.push({ value, unit: key, dim: def.dim, base: value * def.factor * 1, ...(def.currency ? { currency: def.currency } : {}), index: m.index!, raw: raw.trim() });
  }
  return out;
}

// ---- Comparators, modality, concepts --------------------------------------------------------------

const CMP_RULES: Array<[RegExp, Comparator]> = [
  [/(?:no more than|not (?:to )?exceed|at most|up to|maximum(?: of)?|max\.?|cap(?:ped)? at|≤|<=|within|no higher than|no longer than|limit(?:ed)? (?:of|to|at)?|budget(?: is| of)?)\s*$/i, 'le'],
  [/(?:under|below|less than|fewer than|lower than|shorter than|faster than|<)\s*$/i, 'lt'],
  [/(?:at least|minimum(?: of)?|min\.?|no less than|no fewer than|≥|>=|not below|not under)\s*$/i, 'ge'],
  [/(?:over|above|more than|greater than|higher than|longer than|slower than|exceeds?|>)\s*$/i, 'gt'],
  [/(?:about|around|roughly|approximately|approx\.?|~|≈|nearly|almost)\s*$/i, 'approx'],
];

const MUST = /\b(?:must|should|shall|needs? to|has to|have to|required?|requirement|sla|slo|target|goal|budget|limit|cap|cannot|can't|mustn't|may not|keep (?:it |them )?(?:under|below|within)|stay(?:s)? (?:under|below|within)|not exceed|at most|no more than|at least|maximum|minimum)\b/i;
const MEASURE = /\b(?:averages?|averaged|measured|measures|came in at|comes in at|clocked|hits?|hit|reached|reaches|takes?|took|costs?|cost|is|are|was|were|runs? at|p50|p90|p95|p99|median|mean|currently|now at|observed|benchmark(?:ed)?|got|gets|uses?|used)\b/i;
const SUPERSEDE = /\b(?:moved to|moved|postponed|rescheduled|pushed (?:back|out) to|pushed to|changed to|now|instead|updated to|revised to|no longer|new date|delayed to|brought forward to)\b/i;
const NEGATE = /\b(?:not|no longer|won't|will not|don't|do not|never|drop(?:ped)?|abandon(?:ed)?|cancel(?:l?ed)?|ruled? out|reject(?:ed)?|scrap(?:ped)?|against)\b/i;
const DECIDE = /\b(?:decided|decision|we(?:'ll| will)|agreed|going with|chose|chosen|choose|picked|settled on|plan is to|we're using|we are using|switch(?:ing)? to|adopt(?:ed|ing)?)\b/i;
const EVENT = /\b(launch(?:es|ed)?|release|deadline|due|exam|test|meeting|demo|review|ship(?:s|ping)?|go-?live|cutover|kickoff|presentation|interview|appointment|trip|flight|wedding|party|submission|start(?:s)?|ends?)\b/i;

/** Measured concepts, so differently worded claims about the same quantity meet. */
const CONCEPTS: Array<{ name: string; dim: Dimension; words: RegExp; maxBase?: number }> = [
  { name: 'latency', dim: 'time', maxBase: 30, words: /\b(?:latenc\w*|response(?: time)?|round[- ]?trip|rtt|p50|p90|p95|p99|ttfb|lag|delay|pipeline|request|query|endpoint|api|render(?:ing)?|frame|load(?:ing)? time|page load|averages?|median)\b/i },
  { name: 'duration', dim: 'time', words: /\b(?:takes?|took|duration|build|run(?:time)?|long|minutes?|hours?|days?)\b/i },
  { name: 'cost', dim: 'money', words: /./ },
  { name: 'memory', dim: 'data', words: /\b(?:memory|ram|heap|footprint|rss)\b/i },
  { name: 'size', dim: 'data', words: /\b(?:size|bundle|download|binary|file|apk|image|disk|storage|payload)\b/i },
  { name: 'throughput', dim: 'rate', words: /./ },
  { name: 'availability', dim: 'percent', words: /\b(?:uptime|availability|available|sla|slo)\b/i },
  { name: 'error rate', dim: 'percent', words: /\b(?:errors?|failure|fail(?:ing|ed)?|crash(?:es)?)\b/i },
  { name: 'coverage', dim: 'percent', words: /\b(?:coverage|covered)\b/i },
  { name: 'accuracy', dim: 'percent', words: /\b(?:accuracy|accurate|precision|recall|f1|score)\b/i },
];

function comparatorBefore(text: string, index: number): Comparator | undefined {
  const before = text.slice(Math.max(0, index - 32), index);
  for (const [re, c] of CMP_RULES) if (re.test(before)) return c;
  return undefined;
}

/** Words that describe the comparison rather than the subject. */
const NON_SUBJECT = new Set(['must', 'should', 'stay', 'stays', 'under', 'below', 'less', 'fewer', 'lower', 'over', 'above', 'more', 'greater', 'higher', 'least', 'most', 'max', 'maximum', 'minimum', 'min', 'limit', 'budget', 'target', 'goal', 'require', 'requirement', 'required', 'need', 'keep', 'exceed', 'average', 'averag', 'measure', 'measur', 'came', 'come', 'hit', 'reach', 'take', 'took', 'cost', 'currently', 'now', 'around', 'about', 'roughly', 'approx', 'nearly', 'almost', 'within', 'cap', 'capp', 'new', 'old', 'current', 'decid', 'decision', 'agre', 'chose', 'plan', 'go', 'going', 'pick', 'settl', 'mov', 'moved', 'postpon', 'reschedul', 'push', 'chang', 'instead', 'updat', 'revis', 'delay', 'long', 'longer', 'shorter', 'faster', 'slower', 'p50', 'p90', 'p95', 'p99', 'median', 'mean', 'sla', 'slo'].map((w) => w));

const UNIT_WORDS = new Set(Object.keys(UNITS).map((u) => u.toLowerCase()));

function subjectOf(text: string, drop: string[] = []): string[] {
  const skip = new Set(drop.map((d) => d.toLowerCase()));
  return [...new Set(contentWords(text).filter((w) => !NON_SUBJECT.has(w) && !UNIT_WORDS.has(w) && !skip.has(w) && !/^\d/.test(w) && !/^(?:usd|eur|gbp|inr|k|m)$/.test(w)))];
}

function conceptsOf(text: string, qty?: Quantity): string[] {
  if (!qty) return [];
  const out: string[] = [];
  for (const c of CONCEPTS) {
    if (c.dim !== qty.dim) continue;
    if (c.maxBase != null && qty.base > c.maxBase) continue;
    if (c.words.test(text)) out.push(c.name);
  }
  return out;
}

/**
 * Atomic claims of a source: one per quantity with a comparator or a measuring verb, per dated
 * event, and per decision. Sentences that are questions are skipped (they claim nothing).
 */
export function extractClaims(doc: SourceDoc, opts: { dayFirst?: boolean } = {}): Claim[] {
  const out: Claim[] = [];
  const context = [...doc.tags.map((t) => `#${t.toLowerCase()}`), ...(doc.notebookId ? [`nb:${doc.notebookId}`] : []), ...doc.links.map((l) => `[[${l.toLowerCase()}]]`)];
  const ref = new Date(doc.daily ? `${doc.daily}T12:00:00` : doc.createdAt);
  for (const u of doc.units) out.push(...claimsOfUnit(u, doc, context, ref, opts));
  return out;
}

function claimsOfUnit(u: SourceUnit, doc: SourceDoc, context: string[], ref: Date, opts: { dayFirst?: boolean }): Claim[] {
  const text = stripMarkdown(u.text);
  if (/\?\s*$/.test(text) || text.length > 400) return [];
  const out: Claim[] = [];
  const base = { unitId: u.id, noteId: u.noteId, hash: u.hash, text: u.text, at: doc.updatedAt, context: [...context, ...(u.heading ? [`h:${u.heading.toLowerCase()}`] : [])] };
  const supersedes = SUPERSEDE.test(text);
  const must = MUST.test(text);
  let n = 0;
  for (const q of parseQuantities(text)) {
    const cmp = comparatorBefore(text, q.index) ?? (must ? undefined : MEASURE.test(text) ? 'eq' : undefined);
    if (!cmp && !must) continue;
    const kind: ClaimKind = must ? 'constraint' : 'measurement';
    const { index: _i, raw: _r, ...qty } = q;
    out.push({ ...base, id: `${u.id}#${n++}`, kind, subject: subjectOf(text), concepts: conceptsOf(text, qty), cmp: cmp ?? (kind === 'constraint' ? 'le' : 'eq'), qty, ...(supersedes ? { supersedes } : {}) });
  }
  const ev = EVENT.exec(text);
  if (ev) {
    for (const d of extractDates(text, ref, opts)) {
      if (/^(?:today|tonight|tomorrow|tmrw|yesterday)$/i.test(d.text)) continue;
      out.push({ ...base, id: `${u.id}#${n++}`, kind: 'date', subject: subjectOf(text, d.text.split(/\s+/)), concepts: [`event:${ev[1]!.toLowerCase().replace(/(?:es|ed|s|ping)$/, '')}`], date: d.date, ...(supersedes ? { supersedes } : {}) });
      break;
    }
  }
  if (DECIDE.test(text) && !out.length) {
    out.push({ ...base, id: `${u.id}#${n++}`, kind: 'decision', subject: subjectOf(text), concepts: [], polarity: NEGATE.test(text) ? -1 : 1, ...(supersedes ? { supersedes } : {}) });
  }
  return out;
}

// ---- Conflicts ---------------------------------------------------------------------------------------

export type ConflictKind = 'violates-limit' | 'limits-disagree' | 'values-disagree' | 'dates-disagree' | 'decisions-disagree';

export interface Conflict {
  /** Stable while both sentences stay the same. */
  id: string;
  a: Claim;
  b: Claim;
  kind: ConflictKind;
  /** Plain-language explanation shown next to both sides. */
  reason: string;
  /** 0..1: how sure the rules are that this is a real conflict. */
  confidence: number;
  /** How alike the two subjects are (0..1), before the value check. */
  subjectMatch: number;
}

export interface ConflictOptions {
  /** Report only at or above this confidence (default 0.6). */
  threshold?: number;
  /** Also return pairs from this confidence up (grey zone for a model to adjudicate). */
  candidatesFrom?: number;
  /** Ignore pairs inside the same sentence (always). Pairs inside one note are allowed (default true). */
  sameNote?: boolean;
}

export const DEFAULT_CONFLICT_THRESHOLD = 0.6;

/** How alike two claims' subjects are: shared words, a shared measured concept, shared context. */
export function subjectSimilarity(a: Claim, b: Claim): number {
  const words = jaccard(new Set(a.subject), new Set(b.subject));
  const sharedWords = a.subject.filter((w) => b.subject.includes(w)).length;
  const concept = a.concepts.some((c) => b.concepts.includes(c));
  const strong = concept && a.concepts.concat(b.concepts).some((c) => c !== 'duration');
  let s = Math.max(words * 1.4, sharedWords >= 2 ? 0.6 : sharedWords === 1 ? 0.35 : 0);
  if (concept) s = Math.max(s, strong ? 0.62 : 0.3) + (sharedWords ? 0.15 : 0);
  const ctx = a.context.filter((c) => b.context.includes(c)).length;
  if (ctx) s += Math.min(0.2, 0.1 * ctx);
  if (a.noteId === b.noteId) s += 0.05;
  return Math.min(1, s);
}

const fmt = (q: Quantity) => {
  const v = Number.isInteger(q.value) ? q.value : Number(q.value.toFixed(2));
  return q.dim === 'money' ? `${q.currency?.toUpperCase() ?? ''} ${v}`.trim() : q.unit === '%' ? `${v}%` : `${v} ${q.unit}`;
};
const CMP_WORD: Record<Comparator, string> = { lt: 'under', le: 'at most', gt: 'over', ge: 'at least', eq: '', approx: 'about' };

/** Does measured value `m` break limit `c` (`cmp` the limit's comparator)? */
function violates(cmp: Comparator, limit: number, m: number): boolean {
  switch (cmp) {
    case 'lt': return m >= limit;
    case 'le': return m > limit * 1.0001;
    case 'gt': return m <= limit;
    case 'ge': return m < limit * 0.9999;
    default: return false;
  }
}

const upper = (c?: Comparator) => c === 'lt' || c === 'le';
const lower = (c?: Comparator) => c === 'gt' || c === 'ge';

function pairConflict(a: Claim, b: Claim): { kind: ConflictKind; reason: string; weight: number } | null {
  if (a.qty && b.qty) {
    if (a.qty.dim !== b.qty.dim) return null;
    if (a.qty.dim === 'money' && a.qty.currency !== b.qty.currency) return null;
    if (a.qty.dim === 'count' && a.qty.unit !== b.qty.unit) return null;
    // Wildly different scales are almost always different things (a 50 ms budget vs a 3-day build).
    const ratio = Math.max(a.qty.base, b.qty.base) / Math.max(1e-12, Math.min(a.qty.base, b.qty.base));
    const scale = ratio > 1000 ? 0.4 : ratio > 100 ? 0.75 : 1;
    const [c, m] = a.kind === 'constraint' && b.kind !== 'constraint' ? [a, b] : b.kind === 'constraint' && a.kind !== 'constraint' ? [b, a] : [null, null];
    if (c && m) {
      if (!violates(c.cmp!, c.qty!.base, m.qty!.base)) return null;
      return { kind: 'violates-limit', reason: `One note sets a limit of ${CMP_WORD[c.cmp!]} ${fmt(c.qty!)}; another reports ${fmt(m.qty!)}.`.replace('  ', ' '), weight: scale };
    }
    if (a.kind === 'constraint' && b.kind === 'constraint') {
      if ((upper(a.cmp) && lower(b.cmp) && b.qty.base >= a.qty.base) || (upper(b.cmp) && lower(a.cmp) && a.qty.base >= b.qty.base)) {
        return { kind: 'limits-disagree', reason: `The limits can't both hold: ${CMP_WORD[a.cmp!]} ${fmt(a.qty)} and ${CMP_WORD[b.cmp!]} ${fmt(b.qty)}.`, weight: scale };
      }
      if (((upper(a.cmp) && upper(b.cmp)) || (lower(a.cmp) && lower(b.cmp))) && Math.abs(a.qty.base - b.qty.base) / Math.max(a.qty.base, b.qty.base) > 0.15) {
        if (a.supersedes || b.supersedes) return null;
        return { kind: 'limits-disagree', reason: `Two different limits for the same thing: ${CMP_WORD[a.cmp!]} ${fmt(a.qty)} and ${CMP_WORD[b.cmp!]} ${fmt(b.qty)}.`, weight: 0.85 * scale };
      }
      return null;
    }
    if (a.cmp === 'eq' || a.cmp === 'approx' || b.cmp === 'eq' || b.cmp === 'approx') {
      const diff = Math.abs(a.qty.base - b.qty.base) / Math.max(a.qty.base, b.qty.base);
      const tol = a.cmp === 'approx' || b.cmp === 'approx' ? 0.35 : 0.25;
      if (diff <= tol || a.supersedes || b.supersedes) return null;
      // Measurements months apart are more likely progress than disagreement.
      const months = Math.abs(a.at - b.at) / (30 * 86_400_000);
      return { kind: 'values-disagree', reason: `The notes give different values: ${fmt(a.qty)} and ${fmt(b.qty)}.`, weight: 0.8 * scale * (months > 2 ? 0.6 : 1) };
    }
    return null;
  }
  if (a.kind === 'date' && b.kind === 'date' && a.date && b.date) {
    if (a.date === b.date || !a.concepts.some((c) => b.concepts.includes(c))) return null;
    if (a.supersedes || b.supersedes) return null;
    return { kind: 'dates-disagree', reason: `Two different dates: ${a.date} and ${b.date}.`, weight: 0.9 };
  }
  if (a.kind === 'decision' && b.kind === 'decision' && a.polarity !== b.polarity) {
    if (a.supersedes || b.supersedes) return null;
    return { kind: 'decisions-disagree', reason: 'One note records a decision the other reverses.', weight: 0.85 };
  }
  return null;
}

export function conflictId(a: Claim, b: Claim): string {
  const [x, y] = [a.hash + a.id.split('#')[1], b.hash + b.id.split('#')[1]].sort();
  return `c${hashText(`${x}|${y}`)}`;
}

/**
 * Conflicts among claims. Each pair is scored `subjectSimilarity × kind weight`; only pairs at or
 * above `threshold` are returned (plus, with `candidatesFrom`, the grey zone, flagged by its
 * lower confidence). Claims in the same sentence never conflict with each other.
 */
export function detectConflicts(claims: readonly Claim[], opts: ConflictOptions = {}): Conflict[] {
  const threshold = opts.threshold ?? DEFAULT_CONFLICT_THRESHOLD;
  const floor = Math.min(threshold, opts.candidatesFrom ?? threshold);
  const out: Conflict[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < claims.length; i++) {
    for (let j = i + 1; j < claims.length; j++) {
      const a = claims[i]!, b = claims[j]!;
      if (a.unitId === b.unitId) continue;
      if (opts.sameNote === false && a.noteId === b.noteId) continue;
      if (a.hash === b.hash) continue;
      const pc = pairConflict(a, b);
      if (!pc) continue;
      const subjectMatch = subjectSimilarity(a, b);
      const confidence = Math.round(subjectMatch * pc.weight * 100) / 100;
      if (confidence < floor) continue;
      const id = conflictId(a, b);
      if (seen.has(id)) continue;
      seen.add(id);
      // Older claim first, so "A … but later B" reads in time order.
      const [x, y] = a.at <= b.at ? [a, b] : [b, a];
      out.push({ id, a: x, b: y, kind: pc.kind, reason: pc.reason, confidence, subjectMatch });
    }
  }
  return out.sort((p, q) => q.confidence - p.confidence || p.id.localeCompare(q.id));
}
