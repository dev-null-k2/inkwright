/**
 * Provenance for AI-written text: for every sentence, where it came from and how sure we are.
 *
 * Each claim (one sentence) carries a tag — EXTRACTED (copied or closely quoted from a source),
 * INFERRED (synthesised from the cited sources) or AMBIGUOUS (the sources disagree, or support is
 * uncertain) — and one or more source anchors. An anchor names a note, a page, a page-space
 * rectangle (the handwriting, typed text or PDF text the sentence rests on), optionally a moment
 * in a recording, and the hash of the source sentence at the time it was read. That hash is what
 * makes staleness cheap and exact: when the source sentence no longer exists in the note, every
 * claim that cites it is stale until it is re-checked.
 *
 * Storage is compact and lives next to the note it describes (`notes/<id>/assets/provenance.json`,
 * docs/VAULT_FORMAT.md § Provenance), keyed by the text box (or `summary`) the sentences are in.
 * Claims are matched to sentences by their normalised text, not by character offsets, so a user
 * editing one sentence of a compiled page only loses the provenance of that sentence ("edited by
 * you"), never the rest.
 */
import type { Rect } from '../geometry.ts';
import { sentenceHash, splitSentences, normalizeSentence } from './text.ts';

/** EXTRACTED / INFERRED / AMBIGUOUS, stored as one letter. */
export type ProvTag = 'E' | 'I' | 'A';

export const TAG_LABEL: Record<ProvTag, string> = { E: 'Extracted', I: 'Inferred', A: 'Ambiguous' };
export const TAG_NAME: Record<ProvTag, 'EXTRACTED' | 'INFERRED' | 'AMBIGUOUS'> = { E: 'EXTRACTED', I: 'INFERRED', A: 'AMBIGUOUS' };

/** Where a sentence came from, precisely enough to open the note and point at it. */
export interface SourceAnchor {
  noteId: string;
  /** 0-based page index. */
  page: number;
  /** Region on the page (page units), when known. */
  rect?: Rect;
  /** A recording and a moment in it (ms from its start), for things that were said. */
  clip?: string;
  ms?: number;
  /** `sentenceHash` of the source sentence when it was read (staleness). */
  h: string;
}

/** Who wrote a batch of claims: model, provider, prompt id and time ("Explain this answer"). */
export interface ProvenanceGen {
  /** Human label, e.g. "On this device · Qwen3 1.7B" or "Deterministic compiler". */
  by: string;
  provider?: string;
  model?: string;
  /** Prompt id with version, e.g. `compiler.topic/1`; lets anyone find the exact prompt in the source. */
  prompt: string;
  at: number;
}

/** One sentence of AI text with its sources. */
export interface ProvClaim {
  /** The sentence as written (used to find it again in the text). */
  s: string;
  t: ProvTag;
  /** Anchors in compact string form (`formatAnchor`). */
  src: string[];
  /** Confidence 0..1 (support of the sentence by its sources, or the model's own). */
  c?: number;
  /** Why it is AMBIGUOUS, or a note from validation (e.g. "downgraded: not a quote"). */
  why?: string;
}

export interface ProvItem {
  at: number;
  gen: string;
  claims: ProvClaim[];
  /** The previous generation's claims, so undoing an accepted update keeps its provenance. */
  prev?: { gen: string; claims: ProvClaim[] };
}

export interface ProvenanceFile {
  formatVersion: 1;
  updatedAt: number;
  gens: Record<string, ProvenanceGen>;
  /** `text:<textBoxId>`, `summary` (the note's summary), `page:<pageId>` (a page summary). */
  items: Record<string, ProvItem>;
}

export const PROVENANCE_ASSET = 'provenance.json';

export const emptyProvenance = (): ProvenanceFile => ({ formatVersion: 1, updatedAt: 0, gens: {}, items: {} });

export const textItemKey = (textId: string) => `text:${textId}`;

// ---- Anchors -------------------------------------------------------------------------------------

const r1 = (v: number) => Math.round(v * 10) / 10;

/**
 * `<noteId>/<page 1-based>[/x,y,w,h][@<clipId>:<ms>]#<hash>` — readable, compact, and close to
 * the app's `#mem/…` links so it converts to one without a lookup.
 */
