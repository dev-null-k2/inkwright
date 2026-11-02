/**
 * The note tools of @inkstone/ai (the same ones the in-app assistant uses) backed by the vault
 * folder. Writes go through the MCP server's tool handlers, so the agent gets the same safe,
 * sync-friendly writes as MCP clients: atomic files, re-read before save, retries when another
 * device wrote in between. `RecordingVaultHost` logs every write as an undoable Activity op.
 */
import { VaultLayout, VersionHistory, pageText, type NoteMeta } from '@inkstone/core';
import type { NewActivityOp, NoteContent, NoteInfo, NoteListItem, NotePatch, NoteSearchHit, NoteToolHost, NotebookInfo } from '@inkstone/ai';
import { RecordingNoteToolHost } from '@inkstone/ai';
import { notebookPath, readNoteFresh, type ServerContext } from '../context.ts';
import { pageSvg } from '../render.ts';
import { appendTextToNote, createNote, createNotebook, trashNote, updateNote, type AppendOutcome } from '../tools.ts';

function resultJson(r: { content?: Array<{ type: string; text?: string }>; isError?: boolean }): Record<string, any> {
  const t = r.content?.find((c) => c.type === 'text')?.text ?? '';
  if (r.isError) throw new Error(t || 'The change failed.');
  return JSON.parse(t) as Record<string, any>;
}

const info = (n: NoteMeta): NoteInfo => ({
  id: n.id,
  title: n.title,
  tags: [...n.tags],
  ...(n.notebookId ? { notebookId: n.notebookId } : {}),
  pinned: n.pinned,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt,
  ...(n.summary ? { summary: n.summary } : {}),
  kind: n.kind,
  ...(n.trashedAt != null ? { trashedAt: n.trashedAt } : {}),
});

export class VaultNoteToolHost implements NoteToolHost {
  /** Notes this host changed (so the runner doesn't treat its own saves as the user's). */
  readonly touched = new Map<string, number>();
  /** Boxes placed by the last appendText (all pages the text flowed onto). */
  lastAppend: AppendOutcome | null = null;

  constructor(private ctx: ServerContext) {}

  private touch(id: string) {
    this.touched.set(id, this.ctx.clock());
  }

  async listNotes(opts: { notebookId?: string; tag?: string; pinned?: boolean; limit?: number } = {}): Promise<NoteListItem[]> {
    await this.ctx.refresh();
    const notebooks = await this.ctx.vault.listNotebooks();
    let notes = await this.ctx.vault.listNotes();
    if (opts.notebookId) notes = notes.filter((n) => n.notebookId === opts.notebookId);
    if (opts.tag) notes = notes.filter((n) => n.tags.some((t) => t.toLowerCase() === opts.tag!.toLowerCase()));
    if (opts.pinned) notes = notes.filter((n) => n.pinned);
    return notes.slice(0, opts.limit ?? 50).map((n) => ({ ...info(n), pageCount: n.pageIds.length, ...(n.notebookId ? { notebookName: notebookPath(notebooks, n.notebookId) ?? undefined } : {}) }));
  }

  async searchNotes(query: string, opts: { limit?: number } = {}): Promise<NoteSearchHit[]> {
    await this.ctx.refresh();
    const index = await this.ctx.searchIndex();
    return index.search(query, { limit: opts.limit ?? 8 }).map((h) => ({ noteId: h.noteId, title: h.title, pageIndex: h.pageIndex, snippet: h.snippet, score: h.score }));
  }

  async readNote(id: string): Promise<NoteContent | null> {
    const found = await readNoteFresh(this.ctx, id).catch(() => null);
    if (!found) return null;
    const pages = await this.ctx.vault.readPages(found.note);
    return {
      meta: info(found.note),
      pages: pages.map((p, i) => ({ index: i, text: pageText(p), strokeCount: p.strokes.length, hasHandwriting: p.strokes.length > 0, handwritingRecognized: !!p.recognizedText?.trim(), imageCount: p.images?.length ?? 0 })),
    };
  }

  /** PNG of a page for vision models (null without the optional PNG renderer). */
  async getPageImage(noteId: string, pageIndex: number): Promise<{ mediaType: string; base64: string } | null> {
    const found = await readNoteFresh(this.ctx, noteId).catch(() => null);
    const pageId = found?.note.pageIds[pageIndex];
    if (!found || !pageId) return null;
    const page = await this.ctx.vault.readPage(noteId, pageId);
    const png = await this.ctx.renderPng(await pageSvg(this.ctx, found.note, page, { embedAssets: true }), 1200);
    return png ? { mediaType: 'image/png', base64: Buffer.from(png).toString('base64') } : null;
  }

