/**
 * The compiled wiki's write path in the app. Accepted proposals reach notes the way every other
 * agent change does: the note open in the editor is changed through its NoteDocument (live,
 * autosaved, ⌘Z-able); other notes through the vault, then reindexed and the library refreshed.
 * Provenance files (`assets/provenance.json`) are read and written here too.
 */
import { decodeProvenance, emptyProvenance, encodeProvenance, newId, PROVENANCE_ASSET, type ProvenanceFile, type TextBox } from '@inkstone/core';
import type { WikiTarget } from '@inkstone/ai';
import { activeSession } from '../lib/session.ts';
import type { AppVault } from '../lib/vault.ts';
import { useApp } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function readNoteProvenance(vault: AppVault, noteId: string): Promise<ProvenanceFile> {
  const bytes = await vault.vault.readAsset(noteId, PROVENANCE_ASSET).catch(() => null);
  if (!bytes) return emptyProvenance();
  try {
    return decodeProvenance(dec.decode(bytes));
  } catch {
    return emptyProvenance();
  }
}

const listeners = new Set<(noteId: string) => void>();

/** Called whenever a note's provenance file is written (views showing it refresh). */
export function onProvenanceChange(fn: (noteId: string) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function writeNoteProvenance(vault: AppVault, noteId: string, file: ProvenanceFile): Promise<void> {
  await vault.vault.writeAsset(noteId, PROVENANCE_ASSET, enc.encode(encodeProvenance(file)));
  for (const l of [...listeners]) l(noteId);
}

export class AppWikiTarget implements WikiTarget {
  constructor(private vault: AppVault) {}

  private open(noteId: string) {
    const s = activeSession();
    return s && s.doc.meta.id === noteId ? s.doc : null;
  }

  private async reindex(noteId: string) {
    const n = await this.vault.vault.readNote(noteId);
    if (n && n.trashedAt == null) this.vault.indexNote(n, await this.vault.vault.readPages(n));
    else this.vault.search.remove(noteId);
    this.vault.forgetThumb(noteId);
  }

  async ensureNotebook(name: string, parentId?: string): Promise<string> {
    const found = (await this.vault.listNotebooks()).find((n) => n.name === name && (n.parentId ?? undefined) === parentId);
    if (found) return found.id;
    const nb = await this.vault.vault.createNotebook(name, '#FF4E6E5D', parentId);
    await useApp.getState().refresh();
    return nb.id;
  }

  async createPage(args: { title: string; notebookId: string; markdown: string; tags: string[] }) {
    const s = useSettings.getState();
    const { note, pages } = await this.vault.vault.createNote({ title: args.title, notebookId: args.notebookId, tags: args.tags, paper: s.defaultPaper, pageSize: s.defaultPageSize });
    const box: TextBox = { id: newId(), x: 64, y: 72, width: (note.pageSize.width || 794) - 128, text: args.markdown, fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now(), origin: 'ai' };
    const page = { ...pages[0]!, texts: [box] };
    await this.vault.vault.saveNote(note, [page]);
    this.vault.indexNote(note, [page]);
    await useApp.getState().refresh();
    return { noteId: note.id, pageId: page.id, textId: box.id, title: note.title };
  }

  async readText(noteId: string, pageId: string, textId: string): Promise<string | null> {
    const d = this.open(noteId);
    if (d) {
      const i = d.indexOfPage(pageId);
      return i < 0 ? null : (d.page(i).texts ?? []).find((t) => t.id === textId)?.text ?? null;
    }
    const n = await this.vault.vault.readNote(noteId);
    if (!n || !n.pageIds.includes(pageId)) return null;
    return (await this.vault.vault.readPage(noteId, pageId)).texts?.find((t) => t.id === textId)?.text ?? null;
  }

  async replaceText(noteId: string, pageId: string, textId: string, expected: string, next: string): Promise<'replaced' | 'changed' | 'missing'> {
    const d = this.open(noteId);
    if (d) {
      const i = d.indexOfPage(pageId);
      const box = i < 0 ? undefined : (d.page(i).texts ?? []).find((t) => t.id === textId);
      if (!box) return 'missing';
      if (box.text !== expected) return 'changed';
      d.upsertText(i, { ...box, text: next }, 'Compiled wiki update');
      return 'replaced';
    }
    const n = await this.vault.vault.readNote(noteId);
    if (!n || !n.pageIds.includes(pageId)) return 'missing';
    const pages = await this.vault.vault.readPages(n);
    const box = pages.find((p) => p.id === pageId)?.texts?.find((t) => t.id === textId);
    if (!box) return 'missing';
    if (box.text !== expected) return 'changed';
    const nextPages = pages.map((p) => (p.id === pageId ? { ...p, texts: (p.texts ?? []).map((t) => (t.id === textId ? { ...t, text: next } : t)) } : p));
    await this.vault.vault.saveNote({ ...n, updatedAt: Date.now() }, nextPages, { changedPageIds: [pageId] });
    await this.reindex(noteId);
    await useApp.getState().refresh();
    return 'replaced';
  }

  async trashNote(noteId: string): Promise<boolean> {
    const d = this.open(noteId);
    if (d) {
      d.updateMeta((m) => ({ ...m, trashedAt: Date.now() }));
      this.vault.search.remove(noteId);
      return true;
    }
    if (!(await this.vault.vault.readNote(noteId))) return false;
    await this.vault.vault.trashNote(noteId);
    this.vault.search.remove(noteId);
    await useApp.getState().refresh();
    return true;
  }

  readProvenance(noteId: string) { return readNoteProvenance(this.vault, noteId); }
  writeProvenance(noteId: string, file: ProvenanceFile) { return writeNoteProvenance(this.vault, noteId, file); }
}
