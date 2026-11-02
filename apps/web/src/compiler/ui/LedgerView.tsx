/**
 * Conflicts: places where your notes disagree with each other — a measurement over a limit, two
 * dates for one event, a decision reversed — with both sides linked to where they are written.
 * Dismiss one ("not a real conflict") or resolve it with a note of what you decided; either way
 * it stays quiet while both sentences stay the same.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, RotateCcw } from 'lucide-react';
import { anchorLink, stripMarkdown, type Claim, type Conflict } from '@inkstone/core';
import { useApp } from '../../state/app.ts';
import { relativeTime } from '../../ui/primitives.tsx';
import { Section } from '../../ui/agent/shared.tsx';
import { decideConflict, reopenConflict, scanNow, unitById, useCompiler } from '../service.ts';

export function LedgerView() {
  const conflicts = useCompiler((s) => s.conflicts);
  const decided = useCompiler((s) => s.decided);
  const ledger = useCompiler((s) => s.config.ledger);
  const scannedAt = useCompiler((s) => s.scannedAt);
  useEffect(() => { void scanNow(); }, []);
  return (
    <div className="ag-screen cp-ledger">
      <p className="ag-lead">Where your notes disagree: numbers against limits, dates, decisions. Checked on this device in the background, quietly — only when the rules are confident, or an on-device model confirmed a borderline case.</p>
      {!ledger && <p className="ag-empty">Contradiction checks are off (Compiled wiki › Watch for contradictions).</p>}
      <Section title="Open" note={scannedAt ? `Checked ${relativeTime(scannedAt)}.` : undefined}>
        {ledger && !conflicts.length && <p className="ag-empty">No contradictions found.</p>}
        <ul className="ag-list">{conflicts.map((c) => <ConflictRow key={c.id} c={c} />)}</ul>
      </Section>
      {decided.length > 0 && (
        <Section title="Decided">
          <ul className="ag-list">
            {decided.map(({ conflict, decision }) => (
              <li key={conflict.id} className="ag-item cp-conflict is-decided">
                <div className="ag-item-main">
                  <span className="muted small">{decision.status === 'dismissed' ? 'Dismissed' : 'Resolved'} {relativeTime(decision.at)}{decision.note ? `: ${decision.note}` : ''}</span>
                  <span>“{stripMarkdown(conflict.a.text)}” / “{stripMarkdown(conflict.b.text)}”</span>
                </div>
                <button type="button" className="btn btn-sm" onClick={() => void reopenConflict(conflict.id)}><RotateCcw size={13} /> Reopen</button>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </div>
  );
}

function Side({ claim, label }: { claim: Claim; label: string }) {
  const notes = useApp((s) => s.notes);
  const u = unitById(claim.unitId);
  const title = notes.find((n) => n.id === claim.noteId)?.title || 'Untitled';
  return (
    <div className="cp-side">
      <span className="muted small">{label} · {title}{u ? `, page ${u.pageIndex + 1}` : ''}</span>
      <span className="cp-side-text">“{stripMarkdown(claim.text)}”</span>
      {u && <a className="btn btn-sm btn-ghost" href={anchorLink({ noteId: u.noteId, page: u.pageIndex, ...(u.rect ? { rect: u.rect } : {}), h: u.hash })}><ExternalLink size={13} /> Open</a>}
    </div>
  );
}

export function ConflictRow({ c }: { c: Conflict & { by?: 'rules' | 'model'; why?: string } }) {
  const toast = useApp((s) => s.toast);
  const [resolving, setResolving] = useState(false);
  const [note, setNote] = useState('');
  return (
    <li className="ag-item cp-conflict">
      <div className="ag-item-main">
        <span className="cp-reason">{c.reason}</span>
        <Side claim={c.a} label="Earlier" />
        <Side claim={c.b} label="Later" />
        <span className="muted small">Confidence {Math.round(c.confidence * 100)}%{c.by === 'model' ? ` · confirmed by an on-device model${c.why ? `: ${c.why}` : ''}` : ''}</span>
        {resolving && (
          <form className="ag-url-form" onSubmit={(e) => { e.preventDefault(); void decideConflict(c, 'resolved', note).then(() => toast({ text: 'Resolved' })); }}>
            <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="What did you decide? (optional)" aria-label="Resolution note" maxLength={300} autoFocus />
            <button type="submit" className="btn btn-sm btn-primary">Save</button>
          </form>
        )}
      </div>
      {!resolving && (
        <div className="ag-row-acts">
          <button type="button" className="btn btn-sm" onClick={() => void decideConflict(c, 'dismissed').then(() => toast({ text: 'Dismissed' }))}>Not a conflict</button>
          <button type="button" className="btn btn-sm" onClick={() => setResolving(true)}>Resolve…</button>
        </div>
      )}
    </li>
  );
}