  async createNote(args: { title: string; text: string; notebookId?: string; tags?: string[] }): Promise<NoteInfo> {
    const j = resultJson(await createNote(this.ctx, { title: args.title, text: args.text, notebookId: args.notebookId, tags: args.tags }));
    this.touch(j.id);
    const n = await readNoteFresh(this.ctx, j.id);
    if (!n) throw new Error('The note was created but could not be read back.');
    return info(n.note);
  }

  async appendText(noteId: string, text: string, pageIndex?: number) {
    this.touch(noteId);
    // Version history: the note as it was before an agent changed it (locked notes can't be changed here).
    const found = await readNoteFresh(this.ctx, noteId).catch(() => null);
    if (found && !found.note.lock) await new VersionHistory(this.ctx.vault).take(found.note, await this.ctx.vault.readPages(found.note), 'agent').catch(() => null);
    const r = await appendTextToNote(this.ctx, { id: noteId, text, ...(pageIndex != null ? { page: pageIndex + 1 } : {}) });
    this.touch(noteId);
    this.lastAppend = r;
    const first = r.boxes[0];
    return { noteId, pageIndex: r.page - 1, pageId: first?.pageId, textId: first?.textId, addedPage: first?.addedPage };
  }

  async updateNote(id: string, patch: NotePatch): Promise<NoteInfo | null> {
    if (!(await readNoteFresh(this.ctx, id).catch(() => null))) return null;
    this.touch(id);
    resultJson(await updateNote(this.ctx, { id, ...patch, ...(patch.notebookId !== undefined ? { notebookId: patch.notebookId } : {}) }));
    this.touch(id);
    const n = await readNoteFresh(this.ctx, id);
    return n ? info(n.note) : null;
  }

  async listNotebooks(): Promise<NotebookInfo[]> {
    await this.ctx.refresh();
    const notebooks = await this.ctx.vault.listNotebooks();
    const counts = new Map<string, number>();
    for (const n of await this.ctx.vault.listNotes()) if (n.notebookId) counts.set(n.notebookId, (counts.get(n.notebookId) ?? 0) + 1);
    return notebooks.map((b) => ({ id: b.id, name: b.name, ...(b.parentId ? { parentId: b.parentId } : {}), noteCount: counts.get(b.id) ?? 0 }));
  }

  async createNotebook(name: string, opts: { parentId?: string } = {}): Promise<NotebookInfo> {
    const j = resultJson(await createNotebook(this.ctx, { name, ...(opts.parentId ? { parentId: opts.parentId } : {}) }));
    return { id: j.notebook.id, name: j.notebook.name, ...(j.notebook.parentId ? { parentId: j.notebook.parentId } : {}) };
  }

  async trashNote(id: string): Promise<boolean> {
    if (!(await readNoteFresh(this.ctx, id).catch(() => null))) return false;
    this.touch(id);
    resultJson(await trashNote(this.ctx, { id }));
    return true;
  }

  /** Vault path of a note (for messages). */
  notePath(id: string): string {
    return VaultLayout.noteDir(id);
  }
}

/**
 * RecordingNoteToolHost that logs *every* text box an append placed (long text flows onto new
 * pages), so undoing the run removes all of it.
 */
export class RecordingVaultHost extends RecordingNoteToolHost {
  constructor(private vaultHost: VaultNoteToolHost, private log: (op: NewActivityOp) => void, clock?: () => number) {
    super(vaultHost, log, clock);
  }

  override async appendText(noteId: string, text: string, pageIndex?: number) {
    const before = await this.vaultHost.readNote(noteId);
    const r = await this.vaultHost.appendText(noteId, text, pageIndex);
    const title = before?.meta.title ?? '';
    for (const b of this.vaultHost.lastAppend?.boxes ?? []) {
      const clipped = b.text.replace(/\s+/g, ' ');
      this.log({ kind: 'text_appended', tool: this.currentTool || 'append_to_note', noteId, title, pageId: b.pageId, textId: b.textId, text: b.text, ...(b.addedPage ? { addedPage: true } : {}), summary: `Added “${clipped.length > 70 ? `${clipped.slice(0, 69)}…` : clipped}” to “${title || 'Untitled'}”` });
    }
    return r;
  }
}
