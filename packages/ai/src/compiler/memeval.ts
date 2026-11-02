/**
 * "Does my memory help?" — a small, honest eval the user runs on their own notes.
 *
 * 1. Questions with known answers are generated from the notes by the rules (numbers with units,
 *    dates, definitions; each knows the sentence and note it came from). They are *held out*:
 *    nothing about them is given to the model except the question.
 * 2. Each question is asked under up to three conditions:
 *      none   — the model alone (closed book),
 *      notes  — with passages retrieved from the notes (the app's hybrid memory search),
 *      wiki   — with passages retrieved from the notes and the compiled wiki pages.
 * 3. Answers are graded by the rules (numbers must match; key words for definitions), citations
 *    are checked (did the answer cite a passage from the note the fact lives in?), and tokens are
 *    counted from the providers' usage reports.
 * 4. Conditions are compared with an exact McNemar test on the paired right/wrong outcomes. With
 *    p ≥ 0.05 the report says "no significant difference" — including when retrieval looks better
 *    on a handful of questions, because a handful of questions can't show it.
 */
import { extractClaims, extractDefinitions, gradeAnswer, hashText, parseQuantities, stripMarkdown, type SourceDoc } from '@inkwright/core';
import type { Usage } from '../types.ts';
import { COMPILER_PROMPT_IDS, type CompilerAI } from './draft.ts';

export interface EvalQuestion {
  id: string;
  q: string;
  expected: string;
  noteId: string;
  noteTitle: string;
  unitId: string;
  kind: 'number' | 'date' | 'definition';
}

export type EvalCondition = 'none' | 'notes' | 'wiki';

export interface RetrievedPassage {
  id: string;
  title: string;
  text: string;
  /** Notes the passage is from (a compiled page: its sources). */
  noteIds: string[];
}

export interface EvalHost {
  retrieve(question: string, mode: Exclude<EvalCondition, 'none'>, k: number): Promise<RetrievedPassage[]>;
}

export interface QuestionResult {
  id: string;
  condition: EvalCondition;
  answer: string;
  correct: boolean;
  /** Cited a passage from the right note (null when nothing was retrieved or cited). */
  citedRight: boolean | null;
  /** Retrieval put a passage from the right note in front of the model. */
  retrievedRight: boolean | null;
  tokens: number;
}

export interface ConditionSummary {
  condition: EvalCondition;
  n: number;
  accuracy: number;
  /** Share of answers whose citations point at the right note, among answers that cited. */
  citationAccuracy: number | null;
  /** Share of questions where retrieval found the right note. */
  retrievalHit: number | null;
  tokens: number;
  tokensPerQuestion: number;
}

export interface Comparison {
  a: EvalCondition;
  b: EvalCondition;
  /** b right where a was wrong, and the reverse. */
  bBetter: number;
  aBetter: number;
  p: number;
  significant: boolean;
  /** Plain-language result. */
  verdict: string;
}

export interface MemoryEvalReport {
  at: number;
  model: string;
  prompt: string;
  questions: EvalQuestion[];
  results: QuestionResult[];
  summary: ConditionSummary[];
  comparisons: Comparison[];
  /** One honest sentence for the top of the report. */
  headline: string;
}

