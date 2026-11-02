import { describe, expect, it } from 'vitest';
import {
  CollabReplica,
  CollabState,
  NoteDocument,
  classifyPage,
  encodeStroke,
  keyBetween,
  newNote,
  newPage,
  pagesFromSnapshot,
  type CollabOp,
  type ItemAuthor,
  type PageInk,
  type TextBox,
} from '../src/index.ts';
import { stroke, word } from './helpers.ts';

describe('keyBetween (fractional indexing)', () => {
  it('always finds a key strictly between two others', () => {
    let rnd = 7;
    const random = () => ((rnd = (rnd * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const keys: string[] = [keyBetween(null, null)];
    for (let i = 0; i < 2000; i++) {
      const at = Math.floor(random() * (keys.length + 1));
      const k = keyBetween(at > 0 ? keys[at - 1]! : null, at < keys.length ? keys[at]! : null);
      keys.splice(at, 0, k);
    }
    for (let i = 1; i < keys.length; i++) expect(keys[i - 1]! < keys[i]!).toBe(true);
  });

  it('keeps keys short when appending or prepending', () => {
    let k: string | null = null;
    for (let i = 0; i < 5000; i++) k = keyBetween(k, null);
    expect(k!.length).toBeLessThanOrEqual(4);
    let f: string | null = null;
    for (let i = 0; i < 500; i++) f = keyBetween(null, f);
    expect(f!.length).toBeLessThanOrEqual(4);
    expect(() => keyBetween('a1', 'a0')).toThrow();
  });
});

// ---- Replicas ---------------------------------------------------------------------------------------

let ids = 0;
const nid = (p: string) => `${p}${(ids++).toString(36).padStart(4, '0')}`;

function hostDoc(): NoteDocument {
  const page = newPage('p1');
  page.strokes.push({ ...stroke('base1', word(10, 20, 40)), input: 'pen' });
  const meta = { ...newNote({ id: 'n1', title: 'Shared', pageId: 'p1', now: 0 }), pageIds: ['p1'] };
  return new NoteDocument(meta, [page], () => 1000, () => nid('g'));
}

/** A tiny network: every replica's ops are queued per receiver and delivered when we say so. */
class Net {
  readonly queues = new Map<string, { from: ItemAuthor; ops: CollabOp[] }[]>();
  replicas = new Map<string, CollabReplica>();
  send(from: ItemAuthor, ops: CollabOp[]) {
    for (const id of this.replicas.keys()) if (id !== from.id) this.queues.get(id)!.push({ from, ops: structuredClone(ops) });
  }
  /** Delivers everything, shuffled (and with duplicates), as an unreliable mesh would. */
  flush(random: () => number) {
    for (const [id, q] of this.queues) {
      const batch = q.splice(0);
      const dup = batch.filter(() => random() < 0.2);
      const all = [...batch, ...dup].sort(() => random() - 0.5);
      for (const m of all) this.replicas.get(id)!.receive(m.ops, m.from);
    }
  }
}

function setup(readOnlyGuest = false) {
  const net = new Net();
  const host = hostDoc();
  const hostAuthor = { id: 'HOST', name: 'Ada' };
  const guestAuthor = { id: 'GUEST', name: 'Grace' };
  net.queues.set('HOST', []);
  net.queues.set('GUEST', []);
  const h = CollabReplica.seed(host, 'HOST', { send: (ops) => net.send(hostAuthor, ops) });
  const snap = structuredClone(h.state.snapshot());
  const pages = pagesFromSnapshot(snap, (id) => newPage(id));
  const guest = new NoteDocument({ ...host.meta }, pages, () => 2000, () => nid('h'));
  const g = CollabReplica.join(guest, 'GUEST', snap, { send: (ops) => net.send(guestAuthor, ops), readOnly: readOnlyGuest });
  net.replicas.set('HOST', h);
  net.replicas.set('GUEST', g);
  return { net, host, guest, h, g, hostAuthor, guestAuthor };
}

/** The shared content of a page: ids, geometry and order, without who wrote what. */
function shared(p: PageInk) {
  return {
    strokes: p.strokes.map((s) => {
      const { author: _a, ...rest } = s;
      return JSON.stringify(encodeStroke(rest));
    }),
    texts: (p.texts ?? []).map((t) => {
      const { author: _a, ...rest } = t;
      return JSON.stringify(rest);
    }),
  };
}

describe('CollabReplica', () => {
  it('shows a collaborator’s stroke, stamped as theirs and never on this person’s undo stack', () => {
    const { net, host, guest } = setup();
    const s = { ...stroke('g1', word(100, 50, 40)), input: 'pen' as const };
    guest.addStroke(0, s);
    net.flush(Math.random);
    const got = host.page(0).strokes.find((x) => x.id === 'g1')!;
    expect(got.author).toEqual({ id: 'GUEST', name: 'Grace' });
    expect(guest.page(0).strokes.find((x) => x.id === 'g1')!.author).toBeUndefined();
    // Authorship: the host's handwriting count is unchanged; the guest's stroke is a collaborator's.
    const counts = classifyPage(host.page(0)).counts;
    expect(counts.collaborator).toBe(1);
    const events = host.page(0).authorship!.events;
    expect(events.at(-1)).toMatchObject({ op: '+', id: 'g1', by: 'GUEST' });
    // Undo on the host has nothing of its own to undo.
    expect(host.canUndo).toBe(false);
  });

  it('never counts a collaborator’s stroke as handwriting, even when it claims no author', () => {
    const { host, h } = setup();
    const forged = { ...encodeStroke({ ...stroke('f1', word(10, 90, 40)), input: 'pen' }) };
    h.receive([{ type: 'item', page: 'p1', k: 's', id: 'f1', pos: keyBetween('a0', null), ver: { c: 50, r: 'GUEST' }, item: forged as never }], { id: 'GUEST', name: 'Grace' });
    const c = classifyPage(host.page(0)).counts;
    expect(c.handwritten).toBe(0);
    expect(c.collaborator).toBe(1);
  });

  it('converges under concurrent drawing, erasing, undo, text and page adds in any delivery order', () => {
    for (let seed = 1; seed <= 40; seed++) {
      let r = seed * 7919;
      const random = () => ((r = (r * 48271) % 2147483647) / 2147483647);
      const { net, host, guest } = setup();
      const docs = [host, guest];
      for (let round = 0; round < 6; round++) {
        for (const d of docs) {
          const n = 1 + Math.floor(random() * 3);
          for (let i = 0; i < n; i++) {
            const pageIndex = Math.floor(random() * d.pageCount);
            const page = d.page(pageIndex);
            const roll = random();
            if (roll < 0.5 || page.strokes.length === 0) d.addStroke(pageIndex, { ...stroke(nid('s'), word(random() * 300, random() * 300, 30)), input: 'pen' });
            else if (roll < 0.65) d.deleteItems(pageIndex, { strokes: new Set([page.strokes[Math.floor(random() * page.strokes.length)]!.id]) });
            else if (roll < 0.75 && d.canUndo) d.undo();
            else if (roll < 0.85) {
              const t: TextBox = { id: nid('t'), x: random() * 200, y: random() * 200, width: 120, text: `note ${round}`, fontSize: 16, color: '#FF000000', font: 'sans', createdAt: 0 };
              d.upsertText(pageIndex, t);
            } else if (roll < 0.9 && d.pageCount < 3) d.addPage(d.pageCount);
            else {
              const s = page.strokes[Math.floor(random() * page.strokes.length)]!;
              d.commit(pageIndex, { label: 'Recolor', strokes: { removed: [{ index: page.strokes.indexOf(s), item: s }], added: [{ index: page.strokes.indexOf(s), item: { ...s, color: '#FFAA0000' } }] } });
            }
          }
        }
        if (random() < 0.6) net.flush(random);
      }
      net.flush(random);
      net.flush(random);
      expect(host.committedPages.map((p) => p.id)).toEqual(guest.committedPages.map((p) => p.id));
      host.committedPages.forEach((p, i) => expect(shared(p)).toEqual(shared(guest.committedPages[i]!)));
    }
  });

  it('a view-only guest sees edits but its own changes are rolled back and never sent', () => {
    const { net, host, guest } = setup(true);
    guest.addStroke(0, { ...stroke('mine', word(10, 200, 40)), input: 'pen' });
    expect(guest.page(0).strokes.some((s) => s.id === 'mine')).toBe(false);
    expect(net.queues.get('HOST')).toEqual([]);
    host.addStroke(0, { ...stroke('h1', word(10, 120, 40)), input: 'pen' });
    net.flush(Math.random);
    expect(guest.page(0).strokes.map((s) => s.id)).toEqual(host.page(0).strokes.map((s) => s.id));
  });

  it('state snapshots round-trip and merging is idempotent', () => {
    const { h } = setup();
    const snap = h.state.snapshot();
    const copy = CollabState.fromSnapshot('X', structuredClone(snap));
    for (const op of h.state.toOps()) expect(copy.apply(op)).toBe(false);
    expect(copy.snapshot()).toEqual(snap);
  });
});
