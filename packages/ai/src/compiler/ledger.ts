/**
 * The contradiction linter's model step and bookkeeping. The rules in core find and score
 * conflicts; this module
 *  - asks an (on-device) model about grey-zone pairs only — pairs the rules can compare but whose
 *    subjects they are not sure match — and only promotes a pair when the model is confident;
 *  - applies the user's dismiss/resolve decisions, so a dismissed conflict never comes back while
 *    both sentences stay the same.
 * Noise control is the point: the threshold, the confidence the model must reach and the cap on
 * how many pairs it sees per scan are what the precision eval holds to its bar.
 */
import { detectConflicts, extractClaims, stripMarkdown, DEFAULT_CONFLICT_THRESHOLD, type Claim, type Conflict, type SourceDoc } from '@inkwright/core';
import { extractJson } from '../json.ts';
import { COMPILER_PROMPT_IDS, type CompilerAI } from './draft.ts';
import type { LedgerDecision } from './store.ts';

export interface LedgerConflict extends Conflict {
  /** Who decided it is a conflict: the rules alone, or a model on a grey-zone pair. */
  by: 'rules' | 'model';
  /** The model's explanation, when it adjudicated. */
  why?: string;
}

export interface LedgerScan {
  claims: Claim[];
  /** Open conflicts at or above the threshold, minus decided ones. */
  open: LedgerConflict[];
  /** Grey-zone pairs (below the threshold) a model may look at. */
  candidates: Conflict[];
  /** Conflicts the user decided, with the decision. */
  decided: Array<{ conflict: Conflict; decision: LedgerDecision }>;
}

/** Runs the rules over all sources. Cheap; meant to run in the background after saves. */
export function scanLedger(docs: readonly SourceDoc[], decisions: ReadonlyMap<string, LedgerDecision>, opts: { threshold?: number; greyFrom?: number } = {}): LedgerScan {
  const threshold = opts.threshold ?? DEFAULT_CONFLICT_THRESHOLD;
  const claims = docs.flatMap((d) => extractClaims(d));
  const all = detectConflicts(claims, { threshold, candidatesFrom: opts.greyFrom ?? 0.4 });
  const open: LedgerConflict[] = [];
  const candidates: Conflict[] = [];
  const decided: LedgerScan['decided'] = [];
  for (const c of all) {
    const d = decisions.get(c.id);
    if (d) { decided.push({ conflict: c, decision: d }); continue; }
    if (c.confidence >= threshold) open.push({ ...c, by: 'rules' });
    else candidates.push(c);
  }
  return { claims, open, candidates, decided };
}

export const ADJUDICATE_SYSTEM = [
  'You check two sentences from one person\'s notes for a contradiction.',
  'They contradict only if they are about the same thing and cannot both be true (a measured value breaking a stated limit counts).',
  'Different things, different times that explain the difference, or plans that changed on purpose are not contradictions.',
  'Reply with JSON only: {"same_subject": true|false, "contradict": true|false, "confidence": 0.0-1.0, "why": "one short sentence"}',
].join('\n');

/**
 * Asks the model about grey-zone pairs (at most `max`, most likely first). A pair becomes a
 * conflict only when the model says same subject AND contradiction with confidence ≥ `minModel`;
 * its confidence is the mean of the rules' and the model's. Errors and unparseable replies drop
 * the pair (silence over noise).
 */
export async function adjudicate(ai: CompilerAI, candidates: readonly Conflict[], opts: { max?: number; minModel?: number; signal?: AbortSignal } = {}): Promise<LedgerConflict[]> {
  const out: LedgerConflict[] = [];
  for (const c of candidates.slice(0, opts.max ?? 12)) {
    opts.signal?.throwIfAborted();
    try {
      const r = await ai.provider.chat({
        model: ai.model, temperature: 0, maxTokens: 200, json: true, signal: opts.signal,
        messages: [{ role: 'system', content: ADJUDICATE_SYSTEM }, { role: 'user', content: `A: ${stripMarkdown(c.a.text)}\nB: ${stripMarkdown(c.b.text)}\nWhat the rules saw: ${c.reason}` }],
      });
      const v = extractJson(r.text) as { same_subject?: unknown; contradict?: unknown; confidence?: unknown; why?: unknown } | undefined;
      const conf = Number(v?.confidence);
      if (v?.same_subject === true && v.contradict === true && conf >= (opts.minModel ?? 0.75)) {
        out.push({ ...c, confidence: Math.round(((c.confidence + Math.min(1, conf)) / 2) * 100) / 100, by: 'model', ...(typeof v.why === 'string' ? { why: v.why.slice(0, 200) } : {}) });
      }
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw e;
    }
  }
  return out;
}

export const ADJUDICATE_PROMPT_ID = COMPILER_PROMPT_IDS.adjudicate;
