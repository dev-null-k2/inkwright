/**
 * Branches in Activity: open branches with the notes they change, a side-by-side comparison
 * with the notes as they are, and Merge / Discard. Also the "Try on a branch" action for a
 * pending proposal.
 */
import { useEffect, useState } from 'react';
import { GitBranch } from 'lucide-react';
import { lineDiff, type Proposal } from '@inkstone/ai';
import type { BranchInfo } from '@inkstone/core';
import { useApp } from '../state/app.ts';
import { Dialog, relativeTime } from '../ui/primitives.tsx';
import { askConfirm, askText } from '../ui/prompts.tsx';
import { useModule } from '../modules/registry.ts';
import { branchStore, compareBranch, discardBranch, mergeBranch, tryOnBranch, useBranches, type NoteComparison } from './branches.ts';

/** "Try on a branch" for a proposal card (nothing when the module is off). */
export function TryOnBranchButton({ p, disabled, onDone }: { p: Proposal; disabled?: boolean; onDone?: () => void }) {
  const on = useModule('timeline');
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  if (!on) return null;
  const run = async () => {
    const open = (await branchStore()?.list())?.filter((b) => b.status === 'open') ?? [];
    const name = await askText('Try on a branch', open.length ? `Branch name (open: ${open.map((b) => b.name).join(', ')})` : 'Branch name', open[0]?.name ?? `${p.label} ideas`, 'Try it');
    if (!name?.trim()) return;
    setBusy(true);
    try {
      const r = await tryOnBranch(p, name);
      toast({ text: `On branch “${r.branch.name}”: ${r.summary}`, tone: 'success' });
      onDone?.();
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
    setBusy(false);
  };
  return <button type="button" className="btn btn-sm" disabled={disabled || busy} onClick={() => void run()}><GitBranch size={14} /> Try on a branch</button>;
}

export function BranchList() {
  const on = useModule('timeline');
  const version = useBranches((s) => s.version);
  const vault = useApp((s) => s.vault);
  const [items, setItems] = useState<BranchInfo[]>([]);
  const [comparing, setComparing] = useState<string | null>(null);
  useEffect(() => {
    const store = branchStore();
    if (!on || !store) return setItems([]);
    let live = true;
    void store.list().then((l) => { if (live) setItems(l.filter((b) => b.status === 'open')); });
    return () => { live = false; };
  }, [on, version, vault]);
  if (!items.length) return null;
  return (
    <div className="branch-list" role="region" aria-label="Branches">
      {items.map((b) => (
        <div key={b.id} className="branch-card">
          <GitBranch size={16} />
          <div className="branch-text">
            <strong>{b.name}</strong>
            <span className="muted small">{b.notes.map((n) => `${n.title}${n.isNew ? ' (new)' : ''}`).join(', ')} · {b.proposals} {b.proposals === 1 ? 'change' : 'changes'} · {relativeTime(b.updatedAt)}</span>
          </div>
          <button type="button" className="btn btn-sm" onClick={() => setComparing(b.id)}>Compare</button>
        </div>
      ))}
      {comparing && <CompareDialog id={comparing} onClose={() => setComparing(null)} />}
    </div>
  );
}

function CompareDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const [data, setData] = useState<{ name: string; notes: NoteComparison[] } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    void compareBranch(id).then((r) => setData({ name: r.branch.name, notes: r.notes }), (e) => { toast({ text: (e as Error).message, tone: 'error' }); onClose(); });
  }, [id, toast, onClose]);
  const merge = async () => {
    setBusy(true);
    try {
      const n = await mergeBranch(id);
      toast({ text: `Merged into your notes (${n} ${n === 1 ? 'note' : 'notes'})`, tone: 'success' });
      onClose();
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
    setBusy(false);
  };
  const discard = async () => {
    if (!(await askConfirm('Discard this branch?', 'Its changes are thrown away. Your notes stay as they are.', 'Discard', true))) return;
    await discardBranch(id);
    onClose();
  };
  return (
    <Dialog open wide title={data ? `Branch “${data.name}”` : 'Branch'} onClose={onClose} actions={
      <>
        <button type="button" className="btn btn-danger" disabled={busy || !data} onClick={() => void discard()}>Discard</button>
        <button type="button" className="btn" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary" disabled={busy || !data} onClick={() => void merge()}>Merge into my notes</button>
      </>
    }>
      {!data ? <p className="muted">Loading…</p> : data.notes.map((n) => <SideBySide key={n.noteId} n={n} />)}
    </Dialog>
  );
}

/** One note: your notes on the left, the branch on the right, changed lines marked. */
function SideBySide({ n }: { n: NoteComparison }) {
  const rows = lineDiff(n.main, n.branch);
  return (
    <section className="branch-compare" aria-label={`Compare ${n.title}`}>
      <h3 className="branch-compare-title">{n.title}{n.isNew && <span className="muted small"> · new on the branch</span>}</h3>
      <div className="branch-cols">
        <div className="branch-col-head">Your notes</div>
        <div className="branch-col-head">Branch</div>
        {rows.map((r, i) => (
          <div key={i} style={{ display: 'contents' }}>
            <div className={`branch-cell${r.kind === 'remove' ? ' is-removed' : ''}`}>{r.kind !== 'add' ? r.text || ' ' : ''}</div>
            <div className={`branch-cell${r.kind === 'add' ? ' is-added' : ''}`}>{r.kind !== 'remove' ? r.text || ' ' : ''}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
