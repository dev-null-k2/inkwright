import { inkLinksFromRecognition, newId, pageText, resolveWikiTarget, syncInlineTags, type NoteDocument, type RecognizedLine } from '@inkwright/core';
import { useApp } from '../state/app.ts';

/**
 * Link and tag upkeep for the open note, called by the editor session (kept free of other app
 * modules so the session can use it without import cycles).
 */

/** Keeps the note's tags in step with the `#tags` on its pages (called before every save). */
export function syncDocInlineTags(doc: NoteDocument): void {
  const text = doc.committedPages.map((p) => pageText(p)).join('\n');
  const next = syncInlineTags(doc.meta, text);
  if (next !== doc.meta) doc.updateMeta(() => next);
}

/** Handwriting recognized on a page: lines with `[[links]]` become ink links. */
export function applyRecognizedLinks(doc: NoteDocument, pageId: string, lines: readonly RecognizedLine[] | undefined): number {
  if (!lines?.length) return 0;
  const i = doc.indexOfPage(pageId);
  if (i < 0) return 0;
  const page = doc.page(i);
  const { notes, notebooks } = useApp.getState();
  const made = inkLinksFromRecognition(page, lines, {
    now: Date.now(), newId: () => newId(),
    resolve: (t) => resolveWikiTarget(t, notes, { from: doc.meta, notebooks })?.note.id,
  });
  if (!made.length) return 0;
  const base = (page.links ?? []).length;
  doc.commit(i, { label: 'Handwritten link', links: { removed: [], added: made.map((item, k) => ({ index: base + k, item })) } });
  return made.length;
}
