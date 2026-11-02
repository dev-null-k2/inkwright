/**
 * Spaced repetition from your own notes: flashcards that remember the exact place they were made
 * from, scheduled with FSRS-6 (the `ts-fsrs` library, MIT — the scheduler Anki ships), stored as
 * one JSON file per deck in the vault (`ai/study/<deckId>.json`) and merged card by card by sync,
 * so reviewing on a phone and a laptop offline never loses a review.
 *
 * Also here: deterministic cards (cloze deletions of numbers and dates in claims, and glossary
 * definitions) for when no AI is available, and a deterministic answer grader (key terms and
 * numbers) used when no model grades a written answer.
 */
import { createEmptyCard, fsrs, generatorParameters, Rating, State, type Card, type Grade } from 'ts-fsrs';
import { normalizeText } from '../search.ts';
import type { Claim } from './claims.ts';
import type { Definition } from './entities.ts';
import { unitAnchor, type SourceUnit } from './extract.ts';
import { contentWords, numbersIn, stripMarkdown } from './text.ts';

/** FSRS memory state, compact (epoch ms instead of Dates, short names). */
export interface CardMemory {
  due: number;
  /** Stability (days) and difficulty (1..10). */
  s: number;
  d: number;
  reps: number;
  lapses: number;
  /** 0 new, 1 learning, 2 review, 3 relearning. */
  state: 0 | 1 | 2 | 3;
  /** Learning step index. */
  step: number;
  /** Days scheduled at the last review. */
  sched: number;
  last?: number;
}

export type CardSource = 'note' | 'highlight' | 'ink' | 'wiki' | 'manual';

export interface StudyCard {
  id: string;
  q: string;
  a: string;
  /** The region the card was made from (provenance anchor, see provenance.ts). */
  src?: string;
  from: CardSource;
  /** `ai` when a model wrote it, `extracted` when the rules did, `user` when typed. */
  origin: 'ai' | 'extracted' | 'user';
  createdAt: number;
  updatedAt: number;
  mem: CardMemory;
  suspended?: boolean;
}

export interface ReviewEntry {
  card: string;
  at: number;
  rating: 1 | 2 | 3 | 4;
  /** How the answer was given and graded, when written. */
  answer?: string;
  score?: number;
}

export interface StudyDeck {
  formatVersion: 1;
  id: string;
  title: string;
  /** The note (or notebook) the deck studies, when it has one. */
  noteId?: string;
  notebookId?: string;
  updatedAt: number;
  cards: StudyCard[];
  /** The latest reviews (newest last), for stats; at most 500. */
  reviews: ReviewEntry[];
}

export const STUDY_DIR = 'ai/study';
export const RATING_LABEL: Record<1 | 2 | 3 | 4, string> = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

const scheduler = fsrs(generatorParameters({ request_retention: 0.9, maximum_interval: 3650, enable_fuzz: false }));

function toCard(m: CardMemory): Card {
  return {
    due: new Date(m.due), stability: m.s, difficulty: m.d, elapsed_days: 0, scheduled_days: m.sched, learning_steps: m.step,
    reps: m.reps, lapses: m.lapses, state: m.state as State, ...(m.last ? { last_review: new Date(m.last) } : {}),
  };
}

function fromCard(c: Card): CardMemory {
  return {
    due: c.due.getTime(), s: Math.round(c.stability * 1000) / 1000, d: Math.round(c.difficulty * 1000) / 1000, reps: c.reps, lapses: c.lapses,
    state: c.state as CardMemory['state'], step: c.learning_steps, sched: c.scheduled_days, ...(c.last_review ? { last: c.last_review.getTime() } : {}),
  };
}

export function newCard(args: { id: string; q: string; a: string; src?: string; from: CardSource; origin: StudyCard['origin'] }, now: number): StudyCard {
  return { ...args, createdAt: now, updatedAt: now, mem: fromCard(createEmptyCard(new Date(now))) };
}

/** Applies a rating (1 Again … 4 Easy) at `now` and returns the rescheduled card. */
export function reviewCard(card: StudyCard, rating: 1 | 2 | 3 | 4, now: number): StudyCard {
  const r = scheduler.next(toCard(card.mem), new Date(now), rating as unknown as Grade);
  return { ...card, mem: fromCard(r.card), updatedAt: now };
}

