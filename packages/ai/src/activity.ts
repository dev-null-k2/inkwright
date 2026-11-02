/**
 * The AI activity log: every change an agent makes to the user's notes is recorded as a reversible
 * operation, grouped into runs (one assistant turn, one routine run, one external agent session).
 * The log lives in the vault (`ai/activity/<runId>.json`) so it syncs with the notes it describes
 * and undo works on any device.
 *
 * Recording happens in one place — `RecordingNoteToolHost` wraps whatever `NoteToolHost` the agent
 * uses — so in-panel chats, routines and future agents can't forget to log. Undo is expressed
 * against a small `UndoTarget` interface: the app implements it through the open note's
 * NoteDocument (so the change appears live and is itself undoable) and the vault for everything
 * else; `VaultUndoTarget` is the vault-only reference implementation.
 */
import { isSafeId, newId, type NoteMeta, type PageInk, type Vault, type VaultFS } from '@inkstone/core';
import type { NoteContent, NoteInfo, NoteListItem, NotePatch, NoteSearchHit, NoteToolHost, NotebookInfo } from './tools/notes.ts';

/** Metadata fields an agent can change (the subset `update_note` exposes). */
export interface MetaFields {
  title?: string;
  tags?: string[];
  /** `null` = not in a notebook. */
  notebookId?: string | null;
  pinned?: boolean;
  /** `null` = no summary. */
  summary?: string | null;
}

interface OpBase {
  id: string;
  at: number;
  /** The tool that made the change (e.g. `create_note`, `notion__create_page`). */
  tool: string;
  /** Plain-language before → after summary for the activity view. */
  summary: string;
  /** Set once undone (epoch ms). */
  undoneAt?: number;
  /** Why the last undo attempt failed or was partial. */
  undoNote?: string;
}

export type ActivityOp =
  | (OpBase & { kind: 'note_created'; noteId: string; title: string })
  | (OpBase & { kind: 'note_trashed'; noteId: string; title: string })
  | (OpBase & { kind: 'text_appended'; noteId: string; title: string; pageId: string; textId: string; text: string; addedPage?: boolean })
  | (OpBase & { kind: 'meta_changed'; noteId: string; title: string; before: MetaFields; after: MetaFields })
  | (OpBase & { kind: 'notebook_created'; notebookId: string; name: string })
  /** Handwriting on a page was converted to text (the ink is untouched); undo clears that text. */
  | (OpBase & { kind: 'handwriting_recognized'; noteId: string; title: string; pageId: string; text: string })
  /**
   * A text box's Markdown was replaced (an accepted compiled-wiki update, docs/COMPILER.md); undo
   * puts `before` back while the box still holds `after`.
   */
  | (OpBase & { kind: 'text_replaced'; noteId: string; title: string; pageId: string; textId: string; before: string; after: string })
  /** A change in another app through a connected MCP server: shown, but only that app can undo it. */
  | (OpBase & { kind: 'external'; server: string; detail?: string });

export type ActivityOpKind = ActivityOp['kind'];

/** Distributes Omit over the union so each op keeps its own fields. */
export type NewActivityOp = ActivityOp extends infer T ? (T extends ActivityOp ? Omit<T, 'id' | 'at'> : never) : never;

export type ActivitySource = 'assistant' | 'routine' | 'external';

export interface ActivityRun {
  id: string;
  source: ActivitySource;
  /** "Assistant", the routine's name, or the external agent's name. */
  label: string;
  routineId?: string;
  /** What the user asked / the routine's trigger, shortened. */
  prompt?: string;
  startedAt: number;
  endedAt?: number;
  status: 'running' | 'done' | 'error' | 'cancelled';
  /** The agent's final reply, shortened. */
  reply?: string;
  error?: string;
  ops: ActivityOp[];
}

export const isReversible = (op: ActivityOp) => op.kind !== 'external';

const clip = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const q = (s: string) => `“${clip(s || 'Untitled', 60)}”`;

