import { encodeStroke, decodeStroke } from './codec.ts';
import type { ContentOrigin, ImageItem, InkStroke, NoteMeta, PageInk, TextBox } from './model.ts';
import type { PageObject } from './objects.ts';
import { fromBase64Url, sha256, toBase64Url, toHex } from './sha256.ts';

/**
 * Proof of authorship (docs/AUTHORSHIP.md).
 *
 * Every edit to a page appends events to a per-page, append-only hash chain kept in the page file
 * (`PageInk.authorship`): what was added or removed, a digest of its exact content (points with
 * their timing, pressure and tilt), when, and how (written by hand, edited, copied, undone…).
 * A certificate is a JSON manifest — terminology after C2PA content credentials: a *claim* with
 * *assertions*, signed by a *claim signature* — that commits to each page's chain head, counts
 * handwriting vs. typed/AI/imported content, summarises the writing rhythm, carries the evidence
 * (chain + content) and is signed with the device's ECDSA P-256 key.
 *
 * What it shows: the signed content is exactly what this device's key saw, the history is
 * consistent and complete back to the first recorded edit, and anything AI-made or imported is
 * labelled as such and never counted as handwriting. What it cannot show: who held the pen, or
 * that handwriting wasn't copied by hand from an AI's answer.
 */

// ---- The chain -----------------------------------------------------------------------------------

/** What an event's item is: stroke, text box, image, page object. */
export type ChainKind = 's' | 't' | 'i' | 'o';

/**
 * How an item came to be:
 *  - `draw`: written by hand in Inkstone (the ink engine's pen-up);
 *  - `edit`: derived from `from` (moved, resized, recoloured, partly erased, retyped);
 *  - `copy`: pasted or duplicated; `undo` / `redo`: restored by undo or redo;
 *  - `other`: anything else (AI, imports, tools) — the item's `origin` says more.
 */
export type ChainCause = 'draw' | 'edit' | 'copy' | 'undo' | 'redo' | 'other';

export interface ChainEvent {
  /** `+` the item was added to the page, `-` removed. */
  op: '+' | '-';
  k: ChainKind;
  id: string;
  /** Digest of the item's exact saved content: 16 bytes of SHA-256, base64url. */
  d: string;
  /** Wall-clock time of the edit (epoch ms). */
  t: number;
  how?: ChainCause;
  /** For `edit`: the item it was made from. */
  from?: string;
  /** Short fingerprint of the device key that recorded the event, when known. */
  dev?: string;
  /** The live collaborator whose edit this was (their `ItemAuthor.id`); absent for this device's own edits. */
  by?: string;
}

export interface PageAuthorship {
  v: 1;
  events: ChainEvent[];
}

/** Canonical JSON: object keys sorted, no whitespace. What digests and signatures are over. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'null';
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJson(x))).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(',')}}`;
}

type AnyItem = InkStroke | TextBox | ImageItem | PageObject;

/** The exact content of an item as it is saved (strokes use the compact on-disk encoding). */
export function itemContent(kind: ChainKind, item: AnyItem): unknown {
  if (kind === 's') return encodeStroke(item as InkStroke);
  // A graph's view window is where it is panned to, not what it says.
  if (kind === 'o' && (item as PageObject).type === 'graph') { const { view: _v, ...rest } = item as PageObject & { view: unknown }; return rest; }
  return item;
}

export function itemDigest(kind: ChainKind, item: AnyItem): string {
  return toBase64Url(sha256(canonicalJson(itemContent(kind, item))).subarray(0, 16));
}

const GENESIS = 'inkstone.chain/1:';

/** Running chain hashes: `heads[i]` is the head after `i` events (heads[0] is the genesis). */
export function chainHeads(pageId: string, events: readonly ChainEvent[]): string[] {
  let h = sha256(GENESIS + pageId);
  const out = [toBase64Url(h)];
  for (const e of events) {
    const ev = new TextEncoder().encode(canonicalJson(e));
    const buf = new Uint8Array(h.length + ev.length);
    buf.set(h);
    buf.set(ev, h.length);
    h = sha256(buf);
    out.push(toBase64Url(h));
  }
  return out;
}

export function chainHead(pageId: string, events: readonly ChainEvent[]): string {
  const heads = chainHeads(pageId, events);
  return heads[heads.length - 1]!;
}

