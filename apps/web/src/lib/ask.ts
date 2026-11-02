import { buildAskMessages, type AskPassage, type Provider } from '@inkstone/ai';
import { formatStamp, type RankedChunk } from '@inkstone/core';

/**
 * "Ask your notes": find the passages that answer a question (hybrid search over every note) and
 * have the AI answer from them with numbered citations. Each citation keeps the passage's anchor,
 * so tapping [2] opens the note at that page and highlights the handwriting it came from.
 */
export interface AskSource {
  n: number;
  noteId: string;
  title: string;
  pageIndex: number;
  source: RankedChunk['chunk']['source'];
  text: string;
  snippet: string;
  rect?: { x: number; y: number; width: number; height: number };
  /** Speech: where in which recording, and the ink written while it was said. */
  said?: { clipId: string; startMs: number };
  strokeIds?: string[];
}

export interface AskDeps {
  search: (q: string, opts: { limit: number; signal?: AbortSignal }) => Promise<{ results: RankedChunk[]; semantic: boolean }>;
  ai: { provider: Provider; model: string; label: string };
  updatedAt?: (noteId: string) => number | undefined;
  /**
   * The AI policy's view of notes (from lib/trust): passages from notes AI may not see are
   * dropped, and the notes that are used are reported so a local-only one keeps the answer on
   * this device.
   */
  canSee?: (noteId: string) => boolean;
  saw?: (noteIds: string[]) => void;
}

export const SOURCE_KIND: Record<AskSource['source'], string> = { text: 'typed text', handwriting: 'handwriting', pdf: 'PDF', meta: 'note details', speech: 'what was said' };

/** "handwriting", or for speech "what was said at 12:03". */
export function sourceKindLabel(s: { source: AskSource['source']; startMs?: number; said?: { startMs: number } }): string {
  const ms = s.said?.startMs ?? s.startMs;
  return s.source === 'speech' && ms != null ? `${SOURCE_KIND.speech} at ${formatStamp(ms)}` : SOURCE_KIND[s.source];
}

/** Where a source opens: the page region, plus the ink and the moment of the recording for speech. */
export function anchorOf(s: Pick<AskSource, 'noteId' | 'pageIndex' | 'rect' | 'said' | 'strokeIds'>) {
  return { noteId: s.noteId, pageIndex: s.pageIndex, rect: s.rect, ...(s.strokeIds?.length ? { strokeIds: s.strokeIds } : {}), ...(s.said ? { seek: { clipId: s.said.clipId, ms: s.said.startMs } } : {}) };
}

export function toSources(results: RankedChunk[]): AskSource[] {
  return results.map((r, i) => {
    const c = r.chunk;
    return {
      n: i + 1,
      noteId: c.noteId,
      title: c.title,
      pageIndex: c.pageIndex,
      source: c.source,
      text: c.text,
      snippet: r.snippet,
      ...(c.rect ? { rect: { x: c.rect.minX, y: c.rect.minY, width: c.rect.maxX - c.rect.minX, height: c.rect.maxY - c.rect.minY } } : {}),
      ...(c.source === 'speech' && c.clipId ? { said: { clipId: c.clipId, startMs: c.startMs ?? 0 } } : {}),
      ...(c.source === 'speech' && c.strokeIds?.length ? { strokeIds: c.strokeIds } : {}),
    };
  });
}

export async function askNotes(
  question: string,
  deps: AskDeps,
  hooks: { onSources?: (s: AskSource[], semantic: boolean) => void; onDelta?: (textSoFar: string) => void; signal?: AbortSignal; limit?: number } = {},
): Promise<{ answer: string; sources: AskSource[]; label: string }> {
  const found = await deps.search(question, { limit: hooks.limit ?? 8, signal: hooks.signal });
  const { semantic } = found;
  const results = deps.canSee ? found.results.filter((r) => deps.canSee!(r.noteId)) : found.results;
  deps.saw?.([...new Set(results.map((r) => r.noteId))]);
  const sources = toSources(results);
  hooks.onSources?.(sources, semantic);
  const day = (t?: number) => (t ? new Date(t).toISOString().slice(0, 10) : undefined);
  const passages: AskPassage[] = sources.map((s) => ({ n: s.n, title: s.title, page: s.pageIndex + 1, kind: sourceKindLabel(s), text: s.text, updated: day(deps.updatedAt?.(s.noteId)) }));
  const messages = buildAskMessages(question, passages, { today: new Date().toISOString().slice(0, 10) });
  let text = '';
  const r = await deps.ai.provider.chat({ model: deps.ai.model, messages, temperature: 0.2, maxTokens: 700, signal: hooks.signal }, (e) => {
    if (e.type === 'text') {
      text += e.delta;
      hooks.onDelta?.(text);
    }
  });
  return { answer: r.text || text, sources, label: deps.ai.label };
}
