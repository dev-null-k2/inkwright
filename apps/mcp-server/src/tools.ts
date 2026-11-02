import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/server';
import {
  DEFAULT_PAPER,
  LEFT_MARGIN,
  PAPER_STYLES,
  PAPER_TINTS,
  TOP_MARGIN,
  VaultLayout,
  contentBounds,
  exportMarkdown,
  isInfinite,
  newId,
  newNote,
  newPage,
  pageSizeOf,
  pageText,
  rectIsEmpty,
  textBoxHeight,
  wrapText,
  type NoteMeta,
  type NotebookMeta,
  type PageInk,
  type PaperStyle,
  type TextBox,
} from '@inkstone/core';
import { notebookPath, readNoteFresh, requireWritable, type ServerContext } from './context.ts';
import { pageSvg, pageSvgPath } from './render.ts';

// ---- Schemas & result helpers ----------------------------------------------------------------

const SAFE_ID = /^[0-9A-Za-z_-]{1,64}$/;
export const IdSchema = z.string().regex(SAFE_ID, 'Invalid id: expected 1-64 characters of [0-9A-Za-z_-]');
const TagsSchema = z.array(z.string().trim().min(1).max(100)).max(50);
const PAPER_STYLE_KEYS = Object.keys(PAPER_STYLES) as [PaperStyle, ...PaperStyle[]];

export function jsonResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

const iso = (ms: number | undefined) => (ms ? new Date(ms).toISOString() : undefined);
export const noteUri = (id: string) => `inkstone://notes/${id}`;
export const pageUri = (id: string, n: number) => `inkstone://notes/${id}/pages/${n}.svg`;

function notFound(id: string): Error {
  return new Error(`Note not found: ${id}. Use list_notes or search_notes to find note ids.`);
}

function cleanTags(tags: string[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const v = t.trim().replace(/^#/, '');
    if (v && !out.some((o) => o.toLowerCase() === v.toLowerCase())) out.push(v);
  }
  return out;
}

function normalizeColor(c: string): string {
  const hex = c.replace(/^#/, '').toUpperCase();
  return hex.length === 6 ? `#FF${hex}` : `#${hex}`;
}

/** Finds a notebook by id, name or "Parent / Child" path (case-insensitive). */
export function resolveNotebook(all: NotebookMeta[], ref: string): NotebookMeta {
  const byId = all.find((n) => n.id === ref);
  if (byId) return byId;
  const want = ref.trim().toLowerCase();
  const matches = all.filter((n) => n.name.toLowerCase() === want || notebookPath(all, n.id)?.toLowerCase() === want);
  if (matches.length === 1) return matches[0]!;
  if (matches.length > 1) {
    throw new Error(`Notebook name "${ref}" is ambiguous: ${matches.map((n) => `${notebookPath(all, n.id)} (${n.id})`).join(', ')}. Pass the id.`);
  }
  const names = all.map((n) => notebookPath(all, n.id)).join(', ') || 'none yet';
  throw new Error(`Notebook not found: "${ref}". Available notebooks: ${names}.`);
}

function descendantIds(all: NotebookMeta[], rootId: string): Set<string> {
  const out = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const n of all) if (n.parentId && out.has(n.parentId) && !out.has(n.id)) { out.add(n.id); grew = true; }
  }
  return out;
}

function noteSummary(n: NoteMeta, notebooks: NotebookMeta[]) {
  return {
    id: n.id,
    title: n.title,
    updated: iso(n.updatedAt),
    created: iso(n.createdAt),
    tags: n.tags,
    notebook: notebookPath(notebooks, n.notebookId),
    notebookId: n.notebookId ?? null,
    pages: n.pageIds.length,
    kind: n.kind,
    pinned: n.pinned,
    ...(n.summary ? { summary: n.summary } : {}),
    ...(n.trashedAt != null ? { trashed: iso(n.trashedAt) } : {}),
  };
}

function noteDetails(n: NoteMeta, pages: PageInk[], notebooks: NotebookMeta[]) {
  return {
    ...noteSummary(n, notebooks),
    uri: noteUri(n.id),
    markdownPath: VaultLayout.noteMarkdown(n.id),
    pageSize: n.pageSize,
    paper: n.paper,
    recordings: n.recordings?.length ?? 0,
    pageDetails: pages.map((p, i) => ({
      page: i + 1,
      id: p.id,
      strokes: p.strokes.length,
      textBoxes: p.texts?.length ?? 0,
      images: p.images?.length ?? 0,
      ...(p.background ? { background: p.background.kind } : {}),
      handwritingRecognized: Boolean(p.recognizedText?.trim()),
      ...(p.recognizedBy ? { recognizedBy: p.recognizedBy, recognizedAt: iso(p.recognizedAt) } : {}),
      needsRecognition: p.strokes.length > 0 && !p.recognizedText?.trim(),
      svgUri: pageUri(n.id, i + 1),
    })),
  };
}

// ---- Text layout -------------------------------------------------------------------------------

const FONT_SIZE = 16;
const GAP = 24;
const BOARD_TEXT_WIDTH = 560;