/** Replays a chain: the live items it accounts for (id → digest) and each item's root cause. */
export function replayChain(events: readonly ChainEvent[]): { live: Map<string, { k: ChainKind; d: string; how: ChainCause; root: ChainCause }>; problems: string[] } {
  const live = new Map<string, { k: ChainKind; d: string; how: ChainCause; root: ChainCause }>();
  /** Root cause of every item id ever seen (kept after removal so undo can restore it). */
  const roots = new Map<string, ChainCause>();
  const lastDigest = new Map<string, string>();
  const problems: string[] = [];
  let prevT = -Infinity;
  for (const e of events) {
    if (e.t + 5 * 60_000 < prevT) problems.push(`Event for ${e.id} is dated before the one before it`);
    prevT = Math.max(prevT, e.t);
    const key = `${e.k}:${e.id}`;
    if (e.op === '+') {
      const how = e.how ?? 'other';
      let root: ChainCause = how;
      if (how === 'edit' && e.from) root = roots.get(`${e.k}:${e.from}`) ?? 'other';
      else if (how === 'undo' || how === 'redo') root = lastDigest.get(key) === e.d ? (roots.get(key) ?? 'other') : 'other';
      roots.set(key, root);
      lastDigest.set(key, e.d);
      live.set(key, { k: e.k, d: e.d, how, root });
    } else {
      if (!live.has(key)) problems.push(`Removal of ${e.id}, which the chain never added`);
      live.delete(key);
    }
  }
  return { live, problems };
}

// ---- Recording ------------------------------------------------------------------------------------

export interface ChainChange {
  kind: ChainKind;
  removed: AnyItem[];
  added: AnyItem[];
}

/**
 * Events for one committed edit. `how` is what the caller knows (`draw` for a pen-up, `undo`,
 * `copy`…); added items that replace a removed item (same id, or a stroke with the same
 * `createdAt` and pen — moved, recoloured, split by the precise eraser) are recorded as `edit`s
 * of it, so the handwriting they came from is still counted.
 */
export function eventsFor(changes: readonly ChainChange[], how: ChainCause, t: number, dev?: string, by?: string): ChainEvent[] {
  const out: ChainEvent[] = [];
  for (const ch of changes) {
    // Replacing an item with identical content (a graph panned, a table re-saved) is not an edit.
    const removedDigest = new Map(ch.removed.map((r) => [r.id, itemDigest(ch.kind, r)]));
    const unchanged = new Set(ch.added.filter((x) => removedDigest.get(x.id) === itemDigest(ch.kind, x)).map((x) => x.id));
    for (const x of ch.removed) if (!unchanged.has(x.id)) out.push(ev('-', ch.kind, x, t, undefined, undefined, dev, by));
    for (const x of ch.added) {
      if (unchanged.has(x.id)) continue;
      let cause: ChainCause = how;
      let from: string | undefined;
      if (how !== 'draw' && how !== 'undo' && how !== 'redo') {
        const same = ch.removed.find((r) => r.id === x.id);
        // Edits keep `createdAt` (and a stroke its pen) while getting a new id.
        const parent = same ?? ch.removed.find((r) => r.createdAt === x.createdAt && (ch.kind !== 's' || (r as InkStroke).pen === (x as InkStroke).pen));
        if (parent) { cause = 'edit'; from = parent.id; }
      }
      out.push(ev('+', ch.kind, x, t, cause, from, dev, by));
    }
  }
  return out;
}

function ev(op: '+' | '-', k: ChainKind, x: AnyItem, t: number, how?: ChainCause, from?: string, dev?: string, by?: string): ChainEvent {
  const e: ChainEvent = { op, k, id: x.id, d: itemDigest(k, x), t };
  if (op === '+' && how) e.how = how;
  if (from) e.from = from;
  if (dev) e.dev = dev;
  if (by) e.by = by;
  return e;
}

export function appendEvents(page: PageInk, events: readonly ChainEvent[]): PageInk {
  if (!events.length) return page;
  const prev = page.authorship?.events ?? [];
  return { ...page, authorship: { v: 1, events: [...prev, ...events] } };
}

/**
 * Merges two copies of a page's chain (sync): events are unioned and ordered by time. The
 * merged chain has a new head; certificates signed before keep verifying on their own evidence.
 */
