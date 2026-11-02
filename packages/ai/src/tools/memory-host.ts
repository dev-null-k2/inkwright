import {
  MemoryFS,
  SearchIndex,
  Vault,
  contentBounds,
  isInfinite,
  isSafeId,
  newId,
  newPage,
  pageSizeOf,
  pageText,
  rectIsEmpty,
  textBoxHeight,
  type InkStroke,
  type NoteMeta,
  type PageInk,
  type TextBox,
} from '@inkstone/core';
import type { NoteContent, NoteInfo, NoteListItem, NotePatch, NoteSearchHit, NoteToolHost, NotebookInfo } from './notes.ts';

export interface MemoryNoteToolHostOptions {
  /** Defaults to a new Vault over MemoryFS. Pass the app's vault to reuse this host for real. */
  vault?: Vault;
  index?: SearchIndex;
  clock?: () => number;
  /** Renders a page for vision models (PNG/JPEG/WebP). Enables `getPageImage` / get_page_image. */
  renderPage?: (note: NoteMeta, page: PageInk, pageIndex: number) => Promise<{ mediaType: string; base64: string } | null>;
  /** Look of text boxes the agent writes. */
  textStyle?: Partial<Pick<TextBox, 'fontSize' | 'color' | 'font'>>;
}

/** Layout of agent-written text on a page (page units, 1/96 in). */
export const TEXT_LAYOUT = { marginX: 56, top: 72, bottom: 64, gap: 18, boardWidth: 640 } as const;

/** Seed data for tests, evals and demos. */
export interface SeedNote {
  title: string;
  /** Typed text, one entry per page. */
  text?: string | string[];
  /** Recognized handwriting, one entry per page. */
  recognizedText?: string | string[];
  /** Fake handwriting strokes per page (no recognized text unless given). */
  strokes?: number;
  tags?: string[];
  notebookId?: string;
  pinned?: boolean;
  summary?: string;
  trashed?: boolean;
}

function fakeStroke(i: number, now: number): InkStroke {
  const y = 120 + i * 30;
  return {
    id: newId(now),
    pen: 'ballpoint',
    color: '#FF1B1F24',
    size: 1.8,
    createdAt: now,
    points: [0, 1, 2, 3].map((k) => ({ x: 80 + k * 40, y: y + (k % 2) * 6, t: k * 16, p: 0.5, tilt: -1, orient: -1 })),
  };
}

/**
 * NoteToolHost over an @inkstone/core Vault + SearchIndex. In-memory by default (tests, evals,
 * previews); with the app's Vault it is a working reference host. Writes text as TextBoxes
 * stacked below existing content.
 */
export class MemoryNoteToolHost implements NoteToolHost {
  readonly vault: Vault;
  readonly index: SearchIndex;
  getPageImage?: (noteId: string, pageIndex: number) => Promise<{ mediaType: string; base64: string } | null>;
  private clock: () => number;
  private style: Pick<TextBox, 'fontSize' | 'color' | 'font'>;

  constructor(opts: MemoryNoteToolHostOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.vault = opts.vault ?? new Vault(new MemoryFS(this.clock), this.clock);
    this.index = opts.index ?? new SearchIndex();
    this.style = { fontSize: 16, color: '#FF1B1F24', font: 'sans', ...opts.textStyle };
    const render = opts.renderPage;
    if (render) {
      this.getPageImage = async (noteId, pageIndex) => {
        const note = await this.note(noteId);
        if (!note || pageIndex < 0 || pageIndex >= note.pageIds.length) return null;
        const page = await this.vault.readPage(note.id, note.pageIds[pageIndex]!);
        return render(note, page, pageIndex);
      };
    }
  }

  static async create(opts: MemoryNoteToolHostOptions = {}): Promise<MemoryNoteToolHost> {
    const h = new MemoryNoteToolHost(opts);
    await h.vault.init();
    await h.reindexAll();
    return h;
  }

  async reindexAll(): Promise<void> {
    this.index.clear();
    for (const n of await this.vault.listNotes()) this.index.indexNote(n, await this.vault.readPages(n));
  }

  private async reindex(noteId: string): Promise<void> {
    const n = await this.vault.readNote(noteId);
    if (!n || n.trashedAt != null) this.index.remove(noteId);
    else this.index.indexNote(n, await this.vault.readPages(n));
  }