interface Frame {
  x: number;
  width: number;
  top: number;
  bottom: number;
}

/** Where typed text goes on a page: inside the margins on sheets, unbounded below on boards. */
function textFrame(note: NoteMeta, page: PageInk): Frame {
  const size = pageSizeOf(note, page);
  if (note.kind === 'board' || isInfinite(size)) {
    const b = contentBounds(page);
    return { x: rectIsEmpty(b) ? 0 : b.minX, width: BOARD_TEXT_WIDTH, top: rectIsEmpty(b) ? 0 : b.minY, bottom: Infinity };
  }
  const left = size.width >= LEFT_MARGIN * 3 ? LEFT_MARGIN + 8 : 24;
  const top = Math.min(TOP_MARGIN, size.height * 0.2);
  return { x: left, width: Math.max(80, size.width - left - 56), top, bottom: Math.max(top + FONT_SIZE * 2, size.height - 48) };
}

/** First free y below everything on the page. */
function nextFreeY(page: PageInk, frame: Frame): number {
  const b = contentBounds(page);
  return rectIsEmpty(b) ? frame.top : Math.max(frame.top, b.maxY + GAP);
}

/** Splits Markdown so the first part fits in `height`, preferring paragraph boundaries. */
export function splitToFit(text: string, width: number, height: number, fontSize = FONT_SIZE): [string, string] {
  if (!Number.isFinite(height)) return [text, ''];
  const lineH = fontSize * 1.35;
  const maxLines = Math.floor(height / lineH);
  if (maxLines < 1) return ['', text];
  const paras = text.split('\n');
  let used = 0;
  let i = 0;
  for (; i < paras.length; i++) {
    const n = Math.max(1, wrapText(paras[i]!, width, fontSize).length);
    if (used + n > maxLines) break;
    used += n;
  }
  if (i === paras.length) return [text, ''];
  const rest = (head: string[], tail: string[]) => [head.join('\n').trimEnd(), tail.join('\n').replace(/^\s*\n/, '')] as [string, string];
  if (i > 0) return rest(paras.slice(0, i), paras.slice(i));
  // A single paragraph taller than the space: break it between wrapped lines.
  const lines = wrapText(paras[0]!, width, fontSize);
  return [lines.slice(0, maxLines).join(' '), [lines.slice(maxLines).join(' '), ...paras.slice(1)].join('\n')];
}

function makeTextBox(note: NoteMeta, page: PageInk, text: string, x: number, y: number, width: number, now: number): TextBox {
  const tint = (page.paper ?? note.paper).tint;
  return {
    id: newId(now),
    x,
    y,
    width,
    text,
    fontSize: FONT_SIZE,
    color: PAPER_TINTS[tint]?.dark ? '#FFECEFF4' : '#FF1B1F24',
    font: 'sans',
    createdAt: now,
  };
}

const MAX_NEW_PAGES = 200;

/**
 * Lays `text` out from `startY` on `pages[startIndex]`, flowing onto new pages appended to the note
 * when it does not fit (only for fixed-size sheets and when `allowNewPages`). Mutates nothing;
 * returns the new page list and the ids of pages to write.
 */
function flowText(
  note: NoteMeta,
  pages: PageInk[],
  startIndex: number,
  text: string,
  now: number,
  allowNewPages: boolean,
): { pages: PageInk[]; changed: string[]; added: string[]; firstPage: number; boxes: Array<{ pageId: string; textId: string; text: string }> } {
  const out = pages.slice();
  const changed: string[] = [];
  const boxes: Array<{ pageId: string; textId: string; text: string }> = [];
  const added: string[] = [];
  let index = startIndex;
  let remaining = text.replace(/\s+$/, '');
  let firstPage = -1;
  let guard = 0;
  while (remaining.trim()) {
    const page = out[index]!;
    const frame = textFrame(note, page);
    const y = nextFreeY(page, frame);
    let [head, tail] = allowNewPages ? splitToFit(remaining, frame.width, frame.bottom - y) : [remaining, ''];
    const pageIsEmpty = rectIsEmpty(contentBounds(page));
    if (!head.trim() && pageIsEmpty) [head, tail] = [remaining, '']; // cannot fit anywhere: overflow
    if (head.trim()) {
      const box = makeTextBox(note, page, head, frame.x, y, frame.width, now);
      out[index] = { ...page, texts: [...(page.texts ?? []), box] };
      boxes.push({ pageId: page.id, textId: box.id, text: head });
      if (!changed.includes(page.id)) changed.push(page.id);
      if (firstPage < 0) firstPage = index;
    }
    remaining = tail;
    if (!remaining.trim()) break;
    if (++guard > MAX_NEW_PAGES) throw new Error('Text is too long to place (more than 200 pages).');
    const fresh = newPage(newId(now));
    out.splice(index + 1, 0, fresh);
    added.push(fresh.id);
    index += 1;
  }
  return { pages: out, changed, added, firstPage: Math.max(0, firstPage), boxes };
}

/**
 * Optimistic read-modify-write of one note. Re-reads note.json (and the page files it touches)
 * right before writing and retries when another writer (the app, a sync client) changed them in
 * between, so edits are never written over newer data. `updatedAt` only moves forward.
 */
