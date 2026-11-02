import {
  decodeNote,
  decodeNotebook,
  decodePage,
  decodePageSummaries,
  decodeTranscript,
  encodeNote,
  encodePageSummaries,
  encodeTranscript,
  encodeNotebook,
  encodePage,
  type NoteMeta,
  type NotebookMeta,
  type PageInk,
} from '@inkstone/core';
import { utf8Decode, utf8Encode } from './util.ts';
import { mergePageSummaries, mergeTranscript } from './merge-listen.ts';

/*
 * Three-way merges for the vault's JSON files. All functions are pure and work on decoded
 * objects; `base` is the version both sides last agreed on (null → two-way union merge).
 *
 * Rules (see docs/VAULT_FORMAT.md § Sync):
 * - Items with ids (strokes, texts, images, recordings) are unioned by id. An item deleted on
 *   one side and unchanged on the other is deleted. An item edited on one side and unchanged on
 *   the other takes the edit. Edited on one side and deleted on the other: the edit survives
 *   (never lose ink). Edited differently on both: the preferred side wins.
 * - Order is merged too: shared items keep their order, items inserted on each side land after
 *   the same neighbour they followed on that side, concurrent inserts interleave by time.
 * - Scalars merge field-wise against the base; when both sides changed a field the side with the
 *   newer `updatedAt` wins (pages have none: the preferred side wins, except recognizedText,
 *   which follows the newer `recognizedAt`).
 */

export type Side = 'local' | 'remote';

// ---- Equality --------------------------------------------------------------------------------

/** JSON.stringify with sorted keys (undefined members dropped), for structural comparison. */
export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return v === undefined ? 'null' : JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map((x) => (x === undefined ? 'null' : stableStringify(x))).join(',') + ']';
  const keys = Object.keys(v as object)
    .filter((k) => (v as Record<string, unknown>)[k] !== undefined)
    .sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify((v as Record<string, unknown>)[k])).join(',') + '}';
}

class Eq {
  private cache = new Map<unknown, string>();
  key(v: unknown): string {
    if (v === null || typeof v !== 'object') return stableStringify(v);
    let s = this.cache.get(v);
    if (s === undefined) {
      s = stableStringify(v);
      this.cache.set(v, s);
    }
    return s;
  }
  eq(a: unknown, b: unknown): boolean {
    return a === b || this.key(a) === this.key(b);
  }
}

// ---- Scalars ---------------------------------------------------------------------------------

const ABSENT = Symbol('absent');
type Maybe<T> = T | typeof ABSENT;

/** Three-way pick: one-sided change wins; both changed → `conflict()`. `base === ABSENT` → two-way. */
function pick<T>(eq: Eq, base: Maybe<T>, a: T, b: T, conflict: () => T): T {
  if (eq.eq(a, b)) return a;
  if (base !== ABSENT) {
    if (eq.eq(a, base)) return b;
    if (eq.eq(b, base)) return a;
  }
  return conflict();
}

// ---- Ordered id sequences ----------------------------------------------------------------------

function sameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export interface OrderOptions {
  /** Orders concurrent inserts that landed in the same gap (each side's own order is kept). */
  compare?: (x: string, y: string) => number;
  /** Whose order wins when both sides reordered shared items, and whose inserts go first without `compare`. */
  prefer?: 'a' | 'b';
}

/**
 * Merges two orderings of unique ids. `keep` is the set of ids in the result (deletions are
 * decided by the caller). Shared ids form a skeleton in the order of the side that reordered
 * (if any); ids only on one side are re-inserted after the shared id they followed there.
 */
