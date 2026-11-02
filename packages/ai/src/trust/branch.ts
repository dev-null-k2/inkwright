/**
 * Dry run onto a branch: instead of approving a proposal into the notes, apply it to a named
 * branch (core branches.ts) — a shadow copy of just the notes it touches — to open, compare with
 * the notes side by side, and merge or discard later (docs/TRUST.md, "Branches").
 *
 * The recorded operation runs through the same reference host the evals use
 * (`MemoryNoteToolHost`), on a copy-on-write view of the vault in which the branch's earlier
 * changes are already applied, so several proposals stack on one branch. Nothing outside the
 * branch is written except content-addressed page blobs, shared with version history.
 */
import type { Branch, BranchStore } from '@inkstone/core';
import { MemoryNoteToolHost } from '../tools/memory-host.ts';
import { applyProposal, type Proposal } from './proposals.ts';

export interface BranchApplyResult {
  /** What the operation did, in the proposal's words ("Added text to “Groceries”"). */
  summary: string;
  /** Notes the branch now changes because of it. */
  notes: string[];
}

export async function applyProposalToBranch(p: Proposal, store: BranchStore, branch: Branch, opts: { clock?: () => number } = {}): Promise<BranchApplyResult> {
  if (branch.status !== 'open') throw new Error('That branch was already merged or discarded.');
  const ws = await store.workspace(branch);
  const host = new MemoryNoteToolHost({ vault: ws.vault, ...(opts.clock ? { clock: opts.clock } : {}) });
  const summary = await applyProposal(p, host);
  const notes = await store.capture(branch, ws, p.id);
  return { summary, notes };
}
