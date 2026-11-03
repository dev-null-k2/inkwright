/**
 * Searching the memory timeline in plain words: "what was that command in Tuesday's lecture",
 * "pricing page yesterday afternoon", "error in Terminal this morning".
 *
 * A query is read in three parts:
 *  1. **When** — today, yesterday, this morning/afternoon/evening, last night, a weekday ("Tuesday",
 *     "Tuesday's", "last Tuesday"), this/last week, "3 days ago", an ISO date or "Nov 3"/"3 Nov",
 *     and a time of day ("at 3pm", "around 14:30", ±1 hour). It narrows the range searched.
 *  2. **Where** — "in <App>" / "on <App>" / "from <App>" when that app appears in the captures.
 *  3. **What** — the remaining words, matched against captured lines (prefix matching, rarer words
 *     weigh more), the window title, the app, and the titles of notes written at the same time
 *     ("lecture" finds the moments while a note titled "Physics lecture" was being written).
 *     Some words describe the *kind* of line wanted: "command" prefers lines that look like shell
 *     commands, "link"/"url"/"address" lines with addresses, "error" lines that look like errors.
 *
 * Pure and deterministic (the clock is passed in), so every rule is unit-tested.
 */
import { normalizeText, tokenize } from '../search.ts';
import type { Capture, CaptureKind } from './format.ts';

export interface RecallQuery {
  /** The query as typed. */
  raw: string;
  /** Words to match, normalised, without the date/app words and stopwords. */
  terms: string[];
  /** Range searched (epoch ms, `to` exclusive), when the query named one. */
  from?: number;
  to?: number;
  /** Human description of the range ("Tuesday 4 Nov", "yesterday afternoon"). */
  when?: string;
  /** App named in the query (as it appears in captures). */
  app?: string;
  kind?: CaptureKind;
  /** Line kinds asked for by words like "command" or "link". */
  wants: LineKind[];
}

export type LineKind = 'command' | 'url' | 'error';

const STOP = new Set([
  'a', 'an', 'the', 'what', 'whats', 'was', 'were', 'is', 'that', 'this', 'those', 'these', 'it', 'its', 'i', 'me', 'my', 'we', 'our', 'you', 'did', 'do', 'does', 'saw', 'see', 'seen',
  'in', 'on', 'at', 'from', 'of', 'for', 'to', 'with', 'about', 'during', 'around', 'when', 'where', 'which', 'who', 'how', 'show', 'find', 'there', 'some', 'one', 'thing', 'again',
  'and', 'or', 'but', 'had', 'have', 'has', 'been', 'be', 'said', 'say', 'someone', 'something', 'remember', 'used', 'use', 'typed', 'type', 'ran', 'run', 'looked', 'up', 's',
]);

const WANT_WORDS: Record<string, LineKind> = {
  command: 'command', commands: 'command', cmd: 'command', shell: 'command', terminal: 'command',
  link: 'url', links: 'url', url: 'url', urls: 'url', address: 'url', website: 'url', site: 'url', page: 'url',
  error: 'error', errors: 'error', exception: 'error', stacktrace: 'error', traceback: 'error', crash: 'error',
};

const KIND_WORDS: Record<string, CaptureKind> = { said: 'audio', heard: 'audio', spoken: 'audio', mentioned: 'audio', talked: 'audio', screen: 'screen' };

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
/** Short weekday names people type ("Sun" and "Sat" are left out: they are also ordinary words). */
const WEEKDAY_ALIASES: Record<string, number> = { mon: 1, tue: 2, tues: 2, wed: 3, weds: 3, thu: 4, thur: 4, thurs: 4, fri: 5 };
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

const H = 3_600_000;
const startOfDay = (t: number) => { const d = new Date(t); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); };
const addDays = (dayStart: number, n: number) => { const d = new Date(dayStart); return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime(); };
const atHour = (dayStart: number, h: number, m = 0) => { const d = new Date(dayStart); return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime(); };
const fmtDay = (t: number) => new Date(t).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short' });

interface Span { from: number; to: number; when: string }

const PARTS_OF_DAY: Record<string, [number, number]> = { morning: [5, 12], afternoon: [12, 18], evening: [18, 24], night: [18, 24], tonight: [18, 24], lunch: [11, 14], lunchtime: [11, 14] };

