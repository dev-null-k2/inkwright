/**
 * The context compiler in the app (docs/COMPILER.md): keeps every note's extraction in step with
 * the vault, runs the contradiction ledger in the background, compiles the wiki on demand (and
 * for the nightly routine through the `compile_wiki` tool), applies accepted proposals through
 * the activity log, and answers staleness questions for any provenance in the app.
 *
 * Background work is deliberately small: extraction is cached per note version, the ledger scan
 * is debounced to a few seconds after saves and runs at idle, and the only model it ever uses is
 * an on-device one (for grey-zone conflicts, a handful per scan). Compiling uses the AI the
 * compiler settings pick — on this device by default.
 */
import { create } from 'zustand';
import {
  CompilerStore,
  DEFAULT_COMPILER_CONFIG,
  RunRecorder,
  adjudicate,
  applyProposal,
  compileWiki,
  createCompilerTools,
  scanLedger,
  selectSources,
  type AgentTool,
  type CompilerAI,
  type CompilerConfig,
  type CompilerToolHost,
  type LedgerConflict,
  type LedgerDecision,
  type ProposalChoice,
  type SourceNote,
  type WikiProposal,
} from '@inkstone/ai';
import {
  COMPILED_TAG,
  anchorLink,
  claimFreshness,
  extractActions,
  extractSource,
  setItem,
  sourceHashes,
  textItemKey,
  type CompiledPage,
  type Conflict,
  type ProvClaim,
  type ProvenanceGen,
  type SourceDoc,
  type SourceUnit,
  type NoteMeta,
} from '@inkstone/core';
import { getActiveAI } from '../lib/ai.ts';
import { localActiveAI } from '../lib/localai.ts';
import { appMemory } from '../lib/memory.ts';
import { loadNoteTranscripts } from '../lib/listen/transcripts.ts';
import type { AppVault } from '../lib/vault.ts';
import { agentHub } from '../lib/agent/hub.ts';
import { AppWikiTarget, readNoteProvenance, writeNoteProvenance } from './target.ts';

export interface CompilerUIState {
  ready: boolean;
  config: CompilerConfig;
  proposals: WikiProposal[];
  pages: CompiledPage[];
  compiling: { done: number; total: number; title: string } | null;
  /** One line about the last compile. */
  lastResult: string | null;
  conflicts: LedgerConflict[];
  decided: Array<{ conflict: Conflict; decision: LedgerDecision }>;
  scannedAt: number;
  /** Stale or missing claims per compiled note. */
  stale: Record<string, number>;
  /** Bumped when extraction changes (views recompute). */
  version: number;
  error: string | null;
}

export const useCompiler = create<CompilerUIState>(() => ({
  ready: false, config: DEFAULT_COMPILER_CONFIG, proposals: [], pages: [], compiling: null, lastResult: null,
  conflicts: [], decided: [], scannedAt: 0, stale: {}, version: 0, error: null,
}));

let vaultRef: AppVault | null = null;
let store: CompilerStore | null = null;
const docs = new Map<string, { at: number; doc: SourceDoc }>();
let scanTimer: ReturnType<typeof setTimeout> | null = null;
let scanning: Promise<void> | null = null;
let abort: AbortController | null = null;
/** Model verdicts on grey-zone pairs, by conflict id (asked once per pair per session). */
const adjudicated = new Map<string, LedgerConflict | null>();

declare const __E2E__: boolean;

export function compilerStore(): CompilerStore {
  if (!store) throw new Error('Your notes are still opening.');
  return store;
}

export function compilerVault(): AppVault {
  if (!vaultRef) throw new Error('Your notes are still opening.');
  return vaultRef;
}

/** Starts the compiler once the vault is open (idempotent). */
export function startCompiler(vault: AppVault): void {
  if (vaultRef === vault) return;
  vaultRef = vault;
  store = new CompilerStore(vault.fs);
  store.onChange(() => void refreshStoreState());
  vault.vault.onChange((c) => {
    if (c.type === 'reloaded') { docs.clear(); void refreshStoreState(); }
    if (c.type === 'note' || c.type === 'note-deleted' || c.type === 'reloaded') scheduleScan();
  });
  if (typeof __E2E__ !== 'undefined' && __E2E__) (window as unknown as { __inkstoneCompiler?: unknown }).__inkstoneCompiler = { scanNow, compileNow, store, docs: () => [...docs.values()].map((d) => d.doc) };
  void refreshStoreState().then(() => scheduleScan(1500));
}

