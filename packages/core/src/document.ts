import { detectScratchOut, type ScratchOutOptions } from './gestures.ts';
import { newId as defaultNewId } from './ids.ts';
import { newPage, type ImageItem, type InkStroke, type NoteMeta, type PageInk, type PageSize, type PaperSpec, type TextBox } from './model.ts';

/** Anything with an id that lives in a page list in z-order. */
interface Item { id: string }
interface Indexed<T> { index: number; item: T }

/** Removed + added items of one list, with z-indices, so undo restores order exactly. */
export interface ListDiff<T extends Item> {
  removed: Indexed<T>[];
  added: Indexed<T>[];
}

/** The single undoable unit: what changed on one page. */
export interface PageDiff {
  label: string;
  strokes?: ListDiff<InkStroke>;
  texts?: ListDiff<TextBox>;
  images?: ListDiff<ImageItem>;
}

const emptyList = <T extends Item>(d?: ListDiff<T>) => !d || (d.removed.length === 0 && d.added.length === 0);
export const isEmptyDiff = (d: PageDiff) => emptyList(d.strokes) && emptyList(d.texts) && emptyList(d.images);

function splice<T extends Item>(list: readonly T[], out: Indexed<T>[], inn: Indexed<T>[]): T[] {
  const outIds = new Set(out.map((o) => o.item.id));
  const result = list.filter((x) => !outIds.has(x.id));
  for (const it of [...inn].sort((a, b) => a.index - b.index)) {
    result.splice(Math.max(0, Math.min(it.index, result.length)), 0, it.item);
  }
  return result;
}

export function listDiffBetween<T extends Item>(before: readonly T[], after: readonly T[]): ListDiff<T> {
  const afterIds = new Set(after.map((x) => x.id));
  const beforeIds = new Set(before.map((x) => x.id));
  const afterById = new Map(after.map((x) => [x.id, x]));
  const removed: Indexed<T>[] = [];
  const added: Indexed<T>[] = [];
  before.forEach((x, i) => {
    // Same id but different content (moved/edited in place) counts as remove + add.
    if (!afterIds.has(x.id) || afterById.get(x.id) !== x) removed.push({ index: i, item: x });
  });
  after.forEach((x, i) => {
    if (!beforeIds.has(x.id) || removed.some((r) => r.item.id === x.id)) added.push({ index: i, item: x });
  });
  return { removed, added };
}

export function applyDiff(page: PageInk, d: PageDiff): PageInk {
  const next: PageInk = { ...page };
  if (d.strokes) next.strokes = splice(page.strokes, d.strokes.removed, d.strokes.added);
  if (d.texts) next.texts = splice(page.texts ?? [], d.texts.removed, d.texts.added);
  if (d.images) next.images = splice(page.images ?? [], d.images.removed, d.images.added);
  return next;
}

export function invertDiff(d: PageDiff): PageDiff {
  const inv = <T extends Item>(l?: ListDiff<T>) => (l ? { removed: l.added, added: l.removed } : undefined);
  return { label: d.label, strokes: inv(d.strokes), texts: inv(d.texts), images: inv(d.images) };
}

/** Diff turning one page state into another (multi-step gestures commit as one undo step). */
export function pageDiffBetween(before: PageInk, after: PageInk, label: string): PageDiff {
  const d: PageDiff = { label };
  if (before.strokes !== after.strokes) d.strokes = listDiffBetween(before.strokes, after.strokes);
  if ((before.texts ?? []) !== (after.texts ?? [])) d.texts = listDiffBetween(before.texts ?? [], after.texts ?? []);
  if ((before.images ?? []) !== (after.images ?? [])) d.images = listDiffBetween(before.images ?? [], after.images ?? []);
  return d;
}

