import {
  TemplateStore, dayKey, findDailyNote, findJournal, linkFirstMention, normalizeTitle, parseDayKey, parseWikiTarget,
  renameLinksInPage, resolveWikiTarget, segmentLines, newId, findMentions,
  type InkLink, type Mention, type NoteDocument, type NoteMeta, type NoteTemplate, type PageInk,
} from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { useKnowledge } from '../state/knowledge.ts';
import { noteChanged } from './actions.ts';
import { activeSession } from './session.ts';

export { applyRecognizedLinks, syncDocInlineTags } from './docLinks.ts';

/**
 * The knowledge-base side of the app: following links, keeping links right when notes are renamed,
 * turning mentions and ink into links, `#tags` from the page, daily notes and templates. The pure
 * rules live in @inkwright/core (links.ts, knowledge.ts, daily.ts, templates.ts); this file applies
 * them to the open note or to notes on disk and keeps the library and indexes up to date.
 */

const app = () => useApp.getState();

/** The open note's document, if [noteId] is the note open in the editor. */
function openDoc(noteId: string): NoteDocument | null {
  const s = activeSession();
  return s && s.doc.meta.id === noteId ? s.doc : null;
}

/**
 * Applies a page transform to a note wherever it lives: through the open document (one undo
 * step, autosaved) or straight to its files. Returns whether anything changed.
 */
async function editNotePages(noteId: string, label: string, fn: (page: PageInk, index: number) => PageInk): Promise<boolean> {
  const doc = openDoc(noteId);
  if (doc) {
    let changed = false;
    doc.pages.forEach((_, i) => {
      const before = doc.page(i);
      const after = fn(before, i);
      if (after === before) return;
      changed = true;
      doc.commitBetween(i, before, after, label);
      if (after.recognizedText !== before.recognizedText) doc.setRecognizedText(before.id, after.recognizedText, before.recognizedBy);
    });
    return changed;
  }
  const v = app().vault;
  const note = await v?.vault.readNote(noteId);
  if (!v || !note) return false;
  const pages = await v.vault.readPages(note);
  const changed = new Set<string>();
  const next = pages.map((p, i) => {
    const q = fn(p, i);
    if (q !== p) changed.add(p.id);
    return q;
  });
  if (!changed.size) return false;
  await v.vault.saveNote({ ...note, updatedAt: Date.now() }, next, { changedPageIds: changed });
  await noteChanged(noteId);
  return true;
}

// ---- Following links ------------------------------------------------------------------------

/** Opens a link target that is not a note (e.g. `code:` links, dev/); true when it handled it. */
export type LinkHandler = (target: string) => boolean | Promise<boolean>;
const linkHandlers = new Set<LinkHandler>();

/** Lets an optional module claim link targets before they are treated as note titles. */
export function registerLinkHandler(h: LinkHandler): () => void {
  linkHandlers.add(h);
  return () => linkHandlers.delete(h);
}

/**
 * Opens what a link points at: the note (at the page it names), or — like Obsidian — creates the
 * note when there is none yet. A day like `[[2026-11-02]]` opens (or starts) that daily note.
 */
export async function followLink(target: string, opts: { from?: NoteMeta; noteId?: string } = {}): Promise<void> {
  for (const h of linkHandlers) if (await h(target)) return;
  await activeSession()?.flush();
  const { notes, notebooks, navigate } = app();
  const r = resolveWikiTarget(target, notes, { from: opts.from, notebooks, noteId: opts.noteId });
  if (r) {
    navigate({ name: 'editor', noteId: r.note.id, page: r.pageIndex });
    return;
  }
  const { title } = parseWikiTarget(target);
  if (!title) return;
  const day = parseDayKey(title);
  if (day) { await openDay(day); return; }
  const { createNote } = await import('./actions.ts');
  const id = await createNote({ title, notebookId: opts.from?.notebookId });
  if (id) navigate({ name: 'editor', noteId: id });
}

// ---- Rename -----------------------------------------------------------------------------------

/** Notes whose links currently reach [noteId] (ask before renaming, while titles still match). */
export function linkSources(noteId: string): string[] {
  const v = app().vault;
  if (!v) return [];
  return [...new Set(v.knowledge.backlinks(noteId, app().notebooks).map((b) => b.noteId)).add(noteId)];
}