  private async note(id: string): Promise<NoteMeta | null> {
    if (typeof id !== 'string' || !isSafeId(id)) return null;
    const n = await this.vault.readNote(id);
    return n && n.trashedAt == null ? n : null;
  }

  private async requireNotebook(id: string | undefined): Promise<void> {
    if (!id) return;
    const nbs = await this.vault.listNotebooks();
    if (!nbs.some((n) => n.id === id)) throw new Error(`No notebook with id "${id}". Use list_notebooks, or create_notebook first.`);
  }

  private textBox(note: NoteMeta, page: PageInk, text: string, y: number): TextBox {
    const size = pageSizeOf(note, page);
    const board = note.kind === 'board' || isInfinite(size);
    const x = board ? 0 : TEXT_LAYOUT.marginX;
    const width = board ? TEXT_LAYOUT.boardWidth : Math.max(200, size.width - 2 * TEXT_LAYOUT.marginX);
    return { id: newId(this.clock()), x, y, width, text, ...this.style, createdAt: this.clock() };
  }

  private nextY(note: NoteMeta, page: PageInk): number {
    const b = contentBounds(page);
    const top = note.kind === 'board' ? 0 : TEXT_LAYOUT.top;
    return rectIsEmpty(b) ? top : Math.max(top, b.maxY + TEXT_LAYOUT.gap);
  }

  // ---- NoteToolHost ------------------------------------------------------------------------

  async listNotes(opts: { notebookId?: string; tag?: string; pinned?: boolean; limit?: number } = {}): Promise<NoteListItem[]> {
    const nbs = new Map((await this.vault.listNotebooks()).map((n) => [n.id, n.name]));
    let notes = await this.vault.listNotes();
    if (opts.notebookId) notes = notes.filter((n) => n.notebookId === opts.notebookId);
    if (opts.tag) notes = notes.filter((n) => n.tags.some((t) => t.toLowerCase() === opts.tag!.toLowerCase()));
    if (opts.pinned) notes = notes.filter((n) => n.pinned);
    return notes.slice(0, opts.limit ?? notes.length).map((n) => {
      const item: NoteListItem = { ...n, pageCount: n.pageIds.length };
      const nb = n.notebookId ? nbs.get(n.notebookId) : undefined;
      if (nb) item.notebookName = nb;
      return item;
    });
  }

  async searchNotes(query: string, opts: { limit?: number } = {}): Promise<NoteSearchHit[]> {
    return this.index.search(query, { limit: opts.limit ?? 8 });
  }

  async readNote(id: string): Promise<NoteContent | null> {
    const note = await this.note(id);
    if (!note) return null;
    const pages = await this.vault.readPages(note);
    return {
      meta: note,
      pages: pages.map((p, index) => ({
        index,
        text: pageText(p),
        strokeCount: p.strokes.length,
        hasHandwriting: p.strokes.length > 0,
        handwritingRecognized: !!p.recognizedText?.trim(),
        imageCount: p.images?.length ?? 0,
      })),
    };
  }

  async createNote(args: { title: string; text: string; notebookId?: string; tags?: string[] }): Promise<NoteInfo> {
    await this.requireNotebook(args.notebookId);
    const { note, pages } = await this.vault.createNote({ title: args.title.trim() || 'Untitled', notebookId: args.notebookId, tags: args.tags ?? [] });
    let page = pages[0]!;
    if (args.text.trim()) page = { ...page, texts: [this.textBox(note, page, args.text.trim(), this.nextY(note, page))] };
    await this.vault.saveNote(note, [page]);
    await this.reindex(note.id);
    return note;
  }