/** When each rating would bring the card back (ms from now), for the buttons' hints. */
export function previewIntervals(card: StudyCard, now: number): Record<1 | 2 | 3 | 4, number> {
  const p = scheduler.repeat(toCard(card.mem), new Date(now));
  const at = (g: Rating) => (p as unknown as Record<number, { card: Card }>)[g]!.card.due.getTime() - now;
  return { 1: at(Rating.Again), 2: at(Rating.Hard), 3: at(Rating.Good), 4: at(Rating.Easy) };
}

/** Probability of recall now (FSRS forgetting curve), 0..1; 0 for new cards. */
export function retrievability(card: StudyCard, now: number): number {
  if (card.mem.state === 0) return 0;
  return scheduler.get_retrievability(toCard(card.mem), new Date(now), false);
}

/** Short "in 10 min" / "in 3 days" text for an interval. */
export function formatInterval(ms: number): string {
  const min = Math.max(1, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h} h`;
  const d = Math.round(h / 24);
  if (d < 31) return `${d} ${d === 1 ? 'day' : 'days'}`;
  const mo = Math.round(d / 30);
  if (mo < 12) return `${mo} mo`;
  return `${Math.round(d / 365)} y`;
}

/** Cards due at `now` across decks (learning cards first, then oldest due), not suspended. */
export function dueCards(decks: readonly StudyDeck[], now: number, limit = 100): Array<{ deck: StudyDeck; card: StudyCard }> {
  const out: Array<{ deck: StudyDeck; card: StudyCard }> = [];
  for (const deck of decks) for (const card of deck.cards) if (!card.suspended && card.mem.due <= now) out.push({ deck, card });
  return out.sort((a, b) => (a.card.mem.state === 1 || a.card.mem.state === 3 ? 0 : 1) - (b.card.mem.state === 1 || b.card.mem.state === 3 ? 0 : 1) || a.card.mem.due - b.card.mem.due).slice(0, limit);
}

export function deckStats(deck: StudyDeck, now: number): { total: number; due: number; fresh: number; learned: number } {
  let due = 0, fresh = 0, learned = 0;
  for (const c of deck.cards) {
    if (c.suspended) continue;
    if (c.mem.due <= now) due++;
    if (c.mem.state === 0) fresh++;
    if (c.mem.state === 2) learned++;
  }
  return { total: deck.cards.length, due, fresh, learned };
}

/** Records a review in the deck (keeps the latest 500). */
export function recordReview(deck: StudyDeck, card: StudyCard, entry: ReviewEntry): StudyDeck {
  return { ...deck, updatedAt: entry.at, cards: deck.cards.map((c) => (c.id === card.id ? card : c)), reviews: [...deck.reviews, entry].slice(-500) };
}

// ---- Files and sync ---------------------------------------------------------------------------------

export function decodeDeck(json: string): StudyDeck {
  const raw = JSON.parse(json) as Partial<StudyDeck>;
  if (!raw || typeof raw.id !== 'string' || !Array.isArray(raw.cards)) throw new Error('Not a study deck');
  return { formatVersion: 1, id: raw.id, title: String(raw.title ?? 'Deck'), updatedAt: Number(raw.updatedAt) || 0, cards: raw.cards.filter((c) => c && typeof c.id === 'string' && c.mem), reviews: Array.isArray(raw.reviews) ? raw.reviews : [], ...(raw.noteId ? { noteId: raw.noteId } : {}), ...(raw.notebookId ? { notebookId: raw.notebookId } : {}) };
}

export function encodeDeck(d: StudyDeck): string {
  return JSON.stringify(d);
}

/**
 * Card-wise three-way merge: cards are unioned by id (a card deleted on one side and unchanged on
 * the other stays deleted), a card both sides changed takes the newer `updatedAt` (one device's
 * review wins whole — FSRS state can't be combined), reviews are unioned by (card, time).
 */
export function mergeDecks(base: StudyDeck | null, local: StudyDeck, remote: StudyDeck): StudyDeck {
  const b = new Map((base?.cards ?? []).map((c) => [c.id, c]));
  const l = new Map(local.cards.map((c) => [c.id, c]));
  const r = new Map(remote.cards.map((c) => [c.id, c]));
  const cards: StudyCard[] = [];
  const order = [...new Set([...local.cards.map((c) => c.id), ...remote.cards.map((c) => c.id)])];
  for (const id of order) {
    const x = l.get(id), y = r.get(id), o = b.get(id);
    if (x && y) cards.push(y.updatedAt > x.updatedAt ? y : x);
    else {
      const only = (x ?? y)!;
      if (o && o.updatedAt === only.updatedAt) continue;
      cards.push(only);
    }
  }
  const seen = new Set<string>();
  const reviews = [...local.reviews, ...remote.reviews].filter((e) => { const k = `${e.card}@${e.at}`; if (seen.has(k)) return false; seen.add(k); return true; }).sort((p, q) => p.at - q.at).slice(-500);
  const newer = remote.updatedAt > local.updatedAt ? remote : local;
  return { ...newer, formatVersion: 1, updatedAt: Math.max(local.updatedAt, remote.updatedAt), cards, reviews };
}

// ---- Cards without a model ------------------------------------------------------------------------

/**
 * Cards the rules can write: each glossary definition ("What is X?") and each claim with a number
 * or date, as a cloze ("Latency must stay under ___." → "50 ms"). Each card cites its sentence.
 */
export function deterministicCards(units: ReadonlyMap<string, SourceUnit>, defs: readonly Definition[], claims: readonly Claim[]): Array<{ q: string; a: string; src: string; unitId: string }> {
  const out: Array<{ q: string; a: string; src: string; unitId: string }> = [];
  const seen = new Set<string>();
  for (const d of defs) {
    const u = units.get(d.unitId);
    if (!u || seen.has(`d:${d.term.toLowerCase()}`)) continue;
    seen.add(`d:${d.term.toLowerCase()}`);
    out.push({ q: `What is ${d.term}?`, a: d.definition, src: unitAnchor(u), unitId: u.id });
  }
  for (const c of claims) {
    const u = units.get(c.unitId);
    if (!u || seen.has(u.id)) continue;
    const text = stripMarkdown(u.text);
    let hidden: string | null = null;
    if (c.qty) {
      const m = new RegExp(`[$€£₹¥]?\\s?${String(c.qty.value).replace('.', '\\.')}(?:[\\d,.]*)\\s?(?:k|K|M|bn|B)?\\s?${c.qty.dim === 'money' ? '' : escapeRe(c.qty.unit)}`, 'i').exec(text)
        ?? /[$€£₹¥]?\d[\d,.]*\s?(?:%|[a-zµ°/]+)?/i.exec(text);
      hidden = m?.[0].trim() ?? null;
    } else if (c.date) {
      const m = /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}(?:st|nd|rd|th)?\s+[A-Z][a-z]+\.?(?:\s+\d{4})?|[A-Z][a-z]+\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?|\d{1,2}\/\d{1,2}(?:\/\d{2,4})?)\b/.exec(text);
      hidden = m?.[0] ?? null;
    }
    if (!hidden || hidden.length >= text.length - 3) continue;
    seen.add(u.id);
    out.push({ q: text.replace(hidden, '___'), a: hidden, src: unitAnchor(u), unitId: u.id });
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// ---- Grading written answers --------------------------------------------------------------------

export interface Grade0 {
  /** 0..1 */
  score: number;
  /** Suggested FSRS rating. */
  rating: 1 | 2 | 3 | 4;
  /** Expected key terms/numbers missing from the answer. */
  missing: string[];
}

/**
 * Grades an answer against the expected one without a model: every number in the expected answer
 * must appear (units aside), and the share of its key words found decides the rest. Lenient on
 * word forms (stemming) and order; strict on numbers.
 */
export function gradeAnswer(answer: string, expected: string): Grade0 {
  const want = [...new Set(contentWords(expected))];
  const have = new Set(contentWords(answer));
  const nums = numbersIn(expected);
  const got = new Set(numbersIn(answer));
  const missingNums = nums.filter((n) => !got.has(n));
  const missingWords = want.filter((w) => !have.has(w));
  const wordScore = want.length ? (want.length - missingWords.length) / want.length : nums.length ? 1 : normalizeText(answer).trim() === normalizeText(expected).trim() ? 1 : 0;
  const numScore = nums.length ? (nums.length - missingNums.length) / nums.length : 1;
  const score = Math.round((nums.length ? 0.6 * numScore + 0.4 * wordScore : wordScore) * 100) / 100;
  const rating: 1 | 2 | 3 | 4 = missingNums.length || score < 0.4 ? 1 : score < 0.7 ? 2 : score < 0.95 ? 3 : 4;
  return { score, rating, missing: [...missingNums.map(String), ...missingWords].slice(0, 8) };
}
