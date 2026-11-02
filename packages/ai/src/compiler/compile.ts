/**
 * Compiling the wiki end to end, over any host (the app, the MCP server's runner, tests):
 *
 *   sources ──extract──► units ──plan──► pages ──(changed only)──► draft (model or rules)
 *          ──validate──► claims with anchors ──diff vs the page now──► a proposal
 *
 * Nothing is written to a note by `compileWiki`: it produces a *proposal* (a file in
 * `ai/compiler/proposals/`) the user reviews claim by claim. `applyWikiProposal` then writes the
 * accepted changes through a `WikiTarget` and logs every one as an activity op, so the whole
 * accept can be undone from AI activity like any agent change. Provenance for each page is
 * written next to it (`assets/provenance.json`).
 *
 * Re-compiling is incremental (page fingerprints); a page whose sentences did not change but
 * whose sources moved is refreshed silently (new anchors, no proposal), so staleness clears
 * without asking the user to approve nothing.
 */
import {
  applyClaimChoice,
  compileWork,
  diffClaims,
  extractSource,
  locateClaims,
  newId,
  planWiki,
  renderPage,
  setItem,
  textItemKey,
  toProvClaims,
  COMPILED_TAG,
  deterministicGen,
  normalizeSentence,
  parseAnchor,
  unitAnchor,
  type SourceUnit,
  type CompiledPage,
  type CompilerState,
  type NoteMeta,
  type PageInk,
  type PdfTextItem,
  type PlannedPage,
  type ProvClaim,
  type ProvenanceFile,
  type ProvenanceGen,
  type RecordingTranscript,
  type SourceDoc,
  type WikiPlan,
} from '@inkstone/core';
import type { NewActivityOp } from '../activity.ts';
import { compileGen, draftPage, type CompilerAI } from './draft.ts';
import type { CompilerConfig, CompilerStore, ProposalItem, WikiProposal } from './store.ts';

/** One source note as the host read it. */
export interface SourceNote {
  meta: NoteMeta;
  pages: PageInk[];
  transcripts?: RecordingTranscript[];
  pdfText?: ReadonlyMap<number, readonly PdfTextItem[]>;
}

/** The notes a config selects: in a source notebook (or below it), with a source tag, or picked. */
export function selectSources(notes: readonly NoteMeta[], config: CompilerConfig, opts: { notebookParents?: ReadonlyMap<string, string | undefined>; exclude?: ReadonlySet<string> } = {}): NoteMeta[] {
  const nbs = new Set(config.sources.notebooks);
  const tags = new Set(config.sources.tags.map((t) => t.toLowerCase()));
  const picked = new Set(config.sources.notes);
  const inNotebook = (id?: string): boolean => {
    for (let cur = id, guard = 0; cur && guard < 32; cur = opts.notebookParents?.get(cur), guard++) if (nbs.has(cur)) return true;
    return false;
  };
  return notes.filter((n) => n.trashedAt == null && !n.lock && !opts.exclude?.has(n.id) && n.notebookId !== config.notebookId && !n.tags.includes(COMPILED_TAG)
    && (picked.has(n.id) || inNotebook(n.notebookId) || n.tags.some((t) => tags.has(t.toLowerCase()))));
}

export interface CompileOptions {
  store: CompilerStore;
  sources: readonly SourceNote[];
  ai: CompilerAI | null;
  /** Shown on the proposal ("Compile now", "Nightly", "Re-check"). */
  reason: string;
  now?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number, title: string) => void;
  /** Only these page keys (re-check). */
  only?: ReadonlySet<string>;
  /** Recompile even unchanged pages. */
  force?: boolean;
  /** The current claims of a compiled page (from its provenance file). */
  currentClaims: (page: CompiledPage) => Promise<ProvClaim[] | null>;
  /** Writes new anchors for a page whose sentences did not change. */
  refresh?: (page: CompiledPage, claims: ProvClaim[], gen: ProvenanceGen) => Promise<void>;
}

export interface CompileResult {
  proposal: WikiProposal | null;
  plan: WikiPlan;
  docs: SourceDoc[];
  /** Pages drafted. */
  compiled: number;
  /** Pages refreshed without a proposal (sources moved, same sentences). */
  refreshed: number;
  /** Pages the model drafted but validation fell back to quotes for. */
  fallbacks: number;
}

