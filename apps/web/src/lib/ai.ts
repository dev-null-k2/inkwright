import {
  createClaudeSampleProvider,
  createProvider,
  getProviderInfo,
  guessModelCapabilities,
  runSkill,
  transcribeHandwriting,
  type NoteContent,
  type NoteInfo,
  type NoteListItem,
  type NoteSearchHit,
  type NoteToolHost,
  type NotebookInfo,
  type NotePatch,
  type Provider,
} from '@inkstone/ai';
import {
  contentBounds,
  newId,
  pageText,
  pageSizeOf,
  textBoxHeight,
  type InkStroke,
  type NoteDocument,
  type NoteMeta,
  type PageInk,
  type TextBox,
} from '@inkstone/core';
import { claudeRuntime } from '../platform/env.ts';
import { useApp } from '../state/app.ts';
import { useSettings, type AIProviderConfig } from '../state/settings.ts';
import { pageImageForAI } from './exporter.ts';
import { getSecret } from './secrets.ts';
import type { AppVault } from './vault.ts';
import { recognizeLocally } from './recognition.ts';
import { chatChoice, isInstalled, localActiveAI, pickAssistant } from './localai.ts';
import { nativeEngineReady, nativeProofread } from './native-ai.ts';
import { snapshotBeforeAgentEdit } from '../studio/versions.ts';

export const CLAUDE_BUILTIN_ID = '__claude_builtin__';

export interface ActiveAI {
  provider: Provider;
  model: string;
  label: string;
  vision: boolean;
  tools: boolean;
}

let claudeSample: { fn: any; images: boolean } | null | undefined;

/** The Claude that powers the live preview on claude.ai (no key needed there). */
async function builtinClaude(): Promise<{ fn: any; images: boolean } | null> {
  if (claudeSample !== undefined) return claudeSample;
  const rt = claudeRuntime();
  if (!rt) return (claudeSample = null);
  try {
    const sample = await rt.use('sample');
    if (!sample) return (claudeSample = null);
    let images = false;
    try { images = !!(await sample.limits?.())?.images; } catch { /* no images */ }
    claudeSample = { fn: sample, images };
  } catch {
    claudeSample = null;
  }
  return claudeSample;
}

export function hasBuiltinClaude(): boolean {
  return !!claudeRuntime();
}

export function isAIReady(): boolean {
  const s = useSettings.getState().ai;
  return (!!s.activeId && s.providers.some((p) => p.id === s.activeId)) || hasBuiltinClaude() || isInstalled(chatChoice()) || nativeEngineReady();
}

export async function providerFromConfig(cfg: AIProviderConfig, keyOverride?: string): Promise<Provider> {
  const apiKey = keyOverride ?? (cfg.hasKey ? (await getSecret(`ai-key:${cfg.id}`)) ?? undefined : undefined);
  return createProvider({ providerId: cfg.providerId as any, apiKey, baseUrl: cfg.baseUrl, azureApiVersion: cfg.azureApiVersion } as any);
}

/** The AI the user chose in Settings, or Claude built into the preview. */
export async function getActiveAI(): Promise<ActiveAI | null> {
  const s = useSettings.getState().ai;
  const cfg = s.providers.find((p) => p.id === s.activeId);
  // Without a provider the assistant runs on this device; with one, Settings › AI › "Who answers" decides.
  const pick = await pickAssistant({ providerConfigured: !!cfg && cfg.id !== CLAUDE_BUILTIN_ID, builtinClaude: hasBuiltinClaude() });
  if (pick.kind === 'device' || pick.kind === 'chrome' || pick.kind === 'native') {
    const local = localActiveAI(pick.kind);
    if (local) return local;
  }
  if (cfg && cfg.id !== CLAUDE_BUILTIN_ID) {
    const info = getProviderInfo(cfg.providerId);
    const provider = await providerFromConfig(cfg);
    const caps = guessModelCapabilities(cfg.model);
    return { provider, model: cfg.model, label: `${info?.label ?? cfg.label} · ${cfg.model}`, vision: (info?.capabilities.vision ?? true) && caps.vision, tools: info?.capabilities.tools ?? true };
  }
  const c = await builtinClaude();
  if (c) {
    return { provider: createClaudeSampleProvider(c.fn, { images: c.images }), model: 'default', label: 'Claude (built into this preview)', vision: c.images, tools: true };
  }
  return null;
}

// ---- Tool host over the real vault ------------------------------------------------------------