/** Cross-page undo history in the order the user acted. */
export class NoteHistory {
  private undoStack: { pageId: string; diff: PageDiff }[] = [];
  private redoStack: { pageId: string; diff: PageDiff }[] = [];
  constructor(private limit = 1000) {}
  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get undoLabel() { return this.undoStack[this.undoStack.length - 1]?.diff.label; }
  get redoLabel() { return this.redoStack[this.redoStack.length - 1]?.diff.label; }
  record(pageId: string, diff: PageDiff) {
    if (isEmptyDiff(diff)) return;
    this.undoStack.push({ pageId, diff });
    if (this.undoStack.length > this.limit) this.undoStack.shift();
    this.redoStack = [];
  }
  popUndo() { const e = this.undoStack.pop(); if (e) this.redoStack.push(e); return e; }
  popRedo() { const e = this.redoStack.pop(); if (e) this.undoStack.push(e); return e; }
  forgetPage(pageId: string) {
    this.undoStack = this.undoStack.filter((e) => e.pageId !== pageId);
    this.redoStack = this.redoStack.filter((e) => e.pageId !== pageId);
  }
  clear() { this.undoStack = []; this.redoStack = []; }
}

export type AddResult = { kind: 'added' } | { kind: 'scratched'; erased: number } | { kind: 'ignored' };

export interface DocumentSnapshot {
  meta: NoteMeta;
  pages: PageInk[];
  changedPageIds: Set<string>;
  removedPageIds: Set<string>;
}

/**
 * The open note being edited: metadata, pages, and cross-page undo. Every mutation goes through
 * here so undo, dirty tracking (autosave) and change notification are uniform. Plain TypeScript,
 * single-threaded, fully unit-tested.
 */
export class NoteDocument {
  meta: NoteMeta;
  private pageList: PageInk[];
  /** Live-gesture state shown on screen but never saved (erasing in progress, etc.). */
  private previews = new Map<number, PageInk>();
  readonly history = new NoteHistory();
  version = 0;
  private changed = new Set<string>();
  private removed = new Set<string>();
  private metaDirty = false;
  private listeners = new Set<() => void>();

  constructor(
    meta: NoteMeta,
    pages: PageInk[],
    private clock: () => number = Date.now,
    private newId: () => string = () => defaultNewId(),
  ) {
    this.pageList = pages.length ? [...pages] : [newPage(this.newId())];
    this.meta = meta;
    const ids = this.pageList.map((p) => p.id);
    if (JSON.stringify(meta.pageIds) !== JSON.stringify(ids)) {
      this.meta = { ...meta, pageIds: ids };
      this.metaDirty = true;
    }
  }

  /** Pages as shown (including live-gesture previews). */
  get pages(): readonly PageInk[] {
    return this.previews.size ? this.pageList.map((p, i) => this.previews.get(i) ?? p) : this.pageList;
  }
  /** Pages as committed (what is saved and what undo works on). */
  get committedPages(): readonly PageInk[] { return this.pageList; }
  get pageCount() { return this.pageList.length; }
  page(i: number): PageInk { return this.previews.get(i) ?? this.pageList[i]!; }
  /** Ids of pages with unsaved changes. */
  get dirtyPageIds(): ReadonlySet<string> { return this.changed; }
  indexOfPage(id: string) { return this.pageList.findIndex((p) => p.id === id); }
  get isDirty() { return this.metaDirty || this.changed.size > 0 || this.removed.size > 0; }
  get canUndo() { return this.history.canUndo; }
  get canRedo() { return this.history.canRedo; }