/** Extracts, plans, drafts the pages that changed, and stores one proposal with every change. */
export async function compileWiki(o: CompileOptions): Promise<CompileResult> {
  const now = o.now ?? Date.now();
  const config = await o.store.config();
  const state = await o.store.state();
  const compiledIds = new Set(Object.values(state.pages).map((p) => p.noteId));
  const docs = o.sources.filter((s) => !compiledIds.has(s.meta.id)).map((s) => extractSource(s.meta, s.pages, { transcripts: s.transcripts, pdfText: s.pdfText }));
  const plan = planWiki(docs, { people: config.people, ignoreTags: [COMPILED_TAG] });
  const content = plan.pages.filter((p) => p.kind !== 'index');
  const work = compileWork(content, state, { only: o.only, force: o.force });
  const gen = compileGen(o.ai, now);
  const items: ProposalItem[] = [];
  let refreshed = 0;
  let fallbacks = 0;
  const titleOf = new Map(docs.map((d) => [d.noteId, d.title]));
  let done = 0;
  for (const page of work.changed) {
    o.signal?.throwIfAborted();
    o.onProgress?.(done++, work.changed.length, page.title);
    const draft = await draftPage(page, plan, o.ai, { signal: o.signal });
    if (o.ai && !draft.byModel && draft.fallback) fallbacks++;
    const next = toProvClaims(draft.claims, plan.units);
    const existing = state.pages[page.key];
    const current = existing ? await o.currentClaims(existing) : null;
    const sourceTitles = page.noteIds.map((id) => titleOf.get(id) ?? '').filter(Boolean);
    const itemGen = o.ai && !draft.byModel ? compileGen(null, now) : undefined;
    if (existing && current) {
      const diff = diffClaims(current, next);
      if (!diff.added.length && !diff.removed.length) {
        // Same sentences; only the anchors moved. Refresh quietly.
        await o.refresh?.(existing, next, itemGen ?? gen);
        state.pages[page.key] = { ...existing, fingerprint: page.fingerprint, sourceNotes: page.noteIds, at: now };
        refreshed++;
        continue;
      }
      items.push({ id: newId(now), key: page.key, kind: page.kind, title: page.title, action: 'update', noteId: existing.noteId, fingerprint: page.fingerprint, sourceNotes: page.noteIds, sourceTitles, ...diff, next, dropped: draft.report.dropped, ...(itemGen ? { gen: itemGen } : {}), ...(draft.fallback ? { note: draft.fallback } : {}) });
    } else {
      items.push({ id: newId(now), key: page.key, kind: page.kind, title: page.title, action: 'create', fingerprint: page.fingerprint, sourceNotes: page.noteIds, sourceTitles, added: next, removed: [], kept: [], next, dropped: draft.report.dropped, ...(itemGen ? { gen: itemGen } : {}), ...(draft.fallback ? { note: draft.fallback } : {}) });
    }
  }
  o.onProgress?.(done, work.changed.length, '');
  // Pages whose sentences are unchanged may still have moved on their pages: re-anchor them.
  if (o.refresh) {
    const byHash = new Map<string, SourceUnit>();
    for (const u of plan.units.values()) byHash.set(`${u.noteId}#${u.hash}`, u);
    const changedKeys = new Set(work.changed.map((p) => p.key));
    for (const page of content) {
      const existing = state.pages[page.key];
      if (!existing || changedKeys.has(page.key)) continue;
      const claims = await o.currentClaims(existing);
      if (!claims?.length) continue;
      let moved = false;
      const next = claims.map((c) => ({ ...c, src: c.src.map((s) => {
        const a = parseAnchor(s);
        const u = a ? byHash.get(`${a.noteId}#${a.h}`) : undefined;
        const fresh = u ? unitAnchor(u) : s;
        if (fresh !== s) moved = true;
        return fresh;
      }) }));
      if (!moved) continue;
      await o.refresh(existing, next, deterministicGen(now, 'compiler.reanchor/1'));
      refreshed++;
    }
  }
  for (const orphan of work.orphaned) {
    if (orphan.kind === 'index') continue;
    const current = (await o.currentClaims(orphan)) ?? [];
    items.push({ id: newId(now), key: orphan.key, kind: orphan.kind, title: orphan.title, action: 'archive', noteId: orphan.noteId, fingerprint: '', sourceNotes: [], sourceTitles: [], added: [], removed: current, kept: [], next: [], dropped: [] });
  }
  // The index follows the set of pages that will exist once these changes are accepted.
  const indexPlan = plan.pages.find((p) => p.kind === 'index');
  if (indexPlan && !o.only && (items.length || state.pages.index?.fingerprint !== indexPlan.fingerprint)) {
    const list = content.map((p) => ({ title: p.title, kind: p.kind }));
    const next: ProvClaim[] = list.map((p) => ({ s: `[[${p.title}]]`, t: 'E', src: [] }));
    const existing = state.pages.index;
    const current = existing ? (await o.currentClaims(existing)) ?? [] : [];
    const diff = diffClaims(current, next);
    if (!existing || diff.added.length || diff.removed.length) {
      items.push({ id: newId(now), key: 'index', kind: 'index', title: 'Index', action: existing ? 'update' : 'create', ...(existing ? { noteId: existing.noteId } : {}), fingerprint: indexPlan.fingerprint, sourceNotes: [], sourceTitles: [], ...diff, next, dropped: [], index: list, gen: compileGen(null, now) });
    }
  }
  state.lastCompileAt = now;
  await o.store.saveState(state);
  let proposal: WikiProposal | null = null;
  if (items.length) {
    proposal = { id: newId(now), createdAt: now, reason: o.reason, gen, items, status: 'pending' };
    await o.store.saveProposal(proposal);
  }
  return { proposal, plan, docs, compiled: work.changed.length, refreshed, fallbacks };
}