const info = (n: NoteMeta): NoteInfo => ({ id: n.id, title: n.title, tags: n.tags, notebookId: n.notebookId, pinned: n.pinned, updatedAt: n.updatedAt, createdAt: n.createdAt, summary: n.summary } as NoteInfo);

/**
 * Gives agents the same powers the user has, through the same code paths: edits to the note that
 * is open go through its document (so they appear live and can be undone); everything else is
 * written to the vault and synced.
 */
export class AppNoteToolHost implements NoteToolHost {
  constructor(private vault: AppVault, private open: NoteDocument | null) {}

  private async pagesOf(n: NoteMeta): Promise<PageInk[]> {
    // Locked notes stay away from the assistant, even while open.
    if (n.lock) throw new Error('This note is locked. Inkstone keeps locked notes away from the assistant.');
    if (this.open && this.open.meta.id === n.id) return [...this.open.pages];
    return this.vault.vault.readPages(n);
  }

  private async metaOf(id: string): Promise<NoteMeta | null> {
    if (this.open && this.open.meta.id === id) return this.open.meta;
    return this.vault.vault.readNote(id);
  }

  async listNotes(opts: { notebookId?: string; tag?: string; pinned?: boolean; limit?: number } = {}): Promise<NoteListItem[]> {
    const nbs = await this.vault.listNotebooks();
    let list = await this.vault.listNotes();
    if (opts.notebookId) list = list.filter((n) => n.notebookId === opts.notebookId);
    if (opts.tag) list = list.filter((n) => n.tags.includes(opts.tag!));
    if (opts.pinned) list = list.filter((n) => n.pinned);
    return list.slice(0, opts.limit ?? 50).map((n) => ({ ...info(n), pageCount: n.pageIds.length, notebookName: nbs.find((b) => b.id === n.notebookId)?.name }) as NoteListItem);
  }

  async searchNotes(query: string, opts: { limit?: number } = {}): Promise<NoteSearchHit[]> {
    return this.vault.search.search(query, { limit: opts.limit ?? 10 }).map((h) => ({ noteId: h.noteId, title: h.title, pageIndex: h.pageIndex, snippet: h.snippet.replace(/[«»]/g, ''), score: h.score }));
  }

  async readNote(id: string): Promise<NoteContent | null> {
    const n = await this.metaOf(id);
    if (!n) return null;
    const pages = await this.pagesOf(n);
    return {
      // `meta` is what the note tools read; `note` is kept for older callers.
      meta: info(n),
      note: { ...info(n), pageCount: pages.length },
      pages: pages.map((p, i) => ({ index: i, text: pageText(p), strokeCount: p.strokes.length, hasHandwriting: p.strokes.length > 0, handwritingRecognized: !!p.recognizedText, imageCount: p.images?.length ?? 0 })),
    } as unknown as NoteContent;
  }

  async getPageImage(noteId: string, pageIndex: number) {
    const n = await this.metaOf(noteId);
    if (!n) return null;
    const pages = await this.pagesOf(n);
    if (!pages[pageIndex]) return null;
    return pageImageForAI(this.vault, n, pages, pageIndex);
  }

  async createNote(args: { title: string; text: string; notebookId?: string; tags?: string[] }): Promise<NoteInfo> {
    const s = useSettings.getState();
    const { note, pages } = await this.vault.vault.createNote({ title: args.title, notebookId: args.notebookId, tags: args.tags, paper: s.defaultPaper, pageSize: s.defaultPageSize });
    const box = textBox(64, 80, (note.pageSize.width || 794) - 128, args.text);
    const page = { ...pages[0]!, texts: [box] };
    await this.vault.vault.saveNote(note, [page]);
    this.vault.indexNote(note, [page]);
    await useApp.getState().refresh();
    return info(note);
  }

  async appendText(noteId: string, text: string, pageIndex?: number): Promise<{ noteId: string; pageIndex: number; pageId: string; textId: string }> {
    const n = await this.metaOf(noteId);
    if (!n) throw new Error(`No note with id "${noteId}"`);
    const pages = await this.pagesOf(n);
    // Version history: the note as it was before the assistant changed it.
    snapshotBeforeAgentEdit(this.vault, n, pages);
    const i = Math.max(0, Math.min(pages.length - 1, pageIndex ?? pages.length - 1));
    const page = pages[i]!;
    const b = contentBounds(page);
    const width = (pageSizeOf(n, page).width || 794) - 128;
    const y = Number.isFinite(b.maxY) ? b.maxY + 24 : 80;
    const box = textBox(64, y, width, text);
    if (this.open && this.open.meta.id === noteId) {
      this.open.upsertText(i, box, 'AI added text');
    } else {
      const next = pages.map((p, k) => (k === i ? { ...p, texts: [...(p.texts ?? []), box] } : p));
      const meta = { ...n, updatedAt: Date.now() };
      await this.vault.vault.saveNote(meta, next, { changedPageIds: [page.id] });
      this.vault.indexNote(meta, next);
      await useApp.getState().refresh();
    }
    // Ids let the activity log undo exactly this text later.
    return { noteId, pageIndex: i, pageId: page.id, textId: box.id };
  }

