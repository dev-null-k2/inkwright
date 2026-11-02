/**
 * Conflict-free live collaboration on a note (docs/COLLABORATION.md, "Why not Yjs").
 *
 * Strokes, text boxes and page objects already have unique ids and are replaced rather than
 * mutated in place, so a page is modelled as a **map of last-writer-wins registers**, one per
 * item id, ordered by a **fractional index**:
 *
 * - Every change to an item is an op `{ page, kind, id, pos, ver, item }`; `item: null` deletes
 *   it. `ver` is a Lamport stamp `(counter, replica)`: the op with the greatest stamp wins, on
 *   every device, whatever order ops arrive in. Undo that brings an erased stroke back is just a
 *   newer op with the same id.
 * - `pos` is a fractional-index key (`keyBetween`) chosen between the item's neighbours when it
 *   is first added; registers merge positions by taking the smallest key, so the order is the
 *   same everywhere too. Ties (two devices inserting at the same spot at once) break by id.
 * - Pages are registers of their own (added or deleted), ordered the same way.
 *
 * Merging registers is commutative, associative and idempotent, so any two replicas that have
 * seen the same set of ops show identical pages — no transformation, no central server, no
 * history to keep beyond the current registers. That is all a whiteboard of immutable-ish items
 * needs; a general-purpose CRDT library (Yjs, Automerge, Loro) would add a dependency and a
 * second document model alongside the vault's.
 *
 * `CollabReplica` connects this state to a `NoteDocument`: local edits become ops, and remote
 * ops become ordinary commits — with the collaborator as `author`, so authorship keeps telling
 * whose handwriting is whose (docs/AUTHORSHIP.md).
 */
import { decodeStroke, encodeStroke } from './codec.ts';
import { isEmptyDiff, type ListDiff, type NoteDocument, type PageDiff } from './document.ts';
import type { InkStroke, ItemAuthor, PageInk, TextBox } from './model.ts';
import type { PageObject } from './objects.ts';

// ---- Fractional indexing --------------------------------------------------------------------------

/**
 * Base-62 fractional indexing (after David Greenspan's "Implementing Fractional Indexing"): keys
 * are strings that sort with plain `<`, there is always a key between two others, and appending
 * at the end keeps keys short (an integer part that grows by one character per ~60 appends at
 * the same length, then a longer integer).
 */
const DIGITS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const SMALLEST_INT = `A${'0'.repeat(26)}`;

function intLength(head: string): number {
  if (head >= 'a' && head <= 'z') return head.charCodeAt(0) - 97 + 2;
  if (head >= 'A' && head <= 'Z') return 90 - head.charCodeAt(0) + 2;
  throw new Error(`Invalid order key head: ${head}`);
}

function intPart(key: string): string {
  const n = intLength(key[0]!);
  if (n > key.length) throw new Error(`Invalid order key: ${key}`);
  return key.slice(0, n);
}

function validateKey(key: string): void {
  if (key === SMALLEST_INT) throw new Error(`Invalid order key: ${key}`);
  const i = intPart(key);
  if (key.slice(i.length).endsWith('0')) throw new Error(`Invalid order key: ${key}`);
}

function midpoint(a: string, b: string | null): string {
  if (b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a.endsWith('0') || (b && b.endsWith('0'))) throw new Error('Trailing zero');
  if (b) {
    let n = 0;
    while ((a[n] ?? '0') === b[n]) n++;
    if (n > 0) return b.slice(0, n) + midpoint(a.slice(n), b.slice(n));
  }
  const da = a ? DIGITS.indexOf(a[0]!) : 0;
  const db = b !== null ? DIGITS.indexOf(b[0]!) : DIGITS.length;
  if (db - da > 1) return DIGITS[Math.round(0.5 * (da + db))]!;
  if (b && b.length > 1) return b.slice(0, 1);
  return DIGITS[da]! + midpoint(a.slice(1), null);
}

