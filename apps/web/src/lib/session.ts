import { NoteDocument, type NoteMeta, type PageInk } from '@inkstone/core';
import { mergeNote, mergePage } from '@inkstone/sync';
import { useApp } from '../state/app.ts';
import { recognizeLocally } from './recognition.ts';
import { scheduleSync } from './sync.ts';
import type { AppVault } from './vault.ts';

let current: EditorSession | null = null;
/** The note open in the editor, if any (sync saves and reloads it around a run). */
export const activeSession = () => current;

/** Sessions whose final save failed; retried until they succeed so no edit is lost. */
const pendingSaves = new Set<EditorSession>();
let pendingTimer: ReturnType<typeof setInterval> | null = null;

/**
 * An open note: the editable document plus autosave (debounced, crash-safe on hide/close),
 * search indexing and background handwriting recognition.
 */
export class EditorSession {
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving: Promise<void> = Promise.resolve();
  private recogTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private unsub: () => void;
  private closed = false;
  savedAt = 0;
  onSaved?: (state: 'saving' | 'saved' | 'error') => void;

  private constructor(readonly vault: AppVault, readonly doc: NoteDocument) {
    this.unsub = doc.subscribe(() => this.scheduleSave());
    window.addEventListener('pagehide', this.flushSync);
    document.addEventListener('visibilitychange', this.onVisibility);
    current = this;
  }

  static async open(vault: AppVault, noteId: string): Promise<EditorSession | null> {
    const note = await vault.vault.readNote(noteId);
    if (!note) return null;
    const pages = await vault.vault.readPages(note);
    return new EditorSession(vault, new NoteDocument(note, pages));
  }

  private onVisibility = () => {
    if (document.visibilityState === 'hidden') void this.flush();
  };

  private flushSync = () => { void this.flush(); };

  scheduleSave(delay = 650) {
    if (this.closed && !pendingSaves.has(this)) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flush(), delay);
  }

  /** Writes pending changes now. Safe to call repeatedly. */
  flush(): Promise<void> {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.saving = this.saving.then(async () => {
      const snap = this.doc.takeDirty();
      if (!snap) return;
      this.onSaved?.('saving');
      try {
        await this.vault.vault.saveNote(snap.meta, snap.pages, { changedPageIds: snap.changedPageIds, removedPageIds: snap.removedPageIds });
        this.vault.indexNote(snap.meta, snap.pages);
        this.vault.forgetThumb(snap.meta.id);
        this.savedAt = Date.now();
        this.onSaved?.('saved');
        updateListEntry(snap.meta);
        scheduleSync();
      } catch (e) {
        console.error('save failed', e);
        this.doc.restoreDirty(snap);
        this.onSaved?.('error');
        useApp.getState().fail('Could not save this note. Your changes are kept and will be retried.');
        this.scheduleSave(3000);
      }
    });
    return this.saving;
  }

  /** Recognize a page's handwriting a moment after the writer pauses. */
  scheduleRecognition(pageIndex: number, delay = 2200) {
    const page = this.doc.pages[pageIndex];
    if (!page) return;
    const id = page.id;
    const prev = this.recogTimers.get(id);
    if (prev) clearTimeout(prev);
    this.recogTimers.set(id, setTimeout(async () => {
      this.recogTimers.delete(id);
      const i = this.doc.indexOfPage(id);
      if (i < 0 || this.closed) return;
      try {
        const r = await recognizeLocally(this.doc.page(i).strokes);
        if (r) this.doc.setRecognizedText(id, r.text, r.engine, r.lines);
      } catch (e) {
        console.warn('recognition failed', e);
      }
    }, delay));
  }

  /**
   * Sync changed this note on disk (another device edited it). Brings those changes in; pages
   * edited here while sync ran are merged stroke-by-stroke instead of overwritten.
   */
  async reloadAfterSync(base: Map<string, PageInk>, baseMeta: NoteMeta): Promise<void> {
    const doc = this.doc;
    const disk = await this.vault.vault.readNote(doc.meta.id);
    if (!disk) {
      // Deleted on another device while open here: keep it (an edit beats a delete) and re-save.
      doc.replaceContent(doc.meta, [...doc.committedPages], doc.committedPages.map((p) => p.id));
      this.scheduleSave(0);
      return;
    }
    const remote = await this.vault.vault.readPages(disk);
    const dirty = new Set(doc.dirtyPageIds);
    if (!doc.isDirty) {
      doc.replaceContent(disk, remote);
      return;
    }
    const localById = new Map(doc.committedPages.map((p) => [p.id, p]));
    const merged = remote.map((rp) => {
      const lp = localById.get(rp.id);
      return lp && dirty.has(rp.id) ? mergePage(base.get(rp.id) ?? null, lp, rp) : rp;
    });
    // Pages added here during the sync run.
    for (const lp of doc.committedPages) if (!merged.some((p) => p.id === lp.id) && dirty.has(lp.id)) merged.push(lp);
    const meta = mergeNote(baseMeta, doc.meta, disk);
    const order = meta.pageIds.filter((id) => merged.some((p) => p.id === id));
    const pages = [...order.map((id) => merged.find((p) => p.id === id)!), ...merged.filter((p) => !order.includes(p.id))];
    doc.replaceContent(meta, pages, [...dirty]);
    this.scheduleSave();
  }

  async close() {
    this.closed = true;
    for (const t of this.recogTimers.values()) clearTimeout(t);
    await this.flush();
    if (this.doc.isDirty) {
      // The final save failed: keep retrying in the background until it lands.
      pendingSaves.add(this);
      pendingTimer ??= setInterval(() => {
        for (const s of [...pendingSaves]) void s.flush().then(() => { if (!s.doc.isDirty) pendingSaves.delete(s); });
        if (!pendingSaves.size && pendingTimer) { clearInterval(pendingTimer); pendingTimer = null; }
      }, 5000);
    }
    this.unsub();
    window.removeEventListener('pagehide', this.flushSync);
    document.removeEventListener('visibilitychange', this.onVisibility);
    if (current === this) current = null;
  }
}

function updateListEntry(meta: NoteMeta) {
  const s = useApp.getState();
  if (s.notes.some((n) => n.id === meta.id)) useApp.setState({ notes: s.notes.map((n) => (n.id === meta.id ? meta : n)) });
  else void s.refresh();
}