async function refreshStoreState(): Promise<void> {
  if (!store) return;
  const [config, proposals, state] = await Promise.all([store.config(), store.proposals(), store.state()]);
  useCompiler.setState({ ready: true, config, proposals, pages: Object.values(state.pages) });
}

export async function setCompilerConfig(patch: Partial<CompilerConfig>): Promise<void> {
  const s = compilerStore();
  await s.saveConfig({ ...(await s.config()), ...patch });
  scheduleScan(300);
}

// ---- Extraction cache ------------------------------------------------------------------------------

/** Notes the compiler may read: not trashed, not locked. */
async function readableNotes(): Promise<NoteMeta[]> {
  return (await compilerVault().listNotes()).filter((n) => n.trashedAt == null && !n.lock);
}

async function sourceNote(meta: NoteMeta): Promise<SourceNote> {
  const v = compilerVault();
  const pages = await v.vault.readPages(meta);
  const transcripts = meta.recordings?.length ? await loadNoteTranscripts(v, meta).catch(() => []) : [];
  const pdfText = appMemory()?.pdfTextOf(meta, pages);
  return { meta, pages, transcripts, ...(pdfText?.size ? { pdfText } : {}) };
}

/** Extraction of every readable note, from cache when the note hasn't changed. */
export async function allDocs(): Promise<SourceDoc[]> {
  const notes = await readableNotes();
  const live = new Set(notes.map((n) => n.id));
  for (const id of [...docs.keys()]) if (!live.has(id)) docs.delete(id);
  for (const n of notes) {
    const c = docs.get(n.id);
    if (c && c.at === n.updatedAt) continue;
    const s = await sourceNote(n);
    docs.set(n.id, { at: n.updatedAt, doc: extractSource(s.meta, s.pages, { transcripts: s.transcripts, pdfText: s.pdfText }) });
  }
  return notes.map((n) => docs.get(n.id)!.doc);
}

export function cachedDoc(noteId: string): SourceDoc | null {
  return docs.get(noteId)?.doc ?? null;
}

/** Current sentence hashes of a note (null when gone), for staleness. */
export function hashLookup(noteId: string): ReadonlySet<string> | null {
  const d = docs.get(noteId)?.doc;
  return d ? sourceHashes(d) : null;
}

export function unitById(id: string): SourceUnit | null {
  const noteId = id.split(':')[0]!;
  return docs.get(noteId)?.doc.units.find((u) => u.id === id) ?? null;
}

// ---- The ledger (background) ---------------------------------------------------------------------

export function scheduleScan(ms = 3000): void {
  if (scanTimer) clearTimeout(scanTimer);
  scanTimer = setTimeout(() => {
    scanTimer = null;
    const ric = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(() => void scanNow(), { timeout: 4000 });
    else void scanNow();
  }, ms);
}

/** The on-device model, if one is installed (the only model background work may use). */
function deviceAI(): CompilerAI | null {
  for (const kind of ['native', 'device', 'chrome'] as const) {
    try {
      const l = localActiveAI(kind);
      if (l) return { provider: l.provider, model: l.model, label: l.label, where: 'device' };
    } catch { /* engine not available here */ }
  }
  return null;
}

/** The AI compiles use, per the compiler settings (never a cloud model unless set to "My AI"). */
export async function compilerAI(config: CompilerConfig): Promise<CompilerAI | null> {
  if (config.ai === 'none') return null;
  if (config.ai === 'device') return deviceAI();
  const a = await getActiveAI().catch(() => null);
  return a ? { provider: a.provider, model: a.model, label: a.label, where: a.label.startsWith('On this device') ? 'device' : a.provider.id } : null;
}

/** Re-extracts changed notes, finds conflicts and stale claims. Safe to call any time. */
export function scanNow(): Promise<void> {
  scanning ??= (async () => {
    try {
      const s = compilerStore();
      const config = await s.config();
      const state = await s.state();
      const compiled = new Set(Object.values(state.pages).map((p) => p.noteId));
      const all = await allDocs();
      const sources = all.filter((d) => !compiled.has(d.noteId) && !d.tags.includes(COMPILED_TAG));
      const decisions = await s.decisions();
      const scan = config.ledger ? scanLedger(sources, decisions, { threshold: config.threshold }) : { open: [], candidates: [], decided: [], claims: [] };
      let open = scan.open;
      const ai = config.ledger ? deviceAI() : null;
      if (ai && scan.candidates.length) {
        const ask = scan.candidates.filter((c) => !adjudicated.has(c.id)).slice(0, 4);
        if (ask.length) {
          const yes = await adjudicate(ai, ask).catch(() => []);
          for (const c of ask) adjudicated.set(c.id, yes.find((y) => y.id === c.id) ?? null);
        }
        open = [...open, ...scan.candidates.map((c) => adjudicated.get(c.id)).filter((c): c is LedgerConflict => !!c)].sort((a, b) => b.confidence - a.confidence);
      }
      const stale: Record<string, number> = {};
      for (const p of Object.values(state.pages)) {
        const prov = await readNoteProvenance(compilerVault(), p.noteId);
        const n = (prov.items[textItemKey(p.textId)]?.claims ?? []).filter((c) => claimFreshness(c, hashLookup) !== 'fresh').length;
        if (n) stale[p.noteId] = n;
      }
      useCompiler.setState((st) => ({ conflicts: open, decided: scan.decided, scannedAt: Date.now(), stale, version: st.version + 1, error: null }));
    } catch (e) {
      console.warn('compiler scan failed', e);
      useCompiler.setState({ error: (e as Error).message });
    } finally {
      scanning = null;
    }
  })();
  return scanning;
}

