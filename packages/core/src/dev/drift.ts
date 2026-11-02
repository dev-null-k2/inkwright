/**
 * Drift: a note that links to code was written against a particular signature. When a re-scan
 * shows the signature changed, or the symbol is gone, the note may now be wrong — so the link is
 * flagged, the user sees old and new side by side, and decides. Nothing here edits a note's text;
 * the only write is the baseline (`NoteMeta.codeRefs`), recorded when a link is first seen and
 * updated when the user marks the link reviewed.
 */
import type { CodeRefBaseline, NoteMeta, PageInk } from '../model.ts';
import { noteLinkOccurrences, parseWikiTarget, type LinkSource } from '../links.ts';
import { CodeIndex, type CodeGraph, type CodeSymbol } from './codegraph.ts';
import { codeRefKey, isCodeTarget, parseCodeTarget, type CodeTarget } from './codelinks.ts';

/**
 * - `ok` — the symbol's signature is what the link was written against.
 * - `changed` — same symbol, different signature: drift.
 * - `missing` — a code source has the repository but not the symbol (or file): drift.
 * - `moved` — gone from its file, but a symbol with the same name and signature exists elsewhere.
 * - `new` — found, but no baseline yet (it is recorded on the next save in the app).
 * - `unresolved` — never matched anything (a typo, or code that was never scanned).
 * - `unknown` — no code source on this device can say (no graph covers the path).
 */
export type CodeRefStatus = 'ok' | 'changed' | 'missing' | 'moved' | 'new' | 'unresolved' | 'unknown';

export const DRIFTED: ReadonlySet<CodeRefStatus> = new Set(['changed', 'missing', 'moved']);

export interface CodeLinkOccurrence {
  target: CodeTarget;
  key: string;
  pageIndex: number;
  source: LinkSource;
  /** Text box or ink link id. */
  itemId?: string;
}

/** Every code link a note's pages make (typed, recognized handwriting, ink), in page order. */
export function noteCodeLinks(pages: readonly PageInk[]): CodeLinkOccurrence[] {
  const out: CodeLinkOccurrence[] = [];
  for (const o of noteLinkOccurrences(pages)) {
    if (!isCodeTarget(o.target)) continue;
    const parts = parseWikiTarget(o.target);
    const t = parseCodeTarget(parts.subpath ? `${parts.title}#${parts.subpath}` : parts.title);
    if (t) out.push({ target: t, key: codeRefKey(t), pageIndex: o.pageIndex, source: o.source, itemId: o.itemId });
  }
  return out;
}

export interface ResolvedCodeTarget {
  symbol: CodeSymbol | null;
  sourceId: string | null;
  /** Some graph has this file. */
  fileKnown: boolean;
  /** Some graph covers a repository at all. */
  anyGraph: boolean;
}

/** Finds a code link's symbol across the scanned sources, preferring the one it was linked in. */
export function resolveCodeTarget(t: CodeTarget, indexes: readonly CodeIndex[], prefer?: string): ResolvedCodeTarget {
  const ordered = prefer ? [...indexes].sort((a, b) => (b.graph.sourceId === prefer ? 1 : 0) - (a.graph.sourceId === prefer ? 1 : 0)) : indexes;
  let fileKnown = false;
  for (const ix of ordered) {
    if (!ix.hasFile(t.path)) continue;
    fileKnown = true;
    if (!t.symbol) {
      return { symbol: null, sourceId: ix.graph.sourceId, fileKnown, anyGraph: true };
    }
    const s = ix.find(t.path, t.symbol);
    if (s) return { symbol: s, sourceId: ix.graph.sourceId, fileKnown, anyGraph: true };
  }
  return { symbol: null, sourceId: null, fileKnown, anyGraph: indexes.length > 0 };
}

export interface CodeRefState {
  key: string;
  target: CodeTarget;
  status: CodeRefStatus;
  baseline?: CodeRefBaseline;
  /** The symbol now, when found. */
  current?: CodeSymbol;
  sourceId?: string;
  /** For `moved`: where a symbol with the same name and signature lives now. */
  movedTo?: CodeSymbol[];
  /** Where the note links it (first occurrence first). */
  occurrences: CodeLinkOccurrence[];
}

