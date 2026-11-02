/**
 * The compiled wiki, deterministically: which pages exist, which source sentences each one rests
 * on, whether a page needs recompiling, how to check an AI draft against its sources, and how a
 * new draft differs from the page that is there now.
 *
 * Pages (keys are stable, so a page keeps its note across compiles):
 * - `topic:<slug>`   — a tag, a heading shared by notes, or (for notes with neither) the note itself
 * - `concept:<slug>` — a `[[link]]` target or a defined term mentioned in several places
 * - `project:<slug>` — "Project Atlas", `#project/atlas`
 * - `person:<slug>`  — people (only when the user has turned people pages on)
 * - `glossary`       — every "Term: definition" found
 * - `index`          — a list of all pages
 *
 * Incremental compilation is a fingerprint comparison: a page's fingerprint is the hash of the
 * hashes of the sentences it cites, so editing an unrelated note recompiles nothing, and editing
 * one sentence recompiles exactly the pages that use it.
 */
import { hashText } from '../memory.ts';
import { extractClaims, detectConflicts, type Claim, type Conflict } from './claims.ts';
import { extractActions, extractDefinitions, extractEntities, type EntityKind } from './entities.ts';
import { unitAnchor, type SourceDoc, type SourceUnit } from './extract.ts';
import type { ProvClaim, ProvTag, ProvenanceGen } from './provenance.ts';
import { containment, normalizeSentence, numbersIn, slugify, splitSentences, stripMarkdown, wordSet } from './text.ts';

export type WikiPageKind = 'topic' | 'concept' | 'project' | 'person' | 'glossary' | 'index';

export interface PlannedPage {
  key: string;
  kind: WikiPageKind;
  title: string;
  /** Source sentences this page draws on, in reading order. */
  unitIds: string[];
  /** Notes those sentences come from. */
  noteIds: string[];
  /** Hash of the cited sentences' hashes (and the title): changes exactly when the page must. */
  fingerprint: string;
  /** For person pages: open action items and follow-ups found for them. */
  actions?: Array<{ text: string; unitId: string; due?: string; done: boolean; followUp: boolean }>;
}

export interface PlanOptions {
  /** Make person pages (the user's consent; off by default). */
  people?: boolean;
  /** Most sentences per page (default 60): beyond that the page cites the most informative ones. */
  maxUnitsPerPage?: number;
  /** Tags that never become topics (e.g. the compiler's own). */
  ignoreTags?: readonly string[];
}

export interface WikiPlan {
  pages: PlannedPage[];
  units: Map<string, SourceUnit>;
  claims: Claim[];
  conflicts: Conflict[];
}

/** How informative a sentence is for a page (claims, definitions and decisions first). */
function weight(u: SourceUnit, claimUnits: Set<string>, defUnits: Set<string>): number {
  return (claimUnits.has(u.id) ? 3 : 0) + (defUnits.has(u.id) ? 2 : 0) + (u.heading ? 0.5 : 0) + Math.min(1, u.text.length / 120);
}

