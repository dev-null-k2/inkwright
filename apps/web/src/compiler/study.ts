/**
 * Study in the app: decks made from a note, a lasso selection (ink or text), or a compiled wiki
 * page; reviews scheduled by FSRS-6 (core study.ts); answers typed or written by hand and graded
 * (a model when the compiler may use one, the rules otherwise). Each card keeps the anchor of the
 * sentence it tests, so "Show in notes" opens the exact place.
 */
import { create } from 'zustand';
import { makeCards, gradeTeachBack, runSkill, transcribeHandwriting, type CompilerAI, type TutorVerdict } from '@inkwright/ai';
import {
  deckStats,
  dueCards,
  extractSource,
  gradeAnswer,
  newCard,
  newId,
  parseAnchor,
  rectIntersects,
  recordReview,
  reviewCard,
  textItemKey,
  type InkStroke,
  type Rect,
  type SourceUnit,
  type StudyCard,
  type StudyDeck,
} from '@inkwright/core';
import { getActiveAI } from '../lib/ai.ts';
import { recognizeLocally } from '../lib/recognition.ts';
import { useSettings } from '../state/settings.ts';
import { allDocs, cachedDoc, compilerAI, compilerStore, compilerVault } from './service.ts';
import { readNoteProvenance } from './target.ts';

interface StudyState {
  decks: StudyDeck[];
  loaded: boolean;
}

export const useStudy = create<StudyState>(() => ({ decks: [], loaded: false }));

export async function refreshDecks(): Promise<StudyDeck[]> {
  const decks = await compilerStore().decks();
  useStudy.setState({ decks, loaded: true });
  return decks;
}

/** Cards due now across all decks. */
export function dueNow(decks = useStudy.getState().decks, now = Date.now()) {
  return dueCards(decks, now);
}

export { deckStats };

async function studyAI(): Promise<CompilerAI | null> {
  return compilerAI(await compilerStore().config());
}

/** Adds cards for `units` to the deck `id` (made if needed); skips questions it already has. */
async function addCards(id: string, title: string, units: SourceUnit[], from: StudyCard['from'], extra: Partial<StudyDeck> = {}): Promise<{ deck: StudyDeck; added: number; byModel: boolean }> {
  const s = compilerStore();
  const ai = await studyAI();
  const { cards, byModel } = await makeCards(ai, units, { max: 15 });
  const now = Date.now();
  const deck: StudyDeck = (await s.deck(id)) ?? { formatVersion: 1, id, title, updatedAt: now, cards: [], reviews: [], ...extra };
  const have = new Set(deck.cards.map((c) => c.q.trim().toLowerCase()));
  let added = 0;
  for (const c of cards) {
    if (have.has(c.q.trim().toLowerCase())) continue;
    deck.cards.push(newCard({ id: newId(now), q: c.q, a: c.a, src: c.src, from, origin: c.origin }, now));
    added++;
  }
  deck.updatedAt = now;
  await s.saveDeck(deck);
  await refreshDecks();
  return { deck, added, byModel };
}

async function docOf(noteId: string) {
  await allDocs();
  const d = cachedDoc(noteId);
  if (!d) throw new Error('This note can’t be studied (it is locked or gone).');
  return d;
}

/** A deck from a whole note. */
export async function deckFromNote(noteId: string) {
  const d = await docOf(noteId);
  if (!d.units.length) throw new Error('Nothing to study yet: this note has no typed or recognized text. Recognize the handwriting first.');
  return addCards(noteId, d.title, d.units, 'note', { noteId });
}

/** A deck from a lasso selection: the sentences whose ink or text box is selected. */
export async function deckFromSelection(noteId: string, pageIndex: number, sel: { strokeIds: string[]; textIds: string[]; bounds?: Rect }) {
  const d = await docOf(noteId);
  const strokes = new Set(sel.strokeIds);
  const texts = new Set(sel.textIds);
  const units = d.units.filter((u) => u.pageIndex === pageIndex && ((u.strokeIds ?? []).some((s) => strokes.has(s)) || (u.textId && texts.has(u.textId)) || (sel.bounds && u.rect && rectIntersects(u.rect, sel.bounds))));
  if (!units.length) throw new Error('No recognized text in the selection yet. Convert the handwriting to text first, or recognize the page.');
  return addCards(noteId, d.title, units, units.some((u) => u.kind === 'handwriting') ? 'ink' : 'highlight', { noteId });
}

