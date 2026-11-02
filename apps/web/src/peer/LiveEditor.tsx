/**
 * The editor's side of live collaboration: the "Share live" item in the ••• menu, the invite
 * dialog, collaborators' cursors and their strokes as they are drawn, and the doc binding.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Radio } from 'lucide-react';
import { argbToCss, outlineToSvgPath, strokeOutline, type InkStroke, type NoteDocument } from '@inkwright/core';
import type { CollabPermission } from '@inkwright/sync';
import type { InkEngine } from '../canvas/engine.ts';
import { useApp } from '../state/app.ts';
import { Dialog, Segmented } from '../ui/primitives.tsx';
import { admitGuest, attachEditor, inviteToNote, sendInk, sendPresence, stopLive, useLive, type LivePeer } from './collab.ts';
import type { PendingOffer } from './connect.ts';
import { ReadCode, ShowCode } from './CodeExchange.tsx';

interface Args {
  doc: NoteDocument | null;
  engine: InkEngine | null;
  host: HTMLElement | null;
  view: { zoom: number; pageIndex: number; pageCount: number };
}

/** How often strokes in progress and the pointer are sent (ms): smooth enough, light on the link. */
const INK_EVERY = 60;
const CURSOR_EVERY = 90;

export function useLiveEditor({ doc, engine, host, view }: Args): { parts: ReactNode; menuItems: { label: string; icon: ReactNode; hint?: string; onClick: () => void }[] } {
  const noteId = doc?.meta.id ?? '';
  const session = useLive((s) => (noteId ? s.sessions[noteId] : undefined));
  const [open, setOpen] = useState(false);
  const toast = useApp((s) => s.toast);

  // Bind the document to the live session for this note (and re-bind when the session starts).
  const live = !!session && !session.ended;
  useEffect(() => {
    if (!doc || !live) return;
    return attachEditor(doc) ?? undefined;
  }, [doc, live]);

  // Strokes in progress: a few times a second, only the points not sent yet.
  useEffect(() => {
    if (!doc || !engine || !live || session?.permission !== 'write') return;
    let sid: string | null = null;
    let sent = 0;
    const timer = setInterval(() => {
      const s = engine.liveStroke;
      if (!s) {
        if (sid) sendInk(noteId, { sid, done: true });
        sid = null;
        sent = 0;
        return;
      }
      const page = doc.committedPages[s.pageIndex]?.id;
      if (!page) return;
      if (!sid) sid = Math.random().toString(36).slice(2, 10);
      if (s.points.length <= sent) return;
      const pts: number[] = [];
      for (const p of s.points.slice(sent)) pts.push(Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10, Math.round(Math.max(0, p.p) * 100) / 100);
      sent = s.points.length;
      sendInk(noteId, { sid, page, pen: s.pen, color: s.color, size: s.size, pts });
    }, INK_EVERY);
    return () => clearInterval(timer);
  }, [doc, engine, live, noteId, session?.permission]);

  // The pointer, in page coordinates, so it lands in the same place at any zoom.
  useEffect(() => {
    if (!doc || !engine || !host || !live) return;
    let last = 0;
    const move = (e: PointerEvent) => {
      const now = performance.now();
      if (now - last < CURSOR_EVERY) return;
      last = now;
      const r = host.getBoundingClientRect();
      const at = engine.pageAtScreen(e.clientX - r.left, e.clientY - r.top);
      const page = at ? doc.committedPages[at.pageIndex]?.id : undefined;
      sendPresence(noteId, at && page ? { page, x: Math.round(at.x), y: Math.round(at.y) } : null);
    };
    const leave = () => sendPresence(noteId, null);
    host.addEventListener('pointermove', move);
    host.addEventListener('pointerleave', leave);
    return () => {
      host.removeEventListener('pointermove', move);
      host.removeEventListener('pointerleave', leave);
    };
  }, [doc, engine, host, live, noteId]);

  useEffect(() => {
    if (session?.ended) toast({ text: session.ended });
  }, [session?.ended, toast]);

  const peers = Object.values(session?.peers ?? {});
  const parts = (
    <>
      {doc && engine && live && <PresenceLayer doc={doc} engine={engine} peers={peers} view={view} />}
      {doc && live && (
        <div className="live-pill" role="status">
          <Radio size={13} />
          <span>{session!.role === 'host' ? (peers.length ? `Live with ${peers.map((p) => p.author.name).join(', ')}` : 'Live — waiting for people') : session!.permission === 'write' ? `Live with ${peers.map((p) => p.author.name).join(', ') || 'the host'}` : 'Watching live · view only'}</span>
          <button type="button" className="live-pill-btn" onClick={() => setOpen(true)}>{session!.role === 'host' ? 'Invite' : 'Leave'}</button>
        </div>
      )}
      {doc && <ShareDialog open={open} onClose={() => setOpen(false)} doc={doc} />}
    </>
  );
  const menuItems = doc && !doc.meta.lock
    ? [{ label: live ? 'Live sharing' : 'Share live', icon: <Radio size={16} />, hint: live ? `${peers.length} ${peers.length === 1 ? 'person' : 'people'}` : undefined, onClick: () => setOpen(true) }]
    : [];
  return { parts, menuItems };
}

