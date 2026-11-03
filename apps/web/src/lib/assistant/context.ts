/**
 * What the assistant reads before a small on-device model answers (retrieval first, see
 * packages/ai/src/local/grounding.ts): the page being looked at — its handwriting recognized on
 * the device right now if it hasn't been, or has changed since — the lassoed selection as text,
 * the best passages from every note, and the long-term memory items that matter.
 *
 * Also decides which models get images: only strong vision models (cloud providers, or a server
 * the person runs). Small on-device models read text; a picture of "2+2=" sent to a phone's image
 * describer came back as "the Roman numeral fifteen followed by a downward arrow".
 */
import {
  buildGrounding,
  contextBudget,
  type Grounding,
  type MemoryHit,
  type MemoryItem,
} from '@inkwright/ai';
import { isReadableLine, pageText, readableText, segmentLines, type InkStroke, type NoteDocument, type PageInk, type RecognizedLine } from '@inkwright/core';
import type { ActiveAI } from '../ai.ts';
import { appMemory } from '../memory.ts';
import { recognizeLocally } from '../recognition.ts';
import { aiCanSee } from '../trust/state.ts';
import type { AppVault } from '../vault.ts';

/** On-device engines (phone, browser worker, Chrome's model): small context, text only. */
export function isSmallModel(ai: Pick<ActiveAI, 'local' | 'budgetKey'> | null | undefined): boolean {
  return !!ai?.local && ai.budgetKey === 'device';
}

/**
 * Whether to send pictures of handwriting to this model. Only vision models that are not small
 * on-device ones: a 2B model's reading of a sketch is worse than the recognizer's text.
 */
export function sendsImagesTo(ai: Pick<ActiveAI, 'vision' | 'local' | 'budgetKey'> | null | undefined): boolean {
  return !!ai?.vision && !isSmallModel(ai);
}

/** The context window to budget for (tokens); 4096 when the engine doesn't say. */
export function contextTokensOf(ai: Pick<ActiveAI, 'contextTokens'> | null | undefined): number {
  return ai?.contextTokens && ai.contextTokens > 0 ? ai.contextTokens : 4096;
}

/** The page has ink written after its recognized text (or none was recognized yet). */
export function needsRecognition(page: PageInk): boolean {
  if (!page.strokes.length) return false;
  if (!page.recognizedText?.trim()) return true;
  const at = page.recognizedAt ?? 0;
  return page.strokes.some((s) => s.createdAt > at);
}

/**
 * Recognizes the page's handwriting on the device when it needs it, and stores the result on the
 * page (so search, the next question and every other feature see it). Returns whether text was
 * added. Without an on-device recognizer it does nothing (the caller says the ink is unread).
 */
export async function ensurePageRecognized(doc: NoteDocument, pageIndex: number): Promise<boolean> {
  const page = doc.pages[pageIndex];
  if (!page || !needsRecognition(page)) return false;
  const r = await recognizeLocally(page.strokes).catch(() => null);
  if (!r || !r.text.trim()) return false;
  const lines: RecognizedLine[] = r.lines.filter((l) => isReadableLine(l.text));
  doc.setRecognizedText(page.id, lines.map((l) => l.text).join('\n') || r.text, r.engine, lines);
  return true;
}

export interface SelectionText {
  text: string;
  /** Selected handwriting that nothing could read. */
  unreadInk: boolean;
}

/**
 * The text of a lasso selection: typed boxes, the page's recognized lines that belong to the
 * selected strokes, and — when the selected ink has no recognized line yet — the selected strokes
 * recognized on their own, right now.
 */
