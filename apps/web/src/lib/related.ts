import { KeywordRelatedNotes, type RelatedNotesProvider } from '@inkstone/core';
import { useApp } from '../state/app.ts';

/**
 * Where "related notes" come from. By default: shared tags and keywords from the knowledge index
 * (KeywordRelatedNotes). An on-device semantic index registers itself with
 * `setRelatedNotesProvider` and the Links panel and the graph start using it — no other change.
 */
let custom: RelatedNotesProvider | null = null;
const listeners = new Set<() => void>();

export function setRelatedNotesProvider(p: RelatedNotesProvider | null): void {
  custom = p;
  for (const l of [...listeners]) l();
}

/** Notified when the provider changes (the graph rebuilds its "related" edges). */
export function onRelatedProviderChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** True when an embedding-based provider is plugged in (shown as "by meaning" in the UI). */
export const hasSemanticProvider = () => custom != null;

export function relatedNotesProvider(): RelatedNotesProvider | null {
  if (custom) return custom;
  const v = useApp.getState().vault;
  return v ? new KeywordRelatedNotes(v.knowledge) : null;
}

/** Related notes for many notes at once (the graph), falling back to keywords on errors. */
export async function relatedForAll(ids: readonly string[], limit = 4): Promise<Map<string, { id: string; score: number }[]>> {
  const p = relatedNotesProvider();
  const out = new Map<string, { id: string; score: number }[]>();
  if (!p) return out;
  const v = useApp.getState().vault;
  const fallback = v ? new KeywordRelatedNotes(v.knowledge) : null;
  for (const id of ids) {
    try {
      out.set(id, await p.relatedNotes(id, { limit }));
    } catch {
      if (fallback) out.set(id, await fallback.relatedNotes(id, { limit }));
    }
  }
  return out;
}
