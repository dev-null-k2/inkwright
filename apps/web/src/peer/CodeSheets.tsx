/**
 * The short-code screens (docs/COLLABORATION.md): a code card the host shows (the code in large
 * type, a QR code of the join link, "Send link" and "Copy code"), the host dialogs for pairing and
 * syncing a device, and the one join sheet a guest uses for everything — type the code, scan the
 * QR code, or arrive from a link.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { create } from 'zustand';
import { Camera, Check, Copy, Share2 } from 'lucide-react';
import { CODE_LENGTH, formatShortCode, parseShortCode, type HostState, type ShortCodeHost } from '@inkwright/sync';
import { useApp } from '../state/app.ts';
import { Dialog } from '../ui/primitives.tsx';
import { isNative } from '../platform/env.ts';
import { QrCode, Scanner, canScanQr } from './CodeExchange.tsx';
import { answerConnection, type Connected } from './connect.ts';
import { inviteFromOffer } from './collab.ts';
import { hostByCode, joinByCode, parseJoin, type LinkRelay } from './shortcode.ts';
import { serveVaultSetup, syncOverLink, usePeerSync } from './sync.ts';
import type { PairedDevice } from './identity.ts';

const errorText = (e: unknown) => (e as Error)?.message || String(e);
const sasText = (sas: string) => sas.replace(/(\d{3})/, '$1 ');

/** Hands a link to the system share sheet (Android, or Web Share), or copies it where there is none. */
export async function shareLink(o: { title: string; text: string; url: string }): Promise<'shared' | 'copied' | 'cancelled'> {
  try {
    if (isNative) {
      const { Share } = await import('@capacitor/share');
      await Share.share({ title: o.title, text: o.text, url: o.url, dialogTitle: o.title });
      return 'shared';
    }
    if (navigator.share) {
      await navigator.share(o);
      return 'shared';
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') return 'cancelled';
  }
  await navigator.clipboard.writeText(`${o.text}\n${o.url}`);
  return 'copied';
}

/** Minutes left, refreshed while shown. */
function useMinutesLeft(until: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  return Math.max(0, Math.ceil((until - now) / 60_000));
}

/**
 * The code as the host shows it. The QR code holds the join link, so any phone camera opens
 * Inkwright with the code filled in; the in-app scanner reads it too.
 */
export function CodeCard({ code, link, expiresAt, relay, shareText }: { code: string; link: string; expiresAt: number; relay: string; shareText: string }) {
  const toast = useApp((s) => s.toast);
  const [copied, setCopied] = useState(false);
  const minutes = useMinutesLeft(expiresAt);
  const shown = formatShortCode(code);
  return (
    <div className="code-card">
      <QrCode text={link} label={`QR code for the join link (code ${shown})`} />
      <div className="code-card-side">
        <output className="code-big" aria-label="Code" data-code={code}>{shown}</output>
        <div className="row-buttons">
          <button type="button" className="btn btn-primary" onClick={() => void shareLink({ title: 'Join me in Inkwright', text: `${shareText} Code: ${shown}`, url: link }).then((r) => { if (r === 'copied') toast({ text: 'Link copied — paste it in a message' }); })}>
            <Share2 size={15} /> Send link
          </button>
          <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(shown).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => {})}>
            {copied ? <Check size={15} /> : <Copy size={15} />} {copied ? 'Copied' : 'Copy code'}
          </button>
        </div>
        <p className="muted small">Works once{minutes ? `, for ${minutes} more ${minutes === 1 ? 'minute' : 'minutes'}` : ''} · meets through {relay}</p>
      </div>
    </div>
  );
}

/** Plain words for where a host's code stands. */
export function hostStatus(s: HostState | null, who: string): { text: string; tone: 'wait' | 'done' | 'error' } {
  if (!s) return { text: 'Making a code…', tone: 'wait' };
  switch (s.phase) {
    case 'waiting': return { text: s.attempts ? 'Someone is entering the code…' : `Waiting for ${who} to enter the code…`, tone: 'wait' };
    case 'connecting': return { text: 'Connecting…', tone: 'wait' };
    case 'done': return { text: 'Connected.', tone: 'done' };
    case 'failed': return { text: s.error, tone: 'error' };
    case 'ended':
      return s.status === 'locked'
        ? { text: 'Too many wrong tries, so this code is locked. Make a new one.', tone: 'error' }
        : s.status === 'expired'
          ? { text: 'This code expired. Make a new one.', tone: 'error' }
          : { text: 'Stopped.', tone: 'wait' };
  }
}

// ---- Host: pair or sync a device ---------------------------------------------------------------------

/**
 * "Pair a device" and "Sync now" without a self-hosted relay: this device shows a code, the other
 * one enters it under Join with a code.
 */