async function mutateNote(
  ctx: ServerContext,
  id: string,
  change: (note: NoteMeta, pages: PageInk[]) => { note: NoteMeta; pages: PageInk[]; changedPageIds: string[] },
): Promise<{ note: NoteMeta; pages: PageInk[] }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const found = await readNoteFresh(ctx, id);
    if (!found) throw notFound(id);
    const pages = await ctx.vault.readPages(found.note);
    const rawPages = new Map<string, string | null>();
    for (const p of found.note.pageIds) rawPages.set(p, await ctx.fs.readText(VaultLayout.pageInk(id, p)));
    const next = change(found.note, pages);
    const latest = await ctx.fs.readText(VaultLayout.noteMeta(id));
    let stale = latest !== found.raw;
    for (const p of next.changedPageIds) {
      if (stale) break;
      if (rawPages.has(p) && (await ctx.fs.readText(VaultLayout.pageInk(id, p))) !== rawPages.get(p)) stale = true;
    }
    if (stale) continue;
    const note: NoteMeta = { ...next.note, updatedAt: Math.max(ctx.clock(), found.note.updatedAt + 1) };
    await ctx.vault.saveNote(note, next.pages, { changedPageIds: next.changedPageIds });
    ctx.markDirty();
    return { note, pages: next.pages };
  }
  throw new Error(`Note ${id} kept changing while saving (another device is writing to it). Try again in a moment.`);
}

// ---- list_notes ----------------------------------------------------------------------------------

export const listNotesShape = {
  notebook: z.string().min(1).optional().describe('Only notes in this notebook (id, name or "Parent / Child" path, case-insensitive), including nested sections.'),
  tag: z.string().min(1).optional().describe('Only notes with this tag (case-insensitive, leading # optional).'),
  limit: z.number().int().min(1).max(500).default(50).describe('Maximum number of notes to return (default 50).'),
  includeTrashed: z.boolean().default(false).describe('Also include notes in the Trash (default false).'),
};
const listNotesSchema = z.object(listNotesShape);
export type ListNotesArgs = z.input<typeof listNotesSchema>;

