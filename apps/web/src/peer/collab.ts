/**
 * Live collaboration on a note over the peer link (docs/COLLABORATION.md).
 *
 * The person who shares is the **host**: each invite is a one-time code (with a view or write
 * permission) and every guest connects to the host, which relays between guests. Edits travel
 * as CRDT ops (core collab.ts) and land through `NoteDocument.commit` with the collaborator as
 * author; strokes being written stream a few times a second so they appear as they are drawn;
 * cursors show where each person is. A guest's copy is an ordinary note in their own vault: when
 * the session ends it stays, like a photocopy of the shared page.
 *
 * Messages (events on the link's RPC):
 *   collab.welcome  host → guest   { snapshot, meta, permission, host }
 *   collab.ops      both ways      { from, ops }        (host forwards writers' ops to the others)
 *   collab.presence both ways      { from, page, x, y } (null page: left the page)
 *   collab.ink      both ways      { from, sid, page, pen, color, size, at, pts, done? }
 */
import { create } from 'zustand';
import { CollabReplica, fromBase64Url, newId, newNote, newPage, pagesFromSnapshot, type CollabOp, type CollabSnapshot, type ItemAuthor, type NoteDocument, type NoteMeta, type PenType } from '@inkstone/core';
import { isOffer, keyFingerprint, type CollabPermission, type PeerLink } from '@inkstone/sync';
import { useApp } from '../state/app.ts';
import { answerConnection, readCode, startConnection, type Connected, type PendingOffer } from './connect.ts';
import { deviceIdentity, shortKeyId } from './identity.ts';

/** A collaborator as shown: who, their colour slot, and what they are doing. */
export interface LivePeer {
  author: ItemAuthor;
  /** 0–3: picks a calm colour token (`--peer-1` … `--peer-4`). */
  hue: number;
  permission: CollabPermission;
  cursor: { page: string; x: number; y: number; at: number } | null;
  /** Strokes being written right now, by stroke session id. */
  ink: Record<string, { page: string; pen: PenType; color: string; size: number; pts: number[] }>;
}

export interface LiveSessionView {
  noteId: string;
  role: 'host' | 'guest';
  /** What this person may do (a host can always write). */
  permission: CollabPermission;
  title: string;
  peers: Record<string, LivePeer>;
  /** Set when the session ended (the host stopped, the connection dropped). */
  ended: string | null;
}

export const useLive = create<{ sessions: Record<string, LiveSessionView> }>(() => ({ sessions: {} }));

interface Link {
  link: PeerLink;
  author: ItemAuthor;
  permission: CollabPermission;
}

interface Runtime {
  noteId: string;
  role: 'host' | 'guest';
  me: ItemAuthor;
  links: Link[];
  replica: CollabReplica | null;
  /** Guest: the host's snapshot, and ops that arrived before the editor opened the note. */
  snapshot?: CollabSnapshot;
  backlog: { ops: CollabOp[]; from: ItemAuthor }[];
}

const runtimes = new Map<string, Runtime>();

export const hueOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 4;

function view(noteId: string, patch: Partial<LiveSessionView> | ((v: LiveSessionView) => Partial<LiveSessionView>)): void {
  useLive.setState((s) => {
    const cur = s.sessions[noteId];
    if (!cur) return s;
    const p = typeof patch === 'function' ? patch(cur) : patch;
    return { sessions: { ...s.sessions, [noteId]: { ...cur, ...p } } };
  });
}

function setPeer(noteId: string, id: string, f: (p: LivePeer | undefined) => LivePeer | undefined): void {
  view(noteId, (v) => {
    const next = { ...v.peers };
    const p = f(next[id]);
    if (p) next[id] = p;
    else delete next[id];
    return { peers: next };
  });
}

async function me(): Promise<ItemAuthor> {
  const id = await deviceIdentity();
  return { id: shortKeyId(id.fingerprint), name: id.info.name };
}

async function authorOf(c: Connected): Promise<ItemAuthor> {
  return { id: shortKeyId(await keyFingerprint(fromBase64Url(c.peer.key))), name: c.peer.name };
}

const validAuthor = (a: unknown): a is ItemAuthor => !!a && typeof (a as ItemAuthor).id === 'string' && typeof (a as ItemAuthor).name === 'string';

