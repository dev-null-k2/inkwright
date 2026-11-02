/**
 * Settings › Devices & sharing: pair devices by QR code, sync with them directly (no cloud),
 * join a live note someone shared, and the network settings the peer link uses.
 */
import { useEffect, useState } from 'react';
import { Laptop, RefreshCw, Trash2 } from 'lucide-react';
import { isOffer, type PeerOffer } from '@inkwright/sync';
import { useApp } from '../state/app.ts';
import { relativeTime } from '../ui/primitives.tsx';
import { askConfirm } from '../ui/prompts.tsx';
import { answerConnection, connectViaRelay, readCode, relayConfigured, startConnection, type PendingOffer } from './connect.ts';
import { DEFAULT_STUN, deviceIdentity, forgetDevice, getRelayToken, getTurnCredential, setNetwork, setRelayToken, setTurnCredential, usePeer, type Identity, type PairedDevice } from './identity.ts';
import { serveVaultSetup, syncOverLink, usePeerSync } from './sync.ts';
import { readInvite, type JoinStart } from './collab.ts';
import { ReadCode, ShowCode } from './CodeExchange.tsx';

function Group({ title, children, note }: { title: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <section className="set-group">
      <h2>{title}</h2>
      <div className="set-card">{children}</div>
      {note && <p className="set-note">{note}</p>}
    </section>
  );
}

const errorText = (e: unknown) => (e as Error)?.message || String(e);

export function DevicesSection() {
  const [me, setMe] = useState<Identity | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => { void deviceIdentity().then(setMe, (e) => setProblem(errorText(e))); }, []);
  return (
    <>
      <Group title="This device" note="Devices you pair talk to each other directly and end to end encrypted; your notes never pass through a server of ours.">
        {problem ? <p>{problem}</p> : me ? (
          <div className="peer-me">
            <Laptop size={18} />
            <div>
              <div>{me.info.name}</div>
              <div className="muted small">Key <span className="peer-fp">{me.fingerprint}</span>{!me.persistent && ' · this browser forgets it when closed'}</div>
            </div>
          </div>
        ) : <p className="muted">Preparing this device’s key…</p>}
        <p className="muted small">Change the name in Settings › Privacy & trust › Authorship.</p>
      </Group>
      {me && <PairFlows />}
      {me && <PairedList />}
      <NetworkSettings />
    </>
  );
}

type Flow =
  | { kind: 'none' }
  | { kind: 'show'; pending: PendingOffer; title: string; device?: PairedDevice }
  | { kind: 'answer'; code: string; title: string; waiting: string }
  | { kind: 'join'; invite: JoinStart }
  | { kind: 'done'; text: string };

