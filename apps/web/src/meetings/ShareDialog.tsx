import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Send } from 'lucide-react';
import { meetingMarkdown, meetingSlack, type MeetingHeader, type MeetingNotesVersion } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { Dialog, cx } from '../ui/primitives.tsx';
import { INTEGRATIONS, actionItems, connectedIntegrations, sendTo, usableHere, type IntegrationId } from './integrations.ts';

/**
 * Share › one place to send the notes: pick a connected tool, see exactly what will be sent
 * (the message, or the action items that become issues or tasks — untick any), then Send.
 */
export function ShareDialog({ header, version, onClose }: { header: MeetingHeader; version: MeetingNotesVersion; onClose: () => void }) {
  const toast = useApp((s) => s.toast);
  const navigate = useApp((s) => s.navigate);
  const [connected, setConnected] = useState<IntegrationId[] | null>(null);
  const [pick, setPick] = useState<IntegrationId | null>(null);
  const actions = useMemo(() => actionItems(version), [version]);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set(actions.map((a) => a.id)));
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState<{ summary: string; links: Array<{ label: string; url: string }> } | null>(null);

  useEffect(() => { void connectedIntegrations().then((c) => { setConnected(c); setPick(c.find((id) => usableHere(id)) ?? null); }); }, []);

  const spec = INTEGRATIONS.find((i) => i.id === pick);
  const emails = (header.attendees ?? []).map((a) => a.email).filter((e): e is string => !!e);
  const preview = !spec ? '' : spec.kind === 'chat' && spec.id === 'slack' ? meetingSlack(header, version) : spec.kind === 'tasks' ? '' : meetingMarkdown(header, version, { stamps: false });

  const send = async () => {
    if (!pick) return;
    setSending(true);
    try {
      const r = await sendTo(pick, { header, version, emails, actions: actions.filter((a) => chosen.has(a.id)) });
      setDone(r);
      toast({ text: r.summary, tone: 'success' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    } finally {
      setSending(false);
    }
  };

  return (
    <Dialog open title="Share the notes" onClose={onClose} wide actions={
      done ? <button type="button" className="btn btn-primary" onClick={onClose}>Done</button> : (
        <>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" disabled={!pick || sending || (spec?.kind === 'tasks' && !chosen.size) || !usableHere(pick)} onClick={() => void send()}><Send size={15} /> {sending ? 'Sending…' : spec?.kind === 'tasks' ? `Create ${chosen.size}` : 'Send'}</button>
        </>
      )
    }>
      {done ? (
        <div className="mtg-share-done">
          <p>{done.summary}.</p>
          {done.links.length > 0 && <ul>{done.links.map((l) => <li key={l.url}><a href={l.url} target="_blank" rel="noopener noreferrer">{l.label} <ExternalLink size={12} /></a></li>)}</ul>}
        </div>
      ) : connected === null ? <p className="mtg-hint">Loading…</p> : (
        <div className="mtg-share">
          <div className="mtg-share-list" role="radiogroup" aria-label="Send to">
            {INTEGRATIONS.map((i) => {
              const on = connected.includes(i.id);
              const here = usableHere(i.id);
              return (
                <button key={i.id} type="button" role="radio" aria-checked={pick === i.id} disabled={!on || !here} className={cx('mtg-share-item', pick === i.id && 'is-on')} onClick={() => setPick(i.id)} title={!on ? 'Not connected' : !here ? 'Works in the desktop and mobile apps' : i.does}>
                  <span>{i.name}</span>
                  <small>{!on ? 'Not connected' : !here ? 'In the apps' : i.does}</small>
                </button>
              );
            })}
          </div>
          {!connected.length && <p className="mtg-hint">Nothing is connected yet. Connect Slack, Notion, Linear and more in <button type="button" className="link-btn" onClick={() => { onClose(); navigate({ name: 'settings', section: 'meetings' }); }}>Settings › Meetings</button>.</p>}
          {spec && spec.kind === 'tasks' && (
            <fieldset className="mtg-share-actions">
              <legend>Action items to send</legend>
              {!actions.length && <p className="mtg-hint">These notes have no open action items.</p>}
              {actions.map((a) => (
                <label key={a.id}>
                  <input type="checkbox" checked={chosen.has(a.id)} onChange={(e) => setChosen((s) => { const n = new Set(s); if (e.target.checked) n.add(a.id); else n.delete(a.id); return n; })} />
                  <span>{a.text}{a.owner ? <em> — {a.owner}</em> : null}</span>
                </label>
              ))}
            </fieldset>
          )}
          {spec && spec.kind === 'crm' && <p className="mtg-hint">Logged on {emails.length ? emails.join(', ') : 'nobody: add attendees with their email first'}.</p>}
          {preview && <pre className="mtg-share-preview" aria-label="What will be sent">{preview}</pre>}
        </div>
      )}
    </Dialog>
  );
}
