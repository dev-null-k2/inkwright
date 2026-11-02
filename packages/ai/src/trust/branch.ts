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
import { Vault, VaultLayout, decodePage, encodePage, type Branch, type BranchStore, type OverlayFS, type PageInk } from '@inkstone/core';
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
  await markAgentContent(ws.fs);
  const notes = await store.capture(branch, ws, p.id);
  return { summary, notes };
}

/**
 * What the agent added is AI content wherever it ends up (docs/AUTHORSHIP.md): text boxes and
 * strokes on the branch that are not in the notes and say nothing about their origin get
 * `origin: "ai"`, so merging a branch never brings in anything that looks typed or handwritten.
 */
async function markAgentContent(fs: OverlayFS): Promise<void> {
  const main = new Vault(fs.base);
  for (const path of fs.changedSinceCheckpoint()) {
    const m = /^notes\/([^/]+)\/pages\/([^/]+)\.ink\.json$/.exec(path);
    if (!m) continue;
    const [, noteId, pageId] = m as unknown as [string, string, string];
    const raw = await fs.readText(path);
    if (!raw) continue;
    const page = decodePage(raw);
    const before = (await main.readNote(noteId)) ? await main.readPage(noteId, pageId) : null;
    const known = new Set([...(before?.texts ?? []).map((t) => t.id), ...(before?.strokes ?? []).map((s) => s.id)]);
    let changed = false;
    const texts = (page.texts ?? []).map((t) => (known.has(t.id) || t.origin ? t : ((changed = true), { ...t, origin: 'ai' as const })));
    const strokes = (page.strokes ?? []).map((s) => (known.has(s.id) || s.origin ? s : ((changed = true), { ...s, origin: 'ai' as const })));
    if (changed) await fs.writeText(VaultLayout.pageInk(noteId, pageId), encodePage({ ...page, texts, strokes: strokes as PageInk['strokes'] }));
  }
}