/**
 * After a note was renamed, rewrites `[[Old title]]` links (and ink links) in the notes that
 * pointed at it. Returns how many notes changed.
 */
export async function updateLinksAfterRename(noteId: string, oldTitle: string, newTitle: string, sources: readonly string[]): Promise<number> {
  if (normalizeTitle(oldTitle) === normalizeTitle(newTitle) && oldTitle.trim() === newTitle.trim()) return 0;
  let n = 0;
  for (const id of sources) {
    if (await editNotePages(id, 'Update links', (p) => renameLinksInPage(p, oldTitle, newTitle, noteId))) n++;
  }
  return n;
}

/** Renames a note from anywhere and keeps every link to it working. */
export async function renameNoteKeepingLinks(noteId: string, newTitle: string): Promise<void> {
  const v = app().vault;
  const note = await v?.vault.readNote(noteId);
  if (!v || !note || !newTitle.trim()) return;
  const sources = linkSources(noteId);
  const doc = openDoc(noteId);
  if (doc) doc.rename(newTitle);
  else await v.vault.updateNote(noteId, (x) => ({ ...x, title: newTitle.trim() }));
  // Links inside the renamed note itself ([[Old#Page 2]]) are kept right too, without counting them.
  await updateLinksAfterRename(noteId, note.title, newTitle.trim(), [noteId]);
  const changed = await updateLinksAfterRename(noteId, note.title, newTitle.trim(), sources.filter((id) => id !== noteId));
  if (!doc) await noteChanged(noteId);
  if (changed) app().toast({ text: `Updated links in ${changed} ${changed === 1 ? 'note' : 'notes'}`, tone: 'success' });
}

// ---- Turning things into links ---------------------------------------------------------------