export function mergeOrder(base: readonly string[] | null, a: readonly string[], b: readonly string[], keep: ReadonlySet<string>, opts: OrderOptions = {}): string[] {
  const inA = new Set(a);
  const inB = new Set(b);
  const commonA = a.filter((id) => inB.has(id) && keep.has(id));
  const common = new Set(commonA);
  const commonB = b.filter((id) => common.has(id));
  let skeleton: readonly string[];
  if (sameOrder(commonA, commonB)) skeleton = commonA;
  else {
    const commonBase = base ? base.filter((id) => common.has(id)) : null;
    if (commonBase && sameOrder(commonA, commonBase)) skeleton = commonB;
    else if (commonBase && sameOrder(commonB, commonBase)) skeleton = commonA;
    else skeleton = opts.prefer === 'b' ? commonB : commonA;
  }
  const pos = new Map(skeleton.map((id, i) => [id, i]));
  const gaps = (seq: readonly string[], other: Set<string>) => {
    const g = new Map<number, string[]>();
    let anchor = -1;
    // Items after this side's last shared id were appended: they stay at the end even if the
    // other side moved that id.
    let lastShared = -1;
    seq.forEach((id, i) => {
      if (pos.has(id)) lastShared = i;
    });
    for (let i = 0; i < seq.length; i++) {
      const id = seq[i]!;
      const p = pos.get(id);
      if (p !== undefined) {
        anchor = p;
        continue;
      }
      if (i > lastShared && lastShared >= 0) anchor = skeleton.length - 1;
      if (!keep.has(id) || other.has(id)) continue;
      let run = g.get(anchor);
      if (!run) g.set(anchor, (run = []));
      run.push(id);
    }
    return g;
  };
  const gapsA = gaps(a, inB);
  const gapsB = gaps(b, inA);
  const out: string[] = [];
  const emit = (i: number) => {
    const ra = gapsA.get(i) ?? [];
    const rb = gapsB.get(i) ?? [];
    if (!opts.compare) {
      out.push(...(opts.prefer === 'b' ? [...rb, ...ra] : [...ra, ...rb]));
      return;
    }
    let x = 0;
    let y = 0;
    while (x < ra.length && y < rb.length) out.push(opts.compare(ra[x]!, rb[y]!) <= 0 ? ra[x++]! : rb[y++]!);
    while (x < ra.length) out.push(ra[x++]!);
    while (y < rb.length) out.push(rb[y++]!);
  };
  emit(-1);
  skeleton.forEach((id, i) => {
    out.push(id);
    emit(i);
  });
  return out;
}

// ---- Collections by id -------------------------------------------------------------------------

interface WithId {
  id: string;
}

/** Deterministic time-then-id comparator for items with `createdAt` / `startedAt`. */
function byTime<T extends WithId>(time: (x: T) => number) {
  return (x: T, y: T) => time(x) - time(y) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
}

export function mergeById<T extends WithId>(
  base: readonly T[] | null,
  a: readonly T[],
  b: readonly T[],
  opts: { prefer?: 'a' | 'b'; compare?: (x: T, y: T) => number; eq?: Eq } = {},
): T[] {
  const eq = opts.eq ?? new Eq();
  const baseMap = base ? new Map(base.map((x) => [x.id, x])) : null;
  const am = new Map(a.map((x) => [x.id, x]));
  const bm = new Map(b.map((x) => [x.id, x]));
  const result = new Map<string, T>();
  for (const id of new Set([...am.keys(), ...bm.keys()])) {
    const x = am.get(id);
    const y = bm.get(id);
    const o = baseMap?.get(id);
    if (x && y) {
      result.set(id, pick<T>(eq, o ?? ABSENT, x, y, () => (opts.prefer === 'b' ? y : x)));
    } else {
      const only = (x ?? y)!;
      // Present on one side only: added there (keep), or deleted on the other side. A deletion
      // wins only over an unchanged item; an edit made while the other side deleted survives.
      if (o && eq.eq(only, o)) continue;
      result.set(id, only);
    }
  }
  const keep = new Set(result.keys());
  const cmp = opts.compare;
  const order = mergeOrder(
    base ? base.map((x) => x.id) : null,
    a.map((x) => x.id),
    b.map((x) => x.id),
    keep,
    { prefer: opts.prefer, compare: cmp ? (i, j) => cmp(result.get(i)!, result.get(j)!) : undefined },
  );
  return order.map((id) => result.get(id)!);
}