export async function decideConflict(c: Conflict, status: LedgerDecision['status'], note?: string): Promise<void> {
  await compilerStore().decide({ id: c.id, status, a: c.a.text, b: c.b.text, at: Date.now(), ...(note?.trim() ? { note: note.trim() } : {}) });
  await scanNow();
}

export async function reopenConflict(id: string): Promise<void> {
  await compilerStore().undecide(id);
  await scanNow();
}

/** Open conflicts touching a note (for its inline badges). */
export function conflictsInNote(noteId: string, list = useCompiler.getState().conflicts): Array<{ conflict: LedgerConflict; mine: 'a' | 'b' }> {
  const out: Array<{ conflict: LedgerConflict; mine: 'a' | 'b' }> = [];
  for (const c of list) {
    if (c.a.noteId === noteId) out.push({ conflict: c, mine: 'a' });
    if (c.b.noteId === noteId) out.push({ conflict: c, mine: 'b' });
  }
  return out;
}

// ---- Compiling ----------------------------------------------------------------------------------------

/** The source notes the settings select, read fresh. */
export async function compileSources(config: CompilerConfig): Promise<SourceNote[]> {
  const v = compilerVault();
  const notebooks = await v.listNotebooks();
  const picked = selectSources(await v.listNotes(), config, { notebookParents: new Map(notebooks.map((n) => [n.id, n.parentId])) });
  const out: SourceNote[] = [];
  for (const n of picked) out.push(await sourceNote(n));
  return out;
}

/**
 * Compiles now. Returns the new proposal (or null when nothing changed). `only` + `force`
 * re-check single pages (from a stale claim).
 */
export async function compileNow(reason = 'Compile now', opts: { only?: ReadonlySet<string>; force?: boolean } = {}): Promise<WikiProposal | null> {
  const s = compilerStore();
  const v = compilerVault();
  if (useCompiler.getState().compiling) throw new Error('A compile is already running.');
  await (await import('../lib/session.ts')).activeSession()?.flush();
  const config = await s.config();
  if (!config.sources.notebooks.length && !config.sources.tags.length && !config.sources.notes.length) throw new Error('Choose what to compile first: a notebook, a tag or notes.');
  abort = new AbortController();
  useCompiler.setState({ compiling: { done: 0, total: 0, title: '' }, error: null });
  try {
    const ai = await compilerAI(config);
    const r = await compileWiki({
      store: s, sources: await compileSources(config), ai, reason, signal: abort.signal, ...opts,
      onProgress: (done, total, title) => useCompiler.setState({ compiling: { done, total, title } }),
      currentClaims: async (p) => {
        const n = await v.vault.readNote(p.noteId);
        if (!n || n.trashedAt != null) return null;
        return (await readNoteProvenance(v, p.noteId)).items[textItemKey(p.textId)]?.claims ?? [];
      },
      refresh: async (p, claims, gen) => { await writeNoteProvenance(v, p.noteId, setItem(await readNoteProvenance(v, p.noteId), textItemKey(p.textId), gen, claims, gen.at)); },
    });
    const n = r.proposal?.items.length ?? 0;
    const who = ai ? ai.label : 'no AI (quotes only)';
    useCompiler.setState({ lastResult: r.proposal ? `${n} ${n === 1 ? 'change' : 'changes'} to review · written by ${who}${r.fallbacks ? ` · ${r.fallbacks} ${r.fallbacks === 1 ? 'page' : 'pages'} fell back to quotes` : ''}` : r.refreshed ? `Up to date (${r.refreshed} ${r.refreshed === 1 ? 'page' : 'pages'} re-anchored)` : 'Up to date: no sources changed.' });
    await refreshStoreState();
    scheduleScan(200);
    return r.proposal;
  } finally {
    abort = null;
    useCompiler.setState({ compiling: null });
  }
}