/** A deck from a compiled wiki page: the source sentences its claims cite. */
export async function deckFromCompiledPage(noteId: string) {
  const v = compilerVault();
  const state = await compilerStore().state();
  const page = Object.values(state.pages).find((p) => p.noteId === noteId);
  if (!page) throw new Error('This is not a compiled page.');
  await allDocs();
  const prov = await readNoteProvenance(v, noteId);
  const units: SourceUnit[] = [];
  for (const c of prov.items[textItemKey(page.textId)]?.claims ?? []) {
    for (const s of c.src) {
      const a = parseAnchor(s);
      const u = a ? cachedDoc(a.noteId)?.units.find((x) => x.hash === a.h) : undefined;
      if (u && !units.includes(u)) units.push(u);
    }
  }
  if (!units.length) throw new Error('This page has no sources to study from yet.');
  return addCards(noteId, page.title, units, 'wiki', { noteId });
}

/** Records a review and reschedules the card. */
export async function review(deckId: string, cardId: string, rating: 1 | 2 | 3 | 4, answer?: { text: string; score: number }) {
  const s = compilerStore();
  const deck = await s.deck(deckId);
  if (!deck) return;
  const card = deck.cards.find((c) => c.id === cardId);
  if (!card) return;
  const now = Date.now();
  const next = reviewCard(card, rating, now);
  await s.saveDeck(recordReview(deck, next, { card: cardId, at: now, rating, ...(answer ? { answer: answer.text.slice(0, 200), score: answer.score } : {}) }));
  await refreshDecks();
}

export async function setSuspended(deckId: string, cardId: string, suspended: boolean) {
  const s = compilerStore();
  const deck = await s.deck(deckId);
  if (!deck) return;
  deck.cards = deck.cards.map((c) => (c.id === cardId ? { ...c, suspended, updatedAt: Date.now() } : c));
  await s.saveDeck(deck);
  await refreshDecks();
}

export async function deleteDeck(id: string) {
  await compilerStore().deleteDeck(id);
  await refreshDecks();
}

// ---- Written answers --------------------------------------------------------------------------------

/**
 * Reads an answer written by hand: on-device recognition when the device has it, else the active
 * AI's vision (the image of the answer pad only). Returns null when neither is available.
 */
export async function readHandwrittenAnswer(strokes: InkStroke[], image: () => Promise<string>): Promise<{ text: string; by: string } | null> {
  const local = await recognizeLocally(strokes).catch(() => null);
  if (local?.text.trim()) return { text: local.text.trim(), by: local.engine === 'native' ? 'This device' : 'This browser' };
  const ai = await getActiveAI().catch(() => null);
  if (!ai?.vision) return null;
  const data = await image();
  const text = await runSkill(transcribeHandwriting, ai.provider, ai.model, { image: { mediaType: 'image/png', data }, mode: 'plain', languageHint: useSettings.getState().recognition.language });
  return { text: text.trim(), by: ai.label };
}

/**
 * Grades an answer to a card: the rules always (numbers must match), and a model when the
 * compiler may use one. Returns the suggested rating and what was missing.
 */
export async function gradeCard(card: StudyCard, answer: string): Promise<{ score: number; rating: 1 | 2 | 3 | 4; missing: string[]; feedback?: string; by: string; contradictions: TutorVerdict['contradictions'] }> {
  const rules = gradeAnswer(answer, card.a);
  const ai = await studyAI();
  if (!ai) return { ...rules, by: 'rules', contradictions: [] };
  // The tutor's grader with the card as its only source.
  const meta = { id: 'card', title: 'Card', kind: 'paged' as const, paper: { style: 'blank' as const, tint: 'white' as const, texture: 'smooth' as const, spacing: 0 }, pageSize: { name: 'A4', width: 794, height: 1123 }, pageIds: ['p'], tags: [], createdAt: 0, updatedAt: 0, pinned: false, formatVersion: 2 };
  const units = extractSource(meta, [{ id: 'p', strokes: [], formatVersion: 2, texts: [{ id: 't', x: 0, y: 0, width: 600, text: `${card.q.replace('___', card.a)}\n${card.a}`, fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }] }]).units;
  const v = await gradeTeachBack(ai, { id: card.id, q: card.q, expected: card.a, unitIds: units.map((u) => u.id) }, answer, units).catch(() => null);
  if (!v) return { ...rules, by: 'rules', contradictions: [] };
  const rating: 1 | 2 | 3 | 4 = v.verdict === 'wrong' ? 1 : v.verdict === 'partly' ? 2 : v.score >= 0.95 ? 4 : 3;
  return { score: v.score, rating, missing: rules.missing, feedback: v.feedback, by: v.by, contradictions: v.contradictions };
}