/** Plans every page of the wiki from the extracted sources. Pure and deterministic. */
export function planWiki(docs: readonly SourceDoc[], opts: PlanOptions = {}): WikiPlan {
  const max = opts.maxUnitsPerPage ?? 60;
  const ignore = new Set((opts.ignoreTags ?? []).map((t) => t.toLowerCase()));
  const units = new Map<string, SourceUnit>();
  for (const d of docs) for (const u of d.units) units.set(u.id, u);
  const claims = docs.flatMap((d) => extractClaims(d));
  const conflicts = detectConflicts(claims);
  const claimUnits = new Set(claims.map((c) => c.unitId));
  const defs = extractDefinitions([...units.values()]);
  const defUnits = new Set(defs.map((d) => d.unitId));
  const order = new Map([...units.keys()].map((id, i) => [id, i]));

  const pages = new Map<string, { kind: WikiPageKind; title: string; ids: Set<string>; actions?: PlannedPage['actions'] }>();
  const page = (key: string, kind: WikiPageKind, title: string) => {
    let p = pages.get(key);
    if (!p) pages.set(key, (p = { kind, title, ids: new Set() }));
    return p;
  };

  // Topics: tags, then headings shared by at least two notes (or with two sentences), then notes
  // that are on no topic yet.
  const covered = new Set<string>();
  const tagCount = new Map<string, number>();
  for (const d of docs) for (const t of d.tags) if (!ignore.has(t.toLowerCase())) tagCount.set(t.toLowerCase(), (tagCount.get(t.toLowerCase()) ?? 0) + 1);
  for (const d of docs) {
    for (const t of d.tags) {
      if (ignore.has(t.toLowerCase())) continue;
      const p = page(`topic:${slugify(t)}`, 'topic', titleCase(t.replace(/^.*\//, '').replace(/[-_]/g, ' ')));
      for (const u of d.units) p.ids.add(u.id);
      covered.add(d.noteId);
    }
  }
  const headingNotes = new Map<string, { title: string; notes: Set<string>; ids: string[] }>();
  for (const d of docs) {
    for (const u of d.units) {
      if (!u.heading) continue;
      const k = slugify(u.heading);
      let h = headingNotes.get(k);
      if (!h) headingNotes.set(k, (h = { title: u.heading, notes: new Set(), ids: [] }));
      h.notes.add(d.noteId);
      h.ids.push(u.id);
    }
  }
  for (const [k, h] of headingNotes) {
    if (h.notes.size < 2 && h.ids.length < 3) continue;
    if (tagCount.has(k)) continue;
    // A heading inside notes that already share a tag is a section of that topic, not a page.
    const notes = docs.filter((d) => h.notes.has(d.noteId));
    if (notes[0]?.tags.some((t) => !ignore.has(t.toLowerCase()) && notes.every((d) => d.tags.some((x) => x.toLowerCase() === t.toLowerCase())))) continue;
    const p = page(`topic:${k}`, 'topic', h.title);
    for (const id of h.ids) p.ids.add(id);
    for (const n of h.notes) covered.add(n);
  }
  for (const d of docs) {
    if (covered.has(d.noteId) || !d.units.length) continue;
    const p = page(`topic:${slugify(d.title)}`, 'topic', d.title);
    for (const u of d.units) p.ids.add(u.id);
  }

  // Entities.
  const mentions = docs.flatMap((d) => extractEntities(d));
  const byKey = new Map<string, { kind: EntityKind; name: string; ids: Set<string>; notes: Set<string> }>();
  for (const m of mentions) {
    if (m.kind === 'person' && !opts.people) continue;
    let e = byKey.get(m.key);
    if (!e) byKey.set(m.key, (e = { kind: m.kind, name: m.name, ids: new Set(), notes: new Set() }));
    e.ids.add(m.unitId);
    e.notes.add(m.noteId);
  }
  for (const d of defs) {
    const key = `concept:${slugify(d.term)}`;
    const e = byKey.get(key);
    if (e) e.ids.add(d.unitId);
  }
  const actionsByPerson = new Map<string, PlannedPage['actions']>();
  if (opts.people) {
    for (const d of docs) {
      for (const a of extractActions(d)) {
        const who = a.followUp ? a.person : a.owner !== 'me' ? a.owner : undefined;
        if (!who) continue;
        const key = [...byKey.keys()].find((k) => k.startsWith('person:') && (k === `person:${slugify(who)}` || byKey.get(k)!.name.split(' ')[0]!.toLowerCase() === who.toLowerCase()));
        if (!key) continue;
        const list = actionsByPerson.get(key) ?? [];
        list.push({ text: a.text, unitId: a.unitId, done: a.done, followUp: a.followUp, ...(a.due ? { due: a.due } : {}) });
        actionsByPerson.set(key, list);
        byKey.get(key)!.ids.add(a.unitId);
      }
    }
  }
  for (const [key, e] of byKey) {
    // Concepts and projects need two sentences (one mention is a passing reference); people one.
    if (e.kind !== 'person' && e.ids.size < 2) continue;
    if (e.kind === 'concept' && pages.has(`topic:${key.slice(8)}`)) continue;
    const p = page(key, e.kind, e.name);
    for (const id of e.ids) p.ids.add(id);
    if (e.kind === 'person') p.actions = actionsByPerson.get(key) ?? [];
  }

  if (defs.length) {
    const p = page('glossary', 'glossary', 'Glossary');
    for (const d of defs) p.ids.add(d.unitId);
  }

  const planned: PlannedPage[] = [];
  for (const [key, p] of pages) {
    let ids = [...p.ids].filter((id) => units.has(id));
    if (ids.length > max) {
      const ranked = [...ids].sort((a, b) => weight(units.get(b)!, claimUnits, defUnits) - weight(units.get(a)!, claimUnits, defUnits));
      const keep = new Set(ranked.slice(0, max));
      ids = ids.filter((id) => keep.has(id));
    }
    ids.sort((a, b) => order.get(a)! - order.get(b)!);
    if (!ids.length) continue;
    const noteIds = [...new Set(ids.map((id) => units.get(id)!.noteId))];
    planned.push({ key, kind: p.kind, title: p.title, unitIds: ids, noteIds, fingerprint: hashText(`${p.title}|${ids.map((id) => units.get(id)!.hash).join(',')}`), ...(p.actions ? { actions: p.actions } : {}) });
  }
  planned.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || a.title.localeCompare(b.title));
  if (planned.length) {
    const titles = planned.map((p) => `${p.kind}:${p.title}`).join('|');
    planned.push({ key: 'index', kind: 'index', title: 'Index', unitIds: [], noteIds: [], fingerprint: hashText(`index|${titles}`) });
  }
  return { pages: planned, units, claims, conflicts };
}

const KIND_ORDER: WikiPageKind[] = ['topic', 'project', 'concept', 'person', 'glossary', 'index'];
const titleCase = (s: string) => s.replace(/\b\p{Ll}/gu, (c) => c.toUpperCase());

// ---- Drafts -----------------------------------------------------------------------------------------

/** One sentence of a draft page: text, tag and the source units it rests on. */
export interface DraftClaim {
  text: string;
  tag: ProvTag;
  units: string[];
  confidence?: number;
  why?: string;
}

const sentence = (s: string) => {
  const t = stripMarkdown(s).replace(/\s+/g, ' ').trim();
  return /[.!?。]$/.test(t) ? t : `${t}.`;
};

/** Conflicts among a page's own sentences (the page must say the sources disagree). */
export function pageConflicts(page: PlannedPage, conflicts: readonly Conflict[]): Conflict[] {
  const ids = new Set(page.unitIds);
  return conflicts.filter((c) => ids.has(c.a.unitId) && ids.has(c.b.unitId));
}

/**
 * The page without any model: quotes of its sources (EXTRACTED), a sentence for each conflict
 * among them (AMBIGUOUS), and for people their open actions and follow-ups. Always correct, if
 * dry — and what a compile produces when no AI is available or the AI's draft fails validation.
 */
export function deterministicDraft(page: PlannedPage, units: ReadonlyMap<string, SourceUnit>, conflicts: readonly Conflict[] = []): DraftClaim[] {
  const out: DraftClaim[] = [];
  const seen = new Set<string>();
  const push = (c: DraftClaim) => {
    const k = normalizeSentence(c.text);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(c);
  };
  if (page.kind === 'glossary') {
    for (const d of extractDefinitions(page.unitIds.map((id) => units.get(id)!).filter(Boolean))) push({ text: `**${d.term}**: ${sentence(d.definition)}`, tag: 'E', units: [d.unitId], confidence: 1 });
    return out;
  }
  if (page.kind === 'person') {
    const notes = new Set(page.unitIds.map((id) => units.get(id)?.title).filter(Boolean));
    const mentionIds = page.unitIds.filter((id) => !page.actions?.some((a) => a.unitId === id));
    if (mentionIds.length) push({ text: `${page.title} comes up in ${notes.size} ${notes.size === 1 ? 'note' : 'notes'}: ${[...notes].slice(0, 6).join(', ')}.`, tag: 'I', units: mentionIds.slice(0, 8), confidence: 1 });
    for (const a of page.actions ?? []) push({ text: `${a.done ? 'Done' : a.followUp ? 'Follow up' : 'To do'}${a.due ? ` (by ${a.due})` : ''}: ${sentence(a.text)}`, tag: 'E', units: [a.unitId], confidence: 1 });
    for (const id of mentionIds) push({ text: sentence(units.get(id)!.text), tag: 'E', units: [id], confidence: 1 });
    return out;
  }
  for (const c of pageConflicts(page, conflicts)) {
    push({ text: `Sources disagree: “${stripMarkdown(c.a.text).replace(/\.$/, '')}” (${units.get(c.a.unitId)?.title ?? 'a note'}) and “${stripMarkdown(c.b.text).replace(/\.$/, '')}” (${units.get(c.b.unitId)?.title ?? 'a note'}).`, tag: 'A', units: [c.a.unitId, c.b.unitId], confidence: c.confidence, why: c.reason });
  }
  for (const id of page.unitIds) {
    const u = units.get(id);
    if (u) push({ text: sentence(u.text), tag: 'E', units: [id], confidence: 1 });
  }
  return out;
}

/** What a model returns for a page (see packages/ai compiler/draft.ts for the prompt). */
export interface ModelSentence {
  text: string;
  /** Short refs as given in the prompt (`S3`) or unit ids. */
  sources: string[];
  tag?: string;
}

export interface ValidationReport {
  kept: number;
  downgraded: number;
  dropped: Array<{ text: string; reason: string }>;
}

/**
 * Checks a model's draft against the sources before anything is shown:
 * - a sentence must cite at least one real source sentence, else it is dropped;
 * - its content words must be found in what it cites (≥ `minSupport`), else it is dropped as
 *   unsupported — this is the hallucination guard;
 * - every number it states must appear in its sources, else it is dropped;
 * - EXTRACTED must be a near-quote (≥ 0.8 of its words in one cited sentence), else it becomes
 *   INFERRED;
 * - a sentence citing sources that conflict is AMBIGUOUS, whatever the model said.
 * Multi-sentence items are split so each claim is one sentence.
 */
export function validateDraft(sentences: readonly ModelSentence[], refs: ReadonlyMap<string, string>, units: ReadonlyMap<string, SourceUnit>, conflicts: readonly Conflict[] = [], opts: { minSupport?: number } = {}): { claims: DraftClaim[]; report: ValidationReport } {
  const minSupport = opts.minSupport ?? 0.34;
  const report: ValidationReport = { kept: 0, downgraded: 0, dropped: [] };
  const claims: DraftClaim[] = [];
  const seen = new Set<string>();
  for (const raw of sentences) {
    const ids = [...new Set((raw.sources ?? []).map((r) => refs.get(String(r).trim().toUpperCase()) ?? (units.has(String(r)) ? String(r) : null)).filter((x): x is string => !!x))];
    for (const part of splitSentences(String(raw.text ?? '').replace(/\n+/g, ' '))) {
      const text = part.text.trim();
      if (!text) continue;
      if (!ids.length) { report.dropped.push({ text, reason: 'cites no source' }); continue; }
      const cited = ids.map((id) => units.get(id)!);
      const words = wordSet(text);
      const all = new Set(cited.flatMap((u) => [...wordSet(u.text)]));
      const support = words.size ? containment(words, all) : 0;
      if (support < minSupport) { report.dropped.push({ text, reason: `not supported by its sources (${Math.round(support * 100)}% of its words found)` }); continue; }
      const srcNums = new Set(cited.flatMap((u) => numbersIn(u.text)));
      const missing = numbersIn(text).filter((n) => !srcNums.has(n));
      if (missing.length) { report.dropped.push({ text, reason: `states ${missing.join(', ')}, which its sources don't` }); continue; }
      let tag: ProvTag = raw.tag?.toUpperCase().startsWith('E') ? 'E' : raw.tag?.toUpperCase().startsWith('A') ? 'A' : 'I';
      let why: string | undefined;
      if (tag === 'E' && !cited.some((u) => containment(words, wordSet(u.text)) >= 0.8)) { tag = 'I'; why = 'not a quote of its source'; report.downgraded++; }
      const clash = conflicts.find((c) => ids.includes(c.a.unitId) && ids.includes(c.b.unitId));
      if (clash) { tag = 'A'; why = clash.reason; }
      const k = normalizeSentence(text);
      if (seen.has(k)) continue;
      seen.add(k);
      claims.push({ text: sentence(text), tag, units: ids, confidence: Math.round(support * 100) / 100, ...(why ? { why } : {}) });
      report.kept++;
    }
  }
  return { claims, report };
}

/** Draft claims with their anchors, as stored in provenance.json. */
export function toProvClaims(draft: readonly DraftClaim[], units: ReadonlyMap<string, SourceUnit>): ProvClaim[] {
  return draft.map((d) => ({
    s: d.text,
    t: d.tag,
    src: d.units.map((id) => units.get(id)).filter((u): u is SourceUnit => !!u).map(unitAnchor),
    ...(d.confidence != null ? { c: d.confidence } : {}),
    ...(d.why ? { why: d.why } : {}),
  }));
}

// ---- Rendering and diffs ------------------------------------------------------------------------

export const COMPILED_TAG = 'compiled';

/**
 * The page's Markdown: a heading, one bullet per claim (so each claim is one sentence the
 * provenance can find again), and the source notes as `[[links]]` (backlinks for free).
 */
export function renderPage(title: string, claims: readonly Pick<ProvClaim, 's'>[], sourceTitles: readonly string[], opts: { index?: readonly { title: string; kind: WikiPageKind }[] } = {}): string {
  const lines = [`# ${title}`, ''];
  if (opts.index) {
    for (const kind of KIND_ORDER) {
      const list = opts.index.filter((p) => p.kind === kind);
      if (!list.length) continue;
      lines.push(`## ${KIND_HEADINGS[kind]}`, ...list.map((p) => `- [[${p.title}]]`), '');
    }
  } else {
    for (const c of claims) lines.push(`- ${c.s}`);
  }
  const titles = [...new Set(sourceTitles)].filter(Boolean);
  if (titles.length) lines.push('', `Sources: ${titles.map((t) => `[[${t}]]`).join(' · ')}`);
  return lines.join('\n').trim();
}

const KIND_HEADINGS: Record<WikiPageKind, string> = { topic: 'Topics', project: 'Projects', concept: 'Concepts', person: 'People', glossary: 'Glossary', index: 'Index' };

export interface ClaimDiff {
  added: ProvClaim[];
  removed: ProvClaim[];
  kept: ProvClaim[];
}

/** Claims a new draft adds and removes compared with the current page (by normalised sentence). */
export function diffClaims(current: readonly ProvClaim[], next: readonly ProvClaim[]): ClaimDiff {
  const cur = new Map(current.map((c) => [normalizeSentence(c.s), c]));
  const nxt = new Map(next.map((c) => [normalizeSentence(c.s), c]));
  return {
    added: next.filter((c) => !cur.has(normalizeSentence(c.s))),
    removed: current.filter((c) => !nxt.has(normalizeSentence(c.s))),
    // Kept sentences take the new anchors (their sources may have moved on the page).
    kept: next.filter((c) => cur.has(normalizeSentence(c.s))),
  };
}

/** The claims a page ends up with after the user picks which added/removed claims to accept. */
export function applyClaimChoice(diff: ClaimDiff, accept: { added: ReadonlySet<string>; removed: ReadonlySet<string> }, nextOrder: readonly ProvClaim[]): ProvClaim[] {
  const take = new Set([...diff.kept, ...diff.added.filter((c) => accept.added.has(normalizeSentence(c.s)))].map((c) => normalizeSentence(c.s)));
  const out = nextOrder.filter((c) => take.has(normalizeSentence(c.s)));
  // Removals the user rejected stay, at the end.
  for (const c of diff.removed) if (!accept.removed.has(normalizeSentence(c.s))) out.push(c);
  return out;
}

// ---- Compiler state -------------------------------------------------------------------------------

/** What the compiler remembers about a page it made (`ai/compiler/state.json`). */
export interface CompiledPage {
  key: string;
  kind: WikiPageKind;
  title: string;
  noteId: string;
  pageId: string;
  textId: string;
  fingerprint: string;
  sourceNotes: string[];
  at: number;
}

export interface CompilerState {
  formatVersion: 1;
  pages: Record<string, CompiledPage>;
  /** Pages whose proposed change the user rejected, by key → fingerprint: not proposed again until their sources change. */
  declined?: Record<string, string>;
  lastCompileAt?: number;
}

export const emptyCompilerState = (): CompilerState => ({ formatVersion: 1, pages: {} });

/** Pages that are new or whose sources changed, and compiled pages that lost all their sources. */
export function compileWork(plan: readonly PlannedPage[], state: CompilerState, opts: { only?: ReadonlySet<string>; force?: boolean } = {}): { changed: PlannedPage[]; orphaned: CompiledPage[] } {
  const changed = plan.filter((p) => (!opts.only || opts.only.has(p.key)) && (opts.force || (state.pages[p.key]?.fingerprint !== p.fingerprint && state.declined?.[p.key] !== p.fingerprint)));
  const keys = new Set(plan.map((p) => p.key));
  const orphaned = opts.only ? [] : Object.values(state.pages).filter((p) => !keys.has(p.key));
  return { changed, orphaned };
}

/** A generation record for drafts made without a model. */
export const deterministicGen = (at: number, prompt = 'compiler.extract/1'): ProvenanceGen => ({ by: 'Compiler without AI (quotes only)', provider: 'deterministic', prompt, at });