// ---- Messages ---------------------------------------------------------------------------------------

/** Handles the collaboration events on one link (both roles). */
function attach(rt: Runtime, l: Link): void {
  const { link } = l;
  const isHost = rt.role === 'host';
  // As host, everything a guest says is about that guest: `from` is never taken from them.
  const fromOf = (claimed: unknown): ItemAuthor | null => (isHost ? l.author : validAuthor(claimed) ? claimed : null);
  const others = () => rt.links.filter((x) => x !== l && !x.link.closed);

  link.rpc.on('collab.ops', (p) => {
    const { from: f, ops } = (p ?? {}) as { from?: unknown; ops?: CollabOp[] };
    const from = fromOf(f);
    if (!from || !Array.isArray(ops)) return;
    if (isHost && l.permission !== 'write') return; // a view-only guest's edits are refused
    if (rt.replica) rt.replica.receive(ops, from);
    else rt.backlog.push({ ops, from });
    if (isHost) for (const o of others()) void o.link.rpc.emit('collab.ops', { from, ops }).catch(() => {});
  });
  link.rpc.on('collab.presence', (p) => {
    const m = (p ?? {}) as { from?: unknown; page?: string | null; x?: number; y?: number };
    const from = fromOf(m.from);
    if (!from || from.id === rt.me.id) return;
    setPeer(rt.noteId, from.id, (cur) => ({ ...(cur ?? { author: from, hue: hueOf(from.id), permission: 'write', ink: {} }), cursor: m.page && typeof m.x === 'number' && typeof m.y === 'number' ? { page: m.page, x: m.x, y: m.y, at: Date.now() } : null }));
    if (isHost) for (const o of others()) void o.link.rpc.emit('collab.presence', { ...m, from }).catch(() => {});
  });
  link.rpc.on('collab.ink', (p) => {
    const m = (p ?? {}) as { from?: unknown; sid?: string; page?: string; pen?: PenType; color?: string; size?: number; pts?: number[]; done?: boolean };
    const from = fromOf(m.from);
    if (!from || typeof m.sid !== 'string' || from.id === rt.me.id) return;
    if (isHost && l.permission !== 'write') return;
    setPeer(rt.noteId, from.id, (cur) => {
      const peer = cur ?? { author: from, hue: hueOf(from.id), permission: 'write' as const, cursor: null, ink: {} };
      const ink = { ...peer.ink };
      if (m.done) delete ink[m.sid!];
      else if (m.page && Array.isArray(m.pts)) {
        const prev = ink[m.sid!];
        ink[m.sid!] = { page: m.page, pen: m.pen ?? 'ballpoint', color: typeof m.color === 'string' ? m.color : '#FF1B1F24', size: typeof m.size === 'number' ? m.size : 2, pts: [...(prev?.pts ?? []), ...m.pts.filter((n) => typeof n === 'number')] };
      }
      return { ...peer, ink };
    });
    if (isHost) for (const o of others()) void o.link.rpc.emit('collab.ink', { ...m, from }).catch(() => {});
  });
  link.onClose((reason) => {
    rt.links = rt.links.filter((x) => x !== l);
    setPeer(rt.noteId, l.author.id, () => undefined);
    if (!isHost) end(rt.noteId, reason?.includes('Sharing stopped') ? 'The host stopped sharing. Your copy stays in your notes.' : 'The live session ended. Your copy stays in your notes.');
    else for (const o of others()) void o.link.rpc.emit('collab.presence', { from: l.author, page: null }).catch(() => {});
  });
}

function broadcast(rt: Runtime, name: string, payload: Record<string, unknown>): void {
  for (const l of rt.links) if (!l.link.closed) void l.link.rpc.emit(name, { ...payload, from: rt.me }).catch(() => {});
}

// ---- Host -------------------------------------------------------------------------------------------

