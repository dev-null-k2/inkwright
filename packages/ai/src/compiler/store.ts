/**
 * Where the context compiler keeps its state in the vault (docs/VAULT_FORMAT.md § Context
 * compiler). Everything is plain JSON beside the notes, so it syncs and any tool can read it:
 *
 *   ai/compiler/config.json            sources, people-pages consent, which AI to use
 *   ai/compiler/state.json             compiled pages and their source fingerprints
 *   ai/compiler/proposals/<id>.json    pending and decided proposals (diffs with sources)
 *   ai/ledger/<conflictId>.json        conflicts the user dismissed or resolved, with their note
 *   ai/study/<deckId>.json             flashcard decks with FSRS state (merged card by card)
 *   ai/packs/<id>/pack.json, pack.md   saved context packs (served by the MCP server)
 *   ai/evals/memory.json               the latest "Does my memory help?" report
 *
 * Files that two devices can change at once are either merged by sync (decks, provenance) or one
 * file per thing (proposals, ledger decisions), like the activity log.
 */
import { decodeDeck, encodeDeck, isSafeId, type CompilerState, type ProvClaim, type ProvenanceGen, type StudyDeck, type VaultFS, type WikiPageKind, emptyCompilerState, STUDY_DIR } from '@inkwright/core';

export const COMPILER_DIR = 'ai/compiler';
export const LEDGER_DIR = 'ai/ledger';
export const PACKS_DIR = 'ai/packs';
export const EVALS_DIR = 'ai/evals';

/** What the compiler reads and how it behaves. */
export interface CompilerConfig {
  version: 1;
  /** Sources: notebooks (with their sub-notebooks), tags and single notes. Empty = nothing compiled. */
  sources: { notebooks: string[]; tags: string[]; notes: string[] };
  /** Make person pages from names in notes and transcripts (off until the user turns it on). */
  people: boolean;
  /**
   * Which AI writes the pages: `device` (only an on-device model; quotes-only without one),
   * `active` (the AI chosen in Settings, which may be a cloud provider), `none` (quotes only).
   */
  ai: 'device' | 'active' | 'none';
  /** Notebook that holds the compiled pages (created on first accept). */
  notebookId?: string;
  /** Background contradiction checks over all notes (on by default; rules only, on the device). */
  ledger: boolean;
  /** Ledger confidence threshold (0..1). */
  threshold: number;
  updatedAt: number;
}

export const DEFAULT_COMPILER_CONFIG: CompilerConfig = { version: 1, sources: { notebooks: [], tags: [], notes: [] }, people: false, ai: 'device', ledger: true, threshold: 0.6, updatedAt: 0 };

/** One page's change in a proposal. */
export interface ProposalItem {
  id: string;
  key: string;
  kind: WikiPageKind;
  title: string;
  action: 'create' | 'update' | 'archive';
  /** The compiled note, for updates and archives. */
  noteId?: string;
  fingerprint: string;
  sourceNotes: string[];
  /** Titles of the source notes (rendered as [[links]] on the page). */
  sourceTitles: string[];
  added: ProvClaim[];
  removed: ProvClaim[];
  kept: ProvClaim[];
  /** The full claim list of the new draft, in page order. */
  next: ProvClaim[];
  /** What validation threw away (shown in the diff, so nothing disappears silently). */
  dropped: Array<{ text: string; reason: string }>;
  /** Who wrote this page when it differs from the proposal's (e.g. quotes only after the AI failed). */
  gen?: ProvenanceGen;
  /** Why the AI's draft was not used, if it wasn't. */
  note?: string;
  /** Pages listed by the index page (index only). */
  index?: Array<{ title: string; kind: WikiPageKind }>;
  decision?: 'accepted' | 'rejected';
  decidedAt?: number;
}

export interface WikiProposal {
  id: string;
  createdAt: number;
  /** Why it was made: "Compile now", "Nightly", "Re-check". */
  reason: string;
  gen: ProvenanceGen;
  items: ProposalItem[];
  status: 'pending' | 'done';
  /** The activity run accepted changes were logged in. */
  runIds?: string[];
}

/** A conflict the user dismissed (not a real conflict) or resolved (with what they decided). */
export interface LedgerDecision {
  id: string;
  status: 'dismissed' | 'resolved';
  note?: string;
  /** The two sentences, so the decision can be shown after the notes change. */
  a: string;
  b: string;
  at: number;
}

async function readJson<T>(fs: VaultFS, path: string): Promise<T | null> {
  const t = await fs.readText(path).catch(() => null);
  if (t == null) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
}

export class CompilerStore {
  private listeners = new Set<() => void>();
  constructor(readonly fs: VaultFS) {}

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit() { for (const l of [...this.listeners]) l(); }

  async config(): Promise<CompilerConfig> {
    const c = await readJson<Partial<CompilerConfig>>(this.fs, `${COMPILER_DIR}/config.json`);
    return { ...DEFAULT_COMPILER_CONFIG, ...(c ?? {}), sources: { ...DEFAULT_COMPILER_CONFIG.sources, ...(c?.sources ?? {}) } };
  }