/** Reads the query; `knownApps` are the app names present in the captures (for "in <App>"). */
export function parseRecallQuery(raw: string, now: number, knownApps: readonly string[] = []): RecallQuery {
  let text = ` ${normalizeText(raw).replace(/[’`]/g, "'").replace(/[?!.,;:"]/g, ' ')} `;
  const today = startOfDay(now);
  let span: Span | null = null;
  let part: [number, number] | null = null;
  let partWord = '';
  let clock: number | null = null;
  const take = (re: RegExp, fn: (m: RegExpExecArray) => void) => {
    const m = re.exec(text);
    if (m) { fn(m); text = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length); }
  };

  // Explicit dates first.
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => {
    const t = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])).getTime();
    span = { from: t, to: addDays(t, 1), when: fmtDay(t) };
  });
  if (!span) {
    const mon = MONTHS.map((x) => `${x.slice(0, 3)}(?:${x.slice(3)})?`).join('|');
    take(new RegExp(`\\b(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${mon})|(${mon})\\s+(\\d{1,2})(?:st|nd|rd|th)?)\\b`), (m) => {
      const name = (m[2] ?? m[3])!;
      const mi = MONTHS.findIndex((x) => x.startsWith(name.slice(0, 3)));
      const d = Number(m[1] ?? m[4]);
      const y = new Date(now).getFullYear();
      let t = new Date(y, mi, d).getTime();
      if (t > now) t = new Date(y - 1, mi, d).getTime(); // the past is what was captured
      span = { from: t, to: addDays(t, 1), when: fmtDay(t) };
    });
  }
  take(/\b(\d{1,2}) days? ago\b/, (m) => { const t = addDays(today, -Number(m[1])); span = { from: t, to: addDays(t, 1), when: fmtDay(t) }; });
  take(/\blast night\b/, () => { const y = addDays(today, -1); span = { from: atHour(y, 18), to: atHour(today, 5), when: 'last night' }; });
  take(/\byesterday\b/, () => { const y = addDays(today, -1); span = { from: y, to: today, when: 'yesterday' }; });
  take(/\btoday\b/, () => { span = { from: today, to: addDays(today, 1), when: 'today' }; });
  take(/\bthis week\b/, () => {
    const dow = (new Date(today).getDay() + 6) % 7; // Monday-based
    const mon = addDays(today, -dow);
    span = { from: mon, to: addDays(today, 1), when: 'this week' };
  });
  take(/\blast week\b/, () => {
    const dow = (new Date(today).getDay() + 6) % 7;
    const mon = addDays(today, -dow - 7);
    span = { from: mon, to: addDays(mon, 7), when: 'last week' };
  });
  // Weekdays: the most recent one (today counts), "last <day>" the one before it.
  const dayRe = new RegExp(`\\b(last\\s+|this\\s+|on\\s+)?(${[...WEEKDAYS, ...Object.keys(WEEKDAY_ALIASES)].join('|')})(?:'s|s)?\\b`);
  take(dayRe, (m) => {
    const name = m[2]!;
    const idx = WEEKDAYS.includes(name) ? WEEKDAYS.indexOf(name) : WEEKDAY_ALIASES[name]!;
    let back = (new Date(today).getDay() - idx + 7) % 7;
    if (m[1]?.trim() === 'last' && back === 0) back = 7;
    const t = addDays(today, -back);
    span = { from: t, to: addDays(t, 1), when: fmtDay(t) };
  });
  // Part of the day ("this morning", "Tuesday afternoon").
  take(/\b(?:this\s+|in the\s+)?(morning|afternoon|evening|tonight|night|lunchtime|lunch)\b/, (m) => { part = PARTS_OF_DAY[m[1]!]!; partWord = m[1]!; });
  // A time of day: "at 3pm", "around 14:30", "3 pm".
  take(/\b(?:at|around|about|~)?\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b|\b(?:at|around|about)\s+(\d{1,2}):(\d{2})\b/, (m) => {
    let h = Number(m[1] ?? m[4]);
    const min = Number(m[2] ?? m[5] ?? 0);
    if (m[3] === 'pm' && h < 12) h += 12;
    if (m[3] === 'am' && h === 12) h = 0;
    if (h < 24 && min < 60) clock = h * 60 + min;
  });

  const range = span as Span | null;
  let from = range?.from;
  let to = range?.to;
  let when = range?.when;
  if (part || clock != null) {
    const base = from ?? today;
    const p = part as [number, number] | null;
    if (clock != null) {
      const c = clock as number;
      const t = atHour(base, Math.floor(c / 60), c % 60);
      from = t - H;
      to = t + H;
      when = `${when ?? (base === today ? 'today' : fmtDay(base))} around ${String(Math.floor(c / 60)).padStart(2, '0')}:${String(c % 60).padStart(2, '0')}`;
    } else if (p) {
      from = atHour(base, p[0]);
      to = p[1] >= 24 ? addDays(base, 1) : atHour(base, p[1]);
      when = range ? `${range.when} ${partWord}` : `this ${partWord}`;
    }
  }

  // "in <App>", "on <App>", "from <App>" for apps that were captured.
  let app: string | undefined;
  const apps = [...knownApps].filter(Boolean).sort((a, b) => b.length - a.length);
  for (const a of apps) {
    const n = normalizeText(a);
    const re = new RegExp(`\\b(?:in|on|from|using)\\s+(?:the\\s+)?${n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    const m = re.exec(text);
    if (m) {
      app = a;
      text = text.slice(0, m.index) + ' ' + text.slice(m.index + m[0].length);
      break;
    }
  }

  const words = tokenize(text);
  const wants = new Set<LineKind>();
  let kind: CaptureKind | undefined;
  const terms: string[] = [];
  for (const w of words) {
    const want = WANT_WORDS[w];
    if (want) { wants.add(want); continue; }
    if (KIND_WORDS[w]) { kind = KIND_WORDS[w]; continue; }
    if (STOP.has(w) || w.length < 2) continue;
    if (!terms.includes(w)) terms.push(w);
  }
  const q: RecallQuery = { raw, terms, wants: [...wants] };
  if (from != null && to != null) { q.from = from; q.to = to; q.when = when; }
  if (app) q.app = app;
  if (kind) q.kind = kind;
  return q;
}

// ---- Line kinds ------------------------------------------------------------------------------------

const COMMAND_LINE = /^\s*(?:[$#%>❯➜λ]\s*\S|(?:sudo|git|npm|npx|pnpm|yarn|bun|deno|node|python3?|pip3?|uv|cargo|rustup|go|docker|kubectl|helm|terraform|ssh|scp|rsync|cd|ls|cat|grep|rg|find|curl|wget|make|cmake|brew|apt(?:-get)?|dnf|yum|pacman|systemctl|chmod|chown|mkdir|rm|mv|cp|tar|unzip|ffmpeg|gcc|clang|java|mvn|gradle|\.\/\S+)\s)/;
const URL_LINE = /\b(?:https?:\/\/|www\.)\S+|\b[a-z0-9-]+\.(?:com|org|net|io|dev|app|edu|gov|co)\b/i;
const ERROR_LINE = /\b(?:error|exception|failed|failure|traceback|panic|fatal|undefined is not|cannot|can't find|not found|denied|segfault|errno)\b/i;

export function lineKinds(line: string): LineKind[] {
  const out: LineKind[] = [];
  if (COMMAND_LINE.test(line)) out.push('command');
  if (URL_LINE.test(line)) out.push('url');
  if (ERROR_LINE.test(line)) out.push('error');
  return out;
}

// ---- Matching --------------------------------------------------------------------------------------

/** A note being written over a span of time (from its ink timestamps), for "lecture"-style words. */
export interface NoteSpan {
  noteId: string;
  title: string;
  from: number;
  to: number;
}

export interface RecallHit {
  capture: Capture;
  score: number;
  /** The best-matching lines (at most three), in their order in the capture. */
  lines: string[];
  /** Matched words per line, for highlighting (normalised terms). */
  matched: string[];
  /** Notes written at the same time whose titles matched. */
  notes: NoteSpan[];
}

export interface RecallSearchOptions {
  limit?: number;
  /** Notes written during the range (titles count as context for every capture they overlap). */
  notes?: readonly NoteSpan[];
  /** How close a note's writing must be to a capture to count as "at the same time" (default 10 min). */
  noteSlackMs?: number;
}

const tokensOf = (s: string) => tokenize(s);
const hasTerm = (tokens: readonly string[], term: string) => tokens.some((t) => t === term || (term.length >= 3 && t.startsWith(term)));

/**
 * Searches captures. With no words left (only a date, an app or a line kind), returns what is in
 * the range — newest first — so "Tuesday afternoon" scrubs straight to it.
 */
export function searchCaptures(captures: readonly Capture[], q: RecallQuery, opts: RecallSearchOptions = {}): RecallHit[] {
  const limit = opts.limit ?? 50;
  const slack = opts.noteSlackMs ?? 10 * 60_000;
  const inRange = captures.filter((c) => (q.from == null || (c.end ?? c.at) >= q.from) && (q.to == null || c.at < q.to) && (!q.app || normalizeText(c.app ?? '') === normalizeText(q.app)) && (!q.kind || c.kind === q.kind));
  // Rarer words weigh more: inverse document frequency over the candidate captures.
  const docTokens = new Map<Capture, string[]>();
  const df = new Map<string, number>();
  for (const c of inRange) {
    const toks = tokensOf(`${c.text}\n${c.title ?? ''}\n${c.app ?? ''}`);
    docTokens.set(c, toks);
    for (const t of q.terms) if (hasTerm(toks, t)) df.set(t, (df.get(t) ?? 0) + 1);
  }
  const notes = opts.notes ?? [];
  const idf = (t: string) => Math.log(1 + (inRange.length + 1) / (1 + (df.get(t) ?? 0)));

  const hits: RecallHit[] = [];
  for (const c of inRange) {
    const near = notes.filter((n) => c.at >= n.from - slack && c.at <= n.to + slack);
    const noteToks = near.map((n) => ({ n, toks: tokensOf(n.title) }));
    const titleToks = tokensOf(`${c.title ?? ''} ${c.app ?? ''}`);
    const lines = c.text.split('\n').map((l) => l.trim()).filter(Boolean);
    let score = 0;
    const matched = new Set<string>();
    const matchedNotes = new Set<NoteSpan>();
    // Context: words in the title/app or in a note written at the time apply to the whole capture.
    const context = new Set<string>();
    for (const t of q.terms) {
      if (hasTerm(titleToks, t)) { context.add(t); score += 0.6 * idf(t); }
      for (const { n, toks } of noteToks) if (hasTerm(toks, t)) { context.add(t); matchedNotes.add(n); score += 0.8 * idf(t); }
    }
    // Lines: every term not already satisfied by the context should be found in a line.
    const scored = lines.map((line, i) => {
      const toks = tokensOf(line);
      let s = 0;
      const m: string[] = [];
      for (const t of q.terms) if (hasTerm(toks, t)) { s += idf(t); m.push(t); }
      const kinds = q.wants.length ? lineKinds(line) : [];
      const kindHit = q.wants.some((w) => kinds.includes(w));
      if (kindHit) s += m.length || !q.terms.length ? 1.5 : 0.75;
      return { i, line, s, m, kindHit };
    });
    const best = scored.filter((x) => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 3);
    for (const b of best) for (const t of b.m) matched.add(t);
    const covered = new Set([...matched, ...context]);
    if (q.terms.length) {
      const missing = q.terms.filter((t) => !covered.has(t));
      // Every word must be found somewhere (in a line, the title, or a note at the time).
      if (missing.length) continue;
      score += best.reduce((a, b) => a + b.s, 0) / Math.max(1, best.length) + (best[0]?.s ?? 0);
      // A capture whose words come only from context needs a line of the wanted kind (if any was asked for).
      if (!best.length && q.wants.length) continue;
    } else if (q.wants.length) {
      if (!best.some((b) => b.kindHit)) continue;
      score += best[0]!.s;
    }
    const shown = (best.length ? best : scored.slice(0, 2)).sort((a, b) => a.i - b.i).map((x) => x.line);
    hits.push({ capture: c, score, lines: shown, matched: [...matched], notes: [...matchedNotes] });
  }
  return hits.sort((a, b) => b.score - a.score || b.capture.at - a.capture.at).slice(0, limit);
}

/** Splits a line into plain and highlighted parts for the matched terms (prefix matches included). */
export function highlightLine(line: string, terms: readonly string[]): Array<{ text: string; hit: boolean }> {
  if (!terms.length) return [{ text: line, hit: false }];
  const parts: Array<{ text: string; hit: boolean }> = [];
  const re = /[\p{L}\p{N}]+/gu;
  let at = 0;
  for (let m = re.exec(line); m; m = re.exec(line)) {
    const w = normalizeText(m[0]);
    if (terms.some((t) => w === t || (t.length >= 3 && w.startsWith(t)))) {
      if (m.index > at) parts.push({ text: line.slice(at, m.index), hit: false });
      parts.push({ text: m[0], hit: true });
      at = m.index + m[0].length;
    }
  }
  if (at < line.length) parts.push({ text: line.slice(at), hit: false });
  return parts;
}
