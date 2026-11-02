/**
 * Per-notebook (and per-tag) AI permissions, enforced where agents touch notes: a
 * `NoteToolHost` wrapper used by the in-app assistant, routines, the A2A agent and the always-on
 * runner. (The MCP server's own tools read the vault directly and are covered by its policy
 * vault, which applies the same `accessFor` rules.)
 *
 * - `none`: the notes do not exist as far as agents can tell — not listed, not found by search,
 *   not readable, their notebooks not listed.
 * - `read`: agents can read but not change them, move them, or file new notes there.
 * - `read-write` (default): everything the user allows elsewhere.
 *
 * The wrapper also tells the run which notes' content entered the conversation (`TrustRun`), so
 * the router can keep a run on the device once it has read a local-only note, and the audit
 * trail can say exactly which notes each model call saw.
 */
import type { AuditEntry } from './audit.ts';
import { TaintTracker } from './injection.ts';
import { accessFor, hasScopeRules, isLocalOnly, type AIPolicy, type NoteLabel, type NotebookAccess } from './policy.ts';

/** How a local-only note appears in listings and search results: it exists, its content doesn't show. */
export const PRIVATE_TITLE = 'Private note (stays on this device)';
import type { NoteContent, NoteInfo, NoteListItem, NotePatch, NoteSearchHit, NoteToolHost, NotebookInfo } from '../tools/notes.ts';

/**
 * State shared by everything that serves one agent run (or one single AI call): the notes whose
 * content it has seen, and the injection taint. Created by the caller and handed to both the
 * guarded provider and the access-controlled host.
 */
export class TrustRun {
  readonly notes = new Map<string, NoteLabel>();
  readonly taint = new TaintTracker();
  constructor(initial: Iterable<NoteLabel> = []) {
    for (const n of initial) this.see(n);
  }
  see(n: NoteLabel): void {
    this.notes.set(n.id, { ...this.notes.get(n.id), ...n });
  }
}

export class AccessDeniedError extends Error {
  readonly code = 'policy_blocked';
  readonly reason = 'access' as const;
  constructor(message: string) {
    super(message);
    this.name = 'PolicyBlockedError';
  }
}

export interface AccessOptions {
  policy: () => AIPolicy;
  /** The note's labels (notebook chain and tags), or null when it doesn't exist. */
  labelOf: (noteId: string) => Promise<NoteLabel | null>;
  /** Parent of a notebook, for notebook chains. */
  notebookParent: (notebookId: string) => string | null | undefined | Promise<string | null | undefined>;
  run?: TrustRun;
  audit?: (e: AuditEntry) => void;
  actor?: AuditEntry['actor'];
}

const hidden = (id: string) => new AccessDeniedError(`No note with id "${id}" is available to the assistant.`);

/** Wraps a NoteToolHost so the policy's notebook and tag permissions apply to every call. */
export class AccessControlledNoteToolHost implements NoteToolHost {
  getPageImage?: NoteToolHost['getPageImage'];

  constructor(private inner: NoteToolHost, private o: AccessOptions) {
    if (inner.getPageImage) {
      this.getPageImage = async (noteId, pageIndex) => {
        const label = await this.require(noteId, 'read');
        const img = await inner.getPageImage!(noteId, pageIndex);
        if (img) this.saw(label, 'get_page_image');
        return img;
      };
    }
  }

  private async chain(notebookId: string | null | undefined): Promise<string[]> {
    const out: string[] = [];
    let cur = notebookId ?? null;
    while (cur && !out.includes(cur) && out.length < 32) {
      out.push(cur);
      cur = (await this.o.notebookParent(cur)) ?? null;
    }
    return out;
  }

  private async labelFromInfo(n: Pick<NoteInfo, 'id' | 'title' | 'notebookId' | 'tags'>): Promise<NoteLabel> {
    return { id: n.id, title: n.title, notebookIds: await this.chain(n.notebookId), tags: n.tags };
  }

  private access(label: NoteLabel): NotebookAccess {
    return accessFor(this.o.policy(), label);
  }

  private async require(noteId: string, need: 'read' | 'write'): Promise<NoteLabel> {
    const label = await this.o.labelOf(noteId);
    if (!label) throw hidden(noteId);
    const a = this.access(label);
    if (a === 'none') throw hidden(noteId);
    if (need === 'write' && a !== 'read-write') {
      this.o.audit?.({ kind: 'blocked', actor: this.o.actor, summary: `Refused a change to “${label.title ?? noteId}”: the AI policy makes it read-only`, notes: [{ id: noteId, ...(label.title ? { title: label.title } : {}) }], outcome: 'blocked' });
      throw new AccessDeniedError(`“${label.title ?? 'This note'}” is read-only for the assistant (AI policy). Tell the user what you would change instead.`);
    }
    return label;
  }