export function mergeAuthorship(a: PageAuthorship | undefined, b: PageAuthorship | undefined): PageAuthorship | undefined {
  if (!a) return b;
  if (!b) return a;
  const seen = new Set<string>();
  const all: ChainEvent[] = [];
  for (const e of [...a.events, ...b.events]) {
    const key = canonicalJson(e);
    if (seen.has(key)) continue;
    seen.add(key);
    all.push(e);
  }
  // Stable: events of one device keep their order; interleave by time.
  const idx = new Map(all.map((e, i) => [e, i]));
  all.sort((x, y) => x.t - y.t || idx.get(x)! - idx.get(y)!);
  return { v: 1, events: all };
}

// ---- Classification & statistics --------------------------------------------------------------------

/** Content counts of a page or note. "Handwritten" only ever counts strokes drawn by hand in the app. */
export interface ContentCounts {
  /** Strokes written by hand in Inkstone (root event `draw`, input recorded). */
  handwritten: number;
  /** …of which written with a stylus reporting pressure. */
  penWithPressure: number;
  /** …written with a finger or a mouse. */
  touch: number;
  mouse: number;
  /** Strokes pasted or duplicated. */
  copied: number;
  /** Strokes made by AI. */
  aiInk: number;
  /** Strokes not accounted for by the chain (older notes, other apps, other devices before sync). */
  unattested: number;
  typedText: number;
  aiText: number;
  /** Text boxes brought in from files. */
  importedText: number;
  recognizedText: number;
  importedImages: number;
  aiImages: number;
  /** Pages whose background is an imported PDF page or image. */
  importedPages: number;
  /** Tables, solved results and graphs (machine-made). */
  objects: number;
  /**
   * Strokes and text boxes a live collaborator wrote or changed (docs/COLLABORATION.md). Present
   * only when non-zero, so certificates made before live collaboration keep verifying.
   */
  collaborator?: number;
}

export interface WritingRhythm {
  /** First pen-down and last pen-up of handwriting (epoch ms); 0 when none. */
  firstAt: number;
  lastAt: number;
  /** Time the pen was actually moving on the page. */
  inkMs: number;
  /** Writing sessions (gaps over 10 minutes start a new one). */
  sessions: number;
  /** Pauses between consecutive strokes within a session, ms. */
  pauseMedianMs: number;
  pauseP90Ms: number;
  /** Pen speed while writing, page units (1/96 in) per second. */
  speedMean: number;
  /** Coefficient of variation of per-stroke speed (handwriting is uneven; tracing tends to be slow and even). */
  speedCv: number;
  /** Mean and standard deviation of reported pressure (−1 when no pressure was reported). */
  pressureMean: number;
  pressureSd: number;
  /** Share of handwriting points with stylus tilt reported. */
  tiltShare: number;
}

export const ZERO_COUNTS: ContentCounts = { handwritten: 0, penWithPressure: 0, touch: 0, mouse: 0, copied: 0, aiInk: 0, unattested: 0, typedText: 0, aiText: 0, importedText: 0, recognizedText: 0, importedImages: 0, aiImages: 0, importedPages: 0, objects: 0 };

export function addCounts(a: ContentCounts, b: ContentCounts): ContentCounts {
  const out = { ...a };
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)]) as Set<keyof ContentCounts>) out[k] = (a[k] ?? 0) + (b[k] ?? 0);
  return out;
}

const isMachine = (o: ContentOrigin | undefined) => o === 'ai' || o === 'solver' || o === 'import' || o === 'recognized';

/**
 * Sorts a page's content into handwriting / typed / AI / imported, using the chain for strokes.
 * Returns the handwritten strokes too (for the rhythm statistics).
 */
