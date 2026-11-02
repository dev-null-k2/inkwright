/**
 * Study with a model at the edges: flashcards written from numbered source sentences (each card
 * must cite the sentence it tests, and its answer must be found there), a "teach me back" tutor
 * that asks about a notebook and grades the answer against the sources, and grading of answers
 * written by hand. Every function has a deterministic fallback (rules from core), so studying
 * works offline with no AI at all, just with plainer cards.
 */
import {
  containment,
  deterministicCards,
  detectConflicts,
  extractClaims,
  extractDefinitions,
  extractSource,
  gradeAnswer,
  newNote,
  numbersIn,
  stripMarkdown,
  unitAnchor,
  wordSet,
  type Claim,
  type SourceUnit,
} from '@inkwright/core';
import { extractJson } from '../json.ts';
import type { Usage } from '../types.ts';
import { COMPILER_PROMPT_IDS, type CompilerAI } from './draft.ts';

export interface CardDraft {
  q: string;
  a: string;
  unitId: string;
  /** Provenance anchor of the sentence the card tests. */
  src: string;
  origin: 'ai' | 'extracted';
}

const numbered = (units: readonly SourceUnit[], max = 5000) => {
  const refs = new Map<string, SourceUnit>();
  const lines: string[] = [];
  let used = 0;
  for (const u of units) {
    const line = `S${refs.size + 1}: ${stripMarkdown(u.text)}`;
    if (used + line.length > max) break;
    used += line.length;
    refs.set(`S${refs.size + 1}`, u);
    lines.push(line);
  }
  return { refs, text: lines.join('\n') };
};

export const CARDS_SYSTEM = [
  'You write flashcards from a person\'s own notes.',
  'Each card tests one fact from ONE numbered source sentence and names it ("source": "S3").',
  'The answer must be stated in that sentence. Questions are short and unambiguous. No outside knowledge.',
  'Reply with JSON only: {"cards":[{"q":"…","a":"…","source":"S1"}]}',
].join('\n');

/**
 * Cards from source sentences. With a model, cards whose answer is not in the cited sentence
 * (under half its words, or a number the sentence doesn't have) are dropped; without one (or if
 * nothing survives) the rules write cloze and definition cards.
 */
export async function makeCards(ai: CompilerAI | null, units: readonly SourceUnit[], opts: { max?: number; signal?: AbortSignal } = {}): Promise<{ cards: CardDraft[]; byModel: boolean; usage?: Usage }> {
  const max = opts.max ?? 12;
  const rules = (): CardDraft[] => {
    const byId = new Map(units.map((u) => [u.id, u]));
    const pseudo = { noteId: units[0]?.noteId ?? 'x', title: '', tags: [], createdAt: Date.now(), updatedAt: Date.now(), units: [...units], headings: [], links: [], fingerprint: '' };
    return deterministicCards(byId, extractDefinitions(units), extractClaims(pseudo)).slice(0, max).map((c) => ({ ...c, origin: 'extracted' as const }));
  };
  if (!ai || !units.length) return { cards: rules(), byModel: false };
  const { refs, text } = numbered(units);
  let usage: Usage | undefined;
  try {
    const r = await ai.provider.chat({ model: ai.model, temperature: 0, maxTokens: 1500, json: true, signal: opts.signal, messages: [{ role: 'system', content: CARDS_SYSTEM }, { role: 'user', content: `Up to ${max} cards.\n\n${text}` }] });
    usage = r.usage;
    const v = extractJson(r.text) as { cards?: unknown } | unknown[] | undefined;
    const list = (Array.isArray(v) ? v : Array.isArray((v as { cards?: unknown })?.cards) ? (v as { cards: unknown[] }).cards : []) as Array<Record<string, unknown>>;
    const cards: CardDraft[] = [];
    for (const c of list) {
      const u = refs.get(String(c.source ?? '').trim().toUpperCase());
      const q = String(c.q ?? c.question ?? '').trim(), a = String(c.a ?? c.answer ?? '').trim();
      if (!u || !q || !a) continue;
      const src = wordSet(u.text);
      const aw = wordSet(a);
      // An answer must say something (words or a number) and say it from its sentence.
      if (!aw.size && !numbersIn(a).length) continue;
      if (wordSet(q).size < 1) continue;
      if (aw.size && containment(aw, src) < 0.5) continue;
      const nums = new Set(numbersIn(u.text));
      if (numbersIn(a).some((n) => !nums.has(n))) continue;
      cards.push({ q, a, unitId: u.id, src: unitAnchor(u), origin: 'ai' });
      if (cards.length >= max) break;
    }
    if (cards.length) return { cards, byModel: true, ...(usage ? { usage } : {}) };
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
  }
  return { cards: rules(), byModel: false, ...(usage ? { usage } : {}) };
}