// ---- Applying -------------------------------------------------------------------------------------

/** How accepted changes reach the notes (the app: through open documents and the vault). */
export interface WikiTarget {
  /** The notebook for compiled pages (made on first use), and the one for people pages inside it. */
  ensureNotebook(name: string, parentId?: string): Promise<string>;
  createPage(args: { title: string; notebookId: string; markdown: string; tags: string[] }): Promise<{ noteId: string; pageId: string; textId: string; title: string }>;
  /** The page's text box, or null if gone. */
  readText(noteId: string, pageId: string, textId: string): Promise<string | null>;
  replaceText(noteId: string, pageId: string, textId: string, expected: string, next: string): Promise<'replaced' | 'changed' | 'missing'>;
  trashNote(noteId: string): Promise<boolean>;
  readProvenance(noteId: string): Promise<ProvenanceFile>;
  writeProvenance(noteId: string, file: ProvenanceFile): Promise<void>;
}

/** Per item: accept or reject, and optionally which added/removed claims (normalised sentences). */
export type ProposalChoice = Record<string, { accept: boolean; added?: ReadonlySet<string>; removed?: ReadonlySet<string> }>;

export const WIKI_NOTEBOOK = 'Compiled wiki';
export const PEOPLE_NOTEBOOK = 'People';

/**
 * Lines of a compiled page the user wrote themselves (no provenance, not the generated heading or
 * sources line): kept below the new claims when the page is updated, so accepting a proposal
 * never deletes the user's own words.
 */