export function classifyPage(page: PageInk): { counts: ContentCounts; handwritten: InkStroke[] } {
  const { live } = replayChain(page.authorship?.events ?? []);
  const c: ContentCounts = { ...ZERO_COUNTS };
  const hand: InkStroke[] = [];
  const collab = () => { c.collaborator = (c.collaborator ?? 0) + 1; };
  for (const s of page.strokes) {
    // A collaborator's ink is theirs, whatever else it claims: never this owner's handwriting.
    if (s.author) { collab(); continue; }
    if (s.origin === 'ai') { c.aiInk++; continue; }
    if (isMachine(s.origin)) { c.copied++; continue; }
    const e = live.get(`s:${s.id}`);
    if (!e || e.d !== itemDigest('s', s)) { c.unattested++; continue; }
    if (e.root === 'draw' && s.input) {
      c.handwritten++;
      hand.push(s);
      if (s.input === 'touch') c.touch++;
      else if (s.input === 'mouse') c.mouse++;
      else if (s.points.some((p) => p.p >= 0)) c.penWithPressure++;
    } else if (e.root === 'copy') c.copied++;
    else c.unattested++;
  }
  for (const t of page.texts ?? []) {
    if (t.author) collab();
    else if (t.origin === 'ai') c.aiText++;
    else if (t.origin === 'recognized') c.recognizedText++;
    else if (!t.origin) c.typedText++;
    else if (t.origin === 'import') c.importedText++;
    else c.aiText++;
  }
  for (const im of page.images ?? []) {
    if (im.origin === 'ai') c.aiImages++;
    else c.importedImages++;
  }
  if (page.background) c.importedPages++;
  // Sticky notes and tape are the user's own paper, not machine-made content.
  c.objects += (page.objects ?? []).filter((o) => o.type !== 'sticky' && o.type !== 'tape').length;
  return { counts: c, handwritten: hand };
}

const median = (a: number[]) => quantile(a, 0.5);
function quantile(a: number[], q: number): number {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}