  async updateNote(id: string, patch: NotePatch): Promise<NoteInfo | null> {
    if (this.open && this.open.meta.id === id) {
      this.open.updateMeta((m) => ({ ...m, ...clean(patch) }));
      return info(this.open.meta);
    }
    const n = await this.vault.vault.updateNote(id, (m) => ({ ...m, ...clean(patch) }));
    if (n) { this.vault.indexNote(n, await this.vault.vault.readPages(n)); await useApp.getState().refresh(); }
    return n ? info(n) : null;
  }

  async listNotebooks(): Promise<NotebookInfo[]> {
    const notes = await this.vault.listNotes();
    return (await this.vault.listNotebooks()).map((b) => ({ id: b.id, name: b.name, parentId: b.parentId, noteCount: notes.filter((n) => n.notebookId === b.id).length }) as NotebookInfo);
  }

  async createNotebook(name: string, opts: { parentId?: string } = {}): Promise<NotebookInfo> {
    const nb = await this.vault.vault.createNotebook(name, '#FF3D5A80', opts.parentId);
    await useApp.getState().refresh();
    return { id: nb.id, name: nb.name, parentId: nb.parentId } as NotebookInfo;
  }

  async trashNote(id: string): Promise<boolean> {
    if (this.open && this.open.meta.id === id) {
      // Through the open document, so its next autosave keeps the note in Trash.
      this.open.updateMeta((m) => ({ ...m, trashedAt: Date.now() }));
      this.vault.search.remove(id);
      return true;
    }
    await this.vault.vault.trashNote(id);
    this.vault.search.remove(id);
    await useApp.getState().refresh();
    return true;
  }
}

function clean(p: NotePatch): Partial<NoteMeta> {
  const out: Partial<NoteMeta> = {};
  if (p.title != null) out.title = p.title;
  if (p.tags != null) out.tags = p.tags;
  if (p.notebookId !== undefined) out.notebookId = p.notebookId ?? undefined;
  if (p.pinned != null) out.pinned = p.pinned;
  if (p.summary != null) out.summary = p.summary;
  return out;
}

function textBox(x: number, y: number, width: number, text: string): TextBox {
  return { id: newId(), x, y, width, text, fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now(), origin: 'ai' };
}

export { textBoxHeight };

/**
 * Handwriting → text for a page or a selection. Uses a vision model when one is configured
 * (best for messy handwriting), otherwise the on-device recognizer.
 */
export async function transcribePage(vault: AppVault, doc: NoteDocument, pageIndex: number, strokes?: InkStroke[], mode: 'plain' | 'markdown' = 'plain'): Promise<string | null> {
  const ai = await getActiveAI().catch(() => null);
  const page = doc.page(pageIndex);
  if (ai?.vision) {
    let region: { minX: number; minY: number; maxX: number; maxY: number } | undefined;
    if (strokes?.length) {
      const pts = strokes.flatMap((s) => s.points);
      region = { minX: Math.min(...pts.map((p) => p.x)), minY: Math.min(...pts.map((p) => p.y)), maxX: Math.max(...pts.map((p) => p.x)), maxY: Math.max(...pts.map((p) => p.y)) };
    }
    const onlyInk: PageInk = strokes ? { ...page, strokes, texts: [], images: [], background: undefined } : page;
    const pages = doc.pages.map((p, i) => (i === pageIndex ? onlyInk : p));
    const img = await pageImageForAI(vault, doc.meta, pages, pageIndex, region);
    const lang = useSettings.getState().recognition.language;
    return runSkill(transcribeHandwriting, ai.provider, ai.model, { image: { mediaType: img.mediaType, data: img.base64 }, mode, languageHint: lang, context: doc.meta.title });
  }
  const local = await recognizeLocally(strokes ?? page.strokes);
  // On Gemini Nano phones, ML Kit's proofreading fixes recognition slips (unchanged elsewhere).
  if (local) return nativeProofread(local.text);
  throw new Error('Add an AI provider with vision in Settings › AI (or use the Android app for on-device recognition) to convert handwriting.');
}