/** The state of every code link in one note. */
export function codeRefStates(meta: Pick<NoteMeta, 'codeRefs'>, pages: readonly PageInk[], indexes: readonly CodeIndex[]): CodeRefState[] {
  const byKey = new Map<string, CodeLinkOccurrence[]>();
  for (const o of noteCodeLinks(pages)) (byKey.get(o.key) ?? byKey.set(o.key, []).get(o.key)!).push(o);
  const out: CodeRefState[] = [];
  for (const [key, occurrences] of byKey) {
    const target = occurrences[0]!.target;
    const baseline = meta.codeRefs?.[key];
    const r = resolveCodeTarget(target, indexes, baseline?.sourceId);
    const st: CodeRefState = { key, target, status: 'unknown', occurrences };
    if (baseline) st.baseline = baseline;
    if (r.sourceId) st.sourceId = r.sourceId;
    if (!target.symbol) {
      // A link to a whole file: it drifts only by disappearing.
      st.status = r.fileKnown ? 'ok' : !r.anyGraph ? 'unknown' : baseline ? 'missing' : 'unresolved';
    } else if (r.symbol) {
      st.current = r.symbol;
      st.status = !baseline ? 'new' : baseline.hash === r.symbol.hash ? 'ok' : 'changed';
    } else if (!r.anyGraph || (!r.fileKnown && !baseline)) {
      st.status = r.anyGraph ? 'unresolved' : 'unknown';
    } else if (!baseline) {
      st.status = 'unresolved';
    } else {
      const moved = indexes.flatMap((ix) => ix.elsewhere(target.path, target.symbol!)).filter((s) => s.hash === baseline.hash);
      if (moved.length) { st.status = 'moved'; st.movedTo = moved; } else st.status = 'missing';
    }
    out.push(st);
  }
  return out;
}

/** Records a baseline for every link that resolves but has none yet. Returns `meta` itself when nothing changed. */
export function withCodeBaselines<M extends Pick<NoteMeta, 'codeRefs'>>(meta: M, states: readonly CodeRefState[], now: number): M {
  const add = states.filter((s) => s.status === 'new' && s.current);
  if (!add.length) return meta;
  const codeRefs = { ...(meta.codeRefs ?? {}) };
  for (const s of add) codeRefs[s.key] = { hash: s.current!.hash, signature: s.current!.signature, ...(s.sourceId ? { sourceId: s.sourceId } : {}), linkedAt: now };
  return { ...meta, codeRefs };
}

/**
 * "Mark reviewed": the note was checked against the code as it is now. Updates the baseline to the
 * current signature (or, for a symbol that is gone, forgets it so the link reads as unresolved).
 */
export function markCodeRefReviewed<M extends Pick<NoteMeta, 'codeRefs'>>(meta: M, state: Pick<CodeRefState, 'key' | 'current' | 'sourceId' | 'baseline'>, now: number): M {
  const codeRefs = { ...(meta.codeRefs ?? {}) };
  if (state.current) {
    codeRefs[state.key] = { hash: state.current.hash, signature: state.current.signature, ...(state.sourceId ? { sourceId: state.sourceId } : {}), linkedAt: state.baseline?.linkedAt ?? now, reviewedAt: now };
  } else {
    delete codeRefs[state.key];
  }
  return { ...meta, codeRefs };
}

/** Drops baselines for links that are no longer in the note. Returns `meta` itself when nothing changed. */
export function pruneCodeBaselines<M extends Pick<NoteMeta, 'codeRefs'>>(meta: M, pages: readonly PageInk[]): M {
  if (!meta.codeRefs) return meta;
  const live = new Set(noteCodeLinks(pages).map((o) => o.key));
  const keys = Object.keys(meta.codeRefs);
  if (keys.every((k) => live.has(k))) return meta;
  const codeRefs: Record<string, CodeRefBaseline> = {};
  for (const k of keys) if (live.has(k)) codeRefs[k] = meta.codeRefs[k]!;
  const next = { ...meta, codeRefs };
  if (!Object.keys(codeRefs).length) delete (next as Partial<M>).codeRefs;
  return next;
}

export interface DriftItem extends CodeRefState {
  noteId: string;
  title: string;
}

/** Every drifted code link across notes (the "Drift" list, `drift_report`, `inkstone drift`). */
export function driftReport(notes: readonly { meta: NoteMeta; pages: readonly PageInk[] }[], graphs: readonly CodeGraph[] | readonly CodeIndex[]): DriftItem[] {
  const indexes = graphs.map((g) => (g instanceof CodeIndex ? g : new CodeIndex(g as CodeGraph)));
  const out: DriftItem[] = [];
  for (const n of notes) {
    if (n.meta.trashedAt != null) continue;
    for (const s of codeRefStates(n.meta, n.pages, indexes)) {
      if (DRIFTED.has(s.status)) out.push({ ...s, noteId: n.meta.id, title: n.meta.title });
    }
  }
  return out.sort((a, b) => a.title.localeCompare(b.title) || a.key.localeCompare(b.key));
}

/** One line per drifted link, for terminals and agents. */
export function describeDrift(d: Pick<CodeRefState, 'status' | 'key' | 'baseline' | 'current' | 'movedTo'>): string {
  switch (d.status) {
    case 'changed': return `${d.key}: signature changed\n  was: ${d.baseline?.signature ?? '?'}\n  now: ${d.current?.signature ?? '?'}`;
    case 'missing': return `${d.key}: no longer in the code (was: ${d.baseline?.signature ?? '?'})`;
    case 'moved': return `${d.key}: moved to ${d.movedTo?.map((s) => s.id).join(', ')}`;
    default: return `${d.key}: ${d.status}`;
  }
}
