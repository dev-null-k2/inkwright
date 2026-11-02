import { useSyncExternalStore } from 'react';
import { MemoryCorpus, chunkNote, hybridSearch, type MemoryChunk, type NoteMeta, type PageInk, type PdfTextItem, type RankedChunk, type RecordingTranscript } from '@inkstone/core';
import type { MemoryHit, MemorySearchHost } from '@inkstone/ai';
import { loadPdfJs } from '../canvas/assets.ts';
import type { AppVault } from './vault.ts';
import { currentEmbedder, onLocalAIChange, type Embedder } from './localai.ts';
import { loadNoteTranscripts } from './listen/transcripts.ts';

/**
 * All notes as one searchable memory (see packages/core/src/memory.ts for chunking and ranking).
 * This class keeps the passage corpus in step with the app's keyword index, extracts the text
 * layer of imported PDFs, and embeds passages in the background with whichever embedder is
 * available (on-device by default). Vectors are cached in IndexedDB on this device only — never
 * synced, rebuilt per device — and keyed by passage content, so editing one line of a note
 * re-embeds one passage, not the note.
 */

const DB = 'inkstone-memory';
const VEC = 'vectors';
const PDF = 'pdftext';

function idb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(VEC);
        req.result.createObjectStore(PDF);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch {
      resolve(null);
    }
  });
}

function tx<T>(db: IDBDatabase | null, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  if (!db) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    try {
      const r = fn(db.transaction(store, mode).objectStore(store));
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => resolve(undefined);
    } catch {
      resolve(undefined);
    }
  });
}

const idle = (ms: number) => new Promise<void>((r) => {
  const ric = (globalThis as any).requestIdleCallback as ((cb: () => void, o?: { timeout: number }) => void) | undefined;
  setTimeout(() => (ric ? ric(() => r(), { timeout: 1000 }) : r()), ms);
});

export interface MemoryStatus {
  /** Bumped whenever passages are added, changed or removed (not by embedding progress). */
  version: number;
  passages: number;
  embedded: number;
  /** Who makes the vectors, or null for keyword-only search. */
  embedder: string | null;
  indexing: boolean;
  error: string | null;
}

export class AppMemory implements MemorySearchHost {
  readonly corpus = new MemoryCorpus();
  /** Passage hash → vector, for `embedderKey`'s model. */
  private vectors = new Map<string, Float32Array>();
  private embedderKey: string | null = null;
  private embedderLabel: string | null = null;
  private pending = new Set<string>();
  private pumping = false;
  private pdfText = new Map<string, PdfPageText>();
  private pdfQueued = new Set<string>();
  private pdfJobs: Promise<void> = Promise.resolve();
  private db: Promise<IDBDatabase | null> | null = null;
  private error: string | null = null;
  private listeners = new Set<() => void>();
  private snapshot: MemoryStatus = { version: 0, passages: 0, embedded: 0, embedder: null, indexing: false, error: null };
  private version = 0;
  /** Transcripts of each note's recordings ("what was said" passages), loaded once per note. */
  private transcripts = new Map<string, RecordingTranscript[]>();
  /** Recordings whose transcript file was looked for, per note. */
  private transcriptsChecked = new Map<string, Set<string>>();
  private transcriptsQueued = new Set<string>();

  constructor(readonly vault: AppVault) {
    onLocalAIChange(() => this.kick());
  }

  private database() {
    return (this.db ??= idb());
  }

  // ---- Keeping in step with the keyword index ---------------------------------------------------

  /** Indexes or re-indexes one note (called whenever the keyword index is). */
  update(note: NoteMeta, pages: readonly PageInk[]): void {
    if (note.trashedAt != null) return this.remove(note.id);
    this.corpus.setNote(note.id, chunkNote(note, pages, { pdfText: this.pdfFor(note, pages), transcripts: this.transcriptsFor(note, pages) }));
    this.pending.add(note.id);
    this.version++;
    this.changed();
    this.kick();
  }

  remove(noteId: string): void {
    this.corpus.removeNote(noteId);
    this.pending.delete(noteId);
    this.version++;
    this.changed();
  }

  clear(): void {
    // A rebuild (e.g. after sync) may bring new transcripts: read them again.
    this.transcripts.clear();
    this.transcriptsChecked.clear();
    this.transcriptsQueued.clear();
    this.corpus.clear();
    this.pending.clear();
    this.version++;
    this.changed();
  }