  async appendText(noteId: string, text: string, pageIndex?: number): Promise<{ noteId: string; pageIndex: number; pageId: string; textId: string; addedPage?: boolean }> {
    const note = await this.note(noteId);
    if (!note) throw new Error(`No note with id "${noteId}". Use search_notes or list_notes to find the right id.`);
    const pages = await this.vault.readPages(note);
    let idx = pageIndex ?? pages.length - 1;
    if (idx < 0 || idx >= pages.length) throw new Error(`Note "${note.title}" has ${pages.length} page(s); page_index must be 0–${pages.length - 1}.`);
    let page = pages[idx]!;
    let y = this.nextY(note, page);
    let box = this.textBox(note, page, text.trim(), y);
    const size = pageSizeOf(note, page);
    const full = note.kind !== 'board' && !isInfinite(size) && y + textBoxHeight(box) > size.height - TEXT_LAYOUT.bottom && y > TEXT_LAYOUT.top;
    const next: NoteMeta = { ...note, updatedAt: this.clock() };
    if (full && pageIndex === undefined) {
      page = newPage(newId(this.clock()));
      pages.push(page);
      next.pageIds = [...note.pageIds, page.id];
      idx = pages.length - 1;
      y = this.nextY(next, page);
      box = this.textBox(next, page, text.trim(), y);
    }
    const updated: PageInk = { ...page, texts: [...(page.texts ?? []), box] };
    pages[idx] = updated;
    await this.vault.saveNote(next, pages, { changedPageIds: [updated.id] });
    await this.reindex(note.id);
    return { noteId: note.id, pageIndex: idx, pageId: updated.id, textId: box.id, ...(full && pageIndex === undefined ? { addedPage: true } : {}) };
  }

  async updateNote(id: string, patch: NotePatch): Promise<NoteInfo | null> {
    if (!(await this.note(id))) return null;
    if (patch.notebookId) await this.requireNotebook(patch.notebookId);
    const next = await this.vault.updateNote(id, (n) => {
      const out: NoteMeta = { ...n };
      if (patch.title !== undefined) out.title = patch.title || n.title;
      if (patch.tags !== undefined) out.tags = [...patch.tags];
      if (patch.pinned !== undefined) out.pinned = patch.pinned;
      if (patch.summary !== undefined) out.summary = patch.summary || undefined;
      if (patch.notebookId === null) delete out.notebookId;
      else if (patch.notebookId !== undefined) out.notebookId = patch.notebookId;
      return out;
    });
    await this.reindex(id);
    return next;
  }

  async listNotebooks(): Promise<NotebookInfo[]> {
    const notes = await this.vault.listNotes();
    return (await this.vault.listNotebooks()).map((nb) => {
      const info: NotebookInfo = { id: nb.id, name: nb.name, noteCount: notes.filter((n) => n.notebookId === nb.id).length };
      if (nb.parentId) info.parentId = nb.parentId;
      return info;
    });
  }

  async createNotebook(name: string, opts: { parentId?: string } = {}): Promise<NotebookInfo> {
    if (opts.parentId) await this.requireNotebook(opts.parentId);
    const nb = await this.vault.createNotebook(name.trim() || 'Untitled', undefined, opts.parentId);
    const info: NotebookInfo = { id: nb.id, name: nb.name, noteCount: 0 };
    if (nb.parentId) info.parentId = nb.parentId;
    return info;
  }

  async trashNote(id: string): Promise<boolean> {
    if (!(await this.note(id))) return false;
    await this.vault.trashNote(id);
    this.index.remove(id);
    return true;
  }

  // ---- Seeding -----------------------------------------------------------------------------

  /** Adds a note directly (tests, evals, demos). */
  async seed(s: SeedNote): Promise<NoteMeta> {
    const typed = s.text === undefined ? [] : Array.isArray(s.text) ? s.text : [s.text];
    const recog = s.recognizedText === undefined ? [] : Array.isArray(s.recognizedText) ? s.recognizedText : [s.recognizedText];
    const pageCount = Math.max(1, typed.length, recog.length);
    const { note } = await this.vault.createNote({ title: s.title, notebookId: s.notebookId, tags: s.tags ?? [] });
    const now = this.clock();
    const pages: PageInk[] = [];
    const meta: NoteMeta = { ...note, pinned: !!s.pinned, pageIds: [] };
    if (s.summary) meta.summary = s.summary;
    for (let i = 0; i < pageCount; i++) {
      let page: PageInk = newPage(i === 0 ? note.pageIds[0]! : newId(now));
      if (s.strokes) page = { ...page, strokes: Array.from({ length: s.strokes }, (_, k) => fakeStroke(k, now)) };
      if (recog[i]) page = { ...page, recognizedText: recog[i], recognizedAt: now, recognizedBy: 'seed' };
      if (typed[i]) page = { ...page, texts: [this.textBox(meta, page, typed[i]!, this.nextY(meta, page))] };
      pages.push(page);
      meta.pageIds.push(page.id);
    }
    await this.vault.saveNote(meta, pages);
    if (s.trashed) await this.vault.trashNote(meta.id);
    await this.reindex(meta.id);
    return (await this.vault.readNote(meta.id))!;
  }
}
