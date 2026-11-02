import { useEffect, useMemo } from 'react';
import { codeRefStates, markCodeRefReviewed, newId, withCodeBaselines, type CodeRefState, type InkLink, type NoteDocument } from '@inkwright/core';
import { useDev } from './store.ts';

/**
 * The open note's code links and their drift state, recomputed when the note or the graphs
 * change. Also records the baseline of links that appear (the signature the note is written
 * against) — the only automatic write, and only to `NoteMeta.codeRefs`, never the note's text.
 */
export function useCodeRefs(doc: NoteDocument | null, enabled: boolean): CodeRefState[] {
  const indexes = useDev((s) => s.indexes);
  const version = useDev((s) => s.version);
  const states = useMemo(
    () => (doc && enabled ? codeRefStates(doc.meta, doc.pages, indexes) : []),
    [doc, doc?.version, doc?.meta, enabled, indexes, version], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => {
    if (!doc || !states.some((s) => s.status === 'new')) return;
    const next = withCodeBaselines(doc.meta, states, Date.now());
    if (next !== doc.meta) doc.updateMeta(() => next);
  }, [doc, states]);
  return states;
}

/** "Mark reviewed": the note was checked against the code as it is now. */
export function markReviewed(doc: NoteDocument, state: CodeRefState): void {
  doc.updateMeta((m) => markCodeRefReviewed(m, state, Date.now()));
}

/** Binds lassoed ink to a code symbol: an ink link whose target is `code:path#Symbol` (undoable). */
export function linkInkToCode(doc: NoteDocument, pageIndex: number, strokeIds: readonly string[], target: string): InkLink | null {
  const page = doc.page(pageIndex);
  if (!page || !strokeIds.length) return null;
  const ids = new Set(strokeIds);
  const old = (page.links ?? []).map((item, index) => ({ index, item })).filter((x) => x.item.strokeIds.some((id) => ids.has(id)));
  const link: InkLink = { id: newId(), strokeIds: [...strokeIds], target, createdAt: Date.now() };
  doc.commit(pageIndex, { label: 'Link to code', links: { removed: old, added: [{ index: (page.links ?? []).length - old.length, item: link }] } });
  return link;
}