// ---- Teach me back ----------------------------------------------------------------------------------

export interface TutorQuestion {
  id: string;
  q: string;
  /** What a complete answer contains (from the sources). */
  expected: string;
  unitIds: string[];
}

export const TUTOR_ASK_SYSTEM = [
  'You are a calm tutor quizzing a person on their own notes. Ask questions that make them explain, not recall single words.',
  'Each question rests on one or more numbered sources and says which ("sources": ["S2","S4"]); "expected" is what a full answer contains, taken from those sources.',
  'Reply with JSON only: {"questions":[{"q":"…","expected":"…","sources":["S1"]}]}',
].join('\n');

/** Questions about a set of source sentences; with no model, definition and cloze questions. */
export async function tutorQuestions(ai: CompilerAI | null, units: readonly SourceUnit[], opts: { count?: number; signal?: AbortSignal } = {}): Promise<{ questions: TutorQuestion[]; byModel: boolean }> {
  const count = opts.count ?? 5;
  if (ai && units.length) {
    const { refs, text } = numbered(units);
    try {
      const r = await ai.provider.chat({ model: ai.model, temperature: 0.2, maxTokens: 1200, json: true, signal: opts.signal, messages: [{ role: 'system', content: TUTOR_ASK_SYSTEM }, { role: 'user', content: `${count} questions.\n\n${text}` }] });
      const v = extractJson(r.text) as { questions?: unknown } | unknown[] | undefined;
      const list = (Array.isArray(v) ? v : Array.isArray((v as { questions?: unknown })?.questions) ? (v as { questions: unknown[] }).questions : []) as Array<Record<string, unknown>>;
      const qs: TutorQuestion[] = [];
      list.forEach((x, i) => {
        const ids = (Array.isArray(x.sources) ? x.sources : [x.sources]).map((s) => refs.get(String(s ?? '').trim().toUpperCase())?.id).filter((s): s is string => !!s);
        const q = String(x.q ?? x.question ?? '').trim();
        const expected = String(x.expected ?? x.answer ?? '').trim();
        if (q && expected && ids.length) qs.push({ id: `q${i + 1}`, q, expected, unitIds: ids });
      });
      if (qs.length) return { questions: qs.slice(0, count), byModel: true };
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
    }
  }
  const { cards } = await makeCards(null, units, { max: count });
  return { questions: cards.map((c, i) => ({ id: `q${i + 1}`, q: c.q.includes('___') ? `Fill in the gap: ${c.q}` : c.q, expected: c.a, unitIds: [c.unitId] })), byModel: false };
}

export interface TutorVerdict {
  /** 0..1 */
  score: number;
  verdict: 'right' | 'partly' | 'wrong';
  /** What the answer left out. */
  gaps: string[];
  /** Where the answer (or the notes) contradict the sources. */
  contradictions: Array<{ says: string; sourceSays: string; unitId?: string }>;
  feedback: string;
  /** "rules" or the model's label. */
  by: string;
  prompt?: string;
}

export const TUTOR_GRADE_SYSTEM = [
  'You grade a person\'s answer to a question about their own notes, using only the numbered sources.',
  'List what is missing ("gaps") and any statement in the answer that contradicts a source ("contradictions", naming the source).',
  'Be brief and kind. Reply with JSON only: {"score":0.0-1.0,"gaps":["…"],"contradictions":[{"says":"…","source":"S2"}],"feedback":"one or two sentences"}',
].join('\n');

/**
 * Grades an answer. The rules always run (numbers in the expected answer must appear; an answer
 * claim that conflicts with a source claim is a contradiction); a model, when there is one, adds
 * gaps and feedback. The rules' contradictions and missing numbers can't be overruled by the model.
 */
