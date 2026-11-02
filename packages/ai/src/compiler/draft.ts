/**
 * The model's part of compiling a wiki page: a strict prompt over numbered source sentences, a
 * tolerant parser for its JSON, and — the important part — `validateDraft` from core, which
 * throws away any sentence that does not rest on what it cites before a person ever sees it.
 *
 * Small on-device models are the default, so the prompt is short, the sources are capped, and
 * every failure (no JSON, nothing left after validation, an error) falls back to the
 * deterministic draft: the page is then made of quotes, which is dry but never wrong.
 */
import {
  deterministicDraft,
  validateDraft,
  type Conflict,
  type DraftClaim,
  type ModelSentence,
  type PlannedPage,
  type ProvenanceGen,
  type SourceUnit,
  type ValidationReport,
  type WikiPlan,
  deterministicGen,
  pageConflicts,
  stripMarkdown,
} from '@inkwright/core';
import { extractJson } from '../json.ts';
import type { ChatRequest, Provider, Usage } from '../types.ts';

/** The AI a compile uses. */
export interface CompilerAI {
  provider: Provider;
  model: string;
  /** Shown in provenance ("On this device · Qwen3 1.7B"). */
  label: string;
  /** `device` for on-device models (shown as such in "Explain"), else the provider id. */
  where?: string;
}

/** Prompt ids (with version) recorded in provenance, so "Explain" can name the exact prompt. */
export const COMPILER_PROMPT_IDS = {
  page: 'compiler.page/1',
  adjudicate: 'ledger.adjudicate/1',
  cards: 'study.cards/1',
  tutorAsk: 'tutor.ask/1',
  tutorGrade: 'tutor.grade/1',
  evalAnswer: 'memeval.answer/1',
  evalQuestions: 'memeval.questions/1',
} as const;

export const PAGE_SYSTEM = [
  'You compile one page of a personal wiki from the user\'s own notes.',
  'Rules:',
  '- Use only what the numbered source sentences say. Never add outside knowledge, names, numbers or dates.',
  '- Every sentence cites the source ids it rests on, e.g. ["S2","S5"].',
  '- Tag each sentence: EXTRACTED if it restates one source nearly word for word; INFERRED if it combines or summarises sources; AMBIGUOUS if the sources disagree or are unclear (say what disagrees).',
  '- Short, plain sentences. One fact per sentence. At most 12 sentences. Most important first.',
  'Reply with JSON only: {"sentences":[{"text":"…","sources":["S1"],"tag":"INFERRED"}]}',
].join('\n');

const MAX_SOURCE_CHARS = 6000;

/** The prompt for one page and the map from short refs (`S1`) to unit ids. */
export function pagePrompt(page: PlannedPage, units: ReadonlyMap<string, SourceUnit>, conflicts: readonly Conflict[]): { system: string; user: string; refs: Map<string, string> } {
  const refs = new Map<string, string>();
  const lines: string[] = [];
  let used = 0;
  page.unitIds.forEach((id) => {
    const u = units.get(id);
    if (!u) return;
    const ref = `S${refs.size + 1}`;
    const line = `${ref} [${u.title}, p.${u.pageIndex + 1}${u.kind === 'speech' ? ', said' : u.kind === 'handwriting' ? ', handwritten' : ''}]: ${stripMarkdown(u.text)}`;
    if (used + line.length > MAX_SOURCE_CHARS) return;
    used += line.length;
    refs.set(ref, id);
    lines.push(line);
  });
  const byUnit = new Map([...refs].map(([r, id]) => [id, r]));
  const clashes = pageConflicts(page, conflicts).filter((c) => byUnit.has(c.a.unitId) && byUnit.has(c.b.unitId)).map((c) => `${byUnit.get(c.a.unitId)} vs ${byUnit.get(c.b.unitId)}: ${c.reason}`);
  const user = [`Page: ${page.title} (${page.kind})`, '', 'Sources:', ...lines, ...(clashes.length ? ['', 'Known disagreements (write an AMBIGUOUS sentence for each):', ...clashes] : [])].join('\n');
  return { system: PAGE_SYSTEM, user, refs };
}

/** Reads `{"sentences":[…]}` (or a bare array) from model text; [] when there is none. */
export function parseModelSentences(text: string): ModelSentence[] {
  const v = extractJson(text) as { sentences?: unknown } | unknown[] | undefined;
  const list = Array.isArray(v) ? v : Array.isArray((v as { sentences?: unknown })?.sentences) ? (v as { sentences: unknown[] }).sentences : [];
  return list
    .map((x) => x as Record<string, unknown>)
    .filter((x) => x && typeof x.text === 'string')
    .map((x) => ({ text: String(x.text), sources: Array.isArray(x.sources) ? x.sources.map(String) : typeof x.sources === 'string' ? String(x.sources).split(/[,\s]+/) : [], ...(typeof x.tag === 'string' ? { tag: x.tag } : {}) }));
}

export interface PageDraft {
  claims: DraftClaim[];
  report: ValidationReport;
  /** The model wrote it (false: deterministic). */
  byModel: boolean;
  /** Why the model's draft was not used. */
  fallback?: string;
  usage?: Usage;
}

/** Kinds the model writes; the others are always built by the rules (exact, cheap, private). */
const MODEL_KINDS = new Set(['topic', 'concept', 'project']);

/**
 * Drafts one page. With an AI: prompt → parse → validate; falls back to the deterministic draft
 * when the reply has no usable sentences. The AMBIGUOUS lines for the page's known conflicts are
 * always kept, whatever the model wrote.
 */
export async function draftPage(page: PlannedPage, plan: WikiPlan, ai: CompilerAI | null, opts: { signal?: AbortSignal } = {}): Promise<PageDraft> {
  const fallback = (why?: string): PageDraft => ({ claims: deterministicDraft(page, plan.units, plan.conflicts), report: { kept: 0, downgraded: 0, dropped: [] }, byModel: false, ...(why ? { fallback: why } : {}) });
  if (!ai || !MODEL_KINDS.has(page.kind)) return fallback();
  const { system, user, refs } = pagePrompt(page, plan.units, plan.conflicts);
  const req: ChatRequest = { model: ai.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], temperature: 0, maxTokens: 1400, json: true, signal: opts.signal };
  let text = '';
  let usage: Usage | undefined;
  try {
    const r = await ai.provider.chat(req);
    text = r.text;
    usage = r.usage;
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    return fallback(`The AI failed (${(e as Error).message}); quotes only.`);
  }
  const sentences = parseModelSentences(text);
  if (!sentences.length) return { ...fallback('The AI\'s reply had no sentences; quotes only.'), ...(usage ? { usage } : {}) };
  const { claims, report } = validateDraft(sentences, refs, plan.units, plan.conflicts);
  if (!claims.length) return { ...fallback('Nothing the AI wrote was supported by the sources; quotes only.'), report, ...(usage ? { usage } : {}) };
  // Disagreements are never left out, even if the model missed them.
  const det = deterministicDraft(page, plan.units, plan.conflicts).filter((c) => c.tag === 'A' && !claims.some((x) => x.tag === 'A' && x.units.join() === c.units.join()));
  return { claims: [...det, ...claims], report, byModel: true, ...(usage ? { usage } : {}) };
}

/** The generation record for a compile (who wrote it, with which prompt, when). */
export function compileGen(ai: CompilerAI | null, at: number): ProvenanceGen {
  if (!ai) return deterministicGen(at);
  return { by: ai.label, provider: ai.where ?? ai.provider.id, model: ai.model, prompt: COMPILER_PROMPT_IDS.page, at };
}
