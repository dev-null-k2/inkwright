/**
 * Undo for the AI activity log, through the same paths the user's own edits take: the note open
 * in the editor is changed through its NoteDocument (so the change shows at once, autosaves, and
 * can itself be undone with ⌘Z), every other note through the vault (reindexed, library refreshed).
 */
import { VaultUndoTarget, applyMetaFields, undoOpInRun, undoRun, type ActivityRun, type MetaFields, type UndoResult, type UndoTarget } from '@inkstone/ai';
import { activeSession } from '../session.ts';
import { useApp } from '../../state/app.ts';
import type { AppVault } from '../vault.ts';
import { requireHub } from './hub.ts';

export class AppUndoTarget implements UndoTarget {
  private vaultTarget: VaultUndoTarget;

  constructor(private vault: AppVault) {
    this.vaultTarget = new VaultUndoTarget(vault.vault, async (noteId) => {
      if (noteId) {
        const n = await vault.vault.readNote(noteId);
        if (n && n.trashedAt == null) vault.indexNote(n, await vault.vault.readPages(n));
        else vault.search.remove(noteId);
        vault.forgetThumb(noteId);
      }
      await useApp.getState().refresh();
    });
  }

  private open(noteId: string) {
    const s = activeSession();
    return s && s.doc.meta.id === noteId ? s.doc : null;
  }

  async readMeta(noteId: string) {
    const d = this.open(noteId);
    if (d) {
      const m = d.meta;
      return { title: m.title, tags: [...m.tags], notebookId: m.notebookId ?? null, pinned: m.pinned, summary: m.summary ?? null, trashed: m.trashedAt != null };
    }
    return this.vaultTarget.readMeta(noteId);
  }

  async writeMeta(noteId: string, f: MetaFields) {
    const d = this.open(noteId);
    if (d) {
      d.updateMeta((m) => applyMetaFields(m, f));
      return true;
    }
    return this.vaultTarget.writeMeta(noteId, f);
  }

  async trashNote(noteId: string) {
    const d = this.open(noteId);
    if (d) {
      d.updateMeta((m) => ({ ...m, trashedAt: Date.now() }));
      this.vault.search.remove(noteId);
      return true;
    }
    return this.vaultTarget.trashNote(noteId);
  }

  async restoreNote(noteId: string) {
    const d = this.open(noteId);
    if (d) {
      d.updateMeta((m) => { const { trashedAt: _t, ...rest } = m; return rest as typeof m; });
      return true;
    }
    return this.vaultTarget.restoreNote(noteId);
  }

  async removeText(noteId: string, pageId: string, textId: string, opts: { removePageIfEmpty?: boolean } = {}) {
    const d = this.open(noteId);
    if (!d) return this.vaultTarget.removeText(noteId, pageId, textId, opts);
    const i = d.indexOfPage(pageId);
    if (i < 0 || !(d.page(i).texts ?? []).some((t) => t.id === textId)) return false;
    d.deleteItems(i, { texts: new Set([textId]) }, 'Undo AI text');
    const p = d.page(i);
    if (opts.removePageIfEmpty && d.pageCount > 1 && !p.strokes.length && !(p.texts ?? []).length && !(p.images ?? []).length && !p.background) d.deletePage(i);
    return true;
  }

  notebookNoteCount(id: string) { return this.vaultTarget.notebookNoteCount(id); }

  async deleteNotebook(id: string) {
    const ok = await this.vaultTarget.deleteNotebook(id);
    await useApp.getState().refresh();
    return ok;
  }
}

/** Undoes one action of a logged run and saves the run. */
export async function undoActivityOp(runId: string, opId: string): Promise<UndoResult> {
  const hub = requireHub();
  const run = await hub.activity.get(runId);
  if (!run) return { ok: false, message: 'That run is no longer in the log.' };
  const r = await undoOpInRun(run, opId, new AppUndoTarget(hub.vault));
  await hub.activity.save(run);
  return r;
}

/** Undoes every action of a run (newest first) and saves it. */
export async function undoActivityRun(runId: string): Promise<{ undone: number; notes: string[]; run: ActivityRun | null }> {
  const hub = requireHub();
  const run = await hub.activity.get(runId);
  if (!run) return { undone: 0, notes: ['That run is no longer in the log.'], run: null };
  const res = await undoRun(run, new AppUndoTarget(hub.vault));
  await hub.activity.save(run);
  const notes = [...res.values()].filter((r) => r.message && !r.ok).map((r) => r.message!);
  return { undone: [...res.values()].filter((r) => r.ok).length, notes, run };
}