  // ---- Transcripts -------------------------------------------------------------------------------

  /**
   * Known transcripts of the note's recordings. A recording not looked at yet (new, or synced
   * from another device) has its transcript read in the background, then the note is re-chunked.
   */
  private transcriptsFor(note: NoteMeta, pages: readonly PageInk[]): RecordingTranscript[] {
    if (!note.recordings?.length) return [];
    const ids = note.recordings.map((c) => c.id);
    const checked = this.transcriptsChecked.get(note.id);
    if (!checked || ids.some((id) => !checked.has(id))) {
      const key = `${note.id}|${ids.join(',')}`;
      if (!this.transcriptsQueued.has(key)) {
        this.transcriptsQueued.add(key);
        void loadNoteTranscripts(this.vault, note).then((list) => {
          this.transcriptsQueued.delete(key);
          this.setTranscriptList(note.id, list, ids);
          if (list.length) this.update(note, pages);
        }).catch((e) => console.warn('Transcripts unavailable', e));
      }
    }
    return (this.transcripts.get(note.id) ?? []).filter((t) => ids.includes(t.clip.id));
  }

  private setTranscriptList(noteId: string, list: RecordingTranscript[], checkedIds: readonly string[]) {
    this.transcripts.set(noteId, list);
    const set = this.transcriptsChecked.get(noteId) ?? new Set<string>();
    for (const id of checkedIds) set.add(id);
    for (const t of list) set.add(t.clip.id);
    this.transcriptsChecked.set(noteId, set);
  }

  /** A transcript was written: re-index the note with it. */
  setTranscripts(noteId: string, list: RecordingTranscript[]): void {
    this.setTranscriptList(noteId, list, list.map((t) => t.clip.id));
    void this.vault.vault.readNote(noteId).then(async (note) => {
      if (note && note.trashedAt == null) this.update(note, await this.vault.vault.readPages(note));
    });
  }

  // ---- PDF text layers ----------------------------------------------------------------------------

  private pdfKey = (noteId: string, asset: string, n: number) => `${noteId}/${asset}#${n}`;

  /** Text layers already extracted, by page index; queues extraction of the rest. */
  private pdfFor(note: NoteMeta, pages: readonly PageInk[]): Map<number, PdfTextItem[]> {
    const out = new Map<number, PdfTextItem[]>();
    pages.forEach((p, i) => {
      const bg = p.background;
      if (bg?.kind !== 'pdf' || !bg.pageNumber) return;
      const key = this.pdfKey(note.id, bg.asset, bg.pageNumber);
      const text = this.pdfText.get(key);
      if (text) out.set(i, scaleItems(text, (p.size ?? note.pageSize).width));
      else if (!this.pdfQueued.has(key)) {
        this.pdfQueued.add(key);
        this.pdfJobs = this.pdfJobs.then(() => this.loadPdfText(note.id, bg.asset, bg.pageNumber!)).catch((e) => console.warn('PDF text unavailable', e));
      }
    });
    return out;
  }

  private async loadPdfText(noteId: string, asset: string, pageNumber: number): Promise<void> {
    const key = this.pdfKey(noteId, asset, pageNumber);
    const db = await this.database();
    let text = (await tx<PdfPageText>(db, PDF, 'readonly', (s) => s.get(key))) ?? null;
    if (!text) {
      await idle(200);
      const extracted = await extractPdfPage(this.vault, noteId, asset, pageNumber);
      text = extracted;
      void tx(db, PDF, 'readwrite', (s) => s.put(extracted, key));
    }
    this.pdfText.set(key, text);
    if (!text.items.length) return;
    // Re-chunk the note now that its PDF text is known.
    const note = await this.vault.vault.readNote(noteId);
    if (note && note.trashedAt == null) this.update(note, await this.vault.vault.readPages(note));
  }

  // ---- Embeddings ----------------------------------------------------------------------------------

  /** Starts background embedding if an embedder is available and work is pending. */
  kick(): void {
    if (!this.pumping) void this.pump();
  }