/** Writing rhythm of handwritten strokes: when, how long, pauses, speed, pressure and tilt. */
export function writingRhythm(strokes: readonly InkStroke[]): WritingRhythm {
  const r: WritingRhythm = { firstAt: 0, lastAt: 0, inkMs: 0, sessions: 0, pauseMedianMs: 0, pauseP90Ms: 0, speedMean: 0, speedCv: 0, pressureMean: -1, pressureSd: 0, tiltShare: 0 };
  const list = strokes.filter((s) => s.points.length).sort((a, b) => a.createdAt - b.createdAt);
  if (!list.length) return r;
  const dur = (s: InkStroke) => Math.max(0, s.points[s.points.length - 1]!.t);
  r.firstAt = list[0]!.createdAt;
  r.lastAt = Math.max(...list.map((s) => s.createdAt + dur(s)));
  const pauses: number[] = [];
  const speeds: number[] = [];
  const pressures: number[] = [];
  let tilted = 0, points = 0;
  r.sessions = 1;
  for (let i = 0; i < list.length; i++) {
    const s = list[i]!;
    const d = dur(s);
    r.inkMs += d;
    if (i > 0) {
      const prev = list[i - 1]!;
      const gap = s.createdAt - (prev.createdAt + dur(prev));
      if (gap > 10 * 60_000) r.sessions++;
      else pauses.push(Math.max(0, gap));
    }
    let len = 0;
    for (let k = 1; k < s.points.length; k++) len += Math.hypot(s.points[k]!.x - s.points[k - 1]!.x, s.points[k]!.y - s.points[k - 1]!.y);
    if (d > 30) speeds.push((len / d) * 1000);
    for (const p of s.points) {
      points++;
      if (p.p >= 0) pressures.push(p.p);
      if (p.tilt >= 0) tilted++;
    }
  }
  r.pauseMedianMs = Math.round(median(pauses));
  r.pauseP90Ms = Math.round(quantile(pauses, 0.9));
  if (speeds.length) {
    const m = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    const sd = Math.sqrt(speeds.reduce((a, b) => a + (b - m) ** 2, 0) / speeds.length);
    r.speedMean = round(m, 1);
    r.speedCv = m > 0 ? round(sd / m, 3) : 0;
  }
  if (pressures.length) {
    const m = pressures.reduce((a, b) => a + b, 0) / pressures.length;
    r.pressureMean = round(m, 3);
    r.pressureSd = round(Math.sqrt(pressures.reduce((a, b) => a + (b - m) ** 2, 0) / pressures.length), 3);
  }
  r.tiltShare = points ? round(tilted / points, 3) : 0;
  return r;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

// ---- Certificates ---------------------------------------------------------------------------------

export const CERTIFICATE_FORMAT = 'inkstone.authorship/1';

/** IPTC digital source types (as used by C2PA `c2pa.actions`) for each kind of content. */
export const SOURCE_TYPES = {
  handwriting: 'http://cv.iptc.org/newscodes/digitalsourcetype/digitalCreation',
  ai: 'http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia',
  solver: 'http://cv.iptc.org/newscodes/digitalsourcetype/algorithmicMedia',
  imported: 'http://cv.iptc.org/newscodes/digitalsourcetype/composite',
} as const;

export interface SignerInfo {
  alg: 'ES256';
  /** Public key (JWK, EC P-256). */
  publicKey: JsonWebKey;
  /** Human-checkable fingerprint of the public key ("3F2A 9C1B …"). */
  fingerprint: string;
  /** Self-chosen device/person name; not verified by anyone. */
  name?: string;
}

export interface PageClaim {
  pageId: string;
  index: number;
  chain: { head: string; length: number };
  counts: ContentCounts;
  rhythm: WritingRhythm;
}

export interface AuthorshipClaim {
  generator: string;
  /** ISO time the certificate was made. */
  created: string;
  subject: { noteId: string; title: string };
  signer: SignerInfo;
  pages: PageClaim[];
  totals: ContentCounts;
  /** What kinds of content the note holds, as C2PA-style actions with IPTC source types. */
  actions: { action: 'c2pa.created' | 'c2pa.placed'; digitalSourceType: string; count: number; description: string }[];
  /** SHA-256 (base64url) of the canonical evidence. */
  evidenceDigest: string;
}

export interface PageEvidence {
  pageId: string;
  events: ChainEvent[];
  strokes: unknown[];
  texts: TextBox[];
  images: ImageItem[];
  objects: PageObject[];
  background?: PageInk['background'];
}

export interface AuthorshipCertificate {
  format: typeof CERTIFICATE_FORMAT;
  claim: AuthorshipClaim;
  evidence: { pages: PageEvidence[] };
  /** ECDSA P-256 / SHA-256 signature (IEEE P1363 r‖s), base64url, over UTF-8 canonical JSON of `claim`. */
  signature: string;
}

export function pageEvidence(page: PageInk): PageEvidence {
  return {
    pageId: page.id,
    events: page.authorship?.events ?? [],
    strokes: page.strokes.map((s) => encodeStroke(s)),
    texts: page.texts ?? [],
    images: page.images ?? [],
    objects: page.objects ?? [],
    background: page.background,
  };
}

/** A page rebuilt from evidence (to re-check counts and to show the signed ink). */
export function pageFromEvidence(e: PageEvidence): PageInk {
  return {
    id: e.pageId,
    strokes: e.strokes.map(decodeStroke),
    texts: e.texts,
    images: e.images,
    objects: e.objects,
    background: e.background,
    authorship: { v: 1, events: e.events },
    formatVersion: 2,
  };
}

function actionsFor(t: ContentCounts): AuthorshipClaim['actions'] {
  const a: AuthorshipClaim['actions'] = [];
  if (t.handwritten) a.push({ action: 'c2pa.created', digitalSourceType: SOURCE_TYPES.handwriting, count: t.handwritten, description: 'Handwriting written in Inkstone' });
  if (t.typedText) a.push({ action: 'c2pa.created', digitalSourceType: SOURCE_TYPES.handwriting, count: t.typedText, description: 'Text typed in Inkstone' });
  const ai = t.aiInk + t.aiText + t.aiImages;
  if (ai) a.push({ action: 'c2pa.created', digitalSourceType: SOURCE_TYPES.ai, count: ai, description: 'Content made by an AI model' });
  if (t.objects || t.recognizedText) a.push({ action: 'c2pa.created', digitalSourceType: SOURCE_TYPES.solver, count: t.objects + t.recognizedText, description: 'Tables, solved results, graphs and recognized text made by the app' });
  if (t.collaborator) a.push({ action: 'c2pa.placed', digitalSourceType: SOURCE_TYPES.imported, count: t.collaborator, description: 'Written or changed by a collaborator in a live session' });
  const imp = t.importedImages + t.importedPages + t.importedText + t.copied + t.unattested;
  if (imp) a.push({ action: 'c2pa.placed', digitalSourceType: SOURCE_TYPES.imported, count: imp, description: 'Imported, pasted or unattested content' });
  return a;
}

/** The claim and evidence for a note (or some of its pages), ready to sign. */
export function buildClaim(note: Pick<NoteMeta, 'id' | 'title'>, pages: readonly PageInk[], signer: SignerInfo, opts: { pageIndexes?: number[]; now?: number; generator?: string } = {}): { claim: AuthorshipClaim; evidence: { pages: PageEvidence[] } } {
  const idx = opts.pageIndexes ?? pages.map((_, i) => i);
  let totals = { ...ZERO_COUNTS };
  const claims: PageClaim[] = [];
  const evidence: PageEvidence[] = [];
  for (const i of idx) {
    const p = pages[i];
    if (!p) continue;
    const { counts, handwritten } = classifyPage(p);
    const events = p.authorship?.events ?? [];
    claims.push({ pageId: p.id, index: i, chain: { head: chainHead(p.id, events), length: events.length }, counts, rhythm: writingRhythm(handwritten) });
    totals = addCounts(totals, counts);
    evidence.push(pageEvidence(p));
  }
  const ev = { pages: evidence };
  const claim: AuthorshipClaim = {
    generator: opts.generator ?? 'Inkstone',
    created: new Date(opts.now ?? Date.now()).toISOString(),
    subject: { noteId: note.id, title: note.title },
    signer,
    pages: claims,
    totals,
    actions: actionsFor(totals),
    evidenceDigest: toBase64Url(sha256(canonicalJson(ev))),
  };
  return { claim, evidence: ev };
}

// ---- Keys, signing, verifying -----------------------------------------------------------------------

const subtle = () => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('This device has no WebCrypto (needed to sign and verify certificates).');
  return s;
};

