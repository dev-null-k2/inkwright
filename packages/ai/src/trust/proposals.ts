/**
 * Dry run: agent writes become proposals the user approves. With `agentWrites.<source> =
 * "propose"` in the AI policy, `ProposingNoteToolHost` turns create/append/update/notebook/trash
 * calls into proposal files (`ai/proposals/<id>.json`) with a before/after text diff, and tells
 * the model the change is waiting for approval. Approving runs the recorded operation through the
 * normal (recorded, undoable) host, so an applied proposal appears in Activity and can be undone
 * like any other change.
 *
 * The API is deliberately small — `Proposal`, `ProposalStore`, `ProposingNoteToolHost`,
 * `applyProposal`, `lineDiff` — so other features that want "propose, then apply" (the MCP
 * server's external writes, a future compiler) can produce the same files.
 */
import { isSafeId, newId, type VaultFS } from '@inkstone/core';
import type { ActivitySource } from '../activity.ts';
import type { NoteContent, NoteInfo, NoteListItem, NotePatch, NoteSearchHit, NoteToolHost, NotebookInfo } from '../tools/notes.ts';

export type ProposedOp =
  | { op: 'createNote'; args: { title: string; text: string; notebookId?: string; tags?: string[] } }
  | { op: 'appendText'; noteId: string; text: string; pageIndex?: number }
  | { op: 'updateNote'; noteId: string; patch: NotePatch }
  | { op: 'createNotebook'; name: string; parentId?: string }
  | { op: 'trashNote'; noteId: string };

export interface Proposal {
  id: string;
  createdAt: number;
  source: ActivitySource;
  /** "Assistant", the routine's name, or the external agent's name. */
  label: string;
  /** The note it concerns (for the view), when there is one. */
  noteId?: string;
  noteTitle?: string;
  /** Plain one-line description: "Add text to “Groceries”". */
  summary: string;
  op: ProposedOp;
  /** Text before and after, for the diff view. */
  before: string;
  after: string;
  status: 'pending' | 'applied' | 'rejected' | 'failed';
  decidedAt?: number;
  /** What happened when applied (or why it failed). */
  outcome?: string;
}

export const PROPOSALS_DIR = 'ai/proposals';