  subscribe(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  // ---- Edits -------------------------------------------------------------------------------

  /** Commits a diff on a page as one undo step. */
  commit(pageIndex: number, diff: PageDiff): void {
    if (isEmptyDiff(diff) || !this.pageList[pageIndex]) return;
    const page = this.pageList[pageIndex]!;
    this.pageList[pageIndex] = applyDiff(page, diff);
    this.history.record(page.id, diff);
    this.touch(page.id);
  }

  /**
   * Adds a freshly drawn stroke. With scratch-out enabled, a scribble over existing ink erases
   * what it covers instead and the scribble itself is discarded.
   */
  addStroke(pageIndex: number, stroke: InkStroke, scratch?: Partial<ScratchOutOptions> | false): AddResult {
    const page = this.pageList[pageIndex];
    if (!page || stroke.points.length === 0) return { kind: 'ignored' };
    if (scratch !== false && scratch !== undefined) {
      const r = detectScratchOut(stroke, page.strokes, scratch);
      if (r.isScratch && r.targetIds.size) {
        this.commit(pageIndex, { label: 'Scratch out', strokes: { removed: indexed(page.strokes, r.targetIds), added: [] } });
        return { kind: 'scratched', erased: r.targetIds.size };
      }
    }
    this.commit(pageIndex, { label: 'Draw', strokes: { removed: [], added: [{ index: page.strokes.length, item: stroke }] } });
    return { kind: 'added' };
  }

  /**
   * Shows intermediate state during a gesture (live erase) without recording history or marking
   * the page dirty: autosave never writes a half-finished gesture.
   */
  preview(pageIndex: number, page: PageInk): void {
    this.previews.set(pageIndex, page);
    this.emit();
  }

  /** Drops a gesture preview (gesture cancelled). */
  clearPreview(pageIndex: number): void {
    if (this.previews.delete(pageIndex)) this.emit();
  }

  /**
   * Records the net effect of a multi-step gesture as one undo step. The diff is rebased onto the
   * page as it is now, so edits committed during the gesture (AI, undo, recognition) are kept.
   */
  commitBetween(pageIndex: number, before: PageInk, after: PageInk, label: string): boolean {
    this.previews.delete(pageIndex);
    const d = pageDiffBetween(before, after, label);
    if (isEmptyDiff(d)) { this.emit(); return false; }
    this.commit(pageIndex, d);
    return true;
  }

  /**
   * Replaces content after sync brought in changes from another device. Undo history is kept
   * (diffs apply by id); pages listed in [dirty] stay marked for saving.
   */
  replaceContent(meta: NoteMeta, pages: PageInk[], dirty: Iterable<string> = []): void {
    this.previews.clear();
    this.pageList = pages.length ? [...pages] : [newPage(this.newId())];
    this.meta = { ...meta, pageIds: this.pageList.map((p) => p.id) };
    this.changed.clear();
    for (const id of dirty) if (this.pageList.some((p) => p.id === id)) this.changed.add(id);
    this.metaDirty = this.changed.size > 0;
    this.emit();
  }

  deleteStrokes(pageIndex: number, ids: Set<string>, label = 'Delete'): boolean {
    const page = this.pageList[pageIndex];
    if (!page) return false;
    const removed = indexed(page.strokes, ids);
    if (!removed.length) return false;
    this.commit(pageIndex, { label, strokes: { removed, added: [] } });
    return true;
  }

  /** Replaces items by id with transformed copies (new ids) in place; returns the new ids. */
  transform(
    pageIndex: number,
    sel: { strokes?: Set<string>; texts?: Set<string>; images?: Set<string> },
    label: string,
    fns: { stroke?: (s: InkStroke) => InkStroke; text?: (t: TextBox) => TextBox; image?: (i: ImageItem) => ImageItem },
  ): { strokes: Set<string>; texts: Set<string>; images: Set<string> } {
    const page = this.pageList[pageIndex]!;
    const res = { strokes: new Set<string>(), texts: new Set<string>(), images: new Set<string>() };
    const replaceIn = <T extends Item>(list: readonly T[], ids: Set<string> | undefined, fn: ((x: T) => T) | undefined, out: Set<string>): ListDiff<T> | undefined => {
      if (!ids?.size || !fn) return undefined;
      const removed: Indexed<T>[] = [];
      const added: Indexed<T>[] = [];
      list.forEach((x, i) => {
        if (!ids.has(x.id)) return;
        const y = { ...fn(x), id: this.newId() };
        out.add(y.id);
        removed.push({ index: i, item: x });
        added.push({ index: i, item: y });
      });
      return removed.length ? { removed, added } : undefined;
    };
    const diff: PageDiff = {
      label,
      strokes: replaceIn(page.strokes, sel.strokes, fns.stroke, res.strokes),
      texts: replaceIn(page.texts ?? [], sel.texts, fns.text, res.texts),
      images: replaceIn(page.images ?? [], sel.images, fns.image, res.images),
    };
    this.commit(pageIndex, diff);
    return res;
  }

  /** Pastes items on top with fresh ids; returns the ids. */
  paste(pageIndex: number, items: { strokes?: InkStroke[]; texts?: TextBox[]; images?: ImageItem[] }, label = 'Paste') {
    const page = this.pageList[pageIndex]!;
    const now = this.clock();
    const res = { strokes: new Set<string>(), texts: new Set<string>(), images: new Set<string>() };
    const add = <T extends Item>(list: readonly T[], src: T[] | undefined, out: Set<string>, stamp: (x: T) => T): ListDiff<T> | undefined => {
      if (!src?.length) return undefined;
      return {
        removed: [],
        added: src.map((x, k) => {
          const y = { ...stamp(x), id: this.newId() };
          out.add(y.id);
          return { index: list.length + k, item: y };
        }),
      };
    };
    this.commit(pageIndex, {
      label,
      strokes: add(page.strokes, items.strokes, res.strokes, (s) => ({ ...s, createdAt: now })),
      texts: add(page.texts ?? [], items.texts, res.texts, (t) => ({ ...t, createdAt: now })),
      images: add(page.images ?? [], items.images, res.images, (i) => ({ ...i, createdAt: now })),
    });
    return res;
  }

  deleteItems(pageIndex: number, sel: { strokes?: Set<string>; texts?: Set<string>; images?: Set<string> }, label = 'Delete'): boolean {
    const page = this.pageList[pageIndex]!;
    const d: PageDiff = {
      label,
      strokes: sel.strokes?.size ? { removed: indexed(page.strokes, sel.strokes), added: [] } : undefined,
      texts: sel.texts?.size ? { removed: indexed(page.texts ?? [], sel.texts), added: [] } : undefined,
      images: sel.images?.size ? { removed: indexed(page.images ?? [], sel.images), added: [] } : undefined,
    };
    if (isEmptyDiff(d)) return false;
    this.commit(pageIndex, d);
    return true;
  }

  upsertText(pageIndex: number, text: TextBox, label = 'Text'): void {
    const page = this.pageList[pageIndex]!;
    const list = page.texts ?? [];
    const i = list.findIndex((t) => t.id === text.id);
    if (i >= 0 && list[i]!.text === text.text && list[i]!.x === text.x && list[i]!.y === text.y && list[i]!.width === text.width && list[i]!.fontSize === text.fontSize && list[i]!.color === text.color && list[i]!.font === text.font) return;
    if (i >= 0 && !text.text.trim()) {
      this.commit(pageIndex, { label: 'Delete text', texts: { removed: [{ index: i, item: list[i]! }], added: [] } });
      return;
    }
    if (i < 0 && !text.text.trim()) return;
    this.commit(pageIndex, {
      label,
      texts: i >= 0 ? { removed: [{ index: i, item: list[i]! }], added: [{ index: i, item: text }] } : { removed: [], added: [{ index: list.length, item: text }] },
    });
  }

  addImage(pageIndex: number, image: ImageItem): void {
    const page = this.pageList[pageIndex]!;
    this.commit(pageIndex, { label: 'Insert image', images: { removed: [], added: [{ index: (page.images ?? []).length, item: image }] } });
  }

  clearPage(pageIndex: number): boolean {
    const p = this.pageList[pageIndex]!;
    return this.deleteItems(pageIndex, {
      strokes: new Set(p.strokes.map((s) => s.id)),
      texts: new Set((p.texts ?? []).map((t) => t.id)),
      images: new Set((p.images ?? []).map((i) => i.id)),
    }, 'Clear page');
  }

  // ---- Undo / redo -------------------------------------------------------------------------

  /** Undoes the last edit; returns the page index it touched, or -1. */
  undo(): number {
    const e = this.history.popUndo();
    if (!e) return -1;
    const i = this.indexOfPage(e.pageId);
    if (i < 0) return -1;
    this.pageList[i] = applyDiff(this.pageList[i]!, invertDiff(e.diff));
    this.touch(e.pageId);
    return i;
  }

  redo(): number {
    const e = this.history.popRedo();
    if (!e) return -1;
    const i = this.indexOfPage(e.pageId);
    if (i < 0) return -1;
    this.pageList[i] = applyDiff(this.pageList[i]!, e.diff);
    this.touch(e.pageId);
    return i;
  }

  // ---- Pages -------------------------------------------------------------------------------

  addPage(at = this.pageList.length, template?: Partial<PageInk>): number {
    const idx = Math.max(0, Math.min(at, this.pageList.length));
    const page: PageInk = { ...newPage(this.newId()), ...template, strokes: template?.strokes ?? [] };
    this.pageList.splice(idx, 0, page);
    this.changed.add(page.id);
    this.syncPageIds();
    return idx;
  }

  duplicatePage(index: number): number {
    const src = this.pageList[index]!;
    const copy: PageInk = {
      ...src,
      id: this.newId(),
      strokes: src.strokes.map((s) => ({ ...s, id: this.newId() })),
      texts: src.texts?.map((t) => ({ ...t, id: this.newId() })),
      images: src.images?.map((im) => ({ ...im, id: this.newId() })),
    };
    this.pageList.splice(index + 1, 0, copy);
    this.changed.add(copy.id);
    this.syncPageIds();
    return index + 1;
  }

  deletePage(index: number): boolean {
    if (this.pageList.length <= 1 || !this.pageList[index]) return false;
    const [removed] = this.pageList.splice(index, 1);
    this.history.forgetPage(removed!.id);
    this.changed.delete(removed!.id);
    this.removed.add(removed!.id);
    this.syncPageIds();
    return true;
  }

  movePage(from: number, to: number): void {
    if (!this.pageList[from] || !this.pageList[to] || from === to) return;
    const [p] = this.pageList.splice(from, 1);
    this.pageList.splice(to, 0, p!);
    this.syncPageIds();
  }

  setPageProps(index: number, props: { paper?: PaperSpec; size?: PageSize }): void {
    const p = this.pageList[index]!;
    this.pageList[index] = { ...p, ...props };
    this.touch(p.id);
  }

  private syncPageIds() {
    this.previews.clear();
    this.meta = { ...this.meta, pageIds: this.pageList.map((p) => p.id), updatedAt: this.clock() };
    this.metaDirty = true;
    this.emit();
  }

  // ---- Metadata ----------------------------------------------------------------------------

  updateMeta(fn: (m: NoteMeta) => NoteMeta): void {
    const next = fn(this.meta);
    if (next === this.meta) return;
    this.meta = { ...next, updatedAt: this.clock() };
    this.metaDirty = true;
    this.emit();
  }

  rename(title: string) { this.updateMeta((m) => ({ ...m, title: title.trim() || 'Untitled' })); }
  setPaper(paper: PaperSpec) { this.updateMeta((m) => ({ ...m, paper })); }
  setTags(tags: string[]) { this.updateMeta((m) => ({ ...m, tags: [...new Set(tags.map((t) => t.trim()).filter(Boolean))] })); }

  /** Stores recognized text (search/Markdown/agents). Not part of undo history. */
  setRecognizedText(pageId: string, text: string | undefined, by?: string): void {
    const i = this.indexOfPage(pageId);
    if (i < 0 || this.pageList[i]!.recognizedText === text) return;
    this.pageList[i] = { ...this.pageList[i]!, recognizedText: text, recognizedAt: this.clock(), recognizedBy: by };
    this.changed.add(pageId);
    this.metaDirty = true;
    this.emit();
  }

  // ---- Saving ------------------------------------------------------------------------------

  /** Takes what needs saving and clears dirty marks; null when clean. */
  takeDirty(): DocumentSnapshot | null {
    if (!this.isDirty) return null;
    const snap = { meta: this.meta, pages: [...this.pageList], changedPageIds: new Set(this.changed), removedPageIds: new Set(this.removed) };
    this.changed.clear();
    this.removed.clear();
    this.metaDirty = false;
    return snap;
  }

  /** Puts dirty marks back after a failed save so the next attempt retries. */
  restoreDirty(s: DocumentSnapshot): void {
    for (const id of s.changedPageIds) this.changed.add(id);
    for (const id of s.removedPageIds) this.removed.add(id);
    this.metaDirty = true;
  }

  private touch(pageId: string) {
    this.changed.add(pageId);
    this.meta = { ...this.meta, updatedAt: this.clock() };
    this.metaDirty = true;
    this.emit();
  }

  private emit() {
    this.version++;
    for (const l of [...this.listeners]) l();
  }
}

function indexed<T extends Item>(list: readonly T[], ids: Set<string>): Indexed<T>[] {
  const out: Indexed<T>[] = [];
  list.forEach((x, i) => { if (ids.has(x.id)) out.push({ index: i, item: x }); });
  return out;
}