export async function listNotes(ctx: ServerContext, args: ListNotesArgs = {}): Promise<CallToolResult> {
  const a = listNotesSchema.parse(args);
  await ctx.refresh();
  const notebooks = await ctx.vault.listNotebooks();
  let notes = await ctx.vault.listNotes({ includeTrashed: a.includeTrashed });
  if (a.notebook) {
    const ids = descendantIds(notebooks, resolveNotebook(notebooks, a.notebook).id);
    notes = notes.filter((n) => n.notebookId != null && ids.has(n.notebookId));
  }
  if (a.tag) {
    const want = a.tag.replace(/^#/, '').toLowerCase();
    notes = notes.filter((n) => n.tags.some((t) => t.replace(/^#/, '').toLowerCase() === want));
  }
  const page = notes.slice(0, a.limit).map((n) => noteSummary(n, notebooks));
  return jsonResult({ total: notes.length, returned: page.length, notes: page });
}

// ---- search_notes --------------------------------------------------------------------------------

export const searchNotesShape = {
  query: z.string().trim().min(1).max(500).describe('Words to look for. Prefix and accent-insensitive matching ("lau bet" finds "launch the beta").'),
  limit: z.number().int().min(1).max(100).default(10).describe('Maximum number of notes to return (default 10).'),
};
const searchNotesSchema = z.object(searchNotesShape);
export type SearchNotesArgs = z.input<typeof searchNotesSchema>;

export async function searchNotes(ctx: ServerContext, args: SearchNotesArgs): Promise<CallToolResult> {
  const a = searchNotesSchema.parse(args);
  await ctx.refresh();
  const index = await ctx.searchIndex();
  const hits = index.search(a.query, { limit: a.limit });
  const notebooks = await ctx.vault.listNotebooks();
  const out = [];
  for (const h of hits) {
    const n = await ctx.vault.readNote(h.noteId);
    out.push({
      id: h.noteId,
      title: h.title,
      page: h.pageIndex + 1,
      snippet: h.snippet,
      score: Math.round(h.score * 1000) / 1000,
      updated: iso(n?.updatedAt),
      notebook: notebookPath(notebooks, n?.notebookId),
      tags: n?.tags ?? [],
      uri: noteUri(h.noteId),
    });
  }
  return jsonResult({ query: a.query, count: out.length, hits: out, ...(out.length ? {} : { hint: 'No matches. Try fewer or shorter words, or list_notes to browse.' }) });
}

// ---- read_note -------------------------------------------------------------------------------------

export const readNoteShape = { id: IdSchema.describe('Note id (from list_notes or search_notes).') };
const readNoteSchema = z.object(readNoteShape);
export type ReadNoteArgs = z.input<typeof readNoteSchema>;

/** Markdown of a note generated from its source files (front matter + typed and recognized text). */
export async function noteMarkdown(ctx: ServerContext, id: string): Promise<{ note: NoteMeta; pages: PageInk[]; markdown: string }> {
  const found = await readNoteFresh(ctx, id);
  if (!found) throw notFound(id);
  const pages = await ctx.vault.readPages(found.note);
  return { note: found.note, pages, markdown: exportMarkdown(found.note, pages) };
}

export async function readNote(ctx: ServerContext, args: ReadNoteArgs): Promise<CallToolResult> {
  const a = readNoteSchema.parse(args);
  await ctx.refresh();
  const { note, pages, markdown } = await noteMarkdown(ctx, a.id);
  const notebooks = await ctx.vault.listNotebooks();
  return {
    content: [
      { type: 'text', text: markdown },
      { type: 'text', text: JSON.stringify(noteDetails(note, pages, notebooks), null, 2) },
    ],
  };
}

// ---- get_page_image ----------------------------------------------------------------------------

export const getPageImageShape = {
  noteId: IdSchema.describe('Note id.'),
  page: z.number().int().min(1).default(1).describe('1-based page number (default 1).'),
  format: z.enum(['png', 'svg']).default('png').describe('"png" (an image you can look at; default) or "svg" (vector markup as text).'),
  width: z.number().int().min(64).max(4096).default(1200).describe('PNG width in pixels (default 1200).'),
};
const getPageImageSchema = z.object(getPageImageShape);
export type GetPageImageArgs = z.input<typeof getPageImageSchema>;

export async function getPageImage(ctx: ServerContext, args: GetPageImageArgs): Promise<CallToolResult> {
  const a = getPageImageSchema.parse(args);
  await ctx.refresh();
  const found = await readNoteFresh(ctx, a.noteId);
  if (!found) throw notFound(a.noteId);
  const note = found.note;
  const total = note.pageIds.length;
  if (a.page > total) throw new Error(`Page ${a.page} does not exist; "${note.title}" has ${total} page${total === 1 ? '' : 's'}.`);
  const page = await ctx.vault.readPage(note.id, note.pageIds[a.page - 1]!);
  const caption = `Page ${a.page} of ${total} of "${note.title}" (${note.id}).` + (page.recognizedText?.trim() ? `\nRecognized handwriting:\n${page.recognizedText.trim()}` : '');
  if (a.format === 'svg') {
    return { content: [{ type: 'text', text: caption }, { type: 'text', text: await pageSvg(ctx, note, page) }] };
  }
  const svg = await pageSvg(ctx, note, page, { embedAssets: true });
  let png: Uint8Array | null = null;
  let reason = 'the optional @resvg/resvg-js package is not installed';
  try {
    png = await ctx.renderPng(svg, a.width);
  } catch (e) {
    reason = `rendering failed (${(e as Error).message})`;
  }
  if (!png) {
    return {
      content: [
        { type: 'text', text: `${caption}\nPNG rendering is unavailable because ${reason}; returning the page as SVG instead.` },
        { type: 'text', text: await pageSvg(ctx, note, page) },
      ],
    };
  }
  return {
    content: [
      { type: 'image', data: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: caption },
    ],
  };
}

// ---- notebooks -----------------------------------------------------------------------------------

export const listNotebooksShape = {};

export async function listNotebooks(ctx: ServerContext, _args: Record<string, never> = {}): Promise<CallToolResult> {
  await ctx.refresh();
  const notebooks = await ctx.vault.listNotebooks();
  const notes = await ctx.vault.listNotes();
  const counts = new Map<string, number>();
  for (const n of notes) if (n.notebookId) counts.set(n.notebookId, (counts.get(n.notebookId) ?? 0) + 1);
  return jsonResult({
    notebooks: notebooks
      .map((nb) => ({ id: nb.id, name: nb.name, path: notebookPath(notebooks, nb.id), parentId: nb.parentId ?? null, color: nb.color, notes: counts.get(nb.id) ?? 0, created: iso(nb.createdAt) }))
      .sort((x, y) => (x.path ?? '').localeCompare(y.path ?? '')),
    unfiledNotes: notes.filter((n) => !n.notebookId || !notebooks.some((nb) => nb.id === n.notebookId)).length,
  });
}

/**
 * Stores text recognized from a page's handwriting (the ink is untouched). Only fills pages whose
 * recognized text is still empty, so a transcription the user made or corrected is never
 * replaced. Returns false when the page already had text or is gone.
 */
export async function setRecognizedText(ctx: ServerContext, noteId: string, pageId: string, text: string, by: string): Promise<boolean> {
  requireWritable(ctx);
  return ctx.withWriteLock(async () => {
    const found = await readNoteFresh(ctx, noteId);
    if (!found?.note.pageIds.includes(pageId) || (await ctx.vault.readPage(noteId, pageId)).recognizedText?.trim()) return false;
    let wrote = false;
    await mutateNote(ctx, noteId, (cur, pages) => {
      wrote = false;
      const next = pages.map((p) => {
        if (p.id !== pageId || p.recognizedText?.trim()) return p;
        wrote = true;
        return { ...p, recognizedText: text, recognizedAt: ctx.clock(), recognizedBy: by };
      });
      return { note: cur, pages: next, changedPageIds: wrote ? [pageId] : [] };
    });
    return wrote;
  });
}

export const createNotebookShape = {
  name: z.string().trim().min(1).max(200).describe('Notebook name.'),
  color: z.string().regex(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, 'Color must be #RRGGBB or #AARRGGBB').optional().describe('Cover color, #RRGGBB or #AARRGGBB.'),
  parentId: IdSchema.optional().describe('Create as a section inside this notebook.'),
};
const createNotebookSchema = z.object(createNotebookShape);
export type CreateNotebookArgs = z.input<typeof createNotebookSchema>;

export async function createNotebook(ctx: ServerContext, args: CreateNotebookArgs): Promise<CallToolResult> {
  const a = createNotebookSchema.parse(args);
  requireWritable(ctx);
  return ctx.withWriteLock(async () => {
    ctx.vault.invalidate();
    const all = await ctx.vault.listNotebooks();
    if (a.parentId && !all.some((n) => n.id === a.parentId)) throw new Error(`Parent notebook not found: ${a.parentId}`);
    const existing = all.find((n) => n.name.toLowerCase() === a.name.toLowerCase() && (n.parentId ?? null) === (a.parentId ?? null));
    if (existing) return jsonResult({ created: false, message: 'A notebook with this name already exists here.', notebook: { ...existing, path: notebookPath(all, existing.id) } });
    const nb = await ctx.vault.createNotebook(a.name, a.color ? normalizeColor(a.color) : undefined, a.parentId);
    ctx.markDirty();
    return jsonResult({ created: true, notebook: { ...nb, path: notebookPath([...all, nb], nb.id) } });
  });
}

// ---- create_note -------------------------------------------------------------------------------

export const createNoteShape = {
  title: z.string().trim().min(1).max(300).describe('Note title.'),
  text: z.string().max(200_000).optional().describe('Body as Markdown. Placed as typed text on page 1, flowing onto more pages when long.'),
  notebookId: z.string().min(1).optional().describe('Notebook id or exact name (see list_notebooks). Omit to leave the note unfiled.'),
  tags: TagsSchema.optional().describe('Tags, e.g. ["meeting", "project-x"].'),
  paper: z.enum(PAPER_STYLE_KEYS).optional().describe('Paper style for the pages (default ruled_narrow).'),
};
const createNoteSchema = z.object(createNoteShape);
export type CreateNoteArgs = z.input<typeof createNoteSchema>;

export async function createNote(ctx: ServerContext, args: CreateNoteArgs): Promise<CallToolResult> {
  const a = createNoteSchema.parse(args);
  requireWritable(ctx);
  return ctx.withWriteLock(async () => {
    ctx.vault.invalidate();
    const notebooks = await ctx.vault.listNotebooks();
    const notebookId = a.notebookId ? resolveNotebook(notebooks, a.notebookId).id : undefined;
    const now = ctx.clock();
    const first = newPage(newId(now));
    let note = newNote({
      id: newId(now),
      title: a.title,
      pageId: first.id,
      now,
      notebookId,
      tags: cleanTags(a.tags),
      paper: a.paper ? { ...DEFAULT_PAPER, style: a.paper } : undefined,
    });
    let pages: PageInk[] = [first];
    if (a.text?.trim()) {
      pages = flowText(note, pages, 0, a.text, now, true).pages;
      note = { ...note, pageIds: pages.map((p) => p.id) };
    }
    await ctx.vault.saveNote(note, pages);
    ctx.markDirty();
    return jsonResult({
      created: true,
      id: note.id,
      title: note.title,
      notebook: notebookPath(notebooks, notebookId),
      tags: note.tags,
      pages: pages.length,
      uri: noteUri(note.id),
      path: VaultLayout.noteDir(note.id),
    });
  });
}

// ---- append_to_note ----------------------------------------------------------------------------

export const appendToNoteShape = {
  id: IdSchema.describe('Note id.'),
  text: z.string().min(1).max(200_000).describe('Markdown to add as typed text below the existing content.'),
  page: z.number().int().min(1).optional().describe('1-based page to add to. Default: the last page, continuing onto new pages if it is full.'),
};
const appendToNoteSchema = z.object(appendToNoteShape);
export type AppendToNoteArgs = z.input<typeof appendToNoteSchema>;

export interface AppendOutcome {
  note: NoteMeta;
  /** 1-based page the text starts on. */
  page: number;
  newPages: number;
  /** Text boxes added, in order (one per page the text flowed onto). */
  boxes: Array<{ pageId: string; textId: string; text: string; addedPage: boolean }>;
}

/**
 * Appends typed text to a note (see append_to_note) and reports the text boxes it placed, so
 * agent hosts can log reversible operations without diffing the note.
 */
export async function appendTextToNote(ctx: ServerContext, args: AppendToNoteArgs): Promise<AppendOutcome> {
  const a = appendToNoteSchema.parse(args);
  requireWritable(ctx);
  if (!a.text.trim()) throw new Error('Text is empty.');
  return ctx.withWriteLock(async () => {
    let placed = { page: 0, newPages: 0 };
    let boxes: AppendOutcome['boxes'] = [];
    const { note } = await mutateNote(ctx, a.id, (cur, curPages) => {
      if (cur.trashedAt != null) throw new Error(`Note ${cur.id} is in the Trash; restore it first.`);
      const now = ctx.clock();
      let pages = curPages;
      if (!pages.length) pages = [newPage(newId(now))];
      if (a.page != null && a.page > pages.length) throw new Error(`Page ${a.page} does not exist; "${cur.title}" has ${pages.length} page(s).`);
      const index = a.page != null ? a.page - 1 : pages.length - 1;
      const flowed = flowText(cur, pages, index, a.text, now, a.page == null && cur.kind !== 'board');
      placed = { page: flowed.firstPage + 1, newPages: flowed.added.length };
      const existing = new Set(curPages.map((p) => p.id));
      boxes = flowed.boxes.map((b) => ({ ...b, addedPage: !existing.has(b.pageId) }));
      const pageIds = flowed.pages.map((p) => p.id);
      return { note: { ...cur, pageIds }, pages: flowed.pages, changedPageIds: [...new Set([...flowed.changed, ...flowed.added, ...(curPages.length ? [] : pageIds)])] };
    });
    return { note, page: placed.page, newPages: placed.newPages, boxes };
  });
}

export async function appendToNote(ctx: ServerContext, args: AppendToNoteArgs): Promise<CallToolResult> {
  const r = await appendTextToNote(ctx, args);
  return jsonResult({ appended: true, id: r.note.id, title: r.note.title, page: r.page, newPages: r.newPages, totalPages: r.note.pageIds.length, updated: iso(r.note.updatedAt) });
}

// ---- update_note -------------------------------------------------------------------------------

export const updateNoteShape = {
  id: IdSchema.describe('Note id.'),
  title: z.string().trim().min(1).max(300).optional().describe('New title.'),
  tags: TagsSchema.optional().describe('Replaces the whole tag list.'),
  notebookId: z.string().min(1).nullable().optional().describe('Move to this notebook (id or exact name); null to make the note unfiled.'),
  pinned: z.boolean().optional().describe('Pin or unpin in the library.'),
  summary: z.string().max(5000).nullable().optional().describe('Short summary shown in the library and to agents; null or "" clears it.'),
};
const updateNoteSchema = z.object(updateNoteShape);
export type UpdateNoteArgs = z.input<typeof updateNoteSchema>;

export async function updateNote(ctx: ServerContext, args: UpdateNoteArgs): Promise<CallToolResult> {
  const a = updateNoteSchema.parse(args);
  requireWritable(ctx);
  if (a.title === undefined && a.tags === undefined && a.notebookId === undefined && a.pinned === undefined && a.summary === undefined) {
    throw new Error('Nothing to update: pass at least one of title, tags, notebookId, pinned, summary.');
  }
  return ctx.withWriteLock(async () => {
    ctx.vault.invalidate();
    const notebooks = await ctx.vault.listNotebooks();
    const notebookId = a.notebookId == null ? a.notebookId : resolveNotebook(notebooks, a.notebookId).id;
    const { note } = await mutateNote(ctx, a.id, (cur, pages) => {
      const next: NoteMeta = { ...cur };
      if (a.title !== undefined) next.title = a.title;
      if (a.tags !== undefined) next.tags = cleanTags(a.tags);
      if (a.pinned !== undefined) next.pinned = a.pinned;
      if (notebookId === null) delete next.notebookId;
      else if (notebookId !== undefined) next.notebookId = notebookId;
      if (a.summary === null || a.summary?.trim() === '') delete next.summary;
      else if (a.summary !== undefined) next.summary = a.summary.trim();
      return { note: next, pages, changedPageIds: [] };
    });
    return jsonResult({ updated: true, note: noteSummary(note, notebooks) });
  });
}

// ---- trash_note / restore_note -----------------------------------------------------------------

export const trashNoteShape = { id: IdSchema.describe('Note id.') };
const trashNoteSchema = z.object(trashNoteShape);
export type TrashNoteArgs = z.input<typeof trashNoteSchema>;

export async function trashNote(ctx: ServerContext, args: TrashNoteArgs): Promise<CallToolResult> {
  const a = trashNoteSchema.parse(args);
  requireWritable(ctx);
  return ctx.withWriteLock(async () => {
    const found = await readNoteFresh(ctx, a.id);
    if (!found) throw notFound(a.id);
    if (found.note.trashedAt != null) return jsonResult({ trashed: true, id: a.id, title: found.note.title, message: 'Already in the Trash.' });
    ctx.vault.invalidate();
    await ctx.vault.trashNote(a.id);
    ctx.markDirty();
    return jsonResult({
      trashed: true,
      id: a.id,
      title: found.note.title,
      message: 'Moved to the Trash. This is reversible: call restore_note, or restore it from Inkstone’s Trash within 30 days.',
    });
  });
}

export const restoreNoteShape = { id: IdSchema.describe('Note id of a trashed note.') };
const restoreNoteSchema = z.object(restoreNoteShape);
export type RestoreNoteArgs = z.input<typeof restoreNoteSchema>;

export async function restoreNote(ctx: ServerContext, args: RestoreNoteArgs): Promise<CallToolResult> {
  const a = restoreNoteSchema.parse(args);
  requireWritable(ctx);
  return ctx.withWriteLock(async () => {
    const found = await readNoteFresh(ctx, a.id);
    if (!found) throw notFound(a.id);
    if (found.note.trashedAt == null) return jsonResult({ restored: true, id: a.id, title: found.note.title, message: 'The note was not in the Trash.' });
    ctx.vault.invalidate();
    await ctx.vault.restoreNote(a.id);
    ctx.markDirty();
    return jsonResult({ restored: true, id: a.id, title: found.note.title });
  });
}

// ---- get_recent_handwriting --------------------------------------------------------------------

export const getRecentHandwritingShape = {
  sinceHours: z.number().min(0.1).max(24 * 366).default(24).describe('Look back this many hours (default 24).'),
  limit: z.number().int().min(1).max(100).default(20).describe('Maximum number of notes (default 20).'),
};
const getRecentHandwritingSchema = z.object(getRecentHandwritingShape);
export type GetRecentHandwritingArgs = z.input<typeof getRecentHandwritingSchema>;

/** Notes changed since `since`, as Markdown sections with the pages that changed. */
export async function recentNotesMarkdown(ctx: ServerContext, since: number, opts: { until?: number; limit?: number; notebook?: string } = {}): Promise<{ count: number; markdown: string }> {
  await ctx.refresh();
  const notebooks = await ctx.vault.listNotebooks();
  let notes = (await ctx.vault.listNotes()).filter((n) => n.updatedAt >= since && (opts.until == null || n.updatedAt < opts.until));
  if (opts.notebook) {
    const ids = descendantIds(notebooks, resolveNotebook(notebooks, opts.notebook).id);
    notes = notes.filter((n) => n.notebookId != null && ids.has(n.notebookId));
  }
  const total = notes.length;
  notes = notes.slice(0, opts.limit ?? 20);
  const out: string[] = [];
  for (const n of notes) {
    const pages = await ctx.vault.readPages(n);
    const meta = [`id: ${n.id}`, `updated ${iso(n.updatedAt)}`];
    const nb = notebookPath(notebooks, n.notebookId);
    if (nb) meta.push(`notebook: ${nb}`);
    if (n.tags.length) meta.push(`tags: ${n.tags.join(', ')}`);
    out.push(`## ${n.title || 'Untitled'}`, '', meta.join(' · '), '');
    if (n.summary?.trim()) out.push(`> ${n.summary.trim().replace(/\n/g, '\n> ')}`, '');
    // Pages touched in the window (new strokes or text boxes); all pages when timestamps are missing.
    const touched = pages
      .map((p, i) => ({ p, i, strokes: p.strokes.filter((s) => s.createdAt >= since).length, texts: (p.texts ?? []).filter((t) => t.createdAt >= since).length }))
      .filter((x) => x.strokes > 0 || x.texts > 0);
    const shown = touched.length ? touched : pages.map((p, i) => ({ p, i, strokes: 0, texts: 0 })).filter((x) => x.p.strokes.length || x.p.texts?.length || x.p.recognizedText);
    for (const { p, i, strokes } of shown) {
      out.push(`### Page ${i + 1}${strokes ? ` — ${strokes} new stroke${strokes === 1 ? '' : 's'}` : ''}`, '');
      const text = pageText(p);
      if (text) out.push(text, '');
      if (p.strokes.length && !p.recognizedText?.trim()) out.push(`_(handwriting not yet recognized — use get_page_image with noteId ${n.id} and page ${i + 1} to look at it)_`, '');
      else if (!text) out.push('_(blank)_', '');
    }
    if (!shown.length) out.push('_(no content)_', '');
  }
  const more = total > notes.length ? `\n_${total - notes.length} more note(s) not shown; raise \`limit\`._\n` : '';
  return { count: total, markdown: out.join('\n') + more };
}

export async function getRecentHandwriting(ctx: ServerContext, args: GetRecentHandwritingArgs = {}): Promise<CallToolResult> {
  const a = getRecentHandwritingSchema.parse(args);
  const now = ctx.clock();
  const since = now - a.sinceHours * 3600_000;
  const { count, markdown } = await recentNotesMarkdown(ctx, since, { limit: a.limit });
  const head = `# Notes written or edited since ${new Date(since).toISOString()} (last ${a.sinceHours} h)\n\n${count} note${count === 1 ? '' : 's'} updated.\n\n`;
  return textResult(count ? head + markdown : head + '_Nothing new in this window. Try a larger `sinceHours`._\n');
}

// ---- Registry ----------------------------------------------------------------------------------

export interface ToolDef {
  name: string;
  title: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Write tools are not registered in read-only mode. */
  write: boolean;
  annotations: ToolAnnotations;
  // Method syntax keeps handler parameter types bivariant so each tool keeps its own arg type.
  handler(ctx: ServerContext, args: unknown): Promise<CallToolResult>;
}

const READ: ToolAnnotations = { readOnlyHint: true, openWorldHint: false };

export const TOOLS: ToolDef[] = [
  {
    name: 'list_notes',
    title: 'List notes',
    description:
      'List notes in the user’s Inkstone handwriting vault, newest first. Returns id, title, updated time, tags, notebook, page count and summary. Filter by notebook (id or name) or tag. Use the id with read_note or get_page_image.',
    inputSchema: listNotesShape,
    write: false,
    annotations: { ...READ, title: 'List notes' },
    handler: (ctx, args) => listNotes(ctx, args as ListNotesArgs),
  },
  {
    name: 'search_notes',
    title: 'Search notes',
    description:
      'Full-text search across note titles, tags, summaries, typed text and text recognized from handwriting. Returns the best-matching notes with the matching page and a snippet (matches marked with «»).',
    inputSchema: searchNotesShape,
    write: false,
    annotations: { ...READ, title: 'Search notes' },
    handler: (ctx, args) => searchNotes(ctx, args as SearchNotesArgs),
  },
  {
    name: 'read_note',
    title: 'Read note',
    description:
      'Read one note as Markdown: YAML front matter, then each page’s typed text and recognized handwriting. Also returns metadata (notebook, tags, per-page stroke counts, which pages still need handwriting recognition). For pages whose handwriting is not recognized, look at them with get_page_image.',
    inputSchema: readNoteShape,
    write: false,
    annotations: { ...READ, title: 'Read note' },
    handler: (ctx, args) => readNote(ctx, args as ReadNoteArgs),
  },
  {
    name: 'get_page_image',
    title: 'Get page image',
    description:
      'Render one page of a note (paper, handwriting, drawings, images, typed text) as a PNG image you can look at, or as SVG markup. Use it to read handwriting that has not been recognized yet, or to see diagrams and sketches.',
    inputSchema: getPageImageShape,
    write: false,
    annotations: { ...READ, title: 'Get page image' },
    handler: (ctx, args) => getPageImage(ctx, args as GetPageImageArgs),
  },
  {
    name: 'list_notebooks',
    title: 'List notebooks',
    description: 'List notebooks (and nested sections) with ids, paths like "Work / Projects", colors and note counts.',
    inputSchema: listNotebooksShape,
    write: false,
    annotations: { ...READ, title: 'List notebooks' },
    handler: (ctx) => listNotebooks(ctx),
  },
  {
    name: 'get_recent_handwriting',
    title: 'Recent handwriting',
    description:
      'What did I write recently? Returns notes created or edited in the last `sinceHours` hours (default 24) with the recognized handwriting and typed text of the pages that changed, as Markdown. Use it for "check what I wrote today".',
    inputSchema: getRecentHandwritingShape,
    write: false,
    annotations: { ...READ, title: 'Recent handwriting' },
    handler: (ctx, args) => getRecentHandwriting(ctx, args as GetRecentHandwritingArgs),
  },
  {
    name: 'create_notebook',
    title: 'Create notebook',
    description: 'Create a notebook (or a section inside one with parentId). If a notebook with the same name already exists in the same place, returns it instead of creating a duplicate.',
    inputSchema: createNotebookShape,
    write: true,
    annotations: { title: 'Create notebook', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (ctx, args) => createNotebook(ctx, args as CreateNotebookArgs),
  },
  {
    name: 'create_note',
    title: 'Create note',
    description:
      'Create a new note in the vault. The text (Markdown) is placed as typed text on the first page, flowing onto further pages when long. The note appears in the Inkstone app on every synced device, where the user can write on it by hand.',
    inputSchema: createNoteShape,
    write: true,
    annotations: { title: 'Create note', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: (ctx, args) => createNote(ctx, args as CreateNoteArgs),
  },
  {
    name: 'append_to_note',
    title: 'Append to note',
    description:
      'Add typed text (Markdown) to an existing note, below everything already on the page (handwriting, text and images are left untouched). Defaults to the last page and continues on new pages when it is full.',
    inputSchema: appendToNoteShape,
    write: true,
    annotations: { title: 'Append to note', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    handler: (ctx, args) => appendToNote(ctx, args as AppendToNoteArgs),
  },
  {
    name: 'update_note',
    title: 'Update note',
    description: 'Change a note’s metadata: title, tags (replaces the list), notebook (null to unfile), pinned, or summary. Page content is not touched.',
    inputSchema: updateNoteShape,
    write: true,
    annotations: { title: 'Update note', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: (ctx, args) => updateNote(ctx, args as UpdateNoteArgs),
  },
  {
    name: 'trash_note',
    title: 'Move note to Trash',
    description:
      'Move a note to the Trash (soft delete). This is reversible: nothing is erased, restore_note brings it back, and the user can restore it from Inkstone’s Trash for 30 days. Confirm with the user before trashing.',
    inputSchema: trashNoteShape,
    write: true,
    annotations: { title: 'Move note to Trash', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    handler: (ctx, args) => trashNote(ctx, args as TrashNoteArgs),
  },
  {
    name: 'restore_note',
    title: 'Restore note from Trash',
    description: 'Restore a note from the Trash (undo trash_note).',
    inputSchema: restoreNoteShape,
    write: true,
    annotations: { title: 'Restore note from Trash', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    handler: (ctx, args) => restoreNote(ctx, args as RestoreNoteArgs),
  },
];