export async function gradeTeachBack(ai: CompilerAI | null, q: TutorQuestion, answer: string, units: readonly SourceUnit[], opts: { signal?: AbortSignal } = {}): Promise<TutorVerdict> {
  const cited = units.filter((u) => q.unitIds.includes(u.id));
  const base = gradeAnswer(answer, q.expected);
  const contradictions = answerContradictions(answer, cited.length ? cited : units);
  let verdict: TutorVerdict = {
    score: base.score, verdict: contradictions.length ? 'wrong' : base.score >= 0.8 ? 'right' : base.score >= 0.4 ? 'partly' : 'wrong',
    gaps: base.missing.length ? [`Missing: ${base.missing.join(', ')}`] : [], contradictions,
    feedback: contradictions.length ? 'Part of your answer disagrees with your notes.' : base.score >= 0.8 ? 'That matches your notes.' : 'Some of it is there; see what is missing.', by: 'rules',
  };
  if (!ai || !answer.trim()) return verdict;
  const { refs, text } = numbered(cited.length ? cited : units, 3000);
  try {
    const r = await ai.provider.chat({ model: ai.model, temperature: 0, maxTokens: 500, json: true, signal: opts.signal, messages: [{ role: 'system', content: TUTOR_GRADE_SYSTEM }, { role: 'user', content: `Question: ${q.q}\nA full answer contains: ${q.expected}\n\nSources:\n${text}\n\nThe person's answer: ${answer}` }] });
    const v = extractJson(r.text) as { score?: unknown; gaps?: unknown; contradictions?: unknown; feedback?: unknown } | undefined;
    if (v && typeof v === 'object') {
      const modelScore = Math.max(0, Math.min(1, Number(v.score)));
      const modelContra = (Array.isArray(v.contradictions) ? v.contradictions : []).map((c: Record<string, unknown>) => {
        const u = refs.get(String(c.source ?? '').trim().toUpperCase());
        return u && typeof c.says === 'string' ? { says: c.says, sourceSays: stripMarkdown(u.text), unitId: u.id } : null;
      }).filter((c): c is NonNullable<typeof c> => !!c);
      // Missing numbers cap the score: the model can't call a wrong number right.
      const score = Number.isFinite(modelScore) ? Math.min(modelScore, base.missing.some((m) => /^\d/.test(m)) ? 0.5 : 1) : base.score;
      const all = [...contradictions, ...modelContra.filter((m) => !contradictions.some((c) => c.unitId === m.unitId))];
      verdict = {
        score: Math.round(score * 100) / 100,
        verdict: all.length ? 'wrong' : score >= 0.8 ? 'right' : score >= 0.4 ? 'partly' : 'wrong',
        gaps: [...new Set([...(Array.isArray(v.gaps) ? v.gaps.map(String) : []), ...verdict.gaps])].slice(0, 6),
        contradictions: all,
        feedback: typeof v.feedback === 'string' && v.feedback.trim() ? v.feedback.trim().slice(0, 400) : verdict.feedback,
        by: ai.label,
        prompt: COMPILER_PROMPT_IDS.tutorGrade,
      };
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
  }
  return verdict;
}

/** Claims in an answer that conflict with claims in the sources (rules only, high precision). */
export function answerContradictions(answer: string, units: readonly SourceUnit[]): TutorVerdict['contradictions'] {
  if (!units.length || !answer.trim()) return [];
  const meta = newNote({ id: 'answer', title: 'Your answer', pageId: 'p', now: Date.now() });
  const answerDoc = extractSource(meta, [{ id: 'p', strokes: [], formatVersion: 2, texts: [{ id: 't', x: 0, y: 0, width: 600, text: answer, fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 }] }]);
  const srcDoc = { noteId: units[0]!.noteId, title: '', tags: [], createdAt: 0, updatedAt: 0, units: [...units], headings: [], links: [], fingerprint: '' };
  const a = extractClaims(answerDoc);
  const s = extractClaims(srcDoc);
  const out: TutorVerdict['contradictions'] = [];
  for (const c of detectConflicts([...a, ...s] as Claim[], { threshold: 0.5 })) {
    const mine = c.a.noteId === 'answer' ? c.a : c.b.noteId === 'answer' ? c.b : null;
    const theirs = mine === c.a ? c.b : c.a;
    if (!mine || theirs.noteId === 'answer') continue;
    out.push({ says: stripMarkdown(mine.text), sourceSays: stripMarkdown(theirs.text), unitId: theirs.unitId });
  }
  return out;
}