const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const SIGN = { name: 'ECDSA', hash: 'SHA-256' } as const;

/** Key fingerprint: SHA-256 of the uncompressed public point, first 10 bytes as 5 groups of hex. */
export function fingerprintOf(jwk: JsonWebKey): string {
  if (!jwk.x || !jwk.y) throw new Error('Not an EC public key');
  const x = fromBase64Url(jwk.x), y = fromBase64Url(jwk.y);
  const raw = new Uint8Array(1 + x.length + y.length);
  raw[0] = 4;
  raw.set(x, 1);
  raw.set(y, 1 + x.length);
  const hex = toHex(sha256(raw).subarray(0, 10)).toUpperCase();
  return hex.match(/.{4}/g)!.join(' ');
}

/** Signs a claim with a private key (which may be non-extractable). */
export async function signClaim(claim: AuthorshipClaim, evidence: { pages: PageEvidence[] }, privateKey: CryptoKey): Promise<AuthorshipCertificate> {
  const sig = await subtle().sign(SIGN, privateKey, new TextEncoder().encode(canonicalJson(claim)) as BufferSource);
  return { format: CERTIFICATE_FORMAT, claim, evidence, signature: toBase64Url(new Uint8Array(sig)) };
}

export interface PageCheck {
  pageId: string;
  index: number;
  /** The chain in the evidence hashes to the signed head. */
  chainValid: boolean;
  /** Every signed stroke/text/image/object matches the chain's record of it. */
  contentMatchesChain: boolean;
  /** Counts recomputed from the evidence equal the signed counts. */
  countsMatch: boolean;
  problems: string[];
  /** Compared with the current note (when given). */
  since?: { added: number; removed: number; changed: number; appendOnly: boolean; missingPage: boolean };
}

export interface VerifyReport {
  /** `verified`: signature, evidence and chains all check out (and nothing changed since, if compared). */
  status: 'verified' | 'changed' | 'invalid';
  signatureValid: boolean;
  evidenceIntact: boolean;
  fingerprint: string;
  fingerprintMatchesKey: boolean;
  signerName?: string;
  created: string;
  subject: { noteId: string; title: string };
  totals: ContentCounts;
  pages: PageCheck[];
  problems: string[];
}

/** Parses a certificate from JSON, checking its shape. */
export function parseCertificate(json: string): AuthorshipCertificate {
  const o = JSON.parse(json);
  if (!o || o.format !== CERTIFICATE_FORMAT || !o.claim || !o.evidence || typeof o.signature !== 'string') throw new Error('Not an Inkstone authorship certificate');
  return o as AuthorshipCertificate;
}

/**
 * Verifies a certificate offline: the signature with the key it names, the evidence against the
 * signed digest, each page's chain against its signed head, the signed content against the chain,
 * and the counts. With `current` pages, also reports what changed since signing.
 */