function ShareDialog({ open, onClose, doc }: { open: boolean; onClose: () => void; doc: NoteDocument }) {
  const session = useLive((s) => s.sessions[doc.meta.id]);
  const toast = useApp((s) => s.toast);
  const [permission, setPermission] = useState<CollabPermission>('write');
  const [pending, setPending] = useState<PendingOffer | null>(null);
  const [busy, setBusy] = useState(false);
  const pendingRef = useRef<PendingOffer | null>(null);
  pendingRef.current = pending;
  useEffect(() => () => pendingRef.current?.cancel(), []);
  useEffect(() => { if (!open) setPending(null); }, [open]);

  const makeInvite = async () => {
    setBusy(true);
    try {
      setPending(await inviteToNote(doc, permission));
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
    setBusy(false);
  };
  const admit = async (answer: string) => {
    if (!pending) return;
    setBusy(true);
    try {
      const who = await admitGuest(doc, pending, answer);
      setPending(null);
      toast({ text: `${who.name} joined`, tone: 'success' });
    } catch (e) {
      toast({ text: (e as Error).message, tone: 'error' });
    }
    setBusy(false);
  };
  const guest = session?.role === 'guest';
  const peers = Object.values(session?.peers ?? {});
  return (
    <Dialog open={open} onClose={onClose} title={guest ? 'Live note' : 'Share live'} actions={
      <>
        {session && !session.ended && <button type="button" className="btn btn-danger" onClick={() => { stopLive(doc.meta.id); onClose(); }}>{guest ? 'Leave' : 'Stop sharing'}</button>}
        <button type="button" className="btn" onClick={onClose}>Done</button>
      </>
    }>
      {guest ? (
        <p>You are {session!.permission === 'write' ? 'writing on' : 'watching'} a note shared by {peers[0]?.author.name ?? 'someone'}. When you leave, your copy stays in your notes.</p>
      ) : (
        <>
          <p className="muted">People you invite see this note and every stroke as it is written, directly from this device and end to end encrypted. Each invite works once.</p>
          {peers.length > 0 && (
            <ul className="live-people">
              {peers.map((p) => <li key={p.author.id}><span className={`live-dot is-hue-${p.hue}`} aria-hidden />{p.author.name}<span className="muted small"> · {p.permission === 'write' ? 'can write' : 'can view'}</span></li>)}
            </ul>
          )}
          {!pending ? (
            <div className="live-invite">
              <Segmented label="What they can do" value={permission} onChange={setPermission} options={[{ value: 'write', label: 'Can write' }, { value: 'view', label: 'Can view' }]} />
              <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void makeInvite()}>Make an invite</button>
            </div>
          ) : (
            <div className="peer-flow">
              <h3 className="peer-flow-title">Show this to the person you’re inviting</h3>
              <ShowCode code={pending.code} label="Invitation code" />
              <ReadCode label="Then enter the code their device shows" busy={busy} onCode={(c) => void admit(c)} />
            </div>
          )}
        </>
      )}
    </Dialog>
  );
}

/** Collaborators' cursors (name and colour) and their strokes while they are being written. */
function PresenceLayer({ doc, engine, peers, view }: { doc: NoteDocument; engine: InkEngine; peers: LivePeer[]; view: Args['view'] }) {
  void view; // re-render on scroll and zoom (positions are computed from the engine below)
  const [, tick] = useState(0);
  // Cursors fade out after a few quiet seconds.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const pageIndex = (id: string) => doc.indexOfPage(id);
  return (
    <div className="live-layer" aria-hidden>
      <svg className="live-ink">
        {peers.flatMap((p) => Object.entries(p.ink).map(([sid, s]) => {
          const i = pageIndex(s.page);
          if (i < 0 || s.pts.length < 3) return null;
          const o = engine.pageRectToScreen(i, { minX: 0, minY: 0, maxX: 1, maxY: 1 });
          const points = [];
          for (let k = 0; k + 2 < s.pts.length; k += 3) points.push({ x: s.pts[k]!, y: s.pts[k + 1]!, t: k * 5, p: s.pts[k + 2]! || 0.5, tilt: -1, orient: -1 });
          const stroke: InkStroke = { id: sid, pen: s.pen, color: s.color, size: s.size, createdAt: 0, points };
          return <path key={sid} transform={`translate(${o.x} ${o.y}) scale(${o.w})`} d={outlineToSvgPath(strokeOutline(stroke))} fill={argbToCss(s.color)} />;
        }))}
      </svg>
      {peers.map((p) => {
        if (!p.cursor || Date.now() - p.cursor.at > 8000) return null;
        const i = pageIndex(p.cursor.page);
        if (i < 0) return null;
        const r = engine.pageRectToScreen(i, { minX: p.cursor.x, minY: p.cursor.y, maxX: p.cursor.x, maxY: p.cursor.y });
        return (
          <div key={p.author.id} className={`live-cursor is-hue-${p.hue}`} style={{ transform: `translate(${r.x}px, ${r.y}px)` }}>
            <span className="live-cursor-dot" />
            <span className="live-cursor-name">{p.author.name}</span>
          </div>
        );
      })}
    </div>
  );
}
