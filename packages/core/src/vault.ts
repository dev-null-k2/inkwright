import {
  VaultLayout,
  decodeManifest,
  decodeNote,
  decodeNotebook,
  decodePage,
  encodeManifest,
  encodeNote,
  encodeNotebook,
  encodePage,
} from './codec.ts';
import { exportMarkdown, exportPageSvg } from './export.ts';
import type { VaultFS } from './fs.ts';
import { isSafeId, newId, requireSafeId } from './ids.ts';
import { NoteLockedError, assetAad, createLock, isSealedBytes, openBytes, openNoteMeta, openPage, sealBytes, sealNoteMeta, sealPage, sealedView } from './lock.ts';
import {
  VAULT_FORMAT_VERSION,
  newNote,
  newPage,
  type NoteKind,
  type NoteMeta,
  type NotebookMeta,
  type PageInk,
  type PageSize,
  type PaperSpec,
} from './model.ts';

export type VaultChange =
  | { type: 'note'; noteId: string }
  | { type: 'note-deleted'; noteId: string }
  | { type: 'notebook'; notebookId: string }
  | { type: 'notebook-deleted'; notebookId: string }
  | { type: 'reloaded' };

export interface SaveOptions {
  /** Pages whose files must be rewritten. Default: all pages passed in. */
  changedPageIds?: Iterable<string>;
  /** Pages removed from the note whose files must be deleted. */
  removedPageIds?: Iterable<string>;
  /** Regenerate note.md and page SVGs (default true). */
  derived?: boolean;
}

/**
 * A vault: the user's notes as files. All app features read and write through this, so any
 * storage backend (IndexedDB, a real folder, Google Drive via sync) gets the same layout.
 */
export class Vault {
  private listeners = new Set<(c: VaultChange) => void>();
  private noteCache: Map<string, NoteMeta> | null = null;
  private notebookCache: Map<string, NotebookMeta> | null = null;
  /**
   * Keys of locked notes that are open right now (lock.ts). Held in memory only, never written:
   * with a key, saves encrypt and assets decrypt; without one a locked note can't be changed.
   */
  private keys = new Map<string, CryptoKey>();

  constructor(readonly fs: VaultFS, private clock: () => number = Date.now) {}

  // ---- Locked notes -----------------------------------------------------------------------

  /** Remembers a locked note's key while it is open (after the passcode was checked). */
  unlock(noteId: string, key: CryptoKey): void { this.keys.set(noteId, key); }
  /** Forgets a locked note's key (the note closes): its files can no longer be read or written here. */
  forget(noteId: string): void { this.keys.delete(noteId); }
  isUnlocked(noteId: string): boolean { return this.keys.has(noteId); }
  keyFor(noteId: string): CryptoKey | undefined { return this.keys.get(noteId); }

  /**
   * Locks a note: its pages, assets and metadata are rewritten encrypted with a key derived from
   * the passcode, which stays unlocked here until `forget`. Returns the new metadata. Pass the
   * note's current (unlocked) pages. Version history is resealed by `VersionHistory.reseal`.
   */
  async lockNote(note: NoteMeta, pages: PageInk[], passcode: string, opts: { iterations?: number } = {}): Promise<NoteMeta> {
    if (note.lock) throw new Error('This note is already locked.');
    const { lock, key } = await createLock(passcode, { now: this.clock(), iterations: opts.iterations });
    this.keys.set(note.id, key);
    const next: NoteMeta = { ...note, lock };
    await this.saveNote(next, pages);
    for (const e of await this.fs.list(VaultLayout.assetsDir(note.id))) {
      if (e.kind !== 'file') continue;
      const path = VaultLayout.asset(note.id, e.name);
      const bytes = await this.fs.readBytes(path);
      if (bytes && !isSealedBytes(bytes)) await this.fs.writeBytes(path, await sealBytes(key, bytes, assetAad(e.name)));
    }
    return next;
  }

  /**
   * Removes a note's lock for good: everything is written back as plain files. The note must be
   * unlocked (its key known); pass its unlocked metadata and pages.
   */
  async removeLock(note: NoteMeta, pages: PageInk[]): Promise<NoteMeta> {
    const key = this.keys.get(note.id);
    if (!note.lock) return note;
    if (!key) throw new NoteLockedError(note.id);
    for (const e of await this.fs.list(VaultLayout.assetsDir(note.id))) {
      if (e.kind !== 'file') continue;
      const path = VaultLayout.asset(note.id, e.name);
      const bytes = await this.fs.readBytes(path);
      if (bytes && isSealedBytes(bytes)) await this.fs.writeBytes(path, await openBytes(key, bytes, assetAad(e.name)));
    }
    const { lock: _l, ...rest } = note;
    const plain = rest as NoteMeta;
    this.keys.delete(note.id);
    await this.saveNote(plain, pages);
    return plain;
  }