export async function selectionText(doc: NoteDocument, pageIndex: number, strokeIds: readonly string[], textIds: readonly string[]): Promise<SelectionText> {
  const page = doc.page(pageIndex);
  const ids = new Set(strokeIds);
  const typed = (page.texts ?? []).filter((t) => textIds.includes(t.id)).map((t) => t.text.trim()).filter(Boolean);
  const strokes: InkStroke[] = page.strokes.filter((s) => ids.has(s.id));
  const known = (page.recognizedLines ?? []).filter((l) => l.strokeIds.some((id) => ids.has(id)));
  const covered = new Set(known.flatMap((l) => l.strokeIds));
  const fresh = strokes.filter((s) => !covered.has(s.id) || s.createdAt > (page.recognizedAt ?? 0));
  let recognized = known.map((l) => l.text);
  if (fresh.length) {
    // Recognize the whole selection again so its lines come out in reading order.
    const r = await recognizeLocally(segmentLines(strokes).flatMap((l) => l.strokes)).catch(() => null);
    if (r?.text.trim()) recognized = r.lines.map((l) => l.text);
  }
  const text = [...typed, readableText(recognized.join('\n'))].filter((s) => s.trim()).join('\n');
  return { text, unreadInk: strokes.length > 0 && !recognized.some((l) => l.trim()) };
}

export interface GatherOptions {
  ai: ActiveAI;
  vault: AppVault;
  question: string;
  /** The note open in the editor and the page on screen (0-based). */
  doc?: NoteDocument | null;
  pageIndex?: number;
  /** A lasso selection to answer about. */
  selection?: { pageIndex: number; strokeIds: readonly string[]; textIds: readonly string[] } | null;
  /** Long-term memory items (the hub's store). */
  memory?: readonly MemoryItem[];
}

/** Gathers everything a small model needs to answer `question`, recognizing handwriting first. */
export async function gatherGrounding(o: GatherOptions): Promise<Grounding> {
  const doc = o.doc ?? null;
  const pageIndex = Math.max(0, Math.min((doc?.pageCount ?? 1) - 1, o.pageIndex ?? 0));
  if (doc) await ensurePageRecognized(doc, pageIndex);
  const sel = doc && o.selection ? await selectionText(doc, o.selection.pageIndex, o.selection.strokeIds, o.selection.textIds) : null;
  const hits = await searchHits(o.vault, o.question);
  return buildGrounding({
    question: o.question,
    ...(doc ? {
      openNote: {
        id: doc.meta.id,
        title: doc.meta.title,
        currentPage: pageIndex + 1,
        pages: doc.pages.map((p, i) => {
          const text = pageText(p);
          return { page: i + 1, text, unreadInk: p.strokes.length > 0 && !p.recognizedText?.trim() };
        }),
      },
    } : {}),
    ...(sel && o.selection ? { selection: { page: o.selection.pageIndex + 1, text: sel.text, unreadInk: sel.unreadInk } } : {}),
    hits,
    memory: o.memory ?? [],
    budgetChars: contextBudget(contextTokensOf(o.ai)),
  });
}

/** Passages from every note the AI may read: the memory index, else the keyword index. */
async function searchHits(vault: AppVault, question: string): Promise<MemoryHit[]> {
  const mem = appMemory();
  const hits: MemoryHit[] = mem
    ? await mem.searchMemory(question, { limit: 5 }).catch(() => [])
    : vault.search.search(question, { limit: 5 }).map((h) => ({ noteId: h.noteId, title: h.title, pageIndex: h.pageIndex ?? 0, source: 'text' as const, text: h.snippet.replace(/[«»]/g, ''), score: h.score }));
  return hits.filter((h) => aiCanSee(h.noteId)).map((h) => (h.source === 'handwriting' ? { ...h, text: readableText(h.text) } : h)).filter((h) => h.text.trim());
}

/**
 * The whole note as text for summaries, to-dos, flashcards and translation: typed text as written,
 * recognized handwriting with unreadable lines (scribbles turned into symbol soup) left out.
 */
export function noteTextForAI(doc: NoteDocument): string {
  return doc.pages
    .map((p) => pageText(p.recognizedText ? { ...p, recognizedText: readableText(p.recognizedText) } : p))
    .filter((t) => t.trim())
    .join('\n\n');
}
