/**
 * The compiler over a plain core `Vault` — the reference host used by tests, evals and the
 * MCP server (the app has its own, which also routes through open documents and reindexes).
 */
import {
  decodeProvenance,
  decodeTranscript,
  emptyProvenance,
  encodeProvenance,
  newId,
  transcriptAssetName,
  PROVENANCE_ASSET,
  type CompiledPage,
  type ProvClaim,
  type ProvenanceFile,
  type ProvenanceGen,
  type RecordingTranscript,
  type Vault,
  setItem,
  textItemKey,
} from '@inkstone/core';
import type { CompilerConfig } from './store.ts';
import { selectSources, type SourceNote, type WikiTarget } from './compile.ts';

const dec = new TextDecoder();
const enc = new TextEncoder();

export async function readProvenance(vault: Vault, noteId: string): Promise<ProvenanceFile> {
  const bytes = await vault.readAsset(noteId, PROVENANCE_ASSET).catch(() => null);
  if (!bytes) return emptyProvenance();
  try {
    return decodeProvenance(dec.decode(bytes));
  } catch {
    return emptyProvenance();
  }
}

export async function writeProvenance(vault: Vault, noteId: string, file: ProvenanceFile): Promise<void> {
  await vault.writeAsset(noteId, PROVENANCE_ASSET, enc.encode(encodeProvenance(file)));
}

/** Transcripts of a note's recordings, read from its assets. */
export async function readTranscripts(vault: Vault, note: { id: string; recordings?: RecordingTranscript['clip'][] }): Promise<RecordingTranscript[]> {
  const out: RecordingTranscript[] = [];
  for (const clip of note.recordings ?? []) {
    const bytes = await vault.readAsset(note.id, transcriptAssetName(clip.id)).catch(() => null);
    if (!bytes) continue;
    try { out.push({ clip, file: decodeTranscript(dec.decode(bytes)) }); } catch { /* unreadable transcript: skip */ }
  }
  return out;
}

/** The source notes a config selects, read from the vault (PDF text layers are not read here). */
export async function vaultSources(vault: Vault, config: CompilerConfig): Promise<SourceNote[]> {
  const notebooks = await vault.listNotebooks();
  const parents = new Map(notebooks.map((n) => [n.id, n.parentId]));
  const picked = selectSources(await vault.listNotes(), config, { notebookParents: parents });
  const out: SourceNote[] = [];
  for (const meta of picked) out.push({ meta, pages: await vault.readPages(meta), transcripts: await readTranscripts(vault, meta) });
  return out;
}

/** Current claims of a compiled page (its provenance), or null if the note is gone. */
export async function vaultCurrentClaims(vault: Vault, page: CompiledPage): Promise<ProvClaim[] | null> {
  const n = await vault.readNote(page.noteId);
  if (!n || n.trashedAt != null) return null;
  return (await readProvenance(vault, page.noteId)).items[textItemKey(page.textId)]?.claims ?? [];
}

export async function vaultRefresh(vault: Vault, page: CompiledPage, claims: ProvClaim[], gen: ProvenanceGen): Promise<void> {
  await writeProvenance(vault, page.noteId, setItem(await readProvenance(vault, page.noteId), textItemKey(page.textId), gen, claims, gen.at));
}

export class VaultWikiTarget implements WikiTarget {
  constructor(private vault: Vault, private clock: () => number = Date.now) {}

  async ensureNotebook(name: string, parentId?: string): Promise<string> {
    const found = (await this.vault.listNotebooks()).find((n) => n.name === name && (n.parentId ?? undefined) === parentId);
    if (found) return found.id;
    return (await this.vault.createNotebook(name, '#FF4E6E5D', parentId)).id;
  }

  async createPage(args: { title: string; notebookId: string; markdown: string; tags: string[] }) {
    const { note, pages } = await this.vault.createNote({ title: args.title, notebookId: args.notebookId, tags: args.tags });
    const textId = newId(this.clock());
    const page = { ...pages[0]!, texts: [{ id: textId, x: 64, y: 72, width: (note.pageSize.width || 794) - 128, text: args.markdown, fontSize: 16, color: '#FF1B1F24', font: 'sans' as const, createdAt: this.clock(), origin: 'ai' as const }] };
    await this.vault.saveNote(note, [page]);
    return { noteId: note.id, pageId: page.id, textId, title: note.title };
  }

  async readText(noteId: string, pageId: string, textId: string): Promise<string | null> {
    const n = await this.vault.readNote(noteId);
    if (!n || !n.pageIds.includes(pageId)) return null;
    return (await this.vault.readPage(noteId, pageId)).texts?.find((t) => t.id === textId)?.text ?? null;
  }

  async replaceText(noteId: string, pageId: string, textId: string, expected: string, next: string): Promise<'replaced' | 'changed' | 'missing'> {
    const n = await this.vault.readNote(noteId);
    if (!n || !n.pageIds.includes(pageId)) return 'missing';
    const pages = await this.vault.readPages(n);
    const page = pages.find((p) => p.id === pageId)!;
    const box = page.texts?.find((t) => t.id === textId);
    if (!box) return 'missing';
    if (box.text !== expected) return 'changed';
    const nextPages = pages.map((p) => (p.id === pageId ? { ...p, texts: (p.texts ?? []).map((t) => (t.id === textId ? { ...t, text: next } : t)) } : p));
    await this.vault.saveNote({ ...n, updatedAt: this.clock() }, nextPages, { changedPageIds: [pageId] });
    return 'replaced';
  }

  async trashNote(noteId: string): Promise<boolean> {
    if (!(await this.vault.readNote(noteId))) return false;
    await this.vault.trashNote(noteId);
    return true;
  }

  readProvenance(noteId: string) { return readProvenance(this.vault, noteId); }
  writeProvenance(noteId: string, file: ProvenanceFile) { return writeProvenance(this.vault, noteId, file); }
}