export function HostCodeDialog({ purpose, device, onClose }: { purpose: 'pair' | 'sync'; device?: PairedDevice; onClose: () => void }) {
  const [host, setHost] = useState<{ host: ShortCodeHost; link: string; relay: string } | null>(null);
  const [state, setState] = useState<HostState | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const hostRef = useRef<ShortCodeHost | null>(null);
  const start = useCallback(async () => {
    setProblem(null);
    setDone(null);
    setState(null);
    try {
      const h = await hostByCode({
        purpose,
        ...(device ? { expect: device } : {}),
        onState: setState,
        accept: async (answerCode, pending) => {
          const c: Connected = await pending.finish(answerCode);
          if (purpose === 'pair') {
            setTimeout(() => c.link.close('Paired.'), 1500);
            setDone(`Paired with “${c.peer.name}”. Both screens show ${sasText(c.link.sas)}.`);
          } else {
            setDone(`Connected to “${c.peer.name}”. Syncing…`);
            await syncOverLink(c);
            setDone(usePeerSync.getState().message ?? 'Synced.');
          }
        },
      });
      hostRef.current = h.host;
      setHost(h);
    } catch (e) {
      setProblem(errorText(e));
    }
  }, [purpose, device]);
  useEffect(() => {
    void start();
    return () => hostRef.current?.cancel();
  }, [start]);
  const status = hostStatus(state, device ? `“${device.name}”` : 'the other device');
  const ended = state?.phase === 'ended' || state?.phase === 'failed';
  return (
    <Dialog open title={purpose === 'pair' ? 'Pair a device' : `Sync with “${device?.name}”`} onClose={onClose} actions={<button type="button" className="btn" onClick={onClose}>{done ? 'Done' : 'Cancel'}</button>}>
      {problem ? <p role="alert" className="peer-status is-error">{problem}</p> : done ? (
        <p role="status" className="peer-status is-done">{done}</p>
      ) : (
        <>
          <p className="muted">On {device ? `“${device.name}”` : 'the other device'}, open Inkwright, choose <b>Join with a code</b> (Settings › Sync & devices › Devices & sharing) and enter this code — or scan it.</p>
          {host && !ended && <CodeCard code={host.host.code.value} link={host.link} expiresAt={host.host.expiresAt} relay={host.relay} shareText={purpose === 'pair' ? 'Pair with my device in Inkwright.' : 'Sync with my device in Inkwright.'} />}
          <p role="status" className={`peer-status is-${status.tone}`}>{status.text}</p>
          {ended && <button type="button" className="btn" onClick={() => void start()}>New code</button>}
        </>
      )}
    </Dialog>
  );
}

// ---- Guest: one sheet to join anything ------------------------------------------------------------------

interface JoinRequest {
  code: string;
  relay: LinkRelay | null;
  /** Opened from a link or a scanned QR code (asks for one tap before connecting). */
  fromLink: boolean;
}

export const useJoinSheet = create<{ open: boolean; request: JoinRequest | null }>(() => ({ open: false, request: null }));

export const openJoinSheet = (request?: Partial<JoinRequest>) =>
  useJoinSheet.setState({ open: true, request: request?.code ? { code: request.code, relay: request.relay ?? null, fromLink: request.fromLink ?? false } : null });

/** A code field that formats as you type (K7PM-2Q9X) and fires once eight valid characters are in. */
export function CodeInput({ value, onChange, onComplete, disabled }: { value: string; onChange: (v: string) => void; onComplete: (code: string) => void; disabled?: boolean }) {
  const set = (raw: string) => {
    const clean = raw.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, CODE_LENGTH);
    const shown = clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
    onChange(shown);
    const code = parseShortCode(clean);
    if (code) onComplete(code.value);
  };
  return (
    <input
      className="code-input"
      aria-label="Code"
      value={value}
      placeholder="K7PM-2Q9X"
      inputMode="text"
      autoCapitalize="characters"
      autoComplete="one-time-code"
      autoCorrect="off"
      spellCheck={false}
      maxLength={CODE_LENGTH + 2}
      disabled={disabled}
      onChange={(e) => set(e.target.value)}
      onPaste={(e) => {
        const j = parseJoin(e.clipboardData.getData('text'));
        if (j) {
          e.preventDefault();
          set(j.code);
        }
      }}
    />
  );
}

type JoinPhase =
  | { kind: 'enter'; error?: string }
  | { kind: 'link' }
  | { kind: 'connecting'; text: string }
  | { kind: 'confirm-pair'; name: string; go: () => void; no: () => void }
  | { kind: 'done'; text: string };