  private async loadVectors(emb: Embedder) {
    this.vectors.clear();
    this.embedderKey = emb.key;
    this.embedderLabel = emb.label;
    for (const id of this.corpus.noteIds()) this.pending.add(id);
    const db = await this.database();
    const range = IDBKeyRange.bound(`${emb.key}|`, `${emb.key}|￿`);
    const [keys, values] = await Promise.all([
      tx<IDBValidKey[]>(db, VEC, 'readonly', (s) => s.getAllKeys(range)),
      tx<Float32Array[]>(db, VEC, 'readonly', (s) => s.getAll(range)),
    ]);
    keys?.forEach((k, i) => { if (values?.[i]) this.vectors.set(String(k).slice(emb.key.length + 1), values[i]!); });
  }

  private async pump(): Promise<void> {
    this.pumping = true;
    this.changed();
    try {
      for (;;) {
        const emb = await currentEmbedder();
        if (!emb) {
          if (this.embedderKey) { this.embedderKey = null; this.embedderLabel = null; this.vectors.clear(); }
          break;
        }
        if (emb.key !== this.embedderKey) await this.loadVectors(emb);
        const batch: MemoryChunk[] = [];
        const seen = new Set<string>();
        for (const noteId of [...this.pending]) {
          const missing = this.corpus.chunksOf(noteId).filter((c) => !this.vectors.has(c.hash) && !seen.has(c.hash));
          if (!missing.length) { this.pending.delete(noteId); continue; }
          for (const c of missing) { seen.add(c.hash); if (batch.length < 24) batch.push(c); }
          if (batch.length >= 24) break;
        }
        if (!batch.length) break;
        const vecs = await emb.embedDocuments(batch.map((c) => ({ title: c.title, text: c.text })));
        const db = await this.database();
        batch.forEach((c, i) => {
          const v = vecs[i];
          if (!v) return;
          this.vectors.set(c.hash, v);
          void tx(db, VEC, 'readwrite', (s) => s.put(v, `${emb.key}|${c.hash}`));
        });
        this.error = null;
        this.changed();
        await idle(120); // low priority: let the pen and the page renderer have the machine
      }
    } catch (e) {
      this.error = (e as Error).message;
      console.warn('Semantic indexing paused', e);
    } finally {
      this.pumping = false;
      this.changed();
    }
  }

  // ---- Search ---------------------------------------------------------------------------------------

  /** Keyword-only results, synchronously (instant palette results while typing). */
  searchNow(query: string, opts: { limit?: number; noteId?: string } = {}): RankedChunk[] {
    return hybridSearch(this.corpus, query, { ...opts, noteHits: this.vault.search.search(query, { limit: 50 }) });
  }

  /** Hybrid keyword + semantic search (semantic only when vectors exist for the current model). */
  async search(query: string, opts: { limit?: number; noteId?: string; signal?: AbortSignal } = {}): Promise<{ results: RankedChunk[]; semantic: boolean }> {
    let queryVector: Float32Array | undefined;
    if (this.vectors.size && this.embedderKey) {
      const emb = await currentEmbedder().catch(() => null);
      if (emb && emb.key === this.embedderKey) {
        queryVector = await Promise.race([emb.embedQuery(query, opts.signal), new Promise<undefined>((r) => setTimeout(() => r(undefined), 6000))]).catch(() => undefined);
      }
    }
    const results = hybridSearch(this.corpus, query, {
      limit: opts.limit,
      noteId: opts.noteId,
      noteHits: this.vault.search.search(query, { limit: 50 }),
      queryVector,
      vectorOf: (c) => this.vectors.get(c.hash),
    });
    return { results, semantic: !!queryVector };
  }

  /** `search_memory` for the assistant. */
  async searchMemory(query: string, opts: { limit?: number; noteId?: string } = {}): Promise<MemoryHit[]> {
    const { results } = await this.search(query, { limit: opts.limit ?? 8, noteId: opts.noteId });
    return results.map((r) => toHit(r));
  }

  // ---- Status ----------------------------------------------------------------------------------------

  private changed() {
    let embedded = 0;
    if (this.vectors.size) for (const c of this.corpus.all()) if (this.vectors.has(c.hash)) embedded++;
    this.snapshot = { version: this.version, passages: this.corpus.size, embedded, embedder: this.embedderLabel, indexing: this.pumping, error: this.error };
    for (const l of this.listeners) l();
  }