export function formatAnchor(a: SourceAnchor): string {
  const rect = a.rect ? `/${[a.rect.minX, a.rect.minY, a.rect.maxX - a.rect.minX, a.rect.maxY - a.rect.minY].map(r1).join(',')}` : '';
  const at = a.clip ? `@${a.clip}:${Math.round(a.ms ?? 0)}` : '';
  return `${a.noteId}/${a.page + 1}${rect}${at}#${a.h}`;
}

export function parseAnchor(s: string): SourceAnchor | null {
  const m = /^([0-9A-Za-z_-]{1,64})\/(\d+)(?:\/(-?[\d.]+),(-?[\d.]+),([\d.]+),([\d.]+))?(?:@([0-9A-Za-z_-]{1,64}):(\d+))?#([0-9a-z]+)$/.exec(s);
  if (!m) return null;
  const a: SourceAnchor = { noteId: m[1]!, page: Math.max(0, Number(m[2]) - 1), h: m[9]! };
  if (m[3] != null) {
    const x = Number(m[3]), y = Number(m[4]);
    a.rect = { minX: x, minY: y, maxX: x + Number(m[5]), maxY: y + Number(m[6]) };
  }
  if (m[7] != null) { a.clip = m[7]; a.ms = Number(m[8]); }
  return a;
}

/** The app's in-note link for an anchor (`#mem/<note>/<page>/<x,y,w,h>@<clip>:<ms>`), see ai/tools/memory.ts. */
export function anchorLink(a: SourceAnchor): string {
  const r = a.rect ? `/${[a.rect.minX, a.rect.minY, a.rect.maxX - a.rect.minX, a.rect.maxY - a.rect.minY].map((v) => Math.round(v)).join(',')}` : '';
  const t = a.clip ? `@${encodeURIComponent(a.clip)}:${Math.round(a.ms ?? 0)}` : '';
  return `#mem/${encodeURIComponent(a.noteId)}/${a.page + 1}${r}${t}`;
}

// ---- Generations ---------------------------------------------------------------------------------

/** Adds a generation record and returns its id (same content → same id, so files stay small). */
export function addGen(file: ProvenanceFile, gen: ProvenanceGen): string {
  const id = `g${sentenceHash(`${gen.by}|${gen.provider ?? ''}|${gen.model ?? ''}|${gen.prompt}|${gen.at}`)}`;
  file.gens[id] = gen;
  return id;
}

/**
 * Records the claims of one item (a text box, the summary…). The claims it had before are kept
 * as `prev`, so the sentences of an undone update still find their sources. Generations nothing
 * refers to any more are dropped.
 */
export function setItem(file: ProvenanceFile, key: string, gen: ProvenanceGen, claims: ProvClaim[], at = gen.at): ProvenanceFile {
  const id = addGen(file, gen);
  const old = file.items[key];
  const item: ProvItem = { at, gen: id, claims };
  if (old && old.claims.length) item.prev = { gen: old.gen, claims: old.claims };
  file.items[key] = item;
  file.updatedAt = Math.max(file.updatedAt, at);
  pruneGens(file);
  return file;
}

export function pruneGens(file: ProvenanceFile): void {
  const used = new Set<string>();
  for (const it of Object.values(file.items)) {
    used.add(it.gen);
    if (it.prev) used.add(it.prev.gen);
  }
  for (const k of Object.keys(file.gens)) if (!used.has(k)) delete file.gens[k];
}

// ---- Finding claims in text ---------------------------------------------------------------------

export interface LocatedSentence {
  text: string;
  start: number;
  end: number;
  claim: ProvClaim | null;
  gen: ProvenanceGen | null;
}

/**
 * Splits `text` into sentences and attaches each one's claim, matched by normalised sentence (the
 * current generation first, then the previous one). Sentences without a claim were written or
 * edited by the user (or are headings), and are shown without provenance.
 */
export function locateClaims(text: string, file: ProvenanceFile | null, key: string): LocatedSentence[] {
  const item = file?.items[key];
  const pools: Array<{ claims: ProvClaim[]; gen: string }> = item ? [{ claims: item.claims, gen: item.gen }, ...(item.prev ? [item.prev] : [])] : [];
  const index = new Map<string, { claim: ProvClaim; gen: string }>();
  for (const p of [...pools].reverse()) for (const c of p.claims) index.set(normalizeSentence(c.s), { claim: c, gen: p.gen });
  return splitSentences(text).map((s) => {
    const hit = index.get(normalizeSentence(s.text));
    return { text: s.text, start: s.start, end: s.start + s.text.length, claim: hit?.claim ?? null, gen: hit ? file!.gens[hit.gen] ?? null : null };
  });
}