/** Lays a link over ink: the strokes become tappable and lead to [target]. Replaces older links on that ink. */
export function addInkLink(doc: NoteDocument, pageIndex: number, strokeIds: readonly string[], target: { title: string; noteId?: string; page?: number }): InkLink | null {
  const page = doc.page(pageIndex);
  if (!page || !strokeIds.length) return null;
  const ids = new Set(strokeIds);
  const old = (page.links ?? []).map((item, index) => ({ index, item })).filter((x) => x.item.strokeIds.some((id) => ids.has(id)));
  const link: InkLink = {
    id: newId(), strokeIds: [...strokeIds], target: target.title.replace(/[[\]|#\n]+/g, ' ').trim() + (target.page ? `#Page ${target.page}` : ''),
    noteId: target.noteId, createdAt: Date.now(),
  };
  doc.commit(pageIndex, { label: 'Link to note', links: { removed: old, added: [{ index: (page.links ?? []).length - old.length, item: link }] } });
  return link;
}

/** Removes the links riding on these strokes. */
export function removeInkLinks(doc: NoteDocument, pageIndex: number, strokeIds: readonly string[]): boolean {
  const page = doc.page(pageIndex);
  const ids = new Set(strokeIds);
  const old = (page?.links ?? []).map((item, index) => ({ index, item })).filter((x) => x.item.strokeIds.some((id) => ids.has(id)));
  if (!old.length) return false;
  doc.commit(pageIndex, { label: 'Remove link', links: { removed: old, added: [] } });
  return true;
}

/**
 * Links an unlinked mention: typed text gets `[[…]]` around the words; handwriting gets an ink
 * link over the line that says it (when the recognized lines can be matched to the ink).
 */
export async function linkMention(m: Mention, target: NoteMeta): Promise<boolean> {
  if (m.source === 'text' && m.boxId) {
    return editNotePages(m.noteId, 'Link mention', (p, i) => {
      if (i !== m.pageIndex) return p;
      const texts = p.texts?.map((t) => {
        if (t.id !== m.boxId) return t;
        const text = linkFirstMention(t.text, target.title);
        return text ? { ...t, text } : t;
      });
      return texts && texts.some((t, k) => t !== p.texts![k]) ? { ...p, texts } : p;
    });
  }
  return editNotePages(m.noteId, 'Link mention', (p, i) => {
    if (i !== m.pageIndex || !p.recognizedText) return p;
    const strokeIds = handwrittenLineStrokes(p, target.title);
    if (!strokeIds) return p;
    const link: InkLink = { id: newId(), strokeIds, target: target.title, noteId: target.id, createdAt: Date.now() };
    return { ...p, links: [...(p.links ?? []), link] };
  });
}

/** Strokes of the handwritten line whose recognized text mentions [title], when lines line up. */
export function handwrittenLineStrokes(p: PageInk, title: string): string[] | null {
  const lines = (p.recognizedText ?? '').split('\n').filter((l) => l.trim());
  const segs = segmentLines(p.strokes);
  if (!lines.length || lines.length !== segs.length) return null;
  const k = lines.findIndex((l) => findMentions(l, title).length > 0);
  return k < 0 ? null : segs[k]!.strokes.map((s) => s.id);
}

// ---- Daily notes ------------------------------------------------------------------------------

const JOURNAL_COLOR = '#FF3D7A5A';

/** The Journal notebook, made on first use. */
async function ensureJournal(): Promise<string | undefined> {
  const v = app().vault;
  if (!v) return undefined;
  const prefs = useKnowledge.getState();
  const found = findJournal(app().notebooks, prefs.journalNotebookId);
  if (found) {
    if (found.id !== prefs.journalNotebookId) prefs.update(() => ({ journalNotebookId: found.id }));
    return found.id;
  }
  const nb = await v.vault.createNotebook('Journal', JOURNAL_COLOR);
  prefs.update(() => ({ journalNotebookId: nb.id }));
  await app().refresh();
  return nb.id;
}

/** Opens the daily note for [date], creating it in the Journal with the chosen paper or template. */
export async function openDay(date: Date): Promise<string | null> {
  const v = app().vault;
  if (!v) return null;
  await activeSession()?.flush();
  const key = dayKey(date);
  const existing = findDailyNote(app().notes, key);
  if (existing) {
    app().navigate({ name: 'editor', noteId: existing.id });
    return existing.id;
  }
  const notebookId = await ensureJournal();
  const prefs = useKnowledge.getState();
  let id: string | null = null;
  if (prefs.journalTemplateId) {
    try {
      const made = await new TemplateStore(v.fs).createNote(v.vault, prefs.journalTemplateId, { title: key, date, notebookId, daily: key });
      id = made.note.id;
    } catch {
      prefs.update(() => ({ journalTemplateId: null })); // the template was deleted; fall back to paper
    }
  }
  if (!id) {
    const { note } = await v.vault.createNote({ title: key, paper: prefs.journalPaper, pageSize: prefs.journalPageSize, notebookId });
    await v.vault.updateNote(note.id, (n) => ({ ...n, daily: key }), { touch: false });
    id = note.id;
  }
  await noteChanged(id);
  app().navigate({ name: 'editor', noteId: id });
  return id;
}

export const openToday = () => openDay(new Date());

// ---- Templates --------------------------------------------------------------------------------

export function templateStore(): TemplateStore | null {
  const v = app().vault;
  return v ? new TemplateStore(v.fs) : null;
}

export async function listTemplates(): Promise<NoteTemplate[]> {
  return (await templateStore()?.list()) ?? [];
}

/** Saves the open note as a template (its current content, after a save). */
export async function saveDocAsTemplate(doc: NoteDocument, name: string): Promise<NoteTemplate | null> {
  const v = app().vault;
  const store = templateStore();
  if (!v || !store) return null;
  await activeSession()?.flush();
  return store.saveFromNote(v.vault, doc.meta.id, name, { note: doc.meta, pages: doc.committedPages });
}

/** Creates a note from a template and returns its id. */
export async function createFromTemplate(templateId: string, opts: { notebookId?: string; title?: string } = {}): Promise<string | null> {
  const v = app().vault;
  const store = templateStore();
  if (!v || !store) return null;
  const t = await store.read(templateId);
  if (!t) return null;
  const now = new Date();
  const title = opts.title ?? `${t.name} ${now.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  const made = await store.createNote(v.vault, templateId, { title, notebookId: opts.notebookId, date: now });
  await noteChanged(made.note.id);
  return made.note.id;
}