function incrementInt(x: string): string | null {
  const head = x[0]!;
  const digs = x.slice(1).split('');
  let carry = true;
  for (let i = digs.length - 1; carry && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) + 1;
    if (d === DIGITS.length) digs[i] = '0';
    else {
      digs[i] = DIGITS[d]!;
      carry = false;
    }
  }
  if (!carry) return head + digs.join('');
  if (head === 'Z') return 'a0';
  if (head === 'z') return null;
  const h = String.fromCharCode(head.charCodeAt(0) + 1);
  if (h > 'a') digs.push('0');
  else digs.pop();
  return h + digs.join('');
}

function decrementInt(x: string): string | null {
  const head = x[0]!;
  const digs = x.slice(1).split('');
  let borrow = true;
  for (let i = digs.length - 1; borrow && i >= 0; i--) {
    const d = DIGITS.indexOf(digs[i]!) - 1;
    if (d === -1) digs[i] = DIGITS[DIGITS.length - 1]!;
    else {
      digs[i] = DIGITS[d]!;
      borrow = false;
    }
  }
  if (!borrow) return head + digs.join('');
  if (head === 'a') return `Z${DIGITS[DIGITS.length - 1]}`;
  if (head === 'A') return null;
  const h = String.fromCharCode(head.charCodeAt(0) - 1);
  if (h < 'Z') digs.push(DIGITS[DIGITS.length - 1]!);
  else digs.pop();
  return h + digs.join('');
}

/** A key strictly between `a` and `b` (null: open end). Throws when `a >= b`. */
export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null) validateKey(a);
  if (b !== null) validateKey(b);
  if (a !== null && b !== null && a >= b) throw new Error(`${a} >= ${b}`);
  if (a === null) {
    if (b === null) return 'a0';
    const ib = intPart(b);
    const fb = b.slice(ib.length);
    if (ib === SMALLEST_INT) return ib + midpoint('', fb);
    if (ib < b) return ib;
    const r = decrementInt(ib);
    if (r === null) throw new Error('Cannot decrement any more');
    return r;
  }
  if (b === null) {
    const ia = intPart(a);
    const fa = a.slice(ia.length);
    const i = incrementInt(ia);
    return i === null ? ia + midpoint(fa, null) : i;
  }
  const ia = intPart(a);
  const fa = a.slice(ia.length);
  const ib = intPart(b);
  const fb = b.slice(ib.length);
  if (ia === ib) return ia + midpoint(fa, fb);
  const i = incrementInt(ia);
  if (i === null) throw new Error('Cannot increment any more');
  if (i < b) return i;
  return ia + midpoint(fa, null);
}

// ---- Registers ------------------------------------------------------------------------------------

/** Lamport stamp: the counter, then the replica id to break ties. */
export interface Stamp {
  c: number;
  r: string;
}

export const compareStamps = (a: Stamp, b: Stamp): number => a.c - b.c || (a.r < b.r ? -1 : a.r > b.r ? 1 : 0);

/** What a page holds that is shared live: strokes, text boxes and page objects. */
export type CollabKind = 's' | 't' | 'o';

/** Strokes travel in the compact vault encoding; text boxes and objects as they are. */
export type WireItem = Record<string, unknown> & { id: string };

export interface ItemOp {
  type: 'item';
  page: string;
  k: CollabKind;
  id: string;
  pos: string;
  ver: Stamp;
  /** The item as it is now (without `author`), or null when it was removed. */
  item: WireItem | null;
}

export interface PageOp {
  type: 'page';
  page: string;
  pos: string;
  ver: Stamp;
  alive: boolean;
}

export type CollabOp = ItemOp | PageOp;

interface Register {
  pos: string;
  ver: Stamp;
  item: WireItem | null;
}

interface PageRegister {
  pos: string;
  ver: Stamp;
  alive: boolean;
  items: Map<string, Register>;
}

export interface CollabSnapshot {
  v: 1;
  clock: number;
  pages: { id: string; pos: string; ver: Stamp; alive: boolean; items: { k: CollabKind; id: string; pos: string; ver: Stamp; item: WireItem | null }[] }[];
}

const keyOf = (k: CollabKind, id: string) => `${k}:${id}`;
const minPos = (a: string, b: string) => (a <= b ? a : b);
const ZERO: Stamp = { c: 0, r: '' };
/** Sorts after every real key, so any real page position replaces it when merged. */
const IMPLICIT_PAGE_POS = '\uffff';