/** Starts (or continues) sharing the open note and makes a one-time invite with a permission. */
export async function inviteToNote(doc: NoteDocument, permission: CollabPermission): Promise<PendingOffer> {
  const noteId = doc.meta.id;
  let rt = runtimes.get(noteId);
  if (!rt) {
    const author = await me();
    rt = { noteId, role: 'host', me: author, links: [], replica: null, backlog: [] };
    const r = rt;
    r.replica = CollabReplica.seed(doc, `h${author.id}`, { send: (ops) => broadcast(r, 'collab.ops', { ops }) });
    runtimes.set(noteId, rt);
    useLive.setState((s) => ({ sessions: { ...s.sessions, [noteId]: { noteId, role: 'host', permission: 'write', title: doc.meta.title, peers: {}, ended: null } } }));
  }
  return startConnection('collab', { invite: { noteId, title: doc.meta.title, permission } });
}

/** Host: completes an invite with the guest's answer; the guest gets the note and joins. */
export async function admitGuest(doc: NoteDocument, pending: PendingOffer, answerCode: string): Promise<ItemAuthor> {
  const rt = runtimes.get(doc.meta.id);
  if (!rt || rt.role !== 'host' || !rt.replica) throw new Error('This note is not being shared.');
  const permission = pending.offer.invite!.permission;
  let link: Link | null = null;
  const c = await pending.finish(answerCode, { setup: () => {} });
  const author = await authorOf(c);
  link = { link: c.link, author, permission };
  rt.links.push(link);
  attach(rt, link);
  setPeer(rt.noteId, author.id, () => ({ author, hue: hueOf(author.id), permission, cursor: null, ink: {} }));
  const m = doc.meta;
  // Who wrote what is not in the shared state (each device stamps what it receives); the guest
  // learns it from the host's point of view: items the host wrote, and others' as the host has them.
  const authors: Record<string, ItemAuthor> = {};
  for (const p of doc.committedPages) for (const it of [...p.strokes, ...(p.texts ?? [])]) authors[it.id] = it.author ?? rt.me;
  await c.link.rpc.emit('collab.welcome', {
    authors,
    snapshot: rt.replica.state.snapshot(),
    meta: { title: m.title, kind: m.kind, paper: m.paper, pageSize: m.pageSize },
    permission,
    host: rt.me,
  });
  return author;
}

// ---- Guest ------------------------------------------------------------------------------------------

export interface JoinStart {
  /** Who invites, to what, with which permission (shown before joining). */
  from: string;
  title: string;
  permission: CollabPermission;
  /** Answers the invite; returns the code to show back to the host and waits for the note. */
  accept(): Promise<{ answerCode: string; joined: Promise<string> }>;
}

/** Reads an invite code (scanned or pasted). */
export async function readInvite(code: string): Promise<JoinStart> {
  const offer = await readCode(code);
  if (!isOffer(offer) || offer.purpose !== 'collab' || !offer.invite) throw new Error('That is not an invitation to a live note.');
  const invite = offer.invite;
  return {
    from: offer.from.name,
    title: invite.title,
    permission: invite.permission,
    async accept() {
      let welcomed!: (w: Welcome) => void;
      const welcome = new Promise<Welcome>((r) => (welcomed = r));
      const r = await answerConnection(offer, {
        setup: (link) => {
          link.rpc.on('collab.welcome', (p) => welcomed(p as Welcome));
        },
      });
      const joined = (async () => {
        const c = await r.connected;
        const w = await Promise.race([welcome, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('The host did not send the note.')), 20_000))]);
        return startGuest(c, w);
      })();
      return { answerCode: r.answerCode, joined };
    },
  };
}

interface Welcome {
  snapshot: CollabSnapshot;
  meta: Partial<NoteMeta>;
  permission: CollabPermission;
  host: ItemAuthor;
  /** Item id → who wrote it, as the host sees it. */
  authors?: Record<string, ItemAuthor>;
}