  onChange(l: (c: VaultChange) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(c: VaultChange) {
    for (const l of [...this.listeners]) l(c);
  }

  /** Creates the manifest if this is a new vault. */
  async init(): Promise<void> {
    const m = await this.fs.readText(VaultLayout.MANIFEST);
    if (m == null) {
      await this.fs.writeText(VaultLayout.MANIFEST, encodeManifest({ app: 'Inkwright', formatVersion: VAULT_FORMAT_VERSION, createdAt: this.clock() }));
    } else {
      decodeManifest(m);
    }
  }

  /** Drops caches (after a sync pulled remote changes) and notifies listeners. */
  invalidate(): void {
    this.noteCache = null;
    this.notebookCache = null;
    this.emit({ type: 'reloaded' });
  }

  // ---- Notes ----------------------------------------------------------------------------

  async listNotes(opts: { includeTrashed?: boolean } = {}): Promise<NoteMeta[]> {
    if (!this.noteCache) {
      const cache = new Map<string, NoteMeta>();
      for (const e of await this.fs.list(VaultLayout.NOTES_DIR)) {
        if (e.kind !== 'dir') continue;
        try {
          // A folder that can't be read (one linked out of the vault, a permissions problem)
          // is skipped like a corrupt file: one bad entry must not hide every other note.
          const text = await this.fs.readText(VaultLayout.noteMeta(e.name));
          if (text == null) continue;
          const n = decodeNote(text);
          // The folder name is the id; a note.json claiming another (or unsafe) id is ignored.
          if (n.id !== e.name || !isSafeId(n.id)) continue;
          cache.set(n.id, n);
        } catch {
          // A corrupt or half-synced file must never break the library; skip it.
        }
      }
      this.noteCache = cache;
    }
    return [...this.noteCache.values()]
      .filter((n) => opts.includeTrashed || n.trashedAt == null)
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /**
   * A note's metadata. For a locked note, `unlocked: true` also decrypts its sealed fields (needs
   * the key, see `unlock`); otherwise they are simply absent.
   */
  async readNote(id: string, opts: { unlocked?: boolean } = {}): Promise<NoteMeta | null> {
    requireSafeId(id);
    const n = await this.readNoteRaw(id);
    if (!n || !opts.unlocked || !n.lock) return n;
    const key = this.keys.get(id);
    if (!key) throw new NoteLockedError(id);
    return openNoteMeta(key, n);
  }

  private async readNoteRaw(id: string): Promise<NoteMeta | null> {
    const cached = this.noteCache?.get(id);
    if (cached) return cached;
    const text = await this.fs.readText(VaultLayout.noteMeta(id));
    if (text == null) return null;
    try {
      const n = decodeNote(text);
      return n.id === id ? n : null;
    } catch {
      return null;
    }
  }

  async readPage(noteId: string, pageId: string): Promise<PageInk> {
    requireSafeId(noteId);
    requireSafeId(pageId);
    const text = await this.fs.readText(VaultLayout.pageInk(noteId, pageId));
    if (text == null) return newPage(pageId);
    try {
      return decodePage(text);
    } catch {
      return newPage(pageId);
    }
  }

  /**
   * A note's pages. Pages of a locked note come back blank (`sealedView`) — search, agents,
   * thumbnails and sync never see their content — unless `unlocked: true` is passed by the editor
   * that holds the key.
   */
  async readPages(note: NoteMeta, opts: { unlocked?: boolean } = {}): Promise<PageInk[]> {
    // Unsafe page ids (hand-edited or corrupt files) are skipped rather than failing the note.
    const pages = await Promise.all(note.pageIds.filter(isSafeId).map((p) => this.readPage(note.id, p)));
    if (!pages.some((p) => p.sealed)) return pages;
    if (!opts.unlocked) return pages.map((p) => (p.sealed ? sealedView(p) : p));
    const key = this.keys.get(note.id);
    if (!key) throw new NoteLockedError(note.id);
    return Promise.all(pages.map((p) => openPage(key, p)));
  }

  async createNote(args: {
    title: string;
    kind?: NoteKind;
    paper?: PaperSpec;
    pageSize?: PageSize;
    notebookId?: string;
    tags?: string[];
  }): Promise<{ note: NoteMeta; pages: PageInk[] }> {
    const now = this.clock();
    const page = newPage(newId(now));
    const note = newNote({ ...args, id: newId(now), pageId: page.id, now });
    await this.saveNote(note, [page]);
    return { note, pages: [page] };
  }

  async saveNote(note: NoteMeta, pages: PageInk[], opts: SaveOptions = {}): Promise<void> {
    requireSafeId(note.id);
    const changed = new Set(opts.changedPageIds ?? pages.map((p) => p.id));
    // A locked note is only ever written encrypted, and only by whoever holds its key.
    const key = note.lock ? this.keys.get(note.id) : undefined;
    if (note.lock && !key) throw new NoteLockedError(note.id);
    if (key) {
      note = await sealNoteMeta(key, note);
      pages = await Promise.all(pages.map((p) => (changed.has(p.id) ? sealPage(key, p) : Promise.resolve(sealedView(p)))));
    }
    await this.fs.writeText(VaultLayout.noteMeta(note.id), encodeNote(note));
    const derived = opts.derived ?? true;
    for (const p of pages) {
      if (!changed.has(p.id)) continue;
      requireSafeId(p.id);
      await this.fs.writeText(VaultLayout.pageInk(note.id, p.id), encodePage(p));
      if (derived) await this.fs.writeText(VaultLayout.pageSvg(note.id, p.id), exportPageSvg(note, key ? sealedView(p) : p));
    }
    for (const id of opts.removedPageIds ?? []) {
      requireSafeId(id);
      await this.fs.delete(VaultLayout.pageInk(note.id, id));
      await this.fs.delete(VaultLayout.pageSvg(note.id, id));
    }
    if (derived) await this.fs.writeText(VaultLayout.noteMarkdown(note.id), exportMarkdown(note, key ? pages.map(sealedView) : pages));
    this.noteCache?.set(note.id, note);
    this.emit({ type: 'note', noteId: note.id });
  }

  /** Updates metadata only (rename, pin, tags, move, trash). */
  async updateNote(id: string, transform: (n: NoteMeta) => NoteMeta, opts: { touch?: boolean } = {}): Promise<NoteMeta | null> {
    const cur = await this.readNote(id);
    if (!cur) return null;
    const next0 = transform(cur);
    const next = opts.touch === false ? next0 : { ...next0, updatedAt: this.clock() };
    await this.fs.writeText(VaultLayout.noteMeta(id), encodeNote(next));
    const pages = await this.readPages(next);
    await this.fs.writeText(VaultLayout.noteMarkdown(id), exportMarkdown(next, pages));
    this.noteCache?.set(id, next);
    this.emit({ type: 'note', noteId: id });
    return next;
  }

  async trashNote(id: string): Promise<void> {
    await this.updateNote(id, (n) => ({ ...n, trashedAt: this.clock() }), { touch: false });
  }

  async restoreNote(id: string): Promise<void> {
    await this.updateNote(id, (n) => {
      const { trashedAt: _t, ...rest } = n;
      return rest as NoteMeta;
    });
  }

  async deleteNote(id: string): Promise<void> {
    requireSafeId(id);
    await this.fs.deleteDir(VaultLayout.noteDir(id));
    this.noteCache?.delete(id);
    this.emit({ type: 'note-deleted', noteId: id });
  }

  /** Permanently deletes notes trashed longer than [maxAgeMs] (default 30 days). */
  async purgeTrash(maxAgeMs = 30 * 24 * 3600 * 1000): Promise<number> {
    const now = this.clock();
    let n = 0;
    for (const note of await this.listNotes({ includeTrashed: true })) {
      if (note.trashedAt != null && now - note.trashedAt > maxAgeMs) {
        await this.deleteNote(note.id);
        n++;
      }
    }
    return n;
  }

  async duplicateNote(id: string): Promise<NoteMeta | null> {
    const raw = await this.readNote(id);
    if (!raw) return null;
    // A locked note can be duplicated only while unlocked; the copy is locked with the same passcode.
    const src = raw.lock ? await this.readNote(id, { unlocked: true }) : raw;
    if (!src) return null;
    const pages = await this.readPages(src, { unlocked: true });
    const now = this.clock();
    const noteId = newId(now);
    const newPages = pages.map((p) => {
      const ids = new Map<string, string>();
      const out: PageInk = {
        ...p,
        id: newId(now),
        strokes: p.strokes.map((s) => { const id = newId(now); ids.set(s.id, id); return { ...s, id }; }),
        texts: p.texts?.map((t) => ({ ...t, id: newId(now) })),
        images: p.images?.map((im) => ({ ...im, id: newId(now) })),
      };
      if (p.links) out.links = p.links.map((l) => ({ ...l, id: newId(now), strokeIds: l.strokeIds.map((id) => ids.get(id) ?? id) }));
      return out;
    });
    const copy: NoteMeta = {
      ...src,
      id: noteId,
      title: `${src.title} (copy)`,
      pageIds: newPages.map((p) => p.id),
      createdAt: now,
      updatedAt: now,
      pinned: false,
    };
    delete copy.trashedAt;
    if (src.lock) this.keys.set(noteId, this.keys.get(id)!);
    // Assets are shared by name; copy them so the duplicate is self-contained.
    for (const e of await this.fs.list(VaultLayout.assetsDir(id))) {
      if (e.kind !== 'file') continue;
      const bytes = await this.fs.readBytes(VaultLayout.asset(id, e.name));
      if (bytes) await this.fs.writeBytes(VaultLayout.asset(noteId, e.name), bytes);
    }
    await this.saveNote(copy, newPages);
    return copy;
  }

  // ---- Assets ---------------------------------------------------------------------------

  async writeAsset(noteId: string, name: string, bytes: Uint8Array): Promise<string> {
    requireSafeId(noteId);
    if (!/^[0-9A-Za-z_.-]{1,96}$/.test(name) || name.includes('..')) throw new Error(`Unsafe asset name: ${name}`);
    const key = this.keys.get(noteId);
    if (!key && (await this.readNoteRaw(noteId))?.lock) throw new NoteLockedError(noteId);
    await this.fs.writeBytes(VaultLayout.asset(noteId, name), key ? await sealBytes(key, bytes, assetAad(name)) : bytes);
    return name;
  }

  async readAsset(noteId: string, name: string): Promise<Uint8Array | null> {
    requireSafeId(noteId);
    if (name.includes('/') || name.includes('..')) return null;
    const bytes = await this.fs.readBytes(VaultLayout.asset(noteId, name));
    if (!bytes || !isSealedBytes(bytes)) return bytes;
    // An encrypted asset of a locked note reads as missing unless the note is unlocked here.
    const key = this.keys.get(noteId);
    if (!key) return null;
    try { return await openBytes(key, bytes, assetAad(name)); } catch { return null; }
  }

  // ---- Notebooks ------------------------------------------------------------------------

  async listNotebooks(): Promise<NotebookMeta[]> {
    if (!this.notebookCache) {
      const cache = new Map<string, NotebookMeta>();
      for (const e of await this.fs.list(VaultLayout.NOTEBOOKS_DIR)) {
        if (e.kind !== 'dir') continue;
        const text = await this.fs.readText(VaultLayout.notebookMeta(e.name));
        if (text == null) continue;
        try {
          const nb = decodeNotebook(text);
          if (nb.id !== e.name || !isSafeId(nb.id)) continue;
          cache.set(nb.id, nb);
        } catch {
          /* skip corrupt */
        }
      }
      this.notebookCache = cache;
    }
    return [...this.notebookCache.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async createNotebook(name: string, color = '#FF3D5A80', parentId?: string): Promise<NotebookMeta> {
    const nb: NotebookMeta = { id: newId(this.clock()), name, color, parentId, createdAt: this.clock(), formatVersion: VAULT_FORMAT_VERSION };
    await this.writeNotebook(nb);
    return nb;
  }

  async writeNotebook(nb: NotebookMeta): Promise<void> {
    requireSafeId(nb.id);
    await this.fs.writeText(VaultLayout.notebookMeta(nb.id), encodeNotebook(nb));
    this.notebookCache?.set(nb.id, nb);
    this.emit({ type: 'notebook', notebookId: nb.id });
  }

  /** Deletes a notebook; its notes are kept and become unfiled, child notebooks move up. */
  async deleteNotebook(id: string): Promise<void> {
    requireSafeId(id);
    const all = await this.listNotebooks();
    const target = all.find((n) => n.id === id);
    for (const n of await this.listNotes({ includeTrashed: true })) {
      if (n.notebookId === id) await this.updateNote(n.id, (x) => ({ ...x, notebookId: undefined }), { touch: false });
    }
    for (const child of all.filter((n) => n.parentId === id)) {
      await this.writeNotebook({ ...child, parentId: target?.parentId });
    }
    await this.fs.deleteDir(`notebooks/${id}`);
    this.notebookCache?.delete(id);
    this.emit({ type: 'notebook-deleted', notebookId: id });
  }
}