/** The guest's sheet: type, scan or follow a link; then connected (or a plain reason why not). */
export function JoinSheet() {
  const { open, request } = useJoinSheet();
  const navigate = useApp((s) => s.navigate);
  const toast = useApp((s) => s.toast);
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<JoinPhase>({ kind: 'enter' });
  const [scanning, setScanning] = useState(false);
  const [scanOk, setScanOk] = useState(false);
  const relay = useRef<LinkRelay | null>(null);
  const abort = useRef<AbortController | null>(null);
  const close = useCallback(() => {
    abort.current?.abort();
    useJoinSheet.setState({ open: false, request: null });
  }, []);

  useEffect(() => { void canScanQr().then(setScanOk); }, []);
  useEffect(() => {
    if (!open) return;
    relay.current = request?.relay ?? null;
    setText(request ? formatShortCode(request.code) : '');
    setScanning(false);
    setPhase(request?.fromLink ? { kind: 'link' } : { kind: 'enter' });
    if (request && !request.fromLink) void join(request.code);
    // Runs when the sheet opens with a new request only (`join` reads what it needs through refs).
  }, [open, request]);

  const join = async (code: string) => {
    abort.current?.abort();
    const ac = new AbortController();
    abort.current = ac;
    setPhase({ kind: 'connecting', text: 'Looking for the code…' });
    let j: Awaited<ReturnType<typeof joinByCode>> | null = null;
    try {
      j = await joinByCode(code, { relay: relay.current, signal: ac.signal });
      const { offer, pakePsk } = j;
      const jj = j;
      if (offer.purpose === 'collab') {
        const invite = inviteFromOffer(offer, pakePsk);
        setPhase({ kind: 'connecting', text: `Joining “${invite.title}” — ${invite.from} invites you to ${invite.permission === 'write' ? 'write on it' : 'watch it'}…` });
        const r = await invite.accept();
        await jj.reply(r.answerCode);
        const noteId = await r.joined;
        close();
        toast({ text: `Joined “${invite.title}”. A copy stays in your notes.`, tone: 'success' });
        navigate({ name: 'editor', noteId });
        return;
      }
      if (offer.purpose === 'pair') {
        const yes = await new Promise<boolean>((resolve) => setPhase({ kind: 'confirm-pair', name: offer.from.name, go: () => resolve(true), no: () => resolve(false) }));
        if (!yes) {
          jj.close();
          return close();
        }
      }
      setPhase({ kind: 'connecting', text: `Connecting to “${offer.from.name}”…` });
      const r = await answerConnection(offer, { pakePsk, ...(offer.purpose === 'sync' ? { setup: serveVaultSetup } : {}) });
      await jj.reply(r.answerCode);
      const c = await r.connected;
      setPhase({ kind: 'done', text: offer.purpose === 'pair' ? `Paired with “${c.peer.name}”. Both screens show ${sasText(c.link.sas)}.` : `Connected to “${c.peer.name}”. It is syncing with this device.` });
    } catch (e) {
      j?.close();
      if (ac.signal.aborted) return;
      setPhase({ kind: 'enter', error: errorText(e) });
    }
  };

  if (!open) return null;
  const busy = phase.kind === 'connecting';
  return (
    <Dialog open title="Join with a code" onClose={close} actions={<button type="button" className="btn" onClick={close}>{phase.kind === 'done' ? 'Done' : 'Cancel'}</button>}>
      {phase.kind === 'done' ? (
        <p role="status" className="peer-status is-done">{phase.text}</p>
      ) : phase.kind === 'confirm-pair' ? (
        <div className="peer-flow">
          <p>Pair with “{phase.name}”? Paired devices can sync all your notes with each other, directly and end to end encrypted. You can remove a device at any time.</p>
          <div className="row-buttons">
            <button type="button" className="btn btn-primary" onClick={phase.go}>Pair</button>
            <button type="button" className="btn btn-ghost" onClick={phase.no}>Not now</button>
          </div>
        </div>
      ) : (
        <div className="join-sheet">
          <p className="muted">Enter the code from the person sharing a note, or from your other device.</p>
          <CodeInput value={text} onChange={setText} disabled={busy} onComplete={(c) => { if (phase.kind !== 'link') void join(c); }} />
          <div className="row-buttons">
            {phase.kind === 'link' && <button type="button" className="btn btn-primary" onClick={() => { const c = parseShortCode(text); if (c) void join(c.value); }}>Join</button>}
            {scanOk && !busy && <button type="button" className="btn" onClick={() => setScanning(true)}><Camera size={15} /> Scan QR code</button>}
          </div>
          {scanning && (
            <Scanner
              accept={(raw) => !!parseJoin(raw)}
              onClose={() => setScanning(false)}
              onCode={(raw) => {
                setScanning(false);
                const p = parseJoin(raw);
                if (!p) return;
                relay.current = p.relay;
                setText(formatShortCode(p.code));
                void join(p.code);
              }}
            />
          )}
          {busy && <p role="status" className="peer-status">{phase.text}</p>}
          {phase.kind === 'enter' && phase.error && <p role="alert" className="peer-status is-error">{phase.error}</p>}
        </div>
      )}
    </Dialog>
  );
}
