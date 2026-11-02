/**
 * "Explain this answer" for the assistant panel: what the model read during a turn (search hits,
 * notes it opened) becomes the passages its sentences are attributed to (core attribute.ts), and
 * text the user then puts on a page — an answer or a summary — keeps that provenance in the
 * note's provenance file, so "Sources of AI text" can explain it later too.
 */
import { attributeAnswer, attributedClaims, newId, pageText, textItemKey, type NoteDocument, type Passage, type ProvenanceGen, type TextBox } from '@inkstone/core';
import { parseMemoryLink } from '@inkstone/ai';
import { allDocs, cachedDoc, recordProvenance } from './service.ts';
import { openExplain } from './ui/dialogs.tsx';

export const ASSISTANT_PROMPT_ID = 'assistant.chat/1';

/** Adds what a tool returned to the passages of this turn (search_memory, read_note, search_notes). */
export function collectPassages(tool: string, result: unknown, into: Passage[]): void {
  const r = result as Record<string, any> | null;
  if (!r || typeof r !== 'object') return;
  if (tool === 'search_memory' && Array.isArray(r.results)) {
    for (const h of r.results) {
      const at = typeof h.link === 'string' ? parseMemoryLink(h.link) : null;
      into.push({ noteId: String(h.note_id), title: String(h.title ?? ''), pageIndex: Math.max(0, Number(h.page ?? 1) - 1), text: String(h.text ?? ''), ...(at?.rect ? { rect: { minX: at.rect.x, minY: at.rect.y, maxX: at.rect.x + at.rect.width, maxY: at.rect.y + at.rect.height } } : {}), ...(at?.seek ? { clip: at.seek.clipId, ms: at.seek.ms } : {}) });
    }
  } else if (tool === 'read_note' && r.meta && Array.isArray(r.pages)) {
    for (const p of r.pages) if (p.text) into.push({ noteId: String(r.meta.id), title: String(r.meta.title ?? ''), pageIndex: Number(p.index ?? 0), text: String(p.text) });
  } else if (tool === 'search_notes' && Array.isArray(r.results ?? r.hits)) {
    for (const h of r.results ?? r.hits) if (h.snippet || h.text) into.push({ noteId: String(h.note_id ?? h.noteId), title: String(h.title ?? ''), pageIndex: Math.max(0, Number(h.page ?? 1) - 1), text: String(h.snippet ?? h.text) });
  }
}

/** The open note's own pages as passages (for quick actions like Summarize). */
export function notePassages(doc: NoteDocument): Passage[] {
  return doc.pages.map((p, i) => ({ noteId: doc.meta.id, title: doc.meta.title, pageIndex: i, text: pageText(p) })).filter((p) => p.text.trim());
}

export function genFor(ai: { label: string; model: string; provider: { id: string } }, prompt = ASSISTANT_PROMPT_ID): ProvenanceGen {
  return { by: ai.label, provider: ai.label.startsWith('On this device') ? 'device' : ai.provider.id, model: ai.model, prompt, at: Date.now() };
}

/** Opens Explain for an answer. */
export async function explainAnswer(title: string, text: string, passages: readonly Passage[], gen: ProvenanceGen): Promise<void> {
  await allDocs();
  const sentences = attributeAnswer(text, passages);
  const claims = attributedClaims(sentences, (id) => cachedDoc(id)?.units ?? null);
  openExplain({
    title,
    note: passages.length ? `Compared with ${passages.length} ${passages.length === 1 ? 'passage' : 'passages'} the model read.` : 'The model read nothing from your notes for this answer.',
    sentences: sentences.map((s) => ({ text: s.text, claim: claims.find((c) => c.s === s.text) ?? null, gen })),
  });
}

/** Puts an answer on the page as a text box (undoable) and keeps its provenance with the note. */
export async function insertAnswer(doc: NoteDocument, pageIndex: number, text: string, passages: readonly Passage[], gen: ProvenanceGen): Promise<void> {
  const page = doc.page(pageIndex);
  const ys = [...page.strokes.flatMap((s) => s.points.map((p) => p.y)), ...(page.texts ?? []).map((t) => t.y + 60)];
  const box: TextBox = { id: newId(), x: 64, y: ys.length ? Math.max(...ys) + 32 : 96, width: (doc.meta.pageSize.width || 794) - 128, text, fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now(), origin: 'ai' };
  doc.upsertText(pageIndex, box, 'AI text');
  await allDocs();
  const claims = attributedClaims(attributeAnswer(text, passages), (id) => cachedDoc(id)?.units ?? null);
  if (claims.length) await recordProvenance(doc.meta.id, textItemKey(box.id), gen, claims);
}

/** Saving an AI summary as the note's summary keeps where its sentences came from. */
export async function recordSummaryProvenance(doc: NoteDocument, text: string, gen: ProvenanceGen): Promise<void> {
  await allDocs();
  const claims = attributedClaims(attributeAnswer(text, notePassages(doc)), (id) => cachedDoc(id)?.units ?? null);
  if (claims.length) await recordProvenance(doc.meta.id, 'summary', gen, claims);
}