export function cancelCompile(): void {
  abort?.abort();
}

/** Applies the user's choices, logged as one activity run (undo from AI activity). */
export async function decideProposal(id: string, choice: ProposalChoice): Promise<{ applied: number; rejected: number; problems: string[]; runId?: string }> {
  const s = compilerStore();
  const p = await s.proposal(id);
  if (!p) throw new Error('That proposal is gone.');
  const hub = agentHub();
  const recorder = new RunRecorder(hub?.activity ?? null, { source: 'assistant', label: 'Compiled wiki', prompt: `Accepted changes from “${p.reason}”` });
  const res = await applyProposal(p, choice, { store: s, target: new AppWikiTarget(compilerVault()), record: recorder.record });
  const run = await recorder.finish('done');
  if (run.ops.length) {
    p.runIds = [...(p.runIds ?? []), run.id];
    await s.saveProposal(p);
  }
  await s.pruneProposals();
  await refreshStoreState();
  scheduleScan(200);
  return { ...res, ...(run.ops.length ? { runId: run.id } : {}) };
}

/** Re-checks the compiled page a stale claim is on (a proposal for that page only). */
export async function recheckPage(noteId: string): Promise<WikiProposal | null> {
  const state = await compilerStore().state();
  const page = Object.values(state.pages).find((p) => p.noteId === noteId);
  if (!page) throw new Error('This page is not a compiled page.');
  return compileNow('Re-check', { only: new Set([page.key]), force: true });
}

/** Provenance of AI text the user inserts (e.g. an assistant answer): stored like compiled claims. */
export async function recordProvenance(noteId: string, key: string, gen: ProvenanceGen, claims: ProvClaim[]): Promise<void> {
  const v = compilerVault();
  await writeNoteProvenance(v, noteId, setItem(await readNoteProvenance(v, noteId), key, gen, claims, gen.at));
}

// ---- People and follow-ups -------------------------------------------------------------------------

export interface FollowUp { text: string; owner: string; person?: string; due?: string; done: boolean; note: string; noteId: string; link: string; at: number }

/** Action items and follow-ups in notes edited since `since`. */
export async function followUps(since: number): Promise<FollowUp[]> {
  const out: FollowUp[] = [];
  for (const d of await allDocs()) {
    if (d.updatedAt < since || d.tags.includes(COMPILED_TAG)) continue;
    for (const a of extractActions(d)) {
      const u = d.units.find((x) => x.id === a.unitId)!;
      out.push({ text: a.text, owner: a.owner, ...(a.person ? { person: a.person } : {}), ...(a.due ? { due: a.due } : {}), done: a.done, note: d.title, noteId: d.noteId, link: anchorLink({ noteId: d.noteId, page: u.pageIndex, ...(u.rect ? { rect: u.rect } : {}), h: u.hash }), at: d.updatedAt });
    }
  }
  return out;
}

// ---- Agent tools -------------------------------------------------------------------------------------

const toolHost: CompilerToolHost = {
  async compile(reason) {
    try {
      const p = await compileNow(reason);
      const n = p?.items.length ?? 0;
      return { summary: p ? `${n} ${n === 1 ? 'change' : 'changes'} proposed (${p.items.map((i) => `${i.action} “${i.title}”`).join(', ')}). The user reviews them in Compiled wiki.` : useCompiler.getState().lastResult ?? 'Up to date.', ...(p ? { proposalId: p.id } : {}), changes: n };
    } catch (e) {
      return { summary: `Not compiled: ${(e as Error).message}`, changes: 0 };
    }
  },
  async conflicts(limit) {
    await scanNow();
    const titles = new Map((await compilerVault().listNotes()).map((n) => [n.id, n.title]));
    return useCompiler.getState().conflicts.slice(0, limit).map((c) => {
      const ua = unitById(c.a.unitId);
      return { a: c.a.text, aNote: titles.get(c.a.noteId) ?? '', b: c.b.text, bNote: titles.get(c.b.noteId) ?? '', reason: c.reason, confidence: c.confidence, ...(ua ? { link: anchorLink({ noteId: ua.noteId, page: ua.pageIndex, ...(ua.rect ? { rect: ua.rect } : {}), h: ua.hash }) } : {}) };
    });
  },
  followUps,
};

/** The compiler's agent tools, once the compiler has started (else none). */
export function compilerAgentTools(): AgentTool[] {
  return store ? createCompilerTools(toolHost) : [];
}
