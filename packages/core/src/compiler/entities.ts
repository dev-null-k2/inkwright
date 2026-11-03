/**
 * Rule-based entities, definitions, dates and action items over source units. Rules, not a model:
 * they are predictable, explainable ("found because the line says 'call Priya'"), private and
 * fast. They aim for precision over recall — a person page for someone who is not a person is
 * worse than a missing one — and every hit keeps the unit it came from, so pages built on them
 * cite their sources like any other claim.
 */
import { normalizeText } from '../search.ts';
import type { SourceDoc, SourceUnit } from './extract.ts';
import { slugify, stripMarkdown } from './text.ts';

export type EntityKind = 'person' | 'project' | 'concept';

export interface EntityMention {
  kind: EntityKind;
  /** Display name as written ("Priya Shah"). */
  name: string;
  /** Stable key (`person:priya-shah`). */
  key: string;
  unitId: string;
  noteId: string;
  /** Which rule found it, for "why is this here?". */
  rule: string;
}

/** Capitalised words that start sentences or name things that are never people. */
const NOT_A_NAME = new Set(
  ('I Im Ive Id Ill The A An This That These Those It Its We Our Us You Your They Their He She His Her Him My Me Mine Hi Hello Thanks Thank Dear ' +
    'Monday Tuesday Wednesday Thursday Friday Saturday Sunday Mon Tue Wed Thu Fri Sat Sun Today Tomorrow Yesterday Tonight ' +
    'January February March April May June July August September October November December Jan Feb Mar Apr Jun Jul Aug Sep Sept Oct Nov Dec ' +
    'Team Everyone All Both Each Nobody Somebody Someone Anyone Client Customer Customers Users User Manager Boss Mom Mum Dad ' +
    'Google Microsoft Apple Amazon Slack Zoom Teams Notion Linear Jira GitHub Gitlab Figma Excel Word Docs Drive Gmail Outlook Python Java JavaScript TypeScript Rust Go React Postgres Kafka AWS GCP Azure ' +
    'Project Meeting Notes Note Agenda Action Actions Todo TODO Next Re Fw Fwd Q1 Q2 Q3 Q4 OK Okay Yes No Maybe Please Also Then Done And Or But So If When Why How What Who Where ' +
    'North South East West Street Road Avenue Room Office Home Lab Library Chapter Section Page Figure Table Exam Lecture Class Course').split(/\s+/),
);

