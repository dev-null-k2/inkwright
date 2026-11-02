/**
 * Per-page and whole-lecture summaries. A page's summary is written from what is on the page and
 * the transcript segments spoken while it was being written (`bucketSegmentsByPage`); the lecture
 * summary (with key terms and to-dos) from the whole transcript. Both use the active AI — on this
 * device by default — and are stored in the vault (transcripts.ts).
 */
import {
  cleanSummary,
  lectureSummaryMessages,
  pageSummaryMessages,
  parseLectureSummary,
  stampLines,
} from '@inkstone/ai';
import {
  bucketSegmentsByPage,
  newId,
  pageText,
  type LectureSummary,
  type NoteDocument,
  type NoteMeta,
  type PageInk,
  type PageSummary,
  type RecordingTranscript,
  type TextBox,
} from '@inkstone/core';
import { getActiveAI, type ActiveAI } from '../ai.ts';
import type { AppVault } from '../vault.ts';
import { loadNoteTranscripts, updatePageSummaries, writeTranscript } from './transcripts.ts';

export class NoAIError extends Error {
  constructor() {
    super('Summaries need an AI. Download the on-device model or connect a provider in Settings › AI.');
    this.name = 'NoAIError';
  }
}

async function chat(ai: ActiveAI, messages: Parameters<ActiveAI['provider']['chat']>[0]['messages'], maxTokens: number, signal?: AbortSignal): Promise<string> {
  const r = await ai.provider.chat({ model: ai.model, messages, temperature: 0.2, maxTokens, signal });
  return r.text;
}

/** Pages that a set of recordings talked over (or, without recordings, every page with content). */
export function pagesToSummarize(pages: readonly PageInk[], recordings: readonly RecordingTranscript[]): number[] {
  if (recordings.length) return [...bucketSegmentsByPage(pages, recordings).keys()].sort((a, b) => a - b);
  return pages.map((p, i) => (pageText(p).trim() || p.strokes.length ? i : -1)).filter((i) => i >= 0);
}

/**
 * Writes summaries for `pageIndexes` (default: the pages the recordings cover) and stores them.
 * `onPage` reports each one as it is done.
 */
export async function summarizePages(vault: AppVault, note: Pick<NoteMeta, 'id' | 'title' | 'recordings'>, pages: readonly PageInk[], opts: { pageIndexes?: number[]; clipIds?: string[]; signal?: AbortSignal; ai?: ActiveAI | null; onPage?: (pageIndex: number, s: PageSummary) => void } = {}): Promise<Map<number, PageSummary>> {
  const ai = opts.ai ?? (await getActiveAI({ task: 'background', source: 'listen', label: 'Page summaries', notes: [note] }));
  if (!ai) throw new NoAIError();
  const all = await loadNoteTranscripts(vault, note);
  const recordings = opts.clipIds ? all.filter((r) => opts.clipIds!.includes(r.clip.id)) : all;
  const buckets = bucketSegmentsByPage(pages, all);
  const targets = opts.pageIndexes ?? pagesToSummarize(pages, recordings);
  const out = new Map<number, PageSummary>();
  for (const i of targets) {
    const page = pages[i];
    if (!page) continue;
    const said = buckets.get(i) ?? [];
    const text = pageText(page);
    if (!said.length && !text.trim()) continue;
    const lines = said.map((x) => ({ ms: x.segment.startMs, text: x.segment.text }));
    const raw = await chat(ai, pageSummaryMessages({ title: note.title, pageNumber: i + 1, pageText: text, said: lines }), 300, opts.signal);
    const summary: PageSummary = { text: cleanSummary(raw), at: Date.now(), by: ai.label, clipIds: [...new Set(said.map((x) => x.clip.id))] };
    if (!summary.text) continue;
    out.set(i, summary);
    await updatePageSummaries(vault, note.id, { [page.id]: summary });
    opts.onPage?.(i, summary);
  }
  return out;
}

/** The whole recording's summary, key terms and to-dos, saved into its transcript file. */
export async function summarizeLecture(vault: AppVault, note: Pick<NoteMeta, 'id' | 'title' | 'recordings'>, pages: readonly PageInk[], clipId: string, opts: { signal?: AbortSignal; ai?: ActiveAI | null } = {}): Promise<LectureSummary | null> {
  const ai = opts.ai ?? (await getActiveAI({ task: 'heavy', source: 'listen', label: 'Lecture summary', notes: [note] }));
  if (!ai) throw new NoAIError();
  const rec = (await loadNoteTranscripts(vault, note)).find((r) => r.clip.id === clipId);
  if (!rec || !rec.file.segments.length) return null;
  const notesText = pages.map((p) => pageText(p)).filter(Boolean).join('\n\n');
  const raw = await chat(ai, lectureSummaryMessages({ title: note.title, transcript: stampLines(rec.file.segments), notesText }), 700, opts.signal);
  const parsed = parseLectureSummary(raw);
  if (!parsed.summary && !parsed.keyTerms.length && !parsed.todos.length) return null;
  const lecture: LectureSummary = { ...parsed, at: Date.now(), by: ai.label };
  await writeTranscript(vault, note.id, { ...rec.file, lecture, updatedAt: Date.now() });
  return lecture;
}

/** Places a page summary on the page as a text note, below what is there. */
export function addPageNote(doc: NoteDocument, pageIndex: number, summary: string): void {
  const page = doc.page(pageIndex);
  const ys = [...page.strokes.flatMap((s) => s.points.map((p) => p.y)), ...(page.texts ?? []).map((t) => t.y + 60)];
  const y = ys.length ? Math.max(...ys) + 32 : 96;
  const width = (doc.meta.pageSize.width || 794) - 128;
  const box: TextBox = { id: newId(), x: 64, y, width, text: `**Summary**\n${summary}`, fontSize: 14, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() };
  doc.upsertText(pageIndex, box, 'Add page summary');
}

/** Markdown for a lecture summary (inserting it on a page, or giving it to a routine). */
export function lectureMarkdown(l: LectureSummary): string {
  return [
    l.summary,
    l.keyTerms.length ? `**Key terms:** ${l.keyTerms.join(', ')}` : '',
    l.todos.length ? `**To-do**\n${l.todos.map((t) => `- [ ] ${t}`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