// ---- Staleness ----------------------------------------------------------------------------------

export type ClaimFreshness = 'fresh' | 'stale' | 'missing';

/** The hash of anchors that point at a region rather than a sentence (never stale, only missing). */
export const UNHASHED = '0';

/**
 * Current sentence hashes of a source note, or `null` when the note is gone (deleted, trashed or
 * locked). Built by the caller from the notes' current text (see `sourceHashes` in extract.ts).
 */
export type SourceHashLookup = (noteId: string) => ReadonlySet<string> | null;

/**
 * A claim is stale when any sentence it cites no longer exists in its note (edited or erased
 * since the claim was written) and `missing` when a cited note is gone altogether.
 */
export function claimFreshness(claim: Pick<ProvClaim, 'src'>, lookup: SourceHashLookup): ClaimFreshness {
  let stale = false;
  for (const s of claim.src) {
    const a = parseAnchor(s);
    if (!a) continue;
    const hashes = lookup(a.noteId);
    if (!hashes) return 'missing';
    // `0`: an anchor with no sentence behind it (ink a solver read, a page): it can't go stale.
    if (a.h !== UNHASHED && !hashes.has(a.h)) stale = true;
  }
  return stale ? 'stale' : 'fresh';
}

/** Stale and missing claims of a whole provenance file, by item key. */
export function staleClaims(file: ProvenanceFile, lookup: SourceHashLookup): Array<{ key: string; claim: ProvClaim; freshness: Exclude<ClaimFreshness, 'fresh'> }> {
  const out: Array<{ key: string; claim: ProvClaim; freshness: Exclude<ClaimFreshness, 'fresh'> }> = [];
  for (const [key, it] of Object.entries(file.items)) {
    for (const claim of it.claims) {
      const f = claimFreshness(claim, lookup);
      if (f !== 'fresh') out.push({ key, claim, freshness: f });
    }
  }
  return out;
}

// ---- File codec ---------------------------------------------------------------------------------

export function decodeProvenance(json: string): ProvenanceFile {
  const raw = JSON.parse(json) as Partial<ProvenanceFile>;
  if (!raw || typeof raw !== 'object') throw new Error('Not a provenance file');
  const items: Record<string, ProvItem> = {};
  for (const [k, v] of Object.entries(raw.items ?? {})) {
    if (!v || !Array.isArray(v.claims)) continue;
    items[k] = { at: Number(v.at) || 0, gen: String(v.gen ?? ''), claims: v.claims.filter(isClaim), ...(v.prev && Array.isArray(v.prev.claims) ? { prev: { gen: String(v.prev.gen ?? ''), claims: v.prev.claims.filter(isClaim) } } : {}) };
  }
  return { formatVersion: 1, updatedAt: Number(raw.updatedAt) || 0, gens: { ...(raw.gens ?? {}) }, items };
}

function isClaim(c: unknown): c is ProvClaim {
  const x = c as ProvClaim;
  return !!x && typeof x.s === 'string' && (x.t === 'E' || x.t === 'I' || x.t === 'A') && Array.isArray(x.src);
}

export function encodeProvenance(f: ProvenanceFile): string {
  return JSON.stringify(f);
}

/**
 * Three-way-safe merge used by sync: items by key (the newer `at` wins one both devices changed),
 * generations unioned. Provenance is advisory, so the rule is simple and never loses an item.
 */
export function mergeProvenance(base: ProvenanceFile | null, local: ProvenanceFile, remote: ProvenanceFile): ProvenanceFile {
  const items: Record<string, ProvItem> = {};
  for (const key of new Set([...Object.keys(local.items), ...Object.keys(remote.items)])) {
    const l = local.items[key], r = remote.items[key], b = base?.items[key];
    if (l && r) items[key] = r.at > l.at ? r : l;
    else {
      const only = (l ?? r)!;
      // Deleted on one side and unchanged on the other: honour the deletion.
      if (b && b.at === only.at) continue;
      items[key] = only;
    }
  }
  const out: ProvenanceFile = { formatVersion: 1, updatedAt: Math.max(local.updatedAt, remote.updatedAt), gens: { ...remote.gens, ...local.gens }, items };
  pruneGens(out);
  return out;
}