const NAME = "[A-Z][a-z'’]+(?:[- ][A-Z][a-z'’]+)?";
const isName = (n: string) => n.split(/[\s-]/).every((w) => !NOT_A_NAME.has(w.replace(/['’]s$/, ''))) && n.length >= 2;
const clean = (n: string) => n.replace(/['’]s$/, '').trim();

/** Either case for the first letter of each alternative ("Call Priya" at a line start, "call Priya" mid-line). */
const anyCase = (alts: string[]) => alts.map((a) => `[${a[0]!.toUpperCase()}${a[0]!.toLowerCase()}]${a.slice(1)}`).join('|');
/** Context words that, right before a capitalised name, make it a person. */
const PERSON_BEFORE = new RegExp(`\\b(?:${anyCase(['call(?:ed)?', 'email(?:ed)?', 'e-mail', 'ask(?:ed)?', 'tell', 'told', 'met', 'meet(?:ing)? with', 'ping(?:ed)?', 'thank(?:ed)?', 'text(?:ed)?', 'remind', 'cc', 'follow(?:ed)?[- ]up with', 'check in with', 'sync with', '1:1 with', 'one-on-one with', 'talk(?:ed)? to', 'spoke (?:to|with)', 'chat(?:ted)? with', 'introduce(?:d)?', 'hand(?:ed)? off to', 'assign(?:ed)? to', 'owner:?', 'from', 'by'])})\\s+(${NAME})`, 'g');
/** A name followed by a person-only verb ("Priya said", "Sam to send"). */
const PERSON_AFTER = new RegExp(`(?:^|[.;:!?]\\s+|[-*•]\\s+|\\band\\s+)(${NAME})\\s+(?:said|says|thinks|thought|suggested|asked|agreed|disagreed|wants|wanted|mentioned|promised|explained|proposed|presented|will|to (?:send|share|draft|write|check|review|follow|book|call|email|update|fix|prepare|confirm|look|schedule|set up|ping))\\b`, 'g');
const TITLED = new RegExp(`\\b(?:Dr|Prof|Mr|Mrs|Ms|Mx)\\.?\\s+(${NAME})`, 'g');
const AT_MENTION = /(?:^|\s)@([A-Za-z][\w.-]{1,40})/g;
const ATTENDEES = /^\s*(?:attendees|present|participants|people|with|who)\s*[:—-]\s*(.+)$/i;
const PROJECT = new RegExp(`\\b(?:[Pp]roject|[Pp]roj\\.)\\s+(${NAME}|[A-Z][A-Za-z0-9]+)|\\b(${NAME})\\s+project\\b`, 'g');

/** People, projects and concepts mentioned in a source. */
export function extractEntities(doc: SourceDoc): EntityMention[] {
  const out: EntityMention[] = [];
  const push = (kind: EntityKind, raw: string, u: SourceUnit, rule: string) => {
    const name = clean(raw);
    if (!name) return;
    const key = `${kind}:${slugify(name)}`;
    if (out.some((m) => m.key === key && m.unitId === u.id)) return;
    out.push({ kind, name, key, unitId: u.id, noteId: u.noteId, rule });
  };
  for (const u of doc.units) {
    const text = stripMarkdown(u.text);
    const att = ATTENDEES.exec(text);
    if (att) {
      for (const part of att[1]!.split(/,|;|\band\b|&/)) {
        const n = part.trim().replace(/^@/, '');
        if (new RegExp(`^${NAME}$`).test(n) && isName(n)) push('person', n, u, 'attendee list');
      }
    }
    for (const m of text.matchAll(PERSON_BEFORE)) if (isName(m[1]!)) push('person', m[1]!, u, 'named after "call/email/ask/meet…"');
    for (const m of text.matchAll(PERSON_AFTER)) if (isName(m[1]!)) push('person', m[1]!, u, 'named before "said/will/to send…"');
    for (const m of text.matchAll(TITLED)) push('person', m[1]!, u, 'title (Dr., Prof., …)');
    for (const m of u.text.matchAll(AT_MENTION)) push('person', m[1]!.replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), u, '@mention');
    for (const m of text.matchAll(PROJECT)) {
      const n = (m[1] ?? m[2])!;
      if (!NOT_A_NAME.has(n)) push('project', n, u, '"Project X" / "X project"');
    }
    for (const l of [...u.text.matchAll(/\[\[([^\]|#]+)(?:#[^\]|]*)?(?:\|[^\]]+)?\]\]/g)]) push('concept', l[1]!.trim(), u, '[[link]]');
  }
  for (const t of doc.tags) {
    const m = /^(?:project|proj)[/:-](.+)$/i.exec(t);
    if (m && doc.units[0]) push('project', m[1]!.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()), doc.units[0], '#project/… tag');
  }
  return mergeNameVariants(out);
}

/**
 * "Priya" and "Priya Shah" are the same person when only one full name starts with that first
 * name across the mentions; the short form is folded into the full one.
 */
export function mergeNameVariants(mentions: EntityMention[]): EntityMention[] {
  const fulls = new Map<string, Set<string>>();
  for (const m of mentions) {
    if (m.kind !== 'person') continue;
    const parts = m.name.split(' ');
    if (parts.length > 1) {
      const first = normalizeText(parts[0]!);
      if (!fulls.has(first)) fulls.set(first, new Set());
      fulls.get(first)!.add(m.name);
    }
  }
  return mentions.map((m) => {
    if (m.kind !== 'person' || m.name.includes(' ')) return m;
    const set = fulls.get(normalizeText(m.name));
    if (set?.size === 1) {
      const full = [...set][0]!;
      return { ...m, name: full, key: `person:${slugify(full)}` };
    }
    return m;
  });
}

// ---- Definitions (glossary) -----------------------------------------------------------------------

export interface Definition {
  term: string;
  definition: string;
  unitId: string;
}

// A spaced hyphen ("Term - definition") counts like a dash: `\s*` has already eaten the space before
// it, so the alternative looks behind for it instead of matching it (" - " could never match).
const DEF_COLON = /^\s*(?:\*\*)?([\p{L}][\p{L}\p{N} '’/-]{1,40}?)(?:\*\*)?\s*(?::|—|–|(?<=\s)-|=)\s+(.{8,})$/u;
const DEF_IS = /^\s*(?:an?\s+|the\s+)?([\p{Lu}][\p{L}\p{N}'’/-]*(?:\s+[\p{L}\p{N}'’/-]+){0,3}?)\s+(?:is|are|means|refers to|stands for)\s+((?:an?|the|a kind of|a type of|when|how|what)\b.{6,})$/u;
/** Labels that look like "Term: text" but are not definitions. */
const NOT_A_TERM = /^(?:todo|to do|note|notes|action|actions|ai|next|next steps?|q|a|question|answer|date|time|when|where|who|why|attendees|present|participants|agenda|decision|decisions|owner|due|status|re|subject|summary|tl;?dr|ps|update|idea|ideas|follow[- ]?up|priority|cost|price|budget|total|goal|deadline|launch|exam)$/i;

/** "Term: definition", "Term — definition" and "Term is a …" sentences. */
export function extractDefinitions(units: readonly SourceUnit[]): Definition[] {
  const out: Definition[] = [];
  for (const u of units) {
    const text = stripMarkdown(u.text);
    let m = DEF_COLON.exec(text);
    if (m && !NOT_A_TERM.test(m[1]!.trim()) && m[1]!.trim().split(/\s+/).length <= 5 && !/\d{1,2}:\d{2}/.test(m[0])) {
      out.push({ term: m[1]!.trim(), definition: m[2]!.trim().replace(/\.$/, ''), unitId: u.id });
      continue;
    }
    m = DEF_IS.exec(text);
    if (m && !NOT_A_NAME.has(m[1]!.split(/\s+/)[0]!) && !NOT_A_TERM.test(m[1]!.trim())) out.push({ term: m[1]!.trim(), definition: m[2]!.trim().replace(/\.$/, ''), unitId: u.id });
  }
  return out;
}

// ---- Dates -------------------------------------------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MON = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const pad = (n: number) => String(n).padStart(2, '0');
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const valid = (y: number, m: number, d: number) => m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y, m, 0)).getUTCDate();

/** The year that puts month/day closest to `ref` (from 2 months before to 10 months after). */
function guessYear(m: number, d: number, ref: Date): number {
  const y = ref.getFullYear();
  for (const cand of [y, y + 1, y - 1]) {
    const t = Date.UTC(cand, m - 1, d);
    const diff = (t - Date.UTC(y, ref.getMonth(), ref.getDate())) / 86_400_000;
    if (diff >= -62 && diff <= 310) return cand;
  }
  return y;
}

export interface DateMention {
  /** `YYYY-MM-DD`. */
  date: string;
  /** The words matched. */
  text: string;
  index: number;
}

/**
 * Calendar dates written in text: ISO dates, "3 Dec 2026", "Dec 3rd", "12/03" (month first unless
 * `dayFirst`), and weekday or relative words ("today", "tomorrow", "Friday", "next Tuesday")
 * resolved against `ref` (the note's own date, so an old note's "Friday" stays that Friday).
 */
export function extractDates(text: string, ref: Date, opts: { dayFirst?: boolean } = {}): DateMention[] {
  const out: DateMention[] = [];
  const add = (date: string, m: RegExpMatchArray) => { if (!out.some((o) => o.index === m.index)) out.push({ date, text: m[0].trim(), index: m.index! }); };
  const s = stripMarkdown(text);
  for (const m of s.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (valid(y, mo, d)) add(iso(y, mo, d), m);
  }
  for (const m of s.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}\\.?,?(?:\\s+(\\d{4}))?\\b`, 'gi'))) {
    const d = Number(m[1]), mo = MONTHS.indexOf(m[2]!.slice(0, 3).toLowerCase()) + 1;
    const y = m[3] ? Number(m[3]) : guessYear(mo, d, ref);
    if (valid(y, mo, d)) add(iso(y, mo, d), m);
  }
  for (const m of s.matchAll(new RegExp(`\\b${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'))) {
    const mo = MONTHS.indexOf(m[1]!.slice(0, 3).toLowerCase()) + 1, d = Number(m[2]);
    const y = m[3] ? Number(m[3]) : guessYear(mo, d, ref);
    if (valid(y, mo, d)) add(iso(y, mo, d), m);
  }
  for (const m of s.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/g)) {
    let mo = Number(m[1]), d = Number(m[2]);
    if (opts.dayFirst) [mo, d] = [d, mo];
    const y = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : guessYear(mo, d, ref);
    if (valid(y, mo, d)) add(iso(y, mo, d), m);
  }
  const day = (offset: number) => {
    const d = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + offset);
    return iso(d.getFullYear(), d.getMonth() + 1, d.getDate());
  };
  for (const m of s.matchAll(/\b(today|tonight|tomorrow|tmrw|yesterday)\b/gi)) {
    const w = m[1]!.toLowerCase();
    add(day(w === 'yesterday' ? -1 : w.startsWith('to') && w !== 'tomorrow' ? 0 : 1), m);
  }
  // A weekday means its next occurrence after the note's day ("next Friday" reads the same way).
  for (const m of s.matchAll(/\b(?:(?:next|this|on|by|before|until)\s+)?(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/gi)) {
    const target = WEEKDAYS.indexOf(m[1]!.toLowerCase());
    const diff = (target - ref.getDay() + 7) % 7 || 7;
    add(day(diff), m);
  }
  return out.sort((a, b) => a.index - b.index);
}

// ---- Action items and follow-ups ----------------------------------------------------------------

export interface ActionItem {
  text: string;
  /** Who it is for ("me" when written in the first person or unassigned). */
  owner: string;
  /** The person to follow up with, for follow-ups. */
  person?: string;
  due?: string;
  done: boolean;
  followUp: boolean;
  unitId: string;
  noteId: string;
}

const CHECKBOX = /^\s*[-*+]\s+\[([ xX])\]\s+(.+)$/;
const TODO = /^\s*(?:todo|to do|action(?: item)?|ai|next step|next)\s*[:—-]\s*(.+)$/i;
const OWNER_TO = new RegExp(`^\\s*(?:[-*•]\\s*)?(${NAME})\\s+(?:to|will|should|needs to|is going to)\\s+(.{3,})$`);
const FOLLOW = new RegExp(`\\b(?:${anyCase(['follow(?:\\s|-)?up', 'check in', 'circle back', 'get back', 'reach out'])})\\s+(?:with|to)\\s+(${NAME})(?:\\s+(?:about|on|re|regarding)\\s+([^.;]+))?`);
const FIRST_PERSON = /^\s*(?:[-*•]\s*)?(?:i\s+(?:need to|have to|must|should|will|'ll)|i'll|remember to|don't forget to|reminder:?)\s+(.{3,})$/i;

/** Open (and done) to-dos, assigned actions and follow-ups, with owners and due dates. */
export function extractActions(doc: SourceDoc, opts: { ref?: Date; dayFirst?: boolean } = {}): ActionItem[] {
  const ref = opts.ref ?? new Date(doc.daily ? `${doc.daily}T12:00:00` : doc.createdAt);
  const out: ActionItem[] = [];
  for (const u of doc.units) {
    const raw = u.text;
    const plain = stripMarkdown(raw);
    let text: string | null = null;
    let done = false;
    let owner = 'me';
    let person: string | undefined;
    let followUp = false;
    const cb = CHECKBOX.exec(raw);
    if (cb) { done = cb[1] !== ' '; text = cb[2]!.trim(); }
    const td = !text ? TODO.exec(plain) : null;
    if (td) text = td[1]!.trim();
    const fp = !text ? FIRST_PERSON.exec(plain) : null;
    if (fp) text = fp[1]!.trim();
    const body = text ?? plain;
    const ow = OWNER_TO.exec(body);
    if (ow && isName(ow[1]!) && !/^(?:I|We)$/.test(ow[1]!)) { owner = clean(ow[1]!); text ??= body; }
    const fu = FOLLOW.exec(body);
    if (fu && isName(fu[1]!)) { followUp = true; person = clean(fu[1]!); text ??= body; }
    if (!text) continue;
    const due = extractDates(body, ref, opts)[0]?.date;
    const item: ActionItem = { text: text.replace(/\s+/g, ' ').replace(/\.$/, ''), owner, done, followUp, unitId: u.id, noteId: u.noteId };
    if (person) item.person = person;
    if (due) item.due = due;
    out.push(item);
  }
  return out;
}

const NAME_RE = new RegExp(`^${NAME}$`);
/** True when `s` looks like a person's name to these rules (used by the people UI to filter input). */
export function looksLikeName(s: string): boolean {
  return NAME_RE.test(s.trim()) && isName(s.trim());
}
