/**
 * AI activity: every run (assistant chats, routines, external agents) with the changes it made,
 * each with Undo, plus Undo for a whole run. Undo goes through the open note's document or the
 * vault (lib/agent/undo.ts), so it really restores the notes.
 */
import { useState } from 'react';
import { Bot, Plug, Repeat, Undo2 } from 'lucide-react';
import { isReversible, type ActivityOp, type ActivityRun } from '@inkstone/ai';
import { useAgent } from '../../lib/agent/hub.ts';
import { undoActivityOp, undoActivityRun } from '../../lib/agent/undo.ts';
import { useApp } from '../../state/app.ts';
import { cx, relativeTime } from '../primitives.tsx';
import { ApprovalList } from './shared.tsx';
import { ProposalList } from '../trust/ProposalList.tsx';

const SOURCE_ICON = { assistant: <Bot size={15} />, routine: <Repeat size={15} />, external: <Plug size={15} /> } as const;

export function ActivityView() {
  const runs = useAgent((s) => s.runs);
  const [limit, setLimit] = useState(30);
  return (
    <div className="ag-screen">
      <p className="ag-lead">Everything the assistant and your routines changed in your notes. Undo any change, or a whole run.</p>
      <ApprovalList />
      <ProposalList />
      {!runs.length && <p className="ag-empty">Nothing yet. When the assistant creates, edits, tags or moves notes, it shows up here.</p>}
      <ol className="ag-runs">
        {runs.slice(0, limit).map((r) => <RunCard key={r.id} run={r} />)}
      </ol>
      {runs.length > limit && <button type="button" className="btn btn-sm" onClick={() => setLimit((l) => l + 30)}>Show older</button>}
    </div>
  );
}

function RunCard({ run }: { run: ActivityRun }) {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const live = run.ops.filter((o) => isReversible(o) && !o.undoneAt);
  const undoAll = async () => {
    setBusy(true);
    try {
      const r = await undoActivityRun(run.id);
      toast({ text: r.notes.length ? `Undid ${r.undone}. ${r.notes[0]}` : `Undid ${r.undone} ${r.undone === 1 ? 'change' : 'changes'}`, tone: r.notes.length ? undefined : 'success' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={cx('ag-run', run.status === 'error' && 'is-error')}>
      <div className="ag-run-head">
        <span className="ag-run-icon">{SOURCE_ICON[run.source]}</span>
        <span className="ag-run-label">{run.label}</span>
        <span className="muted small">{relativeTime(run.startedAt)}</span>
        {live.length > 1 && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => void undoAll()}><Undo2 size={14} /> Undo all</button>}
      </div>
      {run.prompt && <p className="ag-run-prompt">{run.prompt}</p>}
      {run.status === 'running' && <p className="muted small">Running…</p>}
      {run.error && <p className="ag-run-error">{run.error}</p>}
      {run.ops.length > 0 ? (
        <ul className="ag-ops">{run.ops.map((op) => <OpRow key={op.id} run={run} op={op} />)}</ul>
      ) : run.status !== 'running' && !run.error ? <p className="muted small">No changes.</p> : null}
      {run.reply && <p className="ag-run-reply">{run.reply}</p>}
    </li>
  );
}

function OpRow({ run, op }: { run: ActivityRun; op: ActivityOp }) {
  const toast = useApp((s) => s.toast);
  const [busy, setBusy] = useState(false);
  const undo = async () => {
    setBusy(true);
    try {
      const r = await undoActivityOp(run.id, op.id);
      if (!r.ok || r.message) toast({ text: r.message ?? 'Couldn’t undo that.', tone: r.ok ? undefined : 'error' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className={cx('ag-op', !!op.undoneAt && 'is-undone')}>
      <span className="ag-op-text">{op.summary}</span>
      {op.undoneAt ? <span className="ag-badge">Undone</span> : isReversible(op) ? (
        <button type="button" className="btn btn-sm btn-ghost ag-undo" disabled={busy} onClick={() => void undo()} aria-label={`Undo: ${op.summary}`}>Undo</button>
      ) : <span className="muted small">In {op.kind === 'external' ? op.server : 'another app'}</span>}
      {op.undoNote && <span className="ag-op-note">{op.undoNote}</span>}
    </li>
  );
}