  private async requireNotebookWritable(notebookId: string | null | undefined, tags: readonly string[] = []): Promise<void> {
    if (!hasScopeRules(this.o.policy())) return;
    const label: NoteLabel = { id: '(new)', notebookIds: await this.chain(notebookId), tags };
    const a = this.access(label);
    if (a !== 'read-write') throw new AccessDeniedError(`The assistant can’t put notes there: that notebook is ${a === 'none' ? 'not available' : 'read-only'} to it (AI policy).`);
  }

  private wrote(tool: string, note: { id: string; title?: string } | null, summary?: string): void {
    this.o.audit?.({ kind: 'write', actor: this.o.actor, tool, ...(note ? { notes: [{ id: note.id, ...(note.title ? { title: note.title } : {}) }] } : {}), ...(summary ? { summary } : {}) });
  }

  private saw(label: NoteLabel, how: string): void {
    this.o.run?.see(label);
    this.o.audit?.({ kind: 'read', actor: this.o.actor, tool: how, notes: [{ id: label.id, ...(label.title ? { title: label.title } : {}) }] });
  }

  async listNotes(opts?: Parameters<NoteToolHost['listNotes']>[0]): Promise<NoteListItem[]> {
    const policy = this.o.policy();
    if (!hasScopeRules(policy)) return this.inner.listNotes(opts);
    // Ask for more than the limit, since some may be filtered out.
    const want = opts?.limit ?? 50;
    const all = await this.inner.listNotes({ ...opts, limit: Math.max(want * 3, want + 100) });
    const out: NoteListItem[] = [];
    for (const n of all) {
      if (out.length >= want) break;
      const label = await this.labelFromInfo(n);
      if (accessFor(policy, label) === 'none') continue;
      // Titles and summaries are content: a local-only note is listed without them. Reading it
      // (read_note) brings its content in, and the router then keeps the run on the device.
      out.push(isLocalOnly(policy, label) ? { ...n, title: PRIVATE_TITLE, summary: undefined } : n);
    }
    return out;
  }

  async searchNotes(query: string, opts?: { limit?: number }): Promise<NoteSearchHit[]> {
    const policy = this.o.policy();
    const hits = await this.inner.searchNotes(query, hasScopeRules(policy) ? { limit: (opts?.limit ?? 10) * 3 } : opts);
    const out: NoteSearchHit[] = [];
    for (const h of hits) {
      if (out.length >= (opts?.limit ?? 10)) break;
      const label = await this.o.labelOf(h.noteId);
      if (!label || accessFor(policy, label) === 'none') continue;
      if (isLocalOnly(policy, label)) {
        out.push({ ...h, title: PRIVATE_TITLE, snippet: '' });
        continue;
      }
      // Snippets are note content: they count as seen.
      this.o.run?.see(label);
      out.push(h);
    }
    if (out.length) this.o.audit?.({ kind: 'read', actor: this.o.actor, tool: 'search_notes', notes: out.map((h) => ({ id: h.noteId, title: h.title })) });
    return out;
  }

  async readNote(id: string): Promise<NoteContent | null> {
    const label = await this.require(id, 'read');
    const c = await this.inner.readNote(id);
    if (c) this.saw(label, 'read_note');
    return c;
  }

  async listNotebooks(): Promise<NotebookInfo[]> {
    const policy = this.o.policy();
    const all = await this.inner.listNotebooks();
    if (!hasScopeRules(policy)) return all;
    const out: NotebookInfo[] = [];
    for (const b of all) if (accessFor(policy, { id: '', notebookIds: await this.chain(b.id) }) !== 'none') out.push(b);
    return out;
  }

  async createNote(args: { title: string; text: string; notebookId?: string; tags?: string[] }): Promise<NoteInfo> {
    await this.requireNotebookWritable(args.notebookId, args.tags);
    const n = await this.inner.createNote(args);
    this.wrote('create_note', n);
    return n;
  }

  async appendText(noteId: string, text: string, pageIndex?: number) {
    const label = await this.require(noteId, 'write');
    const r = await this.inner.appendText(noteId, text, pageIndex);
    this.wrote('append_to_note', label);
    return r;
  }

  async updateNote(id: string, patch: NotePatch): Promise<NoteInfo | null> {
    const label = await this.require(id, 'write');
    if (patch.notebookId !== undefined) await this.requireNotebookWritable(patch.notebookId, patch.tags ?? label.tags);
    const r = await this.inner.updateNote(id, patch);
    this.wrote('update_note', label);
    return r;
  }

  async createNotebook(name: string, opts?: { parentId?: string }): Promise<NotebookInfo> {
    if (opts?.parentId) await this.requireNotebookWritable(opts.parentId);
    const b = await this.inner.createNotebook(name, opts);
    this.wrote('create_notebook', null, `Created notebook “${name}”`);
    return b;
  }

  async trashNote(id: string): Promise<boolean | void> {
    const label = await this.require(id, 'write');
    const r = await this.inner.trashNote(id);
    this.wrote('trash_note', label);
    return r;
  }
}
