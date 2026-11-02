/**
 * Moments ↔ notes: what you wrote while something was on screen. Every stroke and text box
 * carries its time (`createdAt` + point times), so the notes written around a capture are found
 * exactly, page by page, and the timeline can open the note at the very ink.
 */
import type { NoteMeta, PageInk } from '../model.ts';
import { inkWrittenBetween } from '../transcript.ts';
import { strokeSpan } from '../transcript.ts';
import type { Rect } from '../geometry.ts';
import type { NoteSpan } from './search.ts';

export interface NoteMoment {
  noteId: string;
  title: string;
  pageIndex: number;
  strokeIds: string[];
  textIds: string[];
  bounds: Rect;
  /** First and last ink time within the window (epoch ms). */
  from: number;
  to: number;
}

/** Notes that might have ink in `[from, to]`: edited after it began and created before it ended. */
export function candidateNotes<N extends Pick<NoteMeta, 'createdAt' | 'updatedAt' | 'trashedAt'>>(notes: readonly N[], from: number, to: number): N[] {
  return notes.filter((n) => n.trashedAt == null && n.updatedAt >= from && n.createdAt <= to);
}

/** Ink written in `[from, to]` in these notes, per page. */
export function inkMomentsBetween(notes: ReadonlyArray<{ meta: Pick<NoteMeta, 'id' | 'title'>; pages: readonly PageInk[] }>, from: number, to: number): NoteMoment[] {
  const out: NoteMoment[] = [];
  for (const { meta, pages } of notes) {
    for (const m of inkWrittenBetween(pages, from, to)) {
      const page = pages[m.pageIndex]!;
      const times: number[] = [];
      for (const s of page.strokes) if (m.strokeIds.includes(s.id)) times.push(...strokeSpan(s));
      for (const t of page.texts ?? []) if (m.textIds.includes(t.id)) times.push(t.createdAt);
      const lo = Math.max(from, Math.min(...times));
      const hi = Math.min(to, Math.max(...times));
      out.push({ noteId: meta.id, title: meta.title, pageIndex: m.pageIndex, strokeIds: m.strokeIds, textIds: m.textIds, bounds: m.bounds, from: lo, to: hi });
    }
  }
  return out.sort((a, b) => a.from - b.from);
}

/** One span per note (first to last ink in the window), for search context ("lecture"). */
export function noteSpans(moments: readonly NoteMoment[]): NoteSpan[] {
  const by = new Map<string, NoteSpan>();
  for (const m of moments) {
    const s = by.get(m.noteId);
    if (s) { s.from = Math.min(s.from, m.from); s.to = Math.max(s.to, m.to); }
    else by.set(m.noteId, { noteId: m.noteId, title: m.title, from: m.from, to: m.to });
  }
  return [...by.values()];
}

/** The moments within `slackMs` of `at`, nearest first (for "written at the same time"). */
export function momentsNear(moments: readonly NoteMoment[], at: number, slackMs = 5 * 60_000): NoteMoment[] {
  const dist = (m: NoteMoment) => (at < m.from ? m.from - at : at > m.to ? at - m.to : 0);
  return moments.filter((m) => dist(m) <= slackMs).sort((a, b) => dist(a) - dist(b));
}
