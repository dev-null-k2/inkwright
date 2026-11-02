import { NoteDocument, type Rect } from '@inkstone/core';
import type { AgentTool } from '@inkstone/ai';
import { activeSession } from '../lib/session.ts';
import { useApp } from '../state/app.ts';
import { aiCanSee } from '../lib/trust/state.ts';
import { useInkPrefs } from '../inkactions/prefs.ts';
import { writeInInk } from './write.ts';

/**
 * `write_in_ink(noteId, page, text, near?)`: the assistant writes on a page in AI handwriting.
 * On the open note it is written on live (and undoable there, one step); on another note it is
 * committed through a `NoteDocument` (so the authorship chain records AI ink) and saved.
 */
export function writeInInkTool(): AgentTool<{ noteId: string; page?: number; text: string; near?: { x: number; y: number; width: number; height: number } }> {
  return {
    name: 'write_in_ink',
    description: 'Write text on a note page in handwriting (marked as AI ink, never as the user\'s). Use it when the user asks you to write, answer or annotate "in ink" or "on the page". `page` is 1-based (default: the last page). `near` (page units: x, y, width, height) puts the writing next to that area, e.g. the question it answers.',
    parameters: {
      type: 'object',
      properties: {
        noteId: { type: 'string' },
        page: { type: 'integer', minimum: 1 },
        text: { type: 'string', description: 'Plain text, at most a few sentences.' },
        near: { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' } } },
      },
      required: ['noteId', 'text'],
    },
    async execute(a) {
      if (!a.text?.trim()) throw new Error('text is empty');
      if (a.text.length > 1500) throw new Error('That is too long to write by hand; put long text in a text box (append_to_note) instead.');
      if (!aiCanSee(a.noteId)) throw new Error('This note is not available to AI.');
      const near: Rect | null = a.near ? { minX: a.near.x, minY: a.near.y, maxX: a.near.x + a.near.width, maxY: a.near.y + a.near.height } : null;
      const style = useInkPrefs.getState().answerStyle;
      const open = activeSession()?.doc;
      if (open && open.meta.id === a.noteId) {
        const pageIndex = Math.max(0, Math.min(open.pageCount - 1, (a.page ?? open.pageCount) - 1));
        const placed = await writeInInk(open, pageIndex, a.text, { near, style, label: 'Assistant wrote in ink' });
        return { ok: true, page: placed.pageIndex + 1, strokes: placed.strokeIds.length, where: placed.rect, undo: 'The user can undo it in the open note.' };
      }
      const vault = useApp.getState().vault;
      if (!vault) throw new Error('The vault is not open');
      const meta = await vault.vault.readNote(a.noteId);
      if (!meta || meta.trashedAt) throw new Error(`No note with id "${a.noteId}"`);
      if (meta.lock) throw new Error('That note is locked.');
      const pages = await vault.vault.readPages(meta);
      const doc = new NoteDocument(meta, pages);
      const pageIndex = Math.max(0, Math.min(doc.pageCount - 1, (a.page ?? doc.pageCount) - 1));
      const placed = await writeInInk(doc, pageIndex, a.text, { near, style, animate: false, label: 'Assistant wrote in ink' });
      const snap = doc.takeDirty();
      if (snap) {
        await vault.vault.saveNote(snap.meta, [...snap.pages], { changedPageIds: [...snap.changedPageIds] });
        vault.indexNote(snap.meta, [...snap.pages]);
        await useApp.getState().refresh();
      }
      return { ok: true, page: placed.pageIndex + 1, strokes: placed.strokeIds.length, where: placed.rect };
    },
  };
}