async function startGuest(c: Connected, w: Welcome): Promise<string> {
  const app = useApp.getState();
  if (!app.vault) throw new Error('No vault is open.');
  const host = await authorOf(c);
  // The guest's copy: a new note in their own vault, made from the host's snapshot. Nothing in
  // it is the guest's handwriting: each item is the host's, or whoever the host says wrote it.
  const by = (id: string): ItemAuthor => (w.authors && validAuthor(w.authors[id]) ? w.authors[id]! : host);
  const pages = pagesFromSnapshot(w.snapshot, (id) => newPage(id)).map((p) => ({
    ...p,
    strokes: p.strokes.map((s) => ({ ...s, author: by(s.id) })),
    ...(p.texts ? { texts: p.texts.map((t) => ({ ...t, author: by(t.id) })) } : {}),
  }));
  const now = Date.now();
  const base = newNote({ id: newId(now), title: typeof w.meta.title === 'string' ? w.meta.title : 'Shared note', pageId: pages[0]?.id ?? newId(now), now });
  const meta: NoteMeta = { ...base, ...(w.meta.kind ? { kind: w.meta.kind } : {}), ...(w.meta.paper ? { paper: w.meta.paper } : {}), ...(w.meta.pageSize ? { pageSize: w.meta.pageSize } : {}), pageIds: pages.map((p) => p.id) };
  await app.vault.vault.saveNote(meta, pages.length ? pages : [newPage(meta.pageIds[0]!)]);
  app.vault.indexNote(meta, pages);
  await app.refresh();
  const rt: Runtime = { noteId: meta.id, role: 'guest', me: await me(), links: [], replica: null, snapshot: w.snapshot, backlog: [] };
  const link: Link = { link: c.link, author: host, permission: 'write' };
  rt.links.push(link);
  runtimes.set(meta.id, rt);
  useLive.setState((s) => ({ sessions: { ...s.sessions, [meta.id]: { noteId: meta.id, role: 'guest', permission: w.permission, title: meta.title, peers: { [host.id]: { author: host, hue: hueOf(host.id), permission: 'write', cursor: null, ink: {} } }, ended: null } } }));
  attach(rt, link);
  return meta.id;
}

// ---- The open editor --------------------------------------------------------------------------------

/**
 * Connects the editor's document to the live session for its note, if there is one. Returns a
 * function that detaches it (the editor closed the note).
 */
export function attachEditor(doc: NoteDocument): (() => void) | null {
  const rt = runtimes.get(doc.meta.id);
  if (!rt) return null;
  if (!rt.replica) {
    const snapshot = rt.snapshot;
    if (!snapshot) return null;
    const permission = useLive.getState().sessions[rt.noteId]?.permission ?? 'view';
    const replicaId = rt.role === 'host' ? `h${rt.me.id}` : rt.me.id;
    rt.replica = CollabReplica.join(doc, replicaId, snapshot, { send: (ops) => broadcast(rt, 'collab.ops', { ops }), readOnly: permission !== 'write' });
    for (const b of rt.backlog.splice(0)) rt.replica.receive(b.ops, b.from);
  }
  const replica = rt.replica;
  return () => {
    // The editor let go of this document: keep the shared state, queue what arrives meanwhile,
    // and bind again when the note is opened (the session goes on until stopped).
    if (rt.replica !== replica) return;
    rt.snapshot = replica.state.snapshot();
    replica.stop();
    rt.replica = null;
  };
}

/** This person's own pointer and strokes in progress, for the others to see. */
export function sendPresence(noteId: string, at: { page: string; x: number; y: number } | null): void {
  const rt = runtimes.get(noteId);
  if (rt) broadcast(rt, 'collab.presence', at ? { ...at } : { page: null });
}

export function sendInk(noteId: string, m: { sid: string; page?: string; pen?: PenType; color?: string; size?: number; pts?: number[]; done?: boolean }): void {
  const rt = runtimes.get(noteId);
  if (!rt) return;
  const permission = useLive.getState().sessions[noteId]?.permission;
  if (permission !== 'write') return;
  broadcast(rt, 'collab.ink', m);
}

/** Stops sharing (host: everyone is disconnected) or leaves (guest). */
export function stopLive(noteId: string): void {
  const rt = runtimes.get(noteId);
  if (!rt) return;
  runtimes.delete(noteId);
  rt.replica?.stop();
  for (const l of rt.links) l.link.close(rt.role === 'host' ? 'Sharing stopped.' : 'Left the session.');
  useLive.setState((s) => {
    const next = { ...s.sessions };
    delete next[noteId];
    return { sessions: next };
  });
}

function end(noteId: string, why: string): void {
  const rt = runtimes.get(noteId);
  if (!rt) return;
  runtimes.delete(noteId);
  rt.replica?.stop();
  view(noteId, { ended: why, peers: {} });
}

export const isLive = (noteId: string) => runtimes.has(noteId);
