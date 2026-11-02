/**
 * Settings › AI › Audit trail: what AI saw and did, newest first — model calls (where they went,
 * why, which notes they carried, what was kept private), notes agents read and changed, policy
 * changes and blocks. Export writes every device's chain as JSONL; Verify checks the hashes and
 * signatures here, and the same check runs offline with `inkwright-agent audit verify`.
 */
import { useEffect, useState, type ReactNode } from 'react';
import { Ban, Bot, Eye, FileKey, Pencil, Scale, Scissors, ShieldCheck } from 'lucide-react';
import { exportAuditJsonl, readChain, auditDevices, verifyAudit, type AuditEvent, type AuditVerifyReport } from '@inkwright/ai';
import { saveFile } from '../../platform/files.ts';
import { useApp } from '../../state/app.ts';
import { trustServices, useTrust } from '../../lib/trust/state.ts';
import { agentHub } from '../../lib/agent/hub.ts';
import { relativeTime } from '../primitives.tsx';

const ICON: Record<string, ReactNode> = {
  ai_call: <Bot size={14} />, read: <Eye size={14} />, write: <Pencil size={14} />, proposal: <Pencil size={14} />,
  policy: <Scale size={14} />, blocked: <Ban size={14} />, key: <FileKey size={14} />, retention: <Scissors size={14} />,
};

function describe(e: AuditEvent): string {
  if (e.summary) return e.summary;
  const notes = e.notes?.length ? ` · ${e.notes.length === 1 ? `“${e.notes[0]!.title ?? e.notes[0]!.id}”` : `${e.notes.length} notes`}` : '';
  if (e.kind === 'ai_call') return `${e.local ? 'On this device' : e.provider ?? 'AI'} · ${e.model ?? ''}${notes}`;
  if (e.kind === 'read') return `Read${notes}${e.tool ? ` (${e.tool})` : ''}`;
  return `${e.kind}${notes}`;
}

export function AuditView() {
  const version = useTrust((s) => s.version);
  const toast = useApp((s) => s.toast);
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [limit, setLimit] = useState(60);
  const [report, setReport] = useState<AuditVerifyReport | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const s = trustServices();
    const fs = agentHub()?.vault.fs;
    if (!s || !fs) return;
    let live = true;
    void (async () => {
      await s.audit.flush();
      const all: AuditEvent[] = [];
      for (const dev of await auditDevices(fs)) all.push(...(await readChain(fs, dev)));
      if (live) setEvents(all.filter((e) => e.kind !== 'key').sort((a, b) => b.at - a.at));
    })();
    return () => { live = false; };
  }, [version]);

  const exportLog = async () => {
    const fs = agentHub()?.vault.fs;
    if (!fs) return;
    await trustServices()?.audit.flush();
    const text = await exportAuditJsonl(fs);
    await saveFile(`inkwright-audit-${new Date().toISOString().slice(0, 10)}.jsonl`, new TextEncoder().encode(text), 'application/jsonl');
  };
  const verify = async () => {
    const fs = agentHub()?.vault.fs;
    if (!fs) return;
    setBusy(true);
    try {
      await trustServices()?.audit.flush();
      setReport(await verifyAudit(await exportAuditJsonl(fs)));
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="ag-screen trust-audit">
      <p className="ag-lead">Every AI request — where it went and why, which notes it carried, what was kept private — and every note agents read or changed. Each device keeps its own signed, linked record, so a changed or missing entry shows up when you verify.</p>
      <div className="ag-row-acts">
        <button type="button" className="btn btn-sm" disabled={busy} onClick={() => void verify()}><ShieldCheck size={14} /> Verify</button>
        <button type="button" className="btn btn-sm" onClick={() => void exportLog()}>Export (JSONL)</button>
      </div>
      {report && (
        <div className={report.ok ? 'trust-verify is-ok' : 'trust-verify is-bad'} role="status">
          {report.ok
            ? <><strong>The record checks out.</strong> {report.chains.map((c) => `${c.events} entries from device ${c.dev}${c.signed ? ', all signed' : ''}${c.startsAfterPruning ? ' (older entries removed by your retention rule)' : ''}`).join('; ')}.</>
            : <><strong>Problems found</strong><ul>{report.problems.slice(0, 10).map((p) => <li key={p}>{p}</li>)}</ul></>}
        </div>
      )}
      {events && !events.length && <p className="ag-empty">Nothing yet. AI requests and what agents read will be listed here.</p>}
      <ol className="trust-events">
        {(events ?? []).slice(0, limit).map((e) => (
          <li key={`${e.dev}:${e.seq}`} className={`trust-event is-${e.kind}`}>
            <span className="trust-event-icon" aria-hidden>{ICON[e.kind] ?? <Eye size={14} />}</span>
            <span className="trust-event-main">
              <span className="trust-event-text">{describe(e)}</span>
              <span className="muted small">
                {relativeTime(e.at)}
                {e.actor?.label || e.actor?.source ? ` · ${e.actor.label ?? e.actor.source}` : ''}
                {e.route && e.kind === 'ai_call' ? ` · ${e.route}` : ''}
                {e.redactions ? ` · kept private: ${Object.entries(e.redactions).map(([k, n]) => `${n} ${k.replace('_', ' ')}`).join(', ')}` : ''}
                {e.tokens ? ` · ${e.tokens.input + e.tokens.output} tokens` : ''}
              </span>
            </span>
          </li>
        ))}
      </ol>
      {events && events.length > limit && <button type="button" className="btn btn-sm" onClick={() => setLimit((l) => l + 100)}>Show older</button>}
    </div>
  );
}
