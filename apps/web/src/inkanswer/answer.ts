import { attributeAnswer, attributedClaims, boundsOfStrokes, rectIsEmpty, textBoxBounds, type InkStroke, type NoteDocument, type Passage, type ProvenanceGen, type Rect, type TextBox } from '@inkwright/core';
import type { ContentPart } from '@inkwright/ai';
import { useApp } from '../state/app.ts';
import { pageImageForAI } from '../lib/exporter.ts';
import type { AppVault } from '../lib/vault.ts';
import type { InkEngine } from '../canvas/engine.ts';
import { isModuleOn } from '../modules/registry.ts';
import { aiForNote, askOnce } from '../inkactions/ai.ts';
import { useInkPrefs } from '../inkactions/prefs.ts';
import { placeTypedAnswer, writeInInk, type PlacedAnswer } from './write.ts';
import { selectionText, sendsImagesTo } from '../lib/assistant/context.ts';

/**
 * "Write the answer here": the lassoed question (its handwriting recognized on the device first,
 * plus typed text; a picture too for strong vision models only) goes to the active AI; the reply
 * is put next to the selection in the form Settings › Ink actions › "Answer on the page in" asks
 * for. Provenance is kept with the note (`ink:<first stroke id>` or `text:<id>` in its provenance file, docs/COMPILER.md), so
 * Explain can say what the model read and who wrote it.
 */

export const INK_ANSWER_PROMPT_ID = 'ink.answer/1';
const SYSTEM = 'You answer what a person wrote on a page of their notes (a question, a sum, a prompt). Reply with the answer only, in plain sentences, at most 70 words. No Markdown, no lists, no preamble.';

export interface Selection {
  pageIndex: number;
  strokes: InkStroke[];
  texts: TextBox[];
}

function selectionBounds(s: Selection): Rect | null {
  const b = boundsOfStrokes(s.strokes);
  const all = [b, ...s.texts.map(textBoxBounds)].filter((r) => !rectIsEmpty(r));
  if (!all.length) return null;
  return { minX: Math.min(...all.map((r) => r.minX)), minY: Math.min(...all.map((r) => r.minY)), maxX: Math.max(...all.map((r) => r.maxX)), maxY: Math.max(...all.map((r) => r.maxY)) };
}

/** Puts an answer on the page per the user's preference; returns where. */
export async function putAnswer(doc: NoteDocument, pageIndex: number, text: string, near: Rect | null): Promise<PlacedAnswer> {
  const { answerIn, answerStyle } = useInkPrefs.getState();
  return answerIn === 'ink' ? writeInInk(doc, pageIndex, text, { near, style: answerStyle }) : placeTypedAnswer(doc, pageIndex, text, near);
}

/** Keeps where an answer came from, for Explain (only while the compiler module is on). */
export async function recordAnswerProvenance(doc: NoteDocument, placed: PlacedAnswer, text: string, passages: readonly Passage[], gen: ProvenanceGen): Promise<void> {
  if (!isModuleOn('compiler')) return;
  const key = placed.textId ? `text:${placed.textId}` : `ink:${placed.strokeIds[0]}`;
  const { allDocs, cachedDoc, recordProvenance } = await import('../compiler/service.ts');
  await allDocs();
  const claims = attributedClaims(attributeAnswer(text, passages), (id) => cachedDoc(id)?.units ?? null);
  await recordProvenance(doc.meta.id, key, gen, claims.length ? claims : [{ s: text, t: 'I', src: [] }]);
}

/** Asks the AI about a selection and writes the answer next to it. */
export async function answerSelectionHere(o: { vault: AppVault; doc: NoteDocument; engine: InkEngine | null; sel: Selection; signal?: AbortSignal }): Promise<{ text: string; placed: PlacedAnswer }> {
  const { doc, sel } = o;
  const near = selectionBounds(sel);
  // Text first: the selected handwriting is recognized on the device right now (lib/assistant),
  // so small on-device models read "2+2=" instead of a picture they would misdescribe.
  const read = await selectionText(doc, sel.pageIndex, sel.strokes.map((s) => s.id), sel.texts.map((t) => t.id));
  const typed = sel.texts.map((t) => t.text).join('\n');
  const recognized = read.text.split('\n').filter((l) => !typed.includes(l)).join('\n');
  const hasInk = sel.strokes.length > 0;
  const noText = !read.text.trim();
  const ai = await aiForNote(doc.meta, { source: 'ink-answer', task: hasInk && noText ? 'vision' : 'chat' });
  // A picture only to strong vision models (not small on-device ones), and only when it can add something.
  const picture = hasInk && near && sendsImagesTo(ai);
  if (noText && !picture) throw new Error(hasInk ? 'I couldn’t read this handwriting on this device. Try writing a little larger, or choose a vision model in Settings › AI.' : 'Select some writing to answer.');
  const parts: ContentPart[] = [{ type: 'text', text: 'Answer what is written in this part of my page. If it is a sum or an equation, work it out.' }];
  if (typed) parts.push({ type: 'text', text: `Typed there:\n${typed}` });
  if (recognized) parts.push({ type: 'text', text: `Handwriting there (recognized):\n${recognized}` });
  if (picture && near) {
    const img = await pageImageForAI(o.vault, doc.meta, [...doc.pages], sel.pageIndex, { minX: near.minX - 8, minY: near.minY - 8, maxX: near.maxX + 8, maxY: near.maxY + 8 });
    parts.push({ type: 'image', mediaType: img.mediaType, data: img.base64 });
  }
  const text = await askOnce(ai, SYSTEM, parts, o.signal);
  if (!text) throw new Error('The AI gave no answer');
  o.engine?.clearSelection();
  const placed = await putAnswer(doc, sel.pageIndex, text, near);
  const { genFor } = await import('../compiler/explain.ts');
  const gen = genFor(ai, INK_ANSWER_PROMPT_ID);
  const passages: Passage[] = [{ noteId: doc.meta.id, title: doc.meta.title, pageIndex: sel.pageIndex, text: [typed, recognized].filter(Boolean).join('\n') || '(handwriting read from the picture)', ...(near ? { rect: near } : {}) }];
  void recordAnswerProvenance(doc, placed, text, passages, gen).catch((e) => console.warn('provenance not kept', e));
  const toast = useApp.getState().toast;
  toast({ text: 'Answered on the page', action: { label: 'Undo', run: () => (o.engine ? o.engine.undo() : doc.undo()) } });
  return { text, placed };
}

/** The assistant panel's "Write in ink" for a reply (when the module is on). */
export function inkReplyActions(doc: NoteDocument, engine: InkEngine, text: string, read: readonly Passage[], gen: ProvenanceGen): { label: string; run: () => void }[] {
  if (!isModuleOn('ink-answers') || !text.trim()) return [];
  return [{
    label: useInkPrefs.getState().answerIn === 'ink' ? 'Write in ink' : 'Write the answer here',
    run: () => void putAnswer(doc, engine.currentPageIndex, text, null)
      .then((placed) => { void recordAnswerProvenance(doc, placed, text, read, gen).catch(() => {}); useApp.getState().toast({ text: 'Added to the page', action: { label: 'Undo', run: () => engine.undo() } }); })
      .catch((e) => useApp.getState().fail((e as Error).message)),
  }];
}