/** The shared state of one note: page and item registers, and the Lamport clock. */
export class CollabState {
  clock = 0;
  readonly pages = new Map<string, PageRegister>();

  constructor(readonly replica: string) {}

  /** A fresh stamp for a local change. */
  tick(): Stamp {
    return { c: ++this.clock, r: this.replica };
  }

  private page(id: string, pos: string, ver: Stamp = ZERO): PageRegister {
    let p = this.pages.get(id);
    if (!p) this.pages.set(id, (p = { pos, ver, alive: true, items: new Map() }));
    return p;
  }

  /** Merges one op; returns true when the visible state changed. Idempotent and order-independent. */
  apply(op: CollabOp): boolean {
    this.clock = Math.max(this.clock, op.ver.c);
    if (op.type === 'page') {
      const existing = this.pages.get(op.page);
      if (!existing) {
        this.pages.set(op.page, { pos: op.pos, ver: op.ver, alive: op.alive, items: new Map() });
        return true;
      }
      const before = `${existing.pos}|${existing.alive}`;
      existing.pos = minPos(existing.pos, op.pos);
      if (compareStamps(op.ver, existing.ver) > 0) {
        existing.ver = op.ver;
        existing.alive = op.alive;
      }
      return before !== `${existing.pos}|${existing.alive}`;
    }
    // An item can arrive before the op that created its page: the page exists implicitly, last,
    // until its own op (whose position wins the merge) arrives.
    const p = this.page(op.page, IMPLICIT_PAGE_POS);
    const key = keyOf(op.k, op.id);
    const r = p.items.get(key);
    if (!r) {
      p.items.set(key, { pos: op.pos, ver: op.ver, item: op.item });
      return true;
    }
    let changed = false;
    if (op.pos < r.pos) {
      r.pos = op.pos;
      changed = true;
    }
    if (compareStamps(op.ver, r.ver) > 0) {
      r.ver = op.ver;
      r.item = op.item;
      changed = true;
    }
    return changed;
  }

  /** Live pages in order. */
  pageOrder(): string[] {
    return [...this.pages].filter(([, p]) => p.alive).sort(([ia, a], [ib, b]) => (a.pos < b.pos ? -1 : a.pos > b.pos ? 1 : ia < ib ? -1 : 1)).map(([id]) => id);
  }

