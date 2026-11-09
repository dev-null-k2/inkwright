/**
 * Pen gestures for meetings: a star drawn while recording marks the moment (it stays on the page
 * as ink, the moment is saved with the transcript and the enhanced notes are told to cover it).
 * Called by the editor after each stroke, only while this note is being recorded.
 */
import { isStarStroke, type NoteDocument } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { markMoment, useListen } from '../lib/listen/session.ts';

export function onMeetingInk(doc: NoteDocument, pageIndex: number): void {
  const live = useListen.getState();
  if (live.noteId !== doc.meta.id || live.status === 'idle') return;
  const page = doc.pages[pageIndex];
  const last = page?.strokes.reduce<(typeof page.strokes)[number] | null>((a, s) => (!a || s.createdAt > a.createdAt ? s : a), null);
  if (!last || Date.now() - last.createdAt > 15_000 || !isStarStroke(last)) return;
  if (markMoment('Starred') != null) useApp.getState().toast({ text: 'Starred — this moment will be in your notes' });
}
