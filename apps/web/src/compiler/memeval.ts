/**
 * Settings › AI › "Does my memory help?" — runs the held-out eval (packages/ai memeval.ts) on the
 * user's own notes with the AI they chose: the model alone, with retrieval from the notes (the
 * app's hybrid memory search), and with the compiled wiki too. The report is saved in the vault
 * (`ai/evals/memory.json`) so it can be compared later or on another device.
 */
import { generateEvalQuestions, runMemoryEval, type EvalCondition, type MemoryEvalReport, type RetrievedPassage } from '@inkstone/ai';
import { COMPILED_TAG } from '@inkstone/core';
import { getActiveAI } from '../lib/ai.ts';
import { appMemory } from '../lib/memory.ts';
import { allDocs, compilerStore } from './service.ts';

export async function lastMemoryEval(): Promise<MemoryEvalReport | null> {
  return compilerStore().evalReport<MemoryEvalReport>('memory');
}

export async function runMemoryEvalNow(o: { questions?: number; signal?: AbortSignal; onProgress?: (done: number, total: number) => void } = {}): Promise<MemoryEvalReport> {
  const a = await getActiveAI();
  if (!a) throw new Error('Connect an AI first (Settings › AI).');
  const memory = appMemory();
  if (!memory) throw new Error('Search is still starting.');
  const state = await compilerStore().state();
  const compiled = new Map(Object.values(state.pages).map((p) => [p.noteId, p.sourceNotes]));
  const docs = (await allDocs()).filter((d) => !compiled.has(d.noteId) && !d.tags.includes(COMPILED_TAG));
  const questions = generateEvalQuestions(docs, o.questions ?? 20);
  if (!questions.length) throw new Error('No questions could be made: the eval needs notes with numbers, dates or definitions ("Term: meaning").');
  const conditions: EvalCondition[] = compiled.size ? ['none', 'notes', 'wiki'] : ['none', 'notes'];
  const report = await runMemoryEval({
    ai: { provider: a.provider, model: a.model, label: a.label }, questions, conditions, signal: o.signal, onProgress: o.onProgress,
    host: {
      async retrieve(q, mode, k): Promise<RetrievedPassage[]> {
        const { results } = await memory.search(q, { limit: k * 3 });
        const out: RetrievedPassage[] = [];
        for (const r of results) {
          const sources = compiled.get(r.chunk.noteId);
          if (sources && mode === 'notes') continue;
          out.push({ id: r.chunk.id, title: r.chunk.title, text: r.chunk.text, noteIds: sources ?? [r.chunk.noteId] });
          if (out.length >= k) break;
        }
        return out;
      },
    },
  });
  await compilerStore().saveEvalReport('memory', report);
  return report;
}