export class ProposalStore {
  private listeners = new Set<() => void>();
  constructor(private fs: VaultFS, private clock: () => number = Date.now) {}

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  async list(): Promise<Proposal[]> {
    const out: Proposal[] = [];
    for (const e of await this.fs.list(PROPOSALS_DIR)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      const p = await this.get(e.name.slice(0, -5));
      if (p) out.push(p);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async get(id: string): Promise<Proposal | null> {
    if (!isSafeId(id)) return null;
    try {
      const raw = await this.fs.readText(`${PROPOSALS_DIR}/${id}.json`);
      return raw ? (JSON.parse(raw) as Proposal) : null;
    } catch {
      return null;
    }
  }

  async save(p: Proposal): Promise<void> {
    await this.fs.writeText(`${PROPOSALS_DIR}/${p.id}.json`, `${JSON.stringify(p, null, 2)}\n`);
    this.listeners.forEach((l) => l());
  }

  async create(p: Omit<Proposal, 'id' | 'createdAt' | 'status'>): Promise<Proposal> {
    const full: Proposal = { ...p, id: newId(), createdAt: this.clock(), status: 'pending' };
    await this.save(full);
    return full;
  }

  /** Marks a proposal decided. Only pending proposals change. */
  async decide(id: string, status: 'applied' | 'rejected' | 'failed', outcome?: string): Promise<Proposal | null> {
    const p = await this.get(id);
    if (!p || p.status !== 'pending') return p;
    const next: Proposal = { ...p, status, decidedAt: this.clock(), ...(outcome ? { outcome } : {}) };
    await this.save(next);
    return next;
  }

  /** Removes decided proposals older than `maxAgeMs` (pending ones stay until decided). */
  async prune(maxAgeMs = 30 * 86_400_000): Promise<number> {
    let n = 0;
    for (const p of await this.list()) {
      if (p.status !== 'pending' && (p.decidedAt ?? p.createdAt) < this.clock() - maxAgeMs) {
        await this.fs.delete(`${PROPOSALS_DIR}/${p.id}.json`);
        n++;
      }
    }
    return n;
  }
}

const q = (s: string | undefined) => `“${(s || 'Untitled').slice(0, 60)}”`;

function noteText(c: NoteContent | null): string {
  return (c?.pages ?? []).map((p) => p.text).filter(Boolean).join('\n\n');
}

function metaLines(n: Partial<NoteInfo> & { notebookName?: string | null }): string {
  return [`Title: ${n.title ?? ''}`, `Tags: ${(n.tags ?? []).map((t) => `#${t}`).join(' ')}`, `Notebook: ${n.notebookName ?? n.notebookId ?? '(none)'}`, `Pinned: ${n.pinned ? 'yes' : 'no'}`, ...(n.summary ? [`Summary: ${n.summary}`] : [])].join('\n');
}

/**
 * A NoteToolHost whose writes become proposals. Reads go to `inner` (so proposals show real
 * before-text); `apply` is not called here — the user approves in the app.
 */
export class ProposingNoteToolHost implements NoteToolHost {
  getPageImage?: NoteToolHost['getPageImage'];
  /** Proposals made during this run (the panel shows them under the reply). */
  readonly made: Proposal[] = [];

  constructor(private inner: NoteToolHost, private store: ProposalStore, private who: { source: ActivitySource; label: string }) {
    if (inner.getPageImage) this.getPageImage = (n, p) => inner.getPageImage!(n, p);
  }

  listNotes(o?: Parameters<NoteToolHost['listNotes']>[0]): Promise<NoteListItem[]> { return this.inner.listNotes(o); }
  searchNotes(qs: string, o?: { limit?: number }): Promise<NoteSearchHit[]> { return this.inner.searchNotes(qs, o); }
  readNote(id: string): Promise<NoteContent | null> { return this.inner.readNote(id); }
  listNotebooks(): Promise<NotebookInfo[]> { return this.inner.listNotebooks(); }

  private async propose(p: Omit<Proposal, 'id' | 'createdAt' | 'status' | 'source' | 'label'>): Promise<Proposal> {
    const made = await this.store.create({ ...p, ...this.who });
    this.made.push(made);
    return made;
  }

  async createNote(args: { title: string; text: string; notebookId?: string; tags?: string[] }): Promise<NoteInfo> {
    const p = await this.propose({ summary: `Create note ${q(args.title)}`, noteTitle: args.title, op: { op: 'createNote', args }, before: '', after: `${args.title}\n\n${args.text}` });
    // The model gets a recognisable placeholder id; using it in another write fails clearly.
    return { id: `proposal-${p.id}`, title: args.title, tags: args.tags ?? [], ...(args.notebookId ? { notebookId: args.notebookId } : {}), pinned: false, createdAt: p.createdAt, updatedAt: p.createdAt, summary: 'Proposed — waiting for the user to approve it in Inkstone.' };
  }

  async appendText(noteId: string, text: string, pageIndex?: number) {
    const cur = await this.real(noteId);
    const before = noteText(cur);
    await this.propose({ summary: `Add text to ${q(cur.meta.title)}`, noteId, noteTitle: cur.meta.title, op: { op: 'appendText', noteId, text, ...(pageIndex != null ? { pageIndex } : {}) }, before, after: before ? `${before}\n\n${text}` : text });
    return { noteId, pageIndex: pageIndex ?? Math.max(0, cur.pages.length - 1) };
  }

  async updateNote(id: string, patch: NotePatch): Promise<NoteInfo | null> {
    const cur = await this.real(id);
    const after = { ...cur.meta, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) } as NoteInfo;
    await this.propose({ summary: `Change ${q(cur.meta.title)}`, noteId: id, noteTitle: cur.meta.title, op: { op: 'updateNote', noteId: id, patch }, before: metaLines(cur.meta), after: metaLines({ ...after, notebookId: patch.notebookId === null ? undefined : after.notebookId }) });
    return { ...cur.meta, summary: 'A change was proposed — waiting for the user to approve it in Inkstone.' };
  }

  async createNotebook(name: string, opts?: { parentId?: string }): Promise<NotebookInfo> {
    const p = await this.propose({ summary: `Create notebook ${q(name)}`, op: { op: 'createNotebook', name, ...(opts?.parentId ? { parentId: opts.parentId } : {}) }, before: '', after: `Notebook: ${name}` });
    return { id: `proposal-${p.id}`, name, ...(opts?.parentId ? { parentId: opts.parentId } : {}) };
  }

  async trashNote(id: string): Promise<boolean> {
    const cur = await this.real(id);
    await this.propose({ summary: `Move ${q(cur.meta.title)} to Trash`, noteId: id, noteTitle: cur.meta.title, op: { op: 'trashNote', noteId: id }, before: noteText(cur), after: '(moved to Trash)' });
    return true;
  }

  private async real(id: string): Promise<NoteContent> {
    if (id.startsWith('proposal-')) throw new Error('That note is only proposed and does not exist yet. Put everything in the create_note proposal instead.');
    const c = await this.inner.readNote(id);
    if (!c) throw new Error(`No note with id "${id}"`);
    return c;
  }
}

/** Tells the model what happened (tool results under dry run). */
export const PROPOSAL_NOTICE = 'Changes are proposals in this mode: the user reviews and approves them in Inkstone (Settings › AI › Activity). Say that the change is waiting for their approval.';

/** Runs a proposal's operation through `host` (the recorded, undoable host) and returns a summary. */
export async function applyProposal(p: Proposal, host: NoteToolHost): Promise<string> {
  const o = p.op;
  switch (o.op) {
    case 'createNote': {
      const n = await host.createNote(o.args);
      return `Created ${q(n.title)}`;
    }
    case 'appendText':
      await host.appendText(o.noteId, o.text, o.pageIndex);
      return `Added text to ${q(p.noteTitle)}`;
    case 'updateNote': {
      const n = await host.updateNote(o.noteId, o.patch);
      if (!n) throw new Error('The note no longer exists.');
      return `Changed ${q(n.title)}`;
    }
    case 'createNotebook':
      await host.createNotebook(o.name, o.parentId ? { parentId: o.parentId } : {});
      return `Created notebook ${q(o.name)}`;
    case 'trashNote':
      await host.trashNote(o.noteId);
      return `Moved ${q(p.noteTitle)} to Trash`;
  }
}

export type DiffLine = { kind: 'same' | 'add' | 'remove'; text: string };

/** Line diff (longest common subsequence) for the proposal view. Large inputs fall back to remove-all/add-all. */
export function lineDiff(before: string, after: string): DiffLine[] {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ kind: 'remove' as const, text })), ...b.map((text) => ({ kind: 'add' as const, text }))];
  const dp: Uint32Array[] = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { out.push({ kind: 'same', text: a[i]! }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) out.push({ kind: 'remove', text: a[i++]! });
    else out.push({ kind: 'add', text: b[j++]! });
  }
  while (i < a.length) out.push({ kind: 'remove', text: a[i++]! });
  while (j < b.length) out.push({ kind: 'add', text: b[j++]! });
  return out;
}