/** Pairing, manual sync codes and invites: one place to show or enter a code. */
function PairFlows() {
  const toast = useApp((s) => s.toast);
  const navigate = useApp((s) => s.navigate);
  const [flow, setFlow] = useState<Flow>({ kind: 'none' });
  const [busy, setBusy] = useState(false);
  const status = usePeerSync();

  useEffect(() => () => { if (flow.kind === 'show') flow.pending.cancel(); }, [flow]);

  const fail = (e: unknown) => {
    console.warn('peer:', e);
    toast({ text: errorText(e), tone: 'error' });
    setBusy(false);
  };

  const showPairing = async () => {
    setBusy(true);
    try {
      setFlow({ kind: 'show', pending: await startConnection('pair'), title: 'Scan this on the other device' });
    } catch (e) { fail(e); }
    setBusy(false);
  };

  /** This device showed a code; the other device's answer completes it. */
  const finishShown = async (answer: string) => {
    if (flow.kind !== 'show') return;
    setBusy(true);
    try {
      const purpose = flow.pending.offer.purpose;
      const c = await flow.pending.finish(answer);
      if (purpose === 'pair') {
        setTimeout(() => c.link.close('Paired.'), 1500);
        setFlow({ kind: 'done', text: `Paired with “${c.peer.name}”. Both screens showed ${c.link.sas.replace(/(\d{3})/, '$1 ')} — if they matched, nobody was in the middle.` });
      } else {
        setFlow({ kind: 'done', text: `Connected to “${c.peer.name}”. Syncing…` });
        await syncOverLink(c);
        setFlow({ kind: 'done', text: usePeerSync.getState().message ?? 'Synced.' });
      }
    } catch (e) { fail(e); }
    setBusy(false);
  };

  /** Another device showed a code (pairing, a sync request or an invite to a live note). */
  const enterCode = async (code: string) => {
    setBusy(true);
    try {
      const v = await readCode(code);
      if (!isOffer(v)) throw new Error('That is an answer code. Enter it on the device that showed the first code.');
      if (v.purpose === 'collab') {
        setFlow({ kind: 'join', invite: await readInvite(code) });
      } else await answerOffer(v);
    } catch (e) { fail(e); }
    setBusy(false);
  };

  const answerOffer = async (offer: PeerOffer) => {
    if (offer.purpose === 'pair' && !(await askConfirm(`Pair with “${offer.from.name}”?`, 'Paired devices can sync all your notes with each other, directly and end to end encrypted. You can remove a device at any time.', 'Pair'))) return;
    const r = await answerConnection(offer, offer.purpose === 'sync' ? { setup: serveVaultSetup } : {});
    setFlow({ kind: 'answer', code: r.answerCode, title: 'Now show this on the first device', waiting: offer.purpose === 'pair' ? `Waiting for “${offer.from.name}”…` : `Waiting for “${offer.from.name}” to sync…` });
    void r.connected.then((c) => {
      // The device that showed the code closes the pairing link once it is done too.
      if (offer.purpose === 'pair') {
        setFlow({ kind: 'done', text: `Paired with “${c.peer.name}”. Both screens showed ${c.link.sas.replace(/(\d{3})/, '$1 ')} — if they matched, nobody was in the middle.` });
      } else setFlow({ kind: 'done', text: `Connected to “${c.peer.name}”.` });
    }, fail);
  };

  const join = async (invite: JoinStart) => {
    setBusy(true);
    try {
      const r = await invite.accept();
      setFlow({ kind: 'answer', code: r.answerCode, title: `Show this to ${invite.from}`, waiting: `Waiting for ${invite.from} to let you in…` });
      const noteId = await r.joined;
      setFlow({ kind: 'none' });
      navigate({ name: 'editor', noteId });
    } catch (e) { fail(e); }
    setBusy(false);
  };

  return (
    <Group title="Pair, sync and join" note="Codes work once and expire after ten minutes. Show a code as a QR code, or copy it into a message to yourself.">
      {flow.kind === 'none' && (
        <>
          <div className="row-buttons">
            <button type="button" className="btn" disabled={busy} onClick={() => void showPairing()}>Pair a new device</button>
          </div>
          <ReadCode label="Code from another device or an invitation" busy={busy} onCode={(c) => void enterCode(c)} />
        </>
      )}
      {flow.kind === 'show' && (
        <div className="peer-flow">
          <h3 className="peer-flow-title">{flow.title}</h3>
          <ShowCode code={flow.pending.code} label="Connection code" />
          <ReadCode label="Then enter the code it shows" busy={busy} onCode={(c) => void finishShown(c)} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFlow({ kind: 'none' })}>Cancel</button>
        </div>
      )}
      {flow.kind === 'answer' && (
        <div className="peer-flow">
          <h3 className="peer-flow-title">{flow.title}</h3>
          <ShowCode code={flow.code} label="Answer code" />
          <p className="muted small" role="status">{flow.waiting}</p>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setFlow({ kind: 'none' })}>Close</button>
        </div>
      )}
      {flow.kind === 'join' && (
        <div className="peer-flow">
          <h3 className="peer-flow-title">Join “{flow.invite.title}”</h3>
          <p>{flow.invite.from} invites you to {flow.invite.permission === 'write' ? 'write on' : 'watch'} this note live. A copy is kept in your notes.</p>
          <div className="row-buttons">
            <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void join(flow.invite)}>Join</button>
            <button type="button" className="btn btn-ghost" onClick={() => setFlow({ kind: 'none' })}>Not now</button>
          </div>
        </div>
      )}
      {flow.kind === 'done' && (
        <div className="peer-flow">
          <p role="status">{flow.text}</p>
          <button type="button" className="btn btn-sm" onClick={() => setFlow({ kind: 'none' })}>Done</button>
        </div>
      )}
      {status.message && flow.kind !== 'done' && <p className={`muted small peer-status is-${status.status}`} role="status">{status.message}</p>}
    </Group>
  );
}

