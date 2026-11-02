/**
 * Proposed changes (dry run) waiting in Activity: each with a before-and-after view and Approve /
 * Don't apply. Approving runs the change through the recorded, permission-checked note host, so
 * it is logged as its own Activity run and can be undone like any other change.
 */
import { useEffect, useState } from 'react';
import { AccessControlledNoteToolHost, RecordingNoteToolHost, RunRecorder, applyProposal, lineDiff, type Proposal } from '@inkwright/ai';
import { AppNoteToolHost } from '../../lib/ai.ts';
import { activeSession } from '../../lib/session.ts';
import { requireHub } from '../../lib/agent/hub.ts';
import { currentPolicy, labelForMeta, noteLabelOf, trustServices, useTrust } from '../../lib/trust/state.ts';
import { useApp } from '../../state/app.ts';
import { relativeTime } from '../primitives.tsx';
import { TryOnBranchButton } from '../../timeline/BranchList.tsx';

export function ProposalList() {
  const version = useTrust((s) => s.version);
  const [items, setItems] = useState<Proposal[]>([]);
  useEffect(() => {
    const s = trustServices();
    if (!s) return;
    let live = true;
    void s.proposals.list().then((l) => { if (live) setItems(l.filter((p) => p.status === 'pending')); });
    return () => { live = false; };
  }, [version]);
  if (!items.length) return null;
  return (
    <div className="ag-approvals" role="region" aria-label="Proposed changes">
      {items.map((p) => <ProposalCard key={p.id} p={p} />)}
    </div>
  );
}

/** Applies a proposal through the same permission checks and activity log as a live agent. */
async function approve(p: Proposal): Promise<string> {
  const hub = requireHub();
  const recorder = new RunRecorder(hub.activity, { source: p.source, label: `${p.label} (approved)`, prompt: p.summary });
  const open = activeSession()?.doc ?? null;
  const host = new RecordingNoteToolHost(new AccessControlledNoteToolHost(new AppNoteToolHost(hub.vault, open), {
    policy: currentPolicy,
    labelOf: async (id) => (open?.meta.id === id ? labelForMeta(open.meta) : noteLabelOf(id)),
    notebookParent: (id) => useApp.getState().notebooks.find((b) => b.id === id)?.parentId,
  }), recorder.record);
  try {
    const out = await applyProposal(p, host);
    await recorder.finish('done', { reply: out });
    return out;
  } catch (e) {
    await recorder.finish('error', { error: (e as Error).message });
    throw e;
  }
}

function ProposalCard({ p }: { p: Proposal }) {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState(p.op.op !== 'trashNote');
  const decide = async (ok: boolean) => {
    const store = trustServices()?.proposals;
    if (!store) return;
    setBusy(true);
    try {
      if (!ok) {
        await store.decide(p.id, 'rejected');
        trustServices()?.audit.record({ kind: 'proposal', actor: { source: 'user' }, summary: `Didn’t apply: ${p.summary}`, ...(p.noteId ? { notes: [{ id: p.noteId, ...(p.noteTitle ? { title: p.noteTitle } : {}) }] } : {}) });
        return;
      }
      const out = await approve(p);
      await store.decide(p.id, 'applied', out);
      trustServices()?.audit.record({ kind: 'proposal', actor: { source: 'user' }, summary: `Approved: ${p.summary}`, ...(p.noteId ? { notes: [{ id: p.noteId, ...(p.noteTitle ? { title: p.noteTitle } : {}) }] } : {}) });
      toast({ text: out, tone: 'success' });
    } catch (e) {
      await store.decide(p.id, 'failed', (e as Error).message);
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const diff = lineDiff(p.before, p.after);
  return (
    <div className="ag-approval trust-proposal">
      <div className="ag-approval-text">
        <strong>{p.summary}</strong>
        <span className="muted small">Proposed by {p.label} · {relativeTime(p.createdAt)}</span>
        <button type="button" className="btn btn-sm btn-ghost trust-diff-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? 'Hide changes' : 'Show changes'}</button>
        {open && (
          <pre className="trust-diff" aria-label="Before and after">
            {diff.map((d, i) => <span key={i} className={`trust-diff-${d.kind}`}>{d.kind === 'add' ? '+ ' : d.kind === 'remove' ? '− ' : '  '}{d.text || ' '}{'\n'}</span>)}
          </pre>
        )}
      </div>
      <div className="ag-row-acts">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void decide(false)}>Don’t apply</button>
        <TryOnBranchButton p={p} disabled={busy} onDone={() => useTrust.setState((s) => ({ version: s.version + 1 }))} />
        <button type="button" className="btn btn-sm btn-primary" disabled={busy} onClick={() => void decide(true)}>Approve</button>
      </div>
    </div>
  );
}