export function userLines(text: string, file: ProvenanceFile | null, key: string): string[] {
  const located = locateClaims(text, file, key);
  const out: string[] = [];
  for (const s of located) {
    if (s.claim) continue;
    const t = s.text.trim();
    if (/^#{1,6}\s/.test(t) || /^Sources:/.test(t) || /^-?\s*\[\[[^\]]+\]\]$/.test(t)) continue;
    out.push(t);
  }
  return out;
}

export interface ApplyResult {
  applied: number;
  rejected: number;
  /** Items that could not be applied, with why. */
  problems: string[];
}

/**
 * Applies the user's choices: accepted items are written (and logged through `record`), rejected
 * ones are remembered so the same change is not proposed again until its sources change.
 */
export async function applyWikiProposal(proposal: WikiProposal, choice: ProposalChoice, deps: { store: CompilerStore; target: WikiTarget; record: (op: NewActivityOp) => void; now?: number }): Promise<ApplyResult> {
  const now = deps.now ?? Date.now();
  const { store, target } = deps;
  const config = await store.config();
  const state: CompilerState = await store.state();
  const res: ApplyResult = { applied: 0, rejected: 0, problems: [] };
  let wikiNb: string | null = null;
  let peopleNb: string | null = null;
  const notebookFor = async (kind: string) => {
    if (!wikiNb) {
      wikiNb = await target.ensureNotebook(WIKI_NOTEBOOK);
      if (config.notebookId !== wikiNb) await store.saveConfig({ ...config, notebookId: wikiNb });
    }
    if (kind !== 'person') return wikiNb;
    return (peopleNb ??= await target.ensureNotebook(PEOPLE_NOTEBOOK, wikiNb));
  };
  for (const item of proposal.items) {
    if (item.decision) continue;
    const c = choice[item.id];
    if (!c) continue;
    if (!c.accept) {
      item.decision = 'rejected';
      item.decidedAt = now;
      if (item.fingerprint) (state.declined ??= {})[item.key] = item.fingerprint;
      res.rejected++;
      continue;
    }
    const gen = item.gen ?? proposal.gen;
    const diff = { added: item.added, removed: item.removed, kept: item.kept };
    const all = (list: ProvClaim[]) => new Set(list.map((x) => normalizeSentence(x.s)));
    const claims = applyClaimChoice(diff, { added: c.added ?? all(item.added), removed: c.removed ?? all(item.removed) }, item.next);
    try {
      if (item.action === 'archive') {
        if (item.noteId && (await target.trashNote(item.noteId))) {
          deps.record({ kind: 'note_trashed', tool: 'compile_wiki', noteId: item.noteId, title: item.title, summary: `Archived the compiled page “${item.title}” (its sources are gone)` });
        }
        delete state.pages[item.key];
      } else if (item.action === 'create') {
        const markdown = renderPage(item.title, claims, item.sourceTitles, item.index ? { index: item.index } : {});
        const nb = await notebookFor(item.kind);
        const made = await target.createPage({ title: item.title, notebookId: nb, markdown, tags: [COMPILED_TAG] });
        deps.record({ kind: 'note_created', tool: 'compile_wiki', noteId: made.noteId, title: made.title, summary: `Compiled “${made.title}” (${claims.length} ${claims.length === 1 ? 'claim' : 'claims'})` });
        const prov = await target.readProvenance(made.noteId);
        await target.writeProvenance(made.noteId, setItem(prov, textItemKey(made.textId), gen, claims, now));
        state.pages[item.key] = { key: item.key, kind: item.kind, title: item.title, noteId: made.noteId, pageId: made.pageId, textId: made.textId, fingerprint: item.fingerprint, sourceNotes: item.sourceNotes, at: now };
      } else {
        const page = state.pages[item.key];
        if (!page) throw new Error('the compiled page is no longer known');
        const before = await target.readText(page.noteId, page.pageId, page.textId);
        if (before == null) throw new Error('the compiled page was deleted');
        const prov = await target.readProvenance(page.noteId);
        const mine = userLines(before, prov, textItemKey(page.textId));
        let markdown = renderPage(item.title, claims, item.sourceTitles, item.index ? { index: item.index } : {});
        if (mine.length) markdown += `\n\n## Your notes\n${mine.map((l) => (/^[-*]\s/.test(l) ? l : `- ${l}`)).join('\n')}`;
        const r = await target.replaceText(page.noteId, page.pageId, page.textId, before, markdown);
        if (r !== 'replaced') throw new Error(r === 'changed' ? 'the page changed while applying; compile again' : 'the compiled page was deleted');
        deps.record({ kind: 'text_replaced', tool: 'compile_wiki', noteId: page.noteId, title: item.title, pageId: page.pageId, textId: page.textId, before, after: markdown, summary: `Updated the compiled page “${item.title}” (+${item.added.length} / −${item.removed.length})` });
        await target.writeProvenance(page.noteId, setItem(prov, textItemKey(page.textId), gen, claims, now));
        state.pages[item.key] = { ...page, title: item.title, fingerprint: item.fingerprint, sourceNotes: item.sourceNotes, at: now };
      }
      item.decision = 'accepted';
      item.decidedAt = now;
      if (state.declined) delete state.declined[item.key];
      res.applied++;
    } catch (e) {
      res.problems.push(`${item.title}: ${(e as Error).message}`);
    }
  }
  if (proposal.items.every((i) => i.decision)) proposal.status = 'done';
  await store.saveProposal(proposal);
  await store.saveState(state);
  return res;
}

/** A plan page's key for a compiled note (used by "re-check" from a stale claim). */
export function pageKeyOfNote(state: CompilerState, noteId: string): string | null {
  return Object.values(state.pages).find((p) => p.noteId === noteId)?.key ?? null;
}

export type { PlannedPage };