function describeMeta(before: MetaFields, after: MetaFields, notebookName?: (id: string | null | undefined) => string): string {
  const parts: string[] = [];
  if (after.title !== undefined && after.title !== before.title) parts.push(`renamed ${q(before.title ?? '')} → ${q(after.title)}`);
  if (after.tags !== undefined) {
    const b = new Set(before.tags ?? []);
    const a = new Set(after.tags);
    const added = [...a].filter((t) => !b.has(t));
    const removed = [...b].filter((t) => !a.has(t));
    if (added.length) parts.push(`tagged ${added.map((t) => `#${t}`).join(' ')}`);
    if (removed.length) parts.push(`removed ${removed.map((t) => `#${t}`).join(' ')}`);
  }
  if (after.notebookId !== undefined && after.notebookId !== before.notebookId) {
    parts.push(after.notebookId ? `moved to ${notebookName?.(after.notebookId) ?? 'a notebook'}` : 'unfiled');
  }
  if (after.pinned !== undefined && after.pinned !== before.pinned) parts.push(after.pinned ? 'pinned' : 'unpinned');
  if (after.summary !== undefined && after.summary !== before.summary) parts.push(after.summary ? 'set the summary' : 'cleared the summary');
  return parts.join(', ') || 'no visible change';
}

function metaOf(n: NoteInfo): MetaFields {
  return { title: n.title, tags: [...(n.tags ?? [])], notebookId: n.notebookId ?? null, pinned: !!n.pinned, summary: n.summary ?? null };
}

function patchToFields(p: NotePatch): MetaFields {
  const out: MetaFields = {};
  if (p.title !== undefined) out.title = p.title;
  if (p.tags !== undefined) out.tags = [...p.tags];
  if (p.notebookId !== undefined) out.notebookId = p.notebookId;
  if (p.pinned !== undefined) out.pinned = p.pinned;
  if (p.summary !== undefined) out.summary = p.summary || null;
  return out;
}

const pick = (m: MetaFields, keys: (keyof MetaFields)[]): MetaFields => Object.fromEntries(keys.map((k) => [k, m[k]])) as MetaFields;

/** Text-box id and page id of the appended text, when the host reports them. */
export interface AppendResult {
  noteId: string;
  pageIndex: number;
  pageId?: string;
  textId?: string;
  /** The host had to add a page for the text. */
  addedPage?: boolean;
}

/**
 * Wraps a NoteToolHost and records every write as a reversible ActivityOp. Reads pass through.
 * Hosts must return `textId`/`pageId` from `appendText` for appends to be undoable.
 */
export class RecordingNoteToolHost implements NoteToolHost {
  getPageImage?: NoteToolHost['getPageImage'];
  /** The tool currently running (set by the tool wrapper so ops name it). */
  currentTool = '';

  constructor(private inner: NoteToolHost, private record: (op: NewActivityOp) => void, private clock: () => number = Date.now) {
    if (inner.getPageImage) this.getPageImage = (n, p) => inner.getPageImage!(n, p);
  }

  listNotes(opts?: Parameters<NoteToolHost['listNotes']>[0]): Promise<NoteListItem[]> { return this.inner.listNotes(opts); }
  searchNotes(query: string, opts?: { limit?: number }): Promise<NoteSearchHit[]> { return this.inner.searchNotes(query, opts); }
  readNote(id: string): Promise<NoteContent | null> { return this.inner.readNote(id); }
  listNotebooks(): Promise<NotebookInfo[]> { return this.inner.listNotebooks(); }

  private tool(fallback: string) { return this.currentTool || fallback; }

  async createNote(args: { title: string; text: string; notebookId?: string; tags?: string[] }): Promise<NoteInfo> {
    const n = await this.inner.createNote(args);
    this.record({ kind: 'note_created', tool: this.tool('create_note'), noteId: n.id, title: n.title, summary: `Created ${q(n.title)}` });
    return n;
  }

  async appendText(noteId: string, text: string, pageIndex?: number): Promise<AppendResult> {
    const before = await this.inner.readNote(noteId);
    const r = (await this.inner.appendText(noteId, text, pageIndex)) as AppendResult;
    const title = before?.meta.title ?? '';
    if (r.textId && r.pageId) {
      this.record({ kind: 'text_appended', tool: this.tool('append_to_note'), noteId, title, pageId: r.pageId, textId: r.textId, text, addedPage: r.addedPage, summary: `Added “${clip(text.replace(/\s+/g, ' '), 70)}” to ${q(title)}` });
    } else {
      this.record({ kind: 'external', tool: this.tool('append_to_note'), server: 'notes', detail: noteId, summary: `Added text to ${q(title)} (this host can't undo it)` });
    }
    return r;
  }

  async updateNote(id: string, patch: NotePatch): Promise<NoteInfo | null> {
    const before = await this.inner.readNote(id);
    const n = await this.inner.updateNote(id, patch);
    if (n && before) {
      const keys = Object.keys(patchToFields(patch)) as (keyof MetaFields)[];
      const b = pick(metaOf(before.meta), keys);
      const a = pick(metaOf(n), keys);
      const names = new Map((await this.inner.listNotebooks()).map((x) => [x.id, x.name]));
      this.record({ kind: 'meta_changed', tool: this.tool('update_note'), noteId: id, title: before.meta.title, before: b, after: a, summary: `${q(before.meta.title)}: ${describeMeta(b, a, (x) => (x ? names.get(x) ?? 'a notebook' : 'no notebook'))}` });
    }
    return n;
  }

  async createNotebook(name: string, opts?: { parentId?: string }): Promise<NotebookInfo> {
    const nb = await this.inner.createNotebook(name, opts);
    this.record({ kind: 'notebook_created', tool: this.tool('create_notebook'), notebookId: nb.id, name: nb.name, summary: `Created the notebook ${q(nb.name)}` });
    return nb;
  }

  async trashNote(id: string): Promise<boolean | void> {
    const before = await this.inner.readNote(id);
    const r = await this.inner.trashNote(id);
    if (r !== false) this.record({ kind: 'note_trashed', tool: this.tool('trash_note'), noteId: id, title: before?.meta.title ?? '', summary: `Moved ${q(before?.meta.title ?? '')} to Trash` });
    return r;
  }

  /** Clock used for op timestamps (exposed for the run recorder). */
  now() { return this.clock(); }
}

// ---- Undo -------------------------------------------------------------------------------------

/** What undo needs from the app: the open note goes through its document, the rest the vault. */
export interface UndoTarget {
  /** Current metadata, or null if the note no longer exists (trashed notes still exist). */
  readMeta(noteId: string): Promise<(MetaFields & { trashed: boolean }) | null>;
  writeMeta(noteId: string, fields: MetaFields): Promise<boolean>;
  trashNote(noteId: string): Promise<boolean>;
  restoreNote(noteId: string): Promise<boolean>;
  /** Removes one text box; false if it is gone already. */
  removeText(noteId: string, pageId: string, textId: string, opts?: { removePageIfEmpty?: boolean }): Promise<boolean>;
  notebookNoteCount(notebookId: string): Promise<number | null>;
  deleteNotebook(notebookId: string): Promise<boolean>;
  /**
   * Clears a page's recognized handwriting text, but only while it is still `expected` (the user
   * may have corrected or re-run recognition since). Optional so older hosts keep compiling; undo
   * says it can't when it is missing.
   */
  clearRecognizedText?(noteId: string, pageId: string, expected: string): Promise<'cleared' | 'changed' | 'missing'>;
  /**
   * Sets a text box's Markdown to `next`, but only while it still holds `expected` (so a later
   * edit by the user is never overwritten). Optional like `clearRecognizedText`.
   */
  replaceText?(noteId: string, pageId: string, textId: string, expected: string, next: string): Promise<'replaced' | 'changed' | 'missing'>;
}

export interface UndoResult {
  ok: boolean;
  /** Explanation when nothing or only part could be undone. */
  message?: string;
}

const sameValue = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/**
 * Reverts one operation. Never clobbers a later edit by the user: metadata fields are only put
 * back when they still hold the value the agent wrote.
 */
export async function undoOp(op: ActivityOp, target: UndoTarget): Promise<UndoResult> {
  if (op.undoneAt) return { ok: true, message: 'Already undone.' };
  switch (op.kind) {
    case 'note_created': {
      const m = await target.readMeta(op.noteId);
      if (!m) return { ok: true, message: 'The note no longer exists.' };
      if (m.trashed) return { ok: true, message: 'The note is already in Trash.' };
      return (await target.trashNote(op.noteId)) ? { ok: true, message: 'Moved the note to Trash (recoverable for 30 days).' } : { ok: false, message: 'Could not move the note to Trash.' };
    }
    case 'note_trashed': {
      const m = await target.readMeta(op.noteId);
      if (!m) return { ok: false, message: 'The note was deleted permanently since.' };
      if (!m.trashed) return { ok: true, message: 'The note is not in Trash.' };
      return (await target.restoreNote(op.noteId)) ? { ok: true } : { ok: false, message: 'Could not restore the note.' };
    }
    case 'text_appended': {
      const removed = await target.removeText(op.noteId, op.pageId, op.textId, { removePageIfEmpty: !!op.addedPage });
      return removed ? { ok: true } : { ok: true, message: 'That text was already removed.' };
    }
    case 'meta_changed': {
      const m = await target.readMeta(op.noteId);
      if (!m) return { ok: false, message: 'The note no longer exists.' };
      const restore: MetaFields = {};
      const kept: string[] = [];
      for (const k of Object.keys(op.after) as (keyof MetaFields)[]) {
        if (sameValue(m[k], op.after[k])) (restore as Record<string, unknown>)[k] = op.before[k];
        else kept.push(k === 'notebookId' ? 'notebook' : k);
      }
      if (!Object.keys(restore).length) return { ok: false, message: `You changed the ${kept.join(', ')} since; kept your version.` };
      const ok = await target.writeMeta(op.noteId, restore);
      if (!ok) return { ok: false, message: 'Could not update the note.' };
      return kept.length ? { ok: true, message: `Kept your later change to the ${kept.join(', ')}.` } : { ok: true };
    }
    case 'notebook_created': {
      const count = await target.notebookNoteCount(op.notebookId);
      if (count == null) return { ok: true, message: 'The notebook no longer exists.' };
      if (count > 0) return { ok: false, message: `The notebook has ${count} ${count === 1 ? 'note' : 'notes'} in it now, so it was kept.` };
      return (await target.deleteNotebook(op.notebookId)) ? { ok: true } : { ok: false, message: 'Could not delete the notebook.' };
    }
    case 'handwriting_recognized': {
      if (!target.clearRecognizedText) return { ok: false, message: 'Update Inkstone to undo this.' };
      const r = await target.clearRecognizedText(op.noteId, op.pageId, op.text);
      if (r === 'cleared') return { ok: true };
      if (r === 'changed') return { ok: false, message: 'The recognized text was edited since; kept your version.' };
      return { ok: true, message: 'That page no longer exists.' };
    }
    case 'text_replaced': {
      if (!target.replaceText) return { ok: false, message: 'Update Inkstone to undo this.' };
      const r = await target.replaceText(op.noteId, op.pageId, op.textId, op.after, op.before);
      if (r === 'replaced') return { ok: true };
      if (r === 'changed') return { ok: false, message: 'The text was edited since; kept your version.' };
      return { ok: true, message: 'That text no longer exists.' };
    }
    case 'external':
      return { ok: false, message: 'This change was made in another app; undo it there.' };
  }
}

/** Undoes a run's operations newest first. Returns per-op results (same order as `run.ops`). */
export async function undoRun(run: ActivityRun, target: UndoTarget, clock: () => number = Date.now): Promise<Map<string, UndoResult>> {
  const out = new Map<string, UndoResult>();
  for (const op of [...run.ops].reverse()) {
    if (op.undoneAt || !isReversible(op)) continue;
    const r = await undoOp(op, target);
    out.set(op.id, r);
    if (r.ok) op.undoneAt = clock();
    if (r.message) op.undoNote = r.message;
    else delete op.undoNote;
  }
  return out;
}

/** Applies one undo to a stored run (marks the op) — the caller saves the run afterwards. */
export async function undoOpInRun(run: ActivityRun, opId: string, target: UndoTarget, clock: () => number = Date.now): Promise<UndoResult> {
  const op = run.ops.find((o) => o.id === opId);
  if (!op) return { ok: false, message: 'Unknown action.' };
  const r = await undoOp(op, target);
  if (r.ok) op.undoneAt = clock();
  if (r.message) op.undoNote = r.message;
  else delete op.undoNote;
  return r;
}

/** UndoTarget over a core Vault (closed notes; tests). `onChange` lets the caller reindex. */
export class VaultUndoTarget implements UndoTarget {
  constructor(private vault: Vault, private onChange: (noteId: string | null) => void | Promise<void> = () => {}) {}

  private async note(id: string): Promise<NoteMeta | null> {
    return isSafeId(id) ? this.vault.readNote(id) : null;
  }

  async readMeta(noteId: string) {
    const n = await this.note(noteId);
    return n ? { title: n.title, tags: [...n.tags], notebookId: n.notebookId ?? null, pinned: n.pinned, summary: n.summary ?? null, trashed: n.trashedAt != null } : null;
  }

  async writeMeta(noteId: string, f: MetaFields) {
    const n = await this.vault.updateNote(noteId, (m) => applyMetaFields(m, f));
    await this.onChange(noteId);
    return !!n;
  }

  async trashNote(noteId: string) {
    if (!(await this.note(noteId))) return false;
    await this.vault.trashNote(noteId);
    await this.onChange(noteId);
    return true;
  }

  async restoreNote(noteId: string) {
    if (!(await this.note(noteId))) return false;
    await this.vault.restoreNote(noteId);
    await this.onChange(noteId);
    return true;
  }

  async removeText(noteId: string, pageId: string, textId: string, opts: { removePageIfEmpty?: boolean } = {}) {
    const n = await this.note(noteId);
    if (!n || !n.pageIds.includes(pageId)) return false;
    const page = await this.vault.readPage(noteId, pageId);
    if (!(page.texts ?? []).some((t) => t.id === textId)) return false;
    const next: PageInk = { ...page, texts: (page.texts ?? []).filter((t) => t.id !== textId) };
    const empty = !next.strokes.length && !(next.texts ?? []).length && !(next.images ?? []).length && !next.background;
    if (opts.removePageIfEmpty && empty && n.pageIds.length > 1) {
      const meta = { ...n, pageIds: n.pageIds.filter((p) => p !== pageId), updatedAt: Date.now() };
      const pages = await this.vault.readPages(meta);
      await this.vault.saveNote(meta, pages, { changedPageIds: [], removedPageIds: [pageId] });
    } else {
      const meta = { ...n, updatedAt: Date.now() };
      const pages = (await this.vault.readPages(n)).map((p) => (p.id === pageId ? next : p));
      await this.vault.saveNote(meta, pages, { changedPageIds: [pageId] });
    }
    await this.onChange(noteId);
    return true;
  }

  async clearRecognizedText(noteId: string, pageId: string, expected: string): Promise<'cleared' | 'changed' | 'missing'> {
    const n = await this.note(noteId);
    if (!n || !n.pageIds.includes(pageId)) return 'missing';
    const page = await this.vault.readPage(noteId, pageId);
    if ((page.recognizedText ?? '') !== expected) return 'changed';
    const { recognizedText: _t, recognizedAt: _a, recognizedBy: _b, ...rest } = page;
    const pages = (await this.vault.readPages(n)).map((p) => (p.id === pageId ? (rest as PageInk) : p));
    await this.vault.saveNote({ ...n, updatedAt: Date.now() }, pages, { changedPageIds: [pageId] });
    await this.onChange(noteId);
    return 'cleared';
  }

  async replaceText(noteId: string, pageId: string, textId: string, expected: string, next: string): Promise<'replaced' | 'changed' | 'missing'> {
    const n = await this.note(noteId);
    if (!n || !n.pageIds.includes(pageId)) return 'missing';
    const page = await this.vault.readPage(noteId, pageId);
    const box = (page.texts ?? []).find((t) => t.id === textId);
    if (!box) return 'missing';
    if (box.text !== expected) return 'changed';
    const pages = (await this.vault.readPages(n)).map((p) => (p.id === pageId ? { ...p, texts: (p.texts ?? []).map((t) => (t.id === textId ? { ...t, text: next } : t)) } : p));
    await this.vault.saveNote({ ...n, updatedAt: Date.now() }, pages, { changedPageIds: [pageId] });
    await this.onChange(noteId);
    return 'replaced';
  }

  async notebookNoteCount(notebookId: string) {
    if (!(await this.vault.listNotebooks()).some((b) => b.id === notebookId)) return null;
    return (await this.vault.listNotes({ includeTrashed: false })).filter((n) => n.notebookId === notebookId).length;
  }

  async deleteNotebook(notebookId: string) {
    await this.vault.deleteNotebook(notebookId);
    await this.onChange(null);
    return true;
  }
}

/** Applies MetaFields to a NoteMeta (null clears notebook/summary). */
export function applyMetaFields(m: NoteMeta, f: MetaFields): NoteMeta {
  const out: NoteMeta = { ...m };
  if (f.title !== undefined) out.title = f.title;
  if (f.tags !== undefined) out.tags = [...f.tags];
  if (f.pinned !== undefined) out.pinned = f.pinned;
  if (f.notebookId !== undefined) {
    if (f.notebookId === null) delete out.notebookId;
    else out.notebookId = f.notebookId;
  }
  if (f.summary !== undefined) {
    if (f.summary === null || f.summary === '') delete out.summary;
    else out.summary = f.summary;
  }
  return out;
}

// ---- Storage ----------------------------------------------------------------------------------

/** Vault folder for the activity log (documented in docs/VAULT_FORMAT.md). */
export const ACTIVITY_DIR = 'ai/activity';

/**
 * Activity runs as one JSON file each, so devices editing different runs never conflict. Keeps the
 * newest `maxRuns` runs; older ones are pruned on write.
 */
export class ActivityStore {
  private listeners = new Set<() => void>();
  constructor(private fs: VaultFS, private opts: { maxRuns?: number } = {}) {}

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() { for (const l of [...this.listeners]) l(); }

  async list(): Promise<ActivityRun[]> {
    const runs: ActivityRun[] = [];
    for (const e of await this.fs.list(ACTIVITY_DIR)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      const r = await this.get(e.name.slice(0, -5));
      if (r) runs.push(r);
    }
    return runs.sort((a, b) => b.startedAt - a.startedAt);
  }

  async get(id: string): Promise<ActivityRun | null> {
    if (!isSafeId(id)) return null;
    const text = await this.fs.readText(`${ACTIVITY_DIR}/${id}.json`);
    if (!text) return null;
    try {
      const r = JSON.parse(text) as ActivityRun;
      return r && r.id === id && Array.isArray(r.ops) ? r : null;
    } catch {
      return null;
    }
  }

  async save(run: ActivityRun): Promise<void> {
    await this.fs.writeText(`${ACTIVITY_DIR}/${run.id}.json`, JSON.stringify(run, null, 1));
    this.emit();
  }

  async remove(id: string): Promise<void> {
    if (!isSafeId(id)) return;
    await this.fs.delete(`${ACTIVITY_DIR}/${id}.json`);
    this.emit();
  }

  /** Deletes the oldest runs beyond `maxRuns` (default 300). */
  async prune(): Promise<number> {
    const max = this.opts.maxRuns ?? 300;
    const runs = await this.list();
    const old = runs.slice(max);
    for (const r of old) await this.fs.delete(`${ACTIVITY_DIR}/${r.id}.json`);
    if (old.length) this.emit();
    return old.length;
  }
}

/**
 * Collects one run's ops and persists them as they happen (so a crash mid-run still leaves an
 * undoable record). Pass `recorder.record` to RecordingNoteToolHost.
 */
export class RunRecorder {
  readonly run: ActivityRun;
  private saving: Promise<void> = Promise.resolve();

  constructor(private store: ActivityStore | null, init: Pick<ActivityRun, 'source' | 'label'> & Partial<Pick<ActivityRun, 'routineId' | 'prompt'>>, private clock: () => number = Date.now) {
    this.run = { id: newId(clock()), startedAt: clock(), status: 'running', ops: [], ...init };
    if (init.prompt) this.run.prompt = clip(init.prompt, 240);
  }

  record = (op: NewActivityOp): void => {
    this.run.ops.push({ ...op, id: newId(this.clock()), at: this.clock() } as ActivityOp);
    this.persist();
  };

  /** Writes the run if anything changed (runs without changes are not logged unless `always`). */
  private persist(always = false) {
    if (!this.store || (!always && !this.run.ops.length)) return;
    const snapshot = JSON.parse(JSON.stringify(this.run)) as ActivityRun;
    this.saving = this.saving.then(() => this.store!.save(snapshot)).catch((e) => console.warn('activity log write failed', e));
  }

  /** Ends the run. Routine runs are always logged (even with no changes) so the user can see they ran. */
  async finish(status: ActivityRun['status'], extra: { reply?: string; error?: string; alwaysLog?: boolean } = {}): Promise<ActivityRun> {
    this.run.status = status;
    this.run.endedAt = this.clock();
    if (extra.reply) this.run.reply = clip(extra.reply.trim(), 400);
    if (extra.error) this.run.error = clip(extra.error, 400);
    this.persist(extra.alwaysLog);
    await this.saving;
    return this.run;
  }
}