/** Deterministic pseudo-random order from a seed (so a rerun asks the same questions). */
function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  return () => ((s = Math.imul(s ^ (s >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0) / 4294967296;
}

/**
 * Questions with answers the rules can check, spread across notes (round-robin), at most `n`.
 * Number questions blank the quantity out of its sentence; definition questions ask "What is X?".
 */
export function generateEvalQuestions(docs: readonly SourceDoc[], n = 20, seed = 7): EvalQuestion[] {
  const perNote: EvalQuestion[][] = [];
  for (const d of docs) {
    const qs: EvalQuestion[] = [];
    const units = new Map(d.units.map((u) => [u.id, u]));
    for (const def of extractDefinitions(d.units)) {
      qs.push({ id: `q${hashText(def.unitId + def.term)}`, q: `In my notes, what is ${def.term}?`, expected: def.definition, noteId: d.noteId, noteTitle: d.title, unitId: def.unitId, kind: 'definition' });
    }
    for (const c of extractClaims(d)) {
      const u = units.get(c.unitId);
      if (!u || qs.some((q) => q.unitId === u.id)) continue;
      const text = stripMarkdown(u.text);
      if (c.qty) {
        const hit = parseQuantities(text).find((x) => x.value === c.qty!.value && x.unit === c.qty!.unit);
        if (!hit) continue;
        const ans = hit.raw;
        qs.push({ id: `q${hashText(u.id + ans)}`, q: `According to my notes, fill in the blank: "${text.replace(ans, '___')}"`, expected: ans, noteId: d.noteId, noteTitle: d.title, unitId: u.id, kind: 'number' });
      } else if (c.date) {
        qs.push({ id: `q${hashText(u.id + c.date)}`, q: `According to my notes, on what date (YYYY-MM-DD) is this: "${text}"? Answer with the date.`, expected: c.date, noteId: d.noteId, noteTitle: d.title, unitId: u.id, kind: 'date' });
      }
    }
    const rnd = seeded(seed + perNote.length);
    perNote.push(qs.map((q) => [rnd(), q] as const).sort((a, b) => a[0] - b[0]).map(([, q]) => q));
  }
  const out: EvalQuestion[] = [];
  for (let round = 0; out.length < n && perNote.some((l) => l.length > round); round++) {
    for (const l of perNote) if (l[round] && out.length < n) out.push(l[round]!);
  }
  return out;
}

export const EVAL_ANSWER_SYSTEM = [
  'Answer the question about the user\'s notes in a few words.',
  'If passages are given, answer only from them and cite the passage you used as [P1], [P2]…; if they don\'t contain the answer, say "I don\'t know".',
  'If no passages are given, answer only if you are sure; otherwise say "I don\'t know".',
].join('\n');

/** Exact two-sided McNemar test (binomial on the discordant pairs). */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (!n) return 1;
  const k = Math.min(b, c);
  let p = 0;
  let coef = 1; // C(n, 0)
  for (let i = 0; i <= k; i++) {
    if (i > 0) coef = (coef * (n - i + 1)) / i;
    p += coef;
  }
  return Math.min(1, (2 * p) / 2 ** n);
}

/** Runs the eval. `conditions` defaults to all three ("wiki" only makes sense once compiled). */
export async function runMemoryEval(o: { ai: CompilerAI; questions: readonly EvalQuestion[]; host: EvalHost; conditions?: EvalCondition[]; k?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void; now?: number }): Promise<MemoryEvalReport> {
  const conditions = o.conditions ?? ['none', 'notes', 'wiki'];
  const k = o.k ?? 5;
  const results: QuestionResult[] = [];
  const total = o.questions.length * conditions.length;
  let done = 0;
  for (const q of o.questions) {
    for (const condition of conditions) {
      o.signal?.throwIfAborted();
      const passages = condition === 'none' ? [] : await o.host.retrieve(q.q, condition, k);
      const ctx = passages.length ? `\n\nPassages:\n${passages.map((p, i) => `[P${i + 1}] (${p.title}) ${p.text.replace(/\s+/g, ' ').slice(0, 600)}`).join('\n')}` : '';
      let answer = '';
      let usage: Usage | undefined;
      try {
        const r = await o.ai.provider.chat({ model: o.ai.model, temperature: 0, maxTokens: 120, signal: o.signal, messages: [{ role: 'system', content: EVAL_ANSWER_SYSTEM }, { role: 'user', content: `${q.q}${ctx}` }] });
        answer = r.text.trim();
        usage = r.usage;
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw e;
        answer = '';
      }
      const g = gradeAnswer(answer, q.expected);
      const correct = !/\bi don'?t know\b/i.test(answer) && (q.kind === 'definition' ? g.score >= 0.6 : g.missing.length === 0 || g.score >= 0.95);
      const cited = [...answer.matchAll(/\[P(\d+)\]/g)].map((m) => passages[Number(m[1]) - 1]).filter((p): p is RetrievedPassage => !!p);
      results.push({
        id: q.id, condition, answer: answer.slice(0, 400), correct,
        citedRight: cited.length ? cited.some((p) => p.noteIds.includes(q.noteId)) : null,
        retrievedRight: condition === 'none' ? null : passages.some((p) => p.noteIds.includes(q.noteId)),
        tokens: usage ? usage.inputTokens + usage.outputTokens : 0,
      });
      o.onProgress?.(++done, total);
    }
  }
  const summary: ConditionSummary[] = conditions.map((condition) => {
    const rs = results.filter((r) => r.condition === condition);
    const citing = rs.filter((r) => r.citedRight != null);
    const retrieving = rs.filter((r) => r.retrievedRight != null);
    const tokens = rs.reduce((s, r) => s + r.tokens, 0);
    return {
      condition, n: rs.length, accuracy: rs.length ? rs.filter((r) => r.correct).length / rs.length : 0,
      citationAccuracy: citing.length ? citing.filter((r) => r.citedRight).length / citing.length : null,
      retrievalHit: retrieving.length ? retrieving.filter((r) => r.retrievedRight).length / retrieving.length : null,
      tokens, tokensPerQuestion: rs.length ? Math.round(tokens / rs.length) : 0,
    };
  });
  const comparisons: Comparison[] = [];
  const pairs: Array<[EvalCondition, EvalCondition]> = [['none', 'notes'], ['notes', 'wiki'], ['none', 'wiki']];
  for (const [a, b] of pairs) {
    if (!conditions.includes(a) || !conditions.includes(b)) continue;
    let bBetter = 0, aBetter = 0;
    for (const q of o.questions) {
      const ra = results.find((r) => r.id === q.id && r.condition === a)?.correct;
      const rb = results.find((r) => r.id === q.id && r.condition === b)?.correct;
      if (rb && !ra) bBetter++;
      if (ra && !rb) aBetter++;
    }
    const p = mcnemarExact(bBetter, aBetter);
    const significant = p < 0.05;
    const name = { none: 'the model alone', notes: 'retrieval from your notes', wiki: 'retrieval with the compiled wiki' };
    const verdict = significant
      ? `${bBetter > aBetter ? name[b] : name[a]} answered more questions correctly (${Math.max(bBetter, aBetter)} vs ${Math.min(bBetter, aBetter)} of the questions where they differed; p = ${p.toFixed(3)}).`
      : `No significant difference between ${name[a]} and ${name[b]} (they differed on ${bBetter + aBetter} of ${o.questions.length} questions; p = ${p.toFixed(2)}).`;
    comparisons.push({ a, b, bBetter, aBetter, p, significant, verdict: verdict[0]!.toUpperCase() + verdict.slice(1) });
  }
  const main = comparisons.find((c) => c.a === 'none' && c.b === 'notes') ?? comparisons[0];
  const headline = o.questions.length < 10
    ? `Only ${o.questions.length} questions could be made from these notes — too few to tell whether memory helps. ${main ? main.verdict : ''}`.trim()
    : main?.verdict ?? 'Nothing to compare.';
  return { at: o.now ?? Date.now(), model: o.ai.label, prompt: COMPILER_PROMPT_IDS.evalAnswer, questions: [...o.questions], results, summary, comparisons, headline };
}
