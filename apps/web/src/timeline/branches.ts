/**
 * Branches in the app: try a dry-run proposal on a named branch, compare it with the notes,
 * merge it (through the note's document, so authorship and undo see an ordinary edit) or
 * discard it. Storage and merging live in core branches.ts and sync branch-merge.ts.
 */
import { create } from 'zustand';
import { BranchStore, NoteDocument, pageText, type Branch, type NoteMeta, type PageInk } from '@inkstone/core';
import { applyProposalToBranch, type Proposal } from '@inkstone/ai';
import { mergeBranchNote } from '@inkstone/sync';
import { useApp } from '../state/app.ts';
import { activeSession } from '../lib/session.ts';
import { trustServices } from '../lib/trust/state.ts';
import { snapshotBeforeAgentEdit } from '../studio/versions.ts';

/** Bumped whenever a branch changes, so lists reload. */
export const useBranches = create<{ version: number }>(() => ({ version: 0 }));
const bump = () => useBranches.setState((s) => ({ version: s.version + 1 }));

export function branchStore(): BranchStore | null {
  const v = useApp.getState().vault;
  // Branches belong to the present: not while looking at the past.
  if (!v || v.asOf != null) return null;
  return new BranchStore(v.fs);
}

/** Applies a pending proposal to the open branch with this name (made if needed). */
export async function tryOnBranch(p: Proposal, name: string): Promise<{ branch: Branch; summary: string }> {
  const store = branchStore();
  const proposals = trustServices()?.proposals;
  if (!store || !proposals) throw new Error('Branches aren’t available right now.');
  const branch = (await store.findOpen(name.trim())) ?? (await store.create(name, { source: p.source, label: p.label }));
  const r = await applyProposalToBranch(p, store, branch);
  await proposals.decide(p.id, 'applied', `On branch “${branch.name}”: ${r.summary}`);
  trustServices()?.audit.record({ kind: 'proposal', actor: { source: 'user' }, summary: `Tried on branch “${branch.name}”: ${p.summary}`, ...(p.noteId ? { notes: [{ id: p.noteId, ...(p.noteTitle ? { title: p.noteTitle } : {}) }] } : {}) });
  bump();
  return { branch: (await store.get(branch.id))!, summary: r.summary };
}

export interface NoteComparison {
  noteId: string;
  title: string;
  isNew: boolean;
  /** Plain text of each side (title, tags and pages), for the side-by-side view. */
  main: string;
  branch: string;
}

const text = (meta: NoteMeta, pages: readonly PageInk[]) => [`# ${meta.title}`, meta.tags.length ? meta.tags.map((t) => `#${t}`).join(' ') : '', ...pages.map((p) => pageText(p))].filter(Boolean).join('\n\n');

/** Each note on a branch beside the note as it is now. */
export async function compareBranch(id: string): Promise<{ branch: Branch; notes: NoteComparison[] }> {
  const store = branchStore();
  const app = useApp.getState();
  if (!store || !app.vault) throw new Error('Branches aren’t available right now.');
  const branch = await store.get(id);
  if (!branch) throw new Error('That branch no longer exists.');
  const notes: NoteComparison[] = [];
  for (const noteId of Object.keys(branch.notes)) {
    const sides = (await store.sides(branch, noteId))!;
    const meta = await app.vault.vault.readNote(noteId);
    const main = meta && !meta.lock ? text(meta, await app.vault.vault.readPages(meta)) : '';
    notes.push({ noteId, title: sides.head.meta.title, isNew: !sides.base, main, branch: text(sides.head.meta, sides.head.pages) });
  }
  return { branch, notes };
}

/**
 * Merges a branch into the notes: a three-way merge per note (what changed in the notes since
 * the branch started is kept), applied as one restore-style edit per note (version history
 * snapshots it first, the authorship chain records it, and it can be undone in the open note).
 */
export async function mergeBranch(id: string): Promise<number> {
  const store = branchStore();
  const app = useApp.getState();
  if (!store || !app.vault) throw new Error('Branches aren’t available right now.');
  const branch = await store.get(id);
  if (!branch || branch.status !== 'open') throw new Error('That branch was already merged or discarded.');
  const vault = app.vault;
  let merged = 0;
  for (const noteId of Object.keys(branch.notes)) {
    const sides = (await store.sides(branch, noteId))!;
    const open = activeSession();
    const meta = await vault.vault.readNote(noteId);
    if (meta?.lock) throw new Error(`“${meta.title}” is locked; unlock it to merge.`);
    if (open && open.doc.meta.id === noteId) {
      const doc = open.doc;
      snapshotBeforeAgentEdit(vault, doc.meta, doc.committedPages);
      const r = mergeBranchNote(sides.base, { meta: doc.meta, pages: [...doc.committedPages] }, sides.head);
      doc.restoreVersion(r.meta, r.pages, `Merge branch “${branch.name}”`);
      await open.flush();
    } else if (meta) {
      const pages = await vault.vault.readPages(meta);
      snapshotBeforeAgentEdit(vault, meta, pages);
      const r = mergeBranchNote(sides.base, { meta, pages }, sides.head);
      // A document so the change is an ordinary commit (authorship chain), then saved.
      const doc = new NoteDocument(meta, pages);
      doc.restoreVersion(r.meta, r.pages, `Merge branch “${branch.name}”`);
      await vault.vault.saveNote({ ...doc.meta, updatedAt: Date.now() }, [...doc.committedPages], { removedPageIds: meta.pageIds.filter((p) => !doc.meta.pageIds.includes(p)) });
      vault.indexNote(doc.meta, [...doc.committedPages]);
    } else {
      // Made on the branch (or deleted here since): it comes over as the branch has it.
      const r = mergeBranchNote(sides.base, null, sides.head);
      await vault.vault.saveNote({ ...r.meta, updatedAt: Date.now() }, r.pages);
      vault.indexNote(r.meta, r.pages);
    }
    merged++;
  }
  await store.decide(id, 'merged');
  trustServices()?.audit.record({ kind: 'proposal', actor: { source: 'user' }, summary: `Merged branch “${branch.name}” (${merged} ${merged === 1 ? 'note' : 'notes'})` });
  await app.refresh();
  bump();
  return merged;
}

export async function discardBranch(id: string): Promise<void> {
  const store = branchStore();
  if (!store) return;
  const b = await store.decide(id, 'discarded');
  if (b) trustServices()?.audit.record({ kind: 'proposal', actor: { source: 'user' }, summary: `Discarded branch “${b.name}”` });
  bump();
}