function PairedList() {
  const paired = usePeer((s) => s.paired);
  const toast = useApp((s) => s.toast);
  const status = usePeerSync();
  const [manual, setManual] = useState<{ device: PairedDevice; pending: PendingOffer } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const syncWith = async (d: PairedDevice) => {
    setBusy(d.key);
    try {
      if (relayConfigured()) {
        await syncOverLink(await connectViaRelay(d));
      } else {
        setManual({ device: d, pending: await startConnection('sync', { expect: d }) });
      }
    } catch (e) {
      toast({ text: errorText(e), tone: 'error' });
    }
    setBusy(null);
  };
  const finishManual = async (answer: string) => {
    if (!manual) return;
    setBusy(manual.device.key);
    try {
      const c = await manual.pending.finish(answer);
      setManual(null);
      await syncOverLink(c);
    } catch (e) {
      toast({ text: errorText(e), tone: 'error' });
    }
    setBusy(null);
  };
  if (!paired.length) return null;
  return (
    <Group title="Paired devices" note={relayConfigured() ? 'Sync now reaches the other device through your signalling server; Inkwright must be open there.' : 'Without a signalling server, each sync is started with a code: show it on the other device (Settings › Sync & devices) and enter its answer here.'}>
      <ul className="peer-devices">
        {paired.map((d) => (
          <li key={d.key} className="peer-device">
            <div className="peer-device-text">
              <span>{d.name}</span>
              <span className="muted small"><span className="peer-fp">{d.fingerprint}</span> · {d.lastSync ? `synced ${relativeTime(d.lastSync)}` : 'not synced yet'}</span>
            </div>
            <button type="button" className="btn btn-sm" disabled={!!busy} onClick={() => void syncWith(d)}><RefreshCw size={14} /> Sync now</button>
            <button type="button" className="icon-btn" aria-label={`Remove ${d.name}`} title="Remove" onClick={async () => { if (await askConfirm(`Remove “${d.name}”?`, 'It can no longer sync with this device. Notes already synced stay on both.', 'Remove', true)) forgetDevice(d.key); }}><Trash2 size={16} /></button>
          </li>
        ))}
      </ul>
      {manual && (
        <div className="peer-flow">
          <h3 className="peer-flow-title">Enter this on “{manual.device.name}”</h3>
          <ShowCode code={manual.pending.code} label="Sync code" />
          <ReadCode label="Then enter the code it shows" busy={!!busy} onCode={(c) => void finishManual(c)} />
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => { manual.pending.cancel(); setManual(null); }}>Cancel</button>
        </div>
      )}
      {status.message && <p className={`muted small peer-status is-${status.status}`} role="status">{status.message}</p>}
    </Group>
  );
}

function NetworkSettings() {
  const net = usePeer((s) => s.network);
  const [turnCred, setTurnCred] = useState('');
  const [relayToken, setRelayTokenText] = useState('');
  useEffect(() => {
    void getTurnCredential().then((v) => setTurnCred(v ? '••••••••' : ''));
    void getRelayToken().then((v) => setRelayTokenText(v ? '••••••••' : ''));
  }, []);
  return (
    <Group title="Network" note={<>Devices find each other with STUN, which only tells each one its public address. Some networks (strict company or mobile networks, symmetric NATs) block direct connections; then a TURN relay is needed — it carries the encrypted traffic but can’t read it. See docs/COLLABORATION.md.</>}>
      <label className="field">
        <span className="field-label">STUN servers (one per line; empty for this network only)</span>
        <textarea rows={2} value={net.stun.join('\n')} spellCheck={false} onChange={(e) => setNetwork({ stun: e.target.value.split('\n').map((s) => s.trim()).filter(Boolean) })} />
      </label>
      {net.stun.join() !== DEFAULT_STUN.join() && <button type="button" className="btn btn-sm btn-ghost" onClick={() => setNetwork({ stun: DEFAULT_STUN })}>Use the default</button>}
      <div className="field-pair">
        <label className="field"><span className="field-label">TURN server</span><input value={net.turn?.url ?? ''} placeholder="turn:turn.example.com:3478" onChange={(e) => setNetwork({ turn: e.target.value.trim() ? { url: e.target.value.trim(), username: net.turn?.username ?? '' } : null })} /></label>
        <label className="field"><span className="field-label">Username</span><input value={net.turn?.username ?? ''} disabled={!net.turn} onChange={(e) => setNetwork({ turn: { url: net.turn!.url, username: e.target.value } })} /></label>
        <label className="field"><span className="field-label">Credential</span><input type="password" value={turnCred} disabled={!net.turn} onChange={(e) => setTurnCred(e.target.value)} onBlur={() => { if (!turnCred.startsWith('•')) void setTurnCredential(turnCred || null); }} /></label>
      </div>
      <div className="field-pair">
        <label className="field"><span className="field-label">Signalling server (optional)</span><input value={net.relayUrl} placeholder="https://notes.example.com" onChange={(e) => setNetwork({ relayUrl: e.target.value.trim() })} /></label>
        <label className="field"><span className="field-label">Signalling token</span><input type="password" value={relayToken} onChange={(e) => setRelayTokenText(e.target.value)} onBlur={() => { if (!relayToken.startsWith('•')) void setRelayToken(relayToken || null); }} /></label>
      </div>
    </Group>
  );
}