export async function verifyCertificate(cert: AuthorshipCertificate, current?: readonly PageInk[]): Promise<VerifyReport> {
  const problems: string[] = [];
  const claim = cert.claim;
  let signatureValid = false;
  try {
    const key = await subtle().importKey('jwk', { ...claim.signer.publicKey, key_ops: ['verify'], ext: true }, ECDSA, false, ['verify']);
    signatureValid = await subtle().verify(SIGN, key, fromBase64Url(cert.signature) as BufferSource, new TextEncoder().encode(canonicalJson(claim)) as BufferSource);
  } catch (e) {
    problems.push(`Signature could not be checked: ${(e as Error).message}`);
  }
  if (!signatureValid) problems.push('The signature does not match the certificate: it was altered or signed by another key.');
  let fingerprintMatchesKey = false;
  try { fingerprintMatchesKey = fingerprintOf(claim.signer.publicKey) === claim.signer.fingerprint; } catch { /* invalid key */ }
  if (!fingerprintMatchesKey) problems.push('The fingerprint shown does not belong to the signing key.');
  const evidenceIntact = toBase64Url(sha256(canonicalJson(cert.evidence))) === claim.evidenceDigest;
  if (!evidenceIntact) problems.push('The evidence (ink and history) was altered after signing.');

  const pages: PageCheck[] = [];
  for (const pc of claim.pages) {
    const ev = cert.evidence.pages.find((p) => p.pageId === pc.pageId);
    const check: PageCheck = { pageId: pc.pageId, index: pc.index, chainValid: false, contentMatchesChain: false, countsMatch: false, problems: [] };
    pages.push(check);
    if (!ev) { check.problems.push('No evidence for this page'); continue; }
    check.chainValid = ev.events.length === pc.chain.length && chainHead(pc.pageId, ev.events) === pc.chain.head;
    if (!check.chainValid) check.problems.push('The history does not hash to the signed chain head.');
    const page = pageFromEvidence(ev);
    const replay = replayChain(ev.events);
    check.problems.push(...replay.problems);
    const mismatched = contentVsChain(page, replay.live);
    check.contentMatchesChain = mismatched === 0;
    if (mismatched) check.problems.push(`${mismatched} item${mismatched === 1 ? '' : 's'} differ from what the history recorded.`);
    check.countsMatch = canonicalJson(classifyPage(page).counts) === canonicalJson(pc.counts);
    if (!check.countsMatch) check.problems.push('The counts in the claim do not match the evidence.');
    if (current) {
      const cur = current.find((p) => p.id === pc.pageId);
      if (!cur) check.since = { added: 0, removed: 0, changed: 0, appendOnly: false, missingPage: true };
      else check.since = changesSince(page, cur);
    }
  }
  const sound = signatureValid && evidenceIntact && fingerprintMatchesKey && pages.every((p) => p.chainValid && p.contentMatchesChain && p.countsMatch);
  const changed = pages.some((p) => p.since && (p.since.added || p.since.removed || p.since.changed || p.since.missingPage));
  return {
    status: !sound ? 'invalid' : changed ? 'changed' : 'verified',
    signatureValid,
    evidenceIntact,
    fingerprint: claim.signer.fingerprint,
    fingerprintMatchesKey,
    signerName: claim.signer.name,
    created: claim.created,
    subject: claim.subject,
    totals: claim.totals,
    pages,
    problems,
  };
}

function liveDigests(page: PageInk): Map<string, string> {
  const m = new Map<string, string>();
  for (const s of page.strokes) m.set(`s:${s.id}`, itemDigest('s', s));
  for (const t of page.texts ?? []) m.set(`t:${t.id}`, itemDigest('t', t));
  for (const i of page.images ?? []) m.set(`i:${i.id}`, itemDigest('i', i));
  for (const o of page.objects ?? []) m.set(`o:${o.id}`, itemDigest('o', o));
  return m;
}

/** Items whose content differs from the chain's record (absent items are "unattested", not mismatches). */
function contentVsChain(page: PageInk, live: Map<string, { d: string }>): number {
  let n = 0;
  for (const [k, d] of liveDigests(page)) {
    const e = live.get(k);
    if (e && e.d !== d) n++;
  }
  return n;
}

/** What changed on a page between the signed state and now. */
export function changesSince(signed: PageInk, now: PageInk): NonNullable<PageCheck['since']> {
  const a = liveDigests(signed), b = liveDigests(now);
  let added = 0, removed = 0, changed = 0;
  for (const [k, d] of b) {
    const old = a.get(k);
    if (old === undefined) added++;
    else if (old !== d) changed++;
  }
  for (const k of a.keys()) if (!b.has(k)) removed++;
  const se = signed.authorship?.events ?? [], ne = now.authorship?.events ?? [];
  const appendOnly = ne.length >= se.length && chainHeads(now.id, ne)[se.length] === chainHead(signed.id, se);
  return { added, removed, changed, appendOnly, missingPage: false };
}