/** Set merge: union minus anything one side removed from the base. Keeps a's order, then b's additions. */
export function mergeSet(base: readonly string[] | null, a: readonly string[], b: readonly string[]): string[] {
  const sa = new Set(a);
  const sb = new Set(b);
  const so = new Set(base ?? []);
  const keep = (t: string) => (sa.has(t) && sb.has(t)) || !so.has(t);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const t of [...a, ...b]) {
    if (seen.has(t) || !keep(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

// ---- Generic field-wise object merge ------------------------------------------------------------

function mergeFields(
  eq: Eq,
  base: Record<string, unknown> | null,
  a: Record<string, unknown>,
  b: Record<string, unknown>,
  skip: ReadonlySet<string>,
  winner: 'a' | 'b',
  out: Record<string, unknown>,
): void {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (skip.has(k)) continue;
    const bv: Maybe<unknown> = base ? base[k] : ABSENT;
    const v = pick(eq, bv, a[k], b[k], () => (winner === 'a' ? a[k] : b[k]));
    if (v !== undefined) out[k] = v;
  }
}

// ---- Pages -------------------------------------------------------------------------------------

export interface MergeOptions {
  /** Which side wins true conflicts that have no timestamp to decide them. Default 'local'. */
  prefer?: Side;
}

const PAGE_SPECIAL = new Set(['id', 'strokes', 'texts', 'images', 'recognizedText', 'recognizedAt', 'recognizedBy', 'recognizedLines', 'formatVersion']);

export function mergePage(base: PageInk | null, local: PageInk, remote: PageInk, opts: MergeOptions = {}): PageInk {
  const eq = new Eq();
  const prefer = opts.prefer === 'remote' ? 'b' : 'a';
  const out: Record<string, unknown> = { id: local.id };

  out.strokes = mergeById(base?.strokes ?? (base ? [] : null), local.strokes, remote.strokes, {
    prefer,
    eq,
    compare: byTime((s) => s.createdAt),
  });
  const coll = <T extends WithId & { createdAt: number }>(k: 'texts' | 'images', get: (p: PageInk) => T[] | undefined) => {
    const merged = mergeById(base ? (get(base) ?? []) : null, get(local) ?? [], get(remote) ?? [], { prefer, eq, compare: byTime((x) => x.createdAt) });
    if (merged.length || get(local) !== undefined || get(remote) !== undefined) out[k] = merged;
  };
  coll('texts', (p) => p.texts);
  coll('images', (p) => p.images);

  // Everything else (background, paper, size, unknown future fields): field-wise.
  mergeFields(eq, base as unknown as Record<string, unknown> | null, local as unknown as Record<string, unknown>, remote as unknown as Record<string, unknown>, PAGE_SPECIAL, prefer, out);

  // Recognition results travel together and the newer run wins.
  const la = local.recognizedAt ?? -Infinity;
  const ra = remote.recognizedAt ?? -Infinity;
  let rec: PageInk;
  if (la > ra) rec = local;
  else if (ra > la) rec = remote;
  else {
    const t = pick(eq, base ? (base.recognizedText as unknown) : ABSENT, local.recognizedText as unknown, remote.recognizedText as unknown, () => (prefer === 'a' ? local.recognizedText : remote.recognizedText));
    rec = t === local.recognizedText ? local : remote;
  }
  if (rec.recognizedText !== undefined) out.recognizedText = rec.recognizedText;
  if (rec.recognizedAt !== undefined) out.recognizedAt = rec.recognizedAt;
  if (rec.recognizedBy !== undefined) out.recognizedBy = rec.recognizedBy;
  if (rec.recognizedLines !== undefined) out.recognizedLines = rec.recognizedLines;

  out.formatVersion = Math.max(local.formatVersion ?? 1, remote.formatVersion ?? 1);
  return out as unknown as PageInk;
}

// ---- Notes -------------------------------------------------------------------------------------

const NOTE_SPECIAL = new Set(['id', 'pageIds', 'tags', 'recordings', 'trashedAt', 'createdAt', 'updatedAt', 'formatVersion', 'forms']);

export function mergeNote(base: NoteMeta | null, local: NoteMeta, remote: NoteMeta, opts: MergeOptions = {}): NoteMeta {
  const eq = new Eq();
  const newer: 'a' | 'b' = local.updatedAt > remote.updatedAt ? 'a' : remote.updatedAt > local.updatedAt ? 'b' : opts.prefer === 'remote' ? 'b' : 'a';
  const out: Record<string, unknown> = { id: local.id };

  mergeFields(eq, base as unknown as Record<string, unknown> | null, local as unknown as Record<string, unknown>, remote as unknown as Record<string, unknown>, NOTE_SPECIAL, newer, out);

  // Pages: a page removed on either side is gone (its ink file merges separately); added pages stay.
  const inBase = new Set(base?.pageIds ?? []);
  const la = new Set(local.pageIds);
  const rb = new Set(remote.pageIds);
  const keep = new Set([...local.pageIds, ...remote.pageIds].filter((id) => (la.has(id) && rb.has(id)) || !inBase.has(id)));
  // Page ids are time-sortable, so concurrent inserts at the same spot interleave by creation time.
  out.pageIds = mergeOrder(base?.pageIds ?? null, local.pageIds, remote.pageIds, keep, {
    prefer: newer,
    compare: (x, y) => (x < y ? -1 : x > y ? 1 : 0),
  });

  out.tags = mergeSet(base ? base.tags : null, local.tags ?? [], remote.tags ?? []);

  if (local.recordings !== undefined || remote.recordings !== undefined) {
    out.recordings = mergeById(base ? (base.recordings ?? []) : null, local.recordings ?? [], remote.recordings ?? [], {
      prefer: newer,
      eq,
      compare: byTime((r) => r.startedAt),
    });
  }

  // PDF form values merge per PDF and per field, so filling different fields on two devices keeps both.
  if (local.forms !== undefined || remote.forms !== undefined) {
    const forms: Record<string, unknown> = {};
    const lf = (local.forms ?? {}) as Record<string, Record<string, unknown>>;
    const rf = (remote.forms ?? {}) as Record<string, Record<string, unknown>>;
    const bf = base ? ((base.forms ?? {}) as Record<string, Record<string, unknown>>) : null;
    for (const asset of new Set([...Object.keys(lf), ...Object.keys(rf)])) {
      const values: Record<string, unknown> = {};
      mergeFields(eq, bf ? (bf[asset] ?? {}) : null, lf[asset] ?? {}, rf[asset] ?? {}, new Set(), newer, values);
      if (Object.keys(values).length) forms[asset] = values;
    }
    out.forms = forms;
  }

  // Trash: a one-sided trash/restore wins. Without a base we can't tell a restore from "never
  // trashed", so trashing wins (it is reversible; losing it would resurrect deleted notes).
  const trashed = pick(eq, base ? (base.trashedAt as unknown) : ABSENT, local.trashedAt as unknown, remote.trashedAt as unknown, () => {
    if (!base) return Math.max(local.trashedAt ?? -Infinity, remote.trashedAt ?? -Infinity);
    return newer === 'a' ? local.trashedAt : remote.trashedAt;
  }) as number | undefined;
  if (trashed !== undefined && Number.isFinite(trashed)) out.trashedAt = trashed;

  const created = [local.createdAt, remote.createdAt].filter((t) => typeof t === 'number' && t > 0);
  out.createdAt = created.length ? Math.min(...created) : (local.createdAt ?? 0);
  out.updatedAt = Math.max(local.updatedAt ?? 0, remote.updatedAt ?? 0);
  out.formatVersion = Math.max(local.formatVersion ?? 1, remote.formatVersion ?? 1);
  return out as unknown as NoteMeta;
}

// ---- Notebooks ---------------------------------------------------------------------------------

function stamp(n: NotebookMeta): number {
  const u = (n as NotebookMeta & { updatedAt?: unknown }).updatedAt;
  return typeof u === 'number' ? u : (n.createdAt ?? 0);
}

/** Newer wins: field-wise against the base when there is one, wholesale otherwise. */
export function mergeNotebook(base: NotebookMeta | null, local: NotebookMeta, remote: NotebookMeta, opts: MergeOptions = {}): NotebookMeta {
  const sl = stamp(local);
  const sr = stamp(remote);
  const newer: 'a' | 'b' = sl > sr ? 'a' : sr > sl ? 'b' : opts.prefer === 'remote' ? 'b' : 'a';
  if (!base) return newer === 'a' ? local : remote;
  const out: Record<string, unknown> = { id: local.id };
  mergeFields(new Eq(), base as unknown as Record<string, unknown>, local as unknown as Record<string, unknown>, remote as unknown as Record<string, unknown>, new Set(['id', 'formatVersion']), newer, out);
  out.formatVersion = Math.max(local.formatVersion ?? 1, remote.formatVersion ?? 1);
  return out as unknown as NotebookMeta;
}

// ---- Files -------------------------------------------------------------------------------------

export type MergeKind = 'page' | 'note' | 'notebook' | 'transcript' | 'page-summaries';

/** Which merge applies to a vault path, or null when the file can't be merged structurally. */
export function mergeKindOf(path: string): MergeKind | null {
  if (path.endsWith('.ink.json')) return 'page';
  if (/(^|\/)note\.json$/.test(path)) return 'note';
  if (/(^|\/)notebook\.json$/.test(path)) return 'notebook';
  // Recording transcripts and page summaries live next to the recordings (merge-listen.ts).
  if (/^notes\/[^/]+\/assets\/[^/]+\.transcript\.json$/.test(path)) return 'transcript';
  if (/^notes\/[^/]+\/assets\/page-summaries\.json$/.test(path)) return 'page-summaries';
  return null;
}

/** Derived files (regenerated from the sources): never merged, newest wins. */
export function isDerivedPath(path: string): boolean {
  return path.endsWith('.svg') || /(^|\/)note\.md$/.test(path);
}

/**
 * Merges three versions of a vault file's bytes. Returns null when the path isn't mergeable or
 * the local/remote version can't be decoded (the caller falls back to newest-wins). A corrupt
 * base degrades to a two-way merge.
 */
export function mergeFileBytes(path: string, base: Uint8Array | null, local: Uint8Array, remote: Uint8Array, opts: MergeOptions = {}): Uint8Array | null {
  const kind = mergeKindOf(path);
  if (!kind) return null;
  const dec = <T>(f: (s: string) => T, b: Uint8Array | null): T | null => {
    if (!b) return null;
    try {
      return f(utf8Decode(b));
    } catch {
      return null;
    }
  };
  switch (kind) {
    case 'page': {
      const l = dec(decodePage, local);
      const r = dec(decodePage, remote);
      if (!l || !r) return null;
      return utf8Encode(encodePage(mergePage(dec(decodePage, base), l, r, opts)));
    }
    case 'note': {
      const l = dec(decodeNote, local);
      const r = dec(decodeNote, remote);
      if (!l || !r) return null;
      return utf8Encode(encodeNote(mergeNote(dec(decodeNote, base), l, r, opts)));
    }
    case 'notebook': {
      const l = dec(decodeNotebook, local);
      const r = dec(decodeNotebook, remote);
      if (!l || !r) return null;
      return utf8Encode(encodeNotebook(mergeNotebook(dec(decodeNotebook, base), l, r, opts)));
    }
    case 'transcript': {
      const l = dec(decodeTranscript, local);
      const r = dec(decodeTranscript, remote);
      if (!l || !r) return null;
      return utf8Encode(encodeTranscript(mergeTranscript(dec(decodeTranscript, base), l, r, { prefer: opts.prefer })));
    }
    case 'page-summaries': {
      const l = dec(decodePageSummaries, local);
      const r = dec(decodePageSummaries, remote);
      if (!l || !r) return null;
      return utf8Encode(encodePageSummaries(mergePageSummaries(dec(decodePageSummaries, base), l, r)));
    }
  }
}