  async saveConfig(c: CompilerConfig): Promise<void> {
    await this.fs.writeText(`${COMPILER_DIR}/config.json`, JSON.stringify({ ...c, updatedAt: Date.now() }, null, 1));
    this.emit();
  }

  async state(): Promise<CompilerState> {
    const s = await readJson<CompilerState>(this.fs, `${COMPILER_DIR}/state.json`);
    return s && s.pages ? s : emptyCompilerState();
  }

  async saveState(s: CompilerState): Promise<void> {
    await this.fs.writeText(`${COMPILER_DIR}/state.json`, JSON.stringify(s, null, 1));
    this.emit();
  }

  async proposals(): Promise<WikiProposal[]> {
    const out: WikiProposal[] = [];
    for (const e of await this.fs.list(`${COMPILER_DIR}/proposals`)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      const p = await readJson<WikiProposal>(this.fs, `${COMPILER_DIR}/proposals/${e.name}`);
      if (p && Array.isArray(p.items)) out.push(p);
    }
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  async proposal(id: string): Promise<WikiProposal | null> {
    return isSafeId(id) ? readJson<WikiProposal>(this.fs, `${COMPILER_DIR}/proposals/${id}.json`) : null;
  }

  async saveProposal(p: WikiProposal): Promise<void> {
    await this.fs.writeText(`${COMPILER_DIR}/proposals/${p.id}.json`, JSON.stringify(p, null, 1));
    this.emit();
  }

  /** Keeps the newest `max` decided proposals (pending ones are never pruned). */
  async pruneProposals(max = 30): Promise<void> {
    const done = (await this.proposals()).filter((p) => p.status === 'done');
    for (const p of done.slice(max)) await this.fs.delete(`${COMPILER_DIR}/proposals/${p.id}.json`);
  }

  async decisions(): Promise<Map<string, LedgerDecision>> {
    const out = new Map<string, LedgerDecision>();
    for (const e of await this.fs.list(LEDGER_DIR)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      const d = await readJson<LedgerDecision>(this.fs, `${LEDGER_DIR}/${e.name}`);
      if (d?.id) out.set(d.id, d);
    }
    return out;
  }

  async decide(d: LedgerDecision): Promise<void> {
    if (!isSafeId(d.id)) throw new Error('Bad conflict id');
    await this.fs.writeText(`${LEDGER_DIR}/${d.id}.json`, JSON.stringify(d, null, 1));
    this.emit();
  }

  async undecide(id: string): Promise<void> {
    if (!isSafeId(id)) return;
    await this.fs.delete(`${LEDGER_DIR}/${id}.json`);
    this.emit();
  }

  async decks(): Promise<StudyDeck[]> {
    const out: StudyDeck[] = [];
    for (const e of await this.fs.list(STUDY_DIR)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      const t = await this.fs.readText(`${STUDY_DIR}/${e.name}`);
      if (!t) continue;
      try { out.push(decodeDeck(t)); } catch { /* skip unreadable decks */ }
    }
    return out.sort((a, b) => a.title.localeCompare(b.title));
  }

  async deck(id: string): Promise<StudyDeck | null> {
    if (!isSafeId(id)) return null;
    const t = await this.fs.readText(`${STUDY_DIR}/${id}.json`);
    if (!t) return null;
    try { return decodeDeck(t); } catch { return null; }
  }

  async saveDeck(d: StudyDeck): Promise<void> {
    if (!isSafeId(d.id)) throw new Error('Bad deck id');
    await this.fs.writeText(`${STUDY_DIR}/${d.id}.json`, encodeDeck(d));
    this.emit();
  }

  async deleteDeck(id: string): Promise<void> {
    if (!isSafeId(id)) return;
    await this.fs.delete(`${STUDY_DIR}/${id}.json`);
    this.emit();
  }

  async savePack(id: string, files: { json: string; markdown: string }): Promise<void> {
    if (!isSafeId(id)) throw new Error('Bad pack id');
    await this.fs.writeText(`${PACKS_DIR}/${id}/pack.json`, files.json);
    await this.fs.writeText(`${PACKS_DIR}/${id}/pack.md`, files.markdown);
    this.emit();
  }

  async packs(): Promise<Array<{ id: string; title: string; createdAt: string }>> {
    const out: Array<{ id: string; title: string; createdAt: string }> = [];
    for (const e of await this.fs.list(PACKS_DIR)) {
      if (e.kind !== 'dir') continue;
      const j = await readJson<{ title?: string; createdAt?: string }>(this.fs, `${PACKS_DIR}/${e.name}/pack.json`);
      if (j) out.push({ id: e.name, title: j.title ?? e.name, createdAt: j.createdAt ?? '' });
    }
    return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async saveEvalReport(name: string, report: unknown): Promise<void> {
    await this.fs.writeText(`${EVALS_DIR}/${name}.json`, JSON.stringify(report, null, 1));
    this.emit();
  }

  async evalReport<T>(name: string): Promise<T | null> {
    return readJson<T>(this.fs, `${EVALS_DIR}/${name}.json`);
  }
}
