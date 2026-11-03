import type { NoteMeta } from '@inkwright/core';
import { getActiveAI, type ActiveAI, type AICallOptions } from '../lib/ai.ts';
import { aiCanSee } from '../lib/trust/state.ts';

/**
 * The one way ink actions reach a model: through the guarded `getActiveAI` (router, AI policy,
 * PII firewall, budgets, audit — docs/TRUST.md), and never for a note the policy hides from AI.
 * Local-only notes are routed to an on-device model by the gateway itself.
 */
export async function aiForNote(note: Pick<NoteMeta, 'id' | 'title' | 'notebookId' | 'tags'> | null, opts: AICallOptions & { needVision?: boolean } = {}): Promise<ActiveAI> {
  if (note && !aiCanSee(note.id)) throw new Error('AI is not allowed to read this note (Settings › Privacy & trust › Routing & privacy).');
  const ai = await getActiveAI({ ...opts, ...(note ? { notes: [{ id: note.id, title: note.title, notebookId: note.notebookId, tags: note.tags }] } : {}) });
  if (!ai) throw new Error('Connect an AI first: add your own key for any provider in Settings › AI.');
  if (opts.needVision && !ai.vision) throw new Error(`${ai.label} can’t read images. Choose a vision model in Settings › AI, or recognize the handwriting first.`);
  return ai;
}

/** One plain request; returns the reply text. */
export async function askOnce(ai: ActiveAI, system: string, user: Parameters<ActiveAI['provider']['chat']>[0]['messages'][number]['content'], signal?: AbortSignal, maxTokens = 600): Promise<string> {
  const res = await ai.provider.chat({ model: ai.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], maxTokens, ...(signal ? { signal } : {}) });
  return res.text.trim();
}