  /** Present items of one kind on a page, in order, with their registers. */
  items(pageId: string, k: CollabKind): { id: string; reg: Register }[] {
    const p = this.pages.get(pageId);
    if (!p) return [];
    const out: { id: string; reg: Register }[] = [];
    for (const [key, reg] of p.items) if (reg.item && key.startsWith(`${k}:`)) out.push({ id: key.slice(2), reg });
    return out.sort((a, b) => (a.reg.pos < b.reg.pos ? -1 : a.reg.pos > b.reg.pos ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  register(pageId: string, k: CollabKind, id: string): Register | undefined {
    return this.pages.get(pageId)?.items.get(keyOf(k, id));
  }

  snapshot(): CollabSnapshot {
    return {
      v: 1,
      clock: this.clock,
      pages: [...this.pages].map(([id, p]) => ({
        id,
        pos: p.pos,
        ver: p.ver,
        alive: p.alive,
        items: [...p.items].map(([key, r]) => ({ k: key[0] as CollabKind, id: key.slice(2), pos: r.pos, ver: r.ver, item: r.item })),
      })),
    };
  }

  /** Every register as ops (what a newcomer needs to catch up). */
  toOps(): CollabOp[] {
    const ops: CollabOp[] = [];
    for (const [page, p] of this.pages) {
      ops.push({ type: 'page', page, pos: p.pos, ver: p.ver, alive: p.alive });
      for (const [key, r] of p.items) ops.push({ type: 'item', page, k: key[0] as CollabKind, id: key.slice(2), pos: r.pos, ver: r.ver, item: r.item });
    }
    return ops;
  }

  static fromSnapshot(replica: string, s: CollabSnapshot): CollabState {
    const st = new CollabState(replica);
    st.clock = s.clock;
    for (const p of s.pages) {
      st.pages.set(p.id, { pos: p.pos, ver: p.ver, alive: p.alive, items: new Map(p.items.map((i) => [keyOf(i.k, i.id), { pos: i.pos, ver: i.ver, item: i.item }])) });
    }
    return st;
  }
}

// ---- Items on the wire ----------------------------------------------------------------------------

type DocItem = InkStroke | TextBox | PageObject;

/** The wire form of an item: authorship stays with each device (the receiver stamps it). */
export function toWire(k: CollabKind, item: DocItem): WireItem {
  if (k === 's') {
    const { author: _a, ...s } = item as InkStroke;
    return encodeStroke(s as InkStroke) as WireItem;
  }
  if (k === 't') {
    const { author: _a, ...t } = item as TextBox;
    return { ...t } as WireItem;
  }
  return { ...(item as PageObject) } as unknown as WireItem;
}

export function fromWire(k: CollabKind, w: WireItem): DocItem {
  if (k === 's') return decodeStroke(w);
  return { ...w } as unknown as DocItem;
}

const LISTS: { k: CollabKind; get: (p: PageInk) => readonly DocItem[] | undefined; field: 'strokes' | 'texts' | 'objects' }[] = [
  { k: 's', get: (p) => p.strokes, field: 'strokes' },
  { k: 't', get: (p) => p.texts, field: 'texts' },
  { k: 'o', get: (p) => p.objects, field: 'objects' },
];

// ---- The bridge to a NoteDocument -------------------------------------------------------------------

export interface CollabReplicaOptions {
  /** Called with the ops of each local change (to send to the others). */
  send: (ops: CollabOp[]) => void;
  /**
   * Local edits are not shared and are rolled back to the shared state (a view-only guest): the
   * person can look, scroll and zoom, but the page stays what the others wrote.
   */
  readOnly?: boolean;
}

/**
 * Keeps a NoteDocument and the shared state in step. Create it with `seed` (the host: the
 * document as it is becomes the shared state) or `join` (a guest: the document was made from
 * the host's snapshot), then feed it remote ops with `receive`.
 */
export class CollabReplica {
  readonly state: CollabState;
  /** Per page and item key: the document object last reconciled and the stamp it shows. */
  private known = new Map<string, Map<string, { item: DocItem; ver: Stamp }>>();
  private knownPages: string[] = [];
  private applying = false;
  private unsub: (() => void) | null = null;

  private constructor(private readonly doc: NoteDocument, state: CollabState, private readonly opts: CollabReplicaOptions) {
    this.state = state;
  }

  /** The host: the note as it is becomes the shared state everyone starts from. */
  static seed(doc: NoteDocument, replica: string, opts: CollabReplicaOptions): CollabReplica {
    const st = new CollabState(replica);
    let pagePos: string | null = null;
    for (const page of doc.committedPages) {
      pagePos = keyBetween(pagePos, null);
      st.apply({ type: 'page', page: page.id, pos: pagePos, ver: ZERO, alive: true });
      for (const { k, get } of LISTS) {
        let pos: string | null = null;
        for (const it of get(page) ?? []) {
          pos = keyBetween(pos, null);
          st.apply({ type: 'item', page: page.id, k, id: it.id, pos, ver: ZERO, item: toWire(k, it) });
        }
      }
    }
    const r = new CollabReplica(doc, st, opts);
    r.rememberAll();
    r.listen();
    return r;
  }

  /** A guest: `doc` holds the pages made from `snapshot` (see `pagesFromSnapshot`). */
  static join(doc: NoteDocument, replica: string, snapshot: CollabSnapshot, opts: CollabReplicaOptions): CollabReplica {
    const r = new CollabReplica(doc, CollabState.fromSnapshot(replica, snapshot), opts);
    r.rememberAll();
    r.listen();
    return r;
  }

  stop(): void {
    this.unsub?.();
    this.unsub = null;
  }

  private listen(): void {
    this.unsub = this.doc.subscribe(() => {
      if (!this.applying) this.onLocalChange();
    });
  }

  private rememberAll(): void {
    this.known.clear();
    for (const page of this.doc.committedPages) this.rememberPage(page);
    this.knownPages = this.doc.committedPages.map((p) => p.id);
  }

  private rememberPage(page: PageInk): void {
    const m = new Map<string, { item: DocItem; ver: Stamp }>();
    for (const { k, get } of LISTS) for (const it of get(page) ?? []) m.set(keyOf(k, it.id), { item: it, ver: this.state.register(page.id, k, it.id)?.ver ?? ZERO });
    this.known.set(page.id, m);
  }

  /** Turns what changed locally since the last reconciliation into ops. */
  private onLocalChange(): void {
    if (this.opts.readOnly) {
      this.reconcileAll();
      return;
    }
    const ops: CollabOp[] = [];
    const pages = this.doc.committedPages;
    // Pages added or removed here.
    const ids = pages.map((p) => p.id);
    if (ids.join() !== this.knownPages.join()) {
      const order = this.state.pageOrder();
      for (let i = 0; i < ids.length; i++) {
        if (this.state.pages.get(ids[i]!)?.alive) continue;
        const prev = i > 0 ? this.state.pages.get(ids[i - 1]!)?.pos ?? null : null;
        const nextId = ids.slice(i + 1).find((x) => this.state.pages.get(x)?.alive);
        const next = nextId ? this.state.pages.get(nextId)!.pos : null;
        const op: PageOp = { type: 'page', page: ids[i]!, pos: safeBetween(prev, next), ver: this.state.tick(), alive: true };
        this.state.apply(op);
        ops.push(op);
      }
      for (const id of order) {
        if (ids.includes(id)) continue;
        const op: PageOp = { type: 'page', page: id, pos: this.state.pages.get(id)!.pos, ver: this.state.tick(), alive: false };
        this.state.apply(op);
        ops.push(op);
        this.known.delete(id);
      }
      this.knownPages = ids;
    }
    for (const page of pages) {
      const known = this.known.get(page.id) ?? new Map();
      for (const { k, get } of LISTS) {
        const list = get(page) ?? [];
        const here = new Set<string>();
        list.forEach((it, i) => {
          const key = keyOf(k, it.id);
          here.add(key);
          const kn = known.get(key);
          if (kn && kn.item === it) return;
          const reg = this.state.register(page.id, k, it.id);
          let pos = reg?.pos;
          if (!pos) {
            const before = list.slice(0, i).reverse().find((x) => this.state.register(page.id, k, x.id)?.item);
            const after = list.slice(i + 1).find((x) => this.state.register(page.id, k, x.id)?.item);
            pos = safeBetween(before ? this.state.register(page.id, k, before.id)!.pos : null, after ? this.state.register(page.id, k, after.id)!.pos : null);
          }
          const op: ItemOp = { type: 'item', page: page.id, k, id: it.id, pos, ver: this.state.tick(), item: toWire(k, it) };
          this.state.apply(op);
          ops.push(op);
          known.set(key, { item: it, ver: op.ver });
        });
        for (const key of [...known.keys()]) {
          if (!key.startsWith(`${k}:`) || here.has(key)) continue;
          const id = key.slice(2);
          const reg = this.state.register(page.id, k, id);
          const op: ItemOp = { type: 'item', page: page.id, k, id, pos: reg?.pos ?? keyBetween(null, null), ver: this.state.tick(), item: null };
          this.state.apply(op);
          ops.push(op);
          known.delete(key);
        }
      }
      this.known.set(page.id, known);
    }
    if (ops.length) this.opts.send(ops);
    // If a local edit reordered items, line the document up with the shared order.
    this.reconcileAll();
  }

  /**
   * Merges ops from a collaborator and shows the result: each changed page gets one commit with
   * `author` (stamped, recorded in the authorship chain, not on this person's undo stack).
   */
  receive(ops: readonly CollabOp[], author: ItemAuthor): void {
    let any = false;
    for (const op of ops) if (this.state.apply(op)) any = true;
    if (any) this.reconcileAll(author);
  }

  /** Makes the document show the shared state, page by page. */
  private reconcileAll(author?: ItemAuthor): void {
    this.applying = true;
    try {
      // Pages first: add the ones that appeared, remove the ones deleted elsewhere.
      const order = this.state.pageOrder();
      order.forEach((id, i) => {
        if (this.doc.indexOfPage(id) < 0) this.doc.addPage(Math.min(i, this.doc.pageCount), { id, strokes: [] });
      });
      for (let i = this.doc.pageCount - 1; i >= 0; i--) {
        const id = this.doc.committedPages[i]!.id;
        const reg = this.state.pages.get(id);
        if (reg && !reg.alive) this.doc.deletePage(i);
      }
      // Then the shared page order.
      order.forEach((id, i) => {
        const from = this.doc.indexOfPage(id);
        if (from >= 0 && from !== i && i < this.doc.pageCount) this.doc.movePage(from, i);
      });
      for (let i = 0; i < this.doc.pageCount; i++) {
        // Content first (a collaborator's commit, stamped with them), then order alone: moving
        // items that didn't change is not an edit and must never re-attribute them.
        const content = this.diffToShared(this.doc.committedPages[i]!, 'content');
        if (!isEmptyDiff(content)) {
          if (author) this.doc.commit(i, content, 'other', { author });
          else this.doc.adjust(i, content);
          this.rememberPage(this.doc.committedPages[i]!);
        }
        const reorder = this.diffToShared(this.doc.committedPages[i]!, 'order');
        if (!isEmptyDiff(reorder)) this.doc.adjust(i, reorder);
        this.rememberPage(this.doc.committedPages[i]!);
      }
      this.knownPages = this.doc.committedPages.map((p) => p.id);
    } finally {
      this.applying = false;
    }
  }

  /**
   * The diff from a document page to what the shared state says it holds: `content` adds,
   * removes and replaces items (indices from the shared order); `order` then only moves the
   * page's own, unchanged objects into the shared order.
   */
  private diffToShared(page: PageInk, mode: 'content' | 'order'): PageDiff {
    const d: PageDiff = { label: 'Collaborator' };
    const known = this.known.get(page.id);
    for (const { k, get, field } of LISTS) {
      const cur = (get(page) ?? []) as DocItem[];
      const curById = new Map(cur.map((x) => [x.id, x]));
      const target: DocItem[] = this.state.items(page.id, k).map(({ id, reg }) => {
        const kn = known?.get(keyOf(k, id));
        const here = curById.get(id);
        // Reuse the object already on the page when it shows this register's version.
        if (here && kn && kn.item === here && compareStamps(kn.ver, reg.ver) === 0) return here;
        return fromWire(k, reg.item!);
      });
      if (target.length === cur.length && target.every((x, i) => x === cur[i])) continue;
      let diff: ListDiff<DocItem>;
      if (mode === 'content') {
        const tgtById = new Map(target.map((x) => [x.id, x]));
        const removed = cur.map((item, index) => ({ index, item })).filter(({ item }) => tgtById.get(item.id) !== item);
        const replaced = new Set(removed.map((r) => r.item.id));
        const added = target.map((item, index) => ({ index, item })).filter(({ item }) => !curById.has(item.id) || replaced.has(item.id));
        if (!removed.length && !added.length) continue;
        diff = { removed, added };
      } else {
        if (target.length !== cur.length || target.some((x) => curById.get(x.id) !== x)) continue;
        diff = { removed: cur.map((item, index) => ({ index, item })), added: target.map((item, index) => ({ index, item })) };
      }
      (d as unknown as Record<string, unknown>)[field] = diff;
    }
    return d;
  }
}

/** A key between two neighbours that tolerates neighbours out of order (ties from concurrent inserts). */
function safeBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) return keyBetween(a, null);
  return keyBetween(a, b);
}

/** A guest's pages, as the host's snapshot describes them (items in shared order, no authors yet). */
export function pagesFromSnapshot(s: CollabSnapshot, base: (id: string) => PageInk): PageInk[] {
  const st = CollabState.fromSnapshot('_', s);
  return st.pageOrder().map((id) => {
    const p = { ...base(id) };
    for (const { k, field } of LISTS) {
      const items = st.items(id, k).map(({ reg }) => fromWire(k, reg.item!));
      if (field === 'strokes') p.strokes = items as InkStroke[];
      else if (items.length) (p as unknown as Record<string, unknown>)[field] = items;
    }
    return p;
  });
}