  status(): MemoryStatus {
    return this.snapshot;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Forgets every stored vector (Settings › AI › rebuild). */
  async resetVectors(): Promise<void> {
    const db = await this.database();
    await tx(db, VEC, 'readwrite', (s) => s.clear());
    this.vectors.clear();
    this.embedderKey = null;
    for (const id of this.corpus.noteIds()) this.pending.add(id);
    this.changed();
    this.kick();
  }
}

export function toHit(r: RankedChunk): MemoryHit {
  const c = r.chunk;
  return {
    noteId: c.noteId,
    title: c.title,
    pageIndex: c.pageIndex,
    source: c.source,
    text: c.text,
    score: r.score,
    ...(c.rect ? { rect: { x: c.rect.minX, y: c.rect.minY, width: c.rect.maxX - c.rect.minX, height: c.rect.maxY - c.rect.minY } } : {}),
    ...(c.source === 'speech' && c.clipId ? { said: { clipId: c.clipId, startMs: c.startMs ?? 0, endMs: c.endMs ?? c.startMs ?? 0 } } : {}),
  };
}

/** A PDF page's text layer at the PDF's own size (1/96 in units). */
interface PdfPageText {
  pageWidth: number;
  items: PdfTextItem[];
}

/** Pages imported at another size than the PDF's own are scaled to match. */
function scaleItems({ items, pageWidth: w }: PdfPageText, pageWidth: number): PdfTextItem[] {
  const k = w && pageWidth ? pageWidth / w : 1;
  if (Math.abs(k - 1) < 0.01) return items;
  return items.map((it) => ({ str: it.str, rect: { minX: it.rect.minX * k, minY: it.rect.minY * k, maxX: it.rect.maxX * k, maxY: it.rect.maxY * k } }));
}

/** The text layer of one PDF page as positioned runs in page units (1/96 inch, top-left origin). */
async function extractPdfPage(vault: AppVault, noteId: string, asset: string, pageNumber: number): Promise<PdfPageText> {
  const bytes = await vault.vault.readAsset(noteId, asset);
  if (!bytes) return { pageWidth: 0, items: [] };
  const pdfjs = await loadPdfJs();
  const task = pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false });
  const doc = await task.promise;
  try {
    const page = await doc.getPage(pageNumber);
    const vp = page.getViewport({ scale: 96 / 72 });
    const content = await page.getTextContent();
    const items: PdfTextItem[] = [];
    for (const it of content.items as { str?: string; transform: number[]; width: number }[]) {
      if (!it.str?.trim()) continue;
      const t = pdfjs.Util.transform(vp.transform, it.transform) as number[];
      const h = Math.hypot(t[2]!, t[3]!);
      const x = t[4]!, y = t[5]!;
      items.push({ str: it.str, rect: { minX: x, minY: y - h, maxX: x + it.width * vp.scale, maxY: y + h * 0.25 } });
    }
    return { pageWidth: vp.width, items };
  } finally {
    await (task.destroy?.() ?? doc.destroy?.());
  }
}

let memory: AppMemory | null = null;

/**
 * Creates the memory for this vault and keeps it in step with the keyword index: every path that
 * (re)indexes, removes or rebuilds notes for search goes through `vault.search`, so observing
 * those three calls covers editor saves, sync, imports, the assistant and the trash.
 */
export function attachMemory(vault: AppVault): AppMemory {
  if (memory?.vault === vault) return memory;
  const m = new AppMemory(vault);
  const s = vault.search;
  const indexNote = s.indexNote.bind(s);
  const remove = s.remove.bind(s);
  const clear = s.clear.bind(s);
  s.indexNote = (note, pages) => { indexNote(note, pages); m.update(note, pages); };
  s.remove = (id) => { remove(id); m.remove(id); };
  s.clear = () => { clear(); m.clear(); };
  memory = m;
  return m;
}

export function appMemory(): AppMemory | null {
  return memory;
}

const EMPTY: MemoryStatus = { version: 0, passages: 0, embedded: 0, embedder: null, indexing: false, error: null };

export function useMemoryStatus(): MemoryStatus {
  return useSyncExternalStore(
    (fn) => memory?.subscribe(fn) ?? (() => {}),
    () => memory?.status() ?? EMPTY,
  );
}
