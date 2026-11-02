/**
 * Every REST operation, declared once: method, path, scope, zod schemas for path/query/body and
 * responses, and the handler. `router.ts` serves them, `openapi.ts` documents them and the
 * contract tests check one against the other.
 *
 * Writes go through the same tool handlers MCP clients use (tools.ts) and are logged per caller in
 * Activity (activity.ts), so a change made with an API key shows up in the app as
 * "<key name> (API)" and can be undone there like any agent's change.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import {
  KnowledgeIndex,
  PAGE_SUMMARIES_ASSET,
  TRANSCRIPT_SUFFIX,
  VaultLayout,
  buildGraph,
  clipIdOfTranscript,
  decodeTranscript,
  exportMarkdown,
  pageSizeOf,
  pageText,
  type NoteMeta,
  type NotebookMeta,
  type PageInk,
} from '@inkstone/core';
import { ActivityStore, RoutineStore } from '@inkstone/ai';
import { PDFDocument } from 'pdf-lib';
import { notebookPath, readNoteFresh, type ServerContext } from '../context.ts';
import { appendToNote, createNote, createNotebook, restoreNote, trashNote, updateNote } from '../tools.ts';
import { pageSvg } from '../render.ts';
import { deferringApprover } from '../approvals.ts';
import { findRoutine, runRoutineOnServer } from '../agent/run.ts';
import type { ServerServices } from '../server.ts';
import { ApiError, decodeCursor, defineRoute, encodeCursor, iso, offsetPage, type ApiRequest, type ApiResult, type RouteDef } from './core.ts';
import * as S from './schemas.ts';
import type { KeyStore } from './keys.ts';
import type { SemanticSearch } from './semantic.ts';
import type { VaultEvents } from './events.ts';
import type { WebhookService } from './webhooks.ts';

/** What handlers can reach. */
export interface ApiDeps {
  ctx: ServerContext;
  services: ServerServices;
  keys: KeyStore;
  webhooks: WebhookService;
  events: VaultEvents;
  semantic: SemanticSearch | null;
}

const LIMIT = (def: number, max: number) => z.coerce.number().int().min(1).max(max).default(def).describe(`Page size (default ${def}, at most ${max}).`);
const Cursor = z.string().optional().describe('Opaque cursor from a previous page’s nextCursor.');
const IdParams = z.object({ id: S.Id.describe('Note id.') });
const PageParams = z.object({ id: S.Id.describe('Note id.'), n: z.coerce.number().int().min(1).describe('1-based page number.') });
const bool = z.enum(['true', 'false']).transform((v) => v === 'true');

const json = (schema: z.ZodType, description: string) => ({ description, schema });
const binary = (mime: string, description: string) => ({ description, content: { [mime]: { schema: { type: 'string', contentMediaType: mime } } } });
const text = (mime: string, description: string) => ({ description, content: { [mime]: { schema: { type: 'string' } } } });
const ETAG_HEADER = { etag: { description: 'Entity tag of the note; send it back in If-Match to update safely.', schema: { type: 'string' } } };

// ---- Representations ------------------------------------------------------------------------------

export function noteEtag(raw: string): string {
  return `"${createHash('sha256').update(raw).digest('base64url').slice(0, 22)}"`;
}

function summary(n: NoteMeta, notebooks: NotebookMeta[]): z.infer<typeof S.NoteSummary> {
  return {
    id: n.id,
    title: n.title,
    kind: n.kind,
    tags: n.tags,
    notebookId: n.notebookId ?? null,
    notebook: notebookPath(notebooks, n.notebookId),
    pages: n.pageIds.length,
    pinned: n.pinned,
    summary: n.summary ?? null,
    createdAt: iso(n.createdAt)!,
    updatedAt: iso(n.updatedAt)!,
    trashedAt: iso(n.trashedAt),
    locked: !!n.lock,
  };
}

function pageInfo(n: NoteMeta, p: PageInk, i: number): z.infer<typeof S.PageInfo> {
  const size = pageSizeOf(n, p);
  return {
    number: i + 1,
    id: p.id,
    strokes: p.strokes.length,
    textBoxes: p.texts?.length ?? 0,
    images: p.images?.length ?? 0,
    objects: p.objects?.length ?? 0,
    background: p.background?.kind ?? null,
    handwritingRecognized: !!p.recognizedText?.trim(),
    width: size.width,
    height: size.height,
  };
}

async function loadNote(ctx: ServerContext, id: string): Promise<{ note: NoteMeta; raw: string; etag: string }> {
  await ctx.refresh();
  const found = await readNoteFresh(ctx, id);
  if (!found) throw new ApiError('not_found', `There is no note with id ${id}.`);
  return { ...found, etag: noteEtag(found.raw) };
}

async function loadPage(ctx: ServerContext, id: string, n: number): Promise<{ note: NoteMeta; page: PageInk; index: number }> {
  const { note } = await loadNote(ctx, id);
  if (n > note.pageIds.length) throw new ApiError('not_found', `Page ${n} does not exist; the note has ${note.pageIds.length} page(s).`);
  return { note, page: await ctx.vault.readPage(note.id, note.pageIds[n - 1]!), index: n - 1 };
}

/** Rejects a write when If-Match does not name the note's current entity tag. */
function checkIfMatch(req: ApiRequest<any, any, any>, etag: string): void {
  if (!req.ifMatch) return;
  const strip = (t: string) => t.replace(/^W\//, '');
  if (!req.ifMatch.some((t) => t === '*' || strip(t) === strip(etag))) {
    throw new ApiError('precondition_failed', 'The note changed since you read it (its ETag no longer matches If-Match). Read it again and retry.', { headers: { etag } });
  }
}

function toolValue(r: CallToolResult): Record<string, any> {
  const t = r.content?.find((c) => c.type === 'text') as { text?: string } | undefined;
  if (r.isError) throw new ApiError('invalid_request', t?.text ?? 'The request failed.');
  try {
    return JSON.parse(t?.text ?? '{}');
  } catch {
    return {};
  }
}

/**
 * Runs one of the MCP write tools on behalf of the caller, logged in Activity under the caller's
 * name so the app can show and undo it. Tool errors become 400/404 problems.
 */
async function write(d: ApiDeps, req: ApiRequest<any, any, any>, tool: string, args: Record<string, unknown>, handler: (ctx: ServerContext, a: any) => Promise<CallToolResult>): Promise<Record<string, any>> {
  if (d.ctx.readOnly) throw new ApiError('read_only', 'This vault is served read-only (--read-only).');
  const log = d.services.activity.get(`${req.principal.label}|${req.principal.id}`, req.principal.label);
  let result: CallToolResult;
  try {
    result = await log.record(tool, args as Record<string, any>, () => handler(d.ctx, args));
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/not found/i.test(msg)) throw new ApiError('not_found', msg);
    if (/locked/i.test(msg)) throw new ApiError('locked', msg);
    if ((e as { issues?: unknown }).issues) throw new ApiError('invalid_request', msg);
    throw new ApiError('invalid_request', msg);
  }
  d.events.poke();
  return toolValue(result);
}

// ---- Knowledge index (links, graph) ------------------------------------------------------------------

const knowledge = new WeakMap<ServerContext, { index: KnowledgeIndex; sigs: Map<string, number> }>();

async function knowledgeIndex(ctx: ServerContext): Promise<KnowledgeIndex> {
  await ctx.refresh();
  let k = knowledge.get(ctx);
  if (!k) knowledge.set(ctx, (k = { index: new KnowledgeIndex(), sigs: new Map() }));
  const notes = await ctx.vault.listNotes();
  const live = new Set(notes.map((n) => n.id));
  for (const id of [...k.sigs.keys()]) if (!live.has(id)) { k.index.remove(id); k.sigs.delete(id); }
  for (const n of notes) {
    if (k.sigs.get(n.id) === n.updatedAt) continue;
    k.index.update(n, await ctx.vault.readPages(n));
    k.sigs.set(n.id, n.updatedAt);
  }
  return k.index;
}

// ---- Routes --------------------------------------------------------------------------------------

export function createRoutes(d: ApiDeps): RouteDef[] {
  const { ctx } = d;
  const routines = new RoutineStore(ctx.fs);

  return [
    // ---- Notes ----
    defineRoute({
      method: 'GET', path: '/notes', operationId: 'listNotes', tag: 'Notes', scope: 'notes:read',
      summary: 'List notes',
      description: 'Newest first (by last change). Filter by notebook (with its sections), tag, change time or trash state. Paginated with an opaque cursor that stays stable while notes change.',
      query: z.object({
        limit: LIMIT(50, 200),
        cursor: Cursor,
        notebook: z.string().optional().describe('Notebook id or exact name; includes its sections.'),
        tag: z.string().optional().describe('Only notes with this tag (case-insensitive, # optional).'),
        updatedSince: z.iso.datetime({ offset: true }).optional().describe('Only notes changed at or after this time.'),
        status: z.enum(['active', 'trashed', 'all']).default('active').describe('Live notes (default), notes in the Trash, or both.'),
      }),
      responses: { 200: json(S.NoteList, 'A page of notes.') },
      async handler(req: ApiRequest<unknown, { limit: number; cursor?: string; notebook?: string; tag?: string; updatedSince?: string; status: 'active' | 'trashed' | 'all' }>) {
        const q = req.query;
        await ctx.refresh();
        const notebooks = await ctx.vault.listNotebooks();
        let notes = await ctx.vault.listNotes({ includeTrashed: q.status !== 'active' });
        if (q.status === 'trashed') notes = notes.filter((n) => n.trashedAt != null);
        if (q.notebook) {
          const nb = notebooks.find((n) => n.id === q.notebook) ?? notebooks.find((n) => n.name.toLowerCase() === q.notebook!.toLowerCase());
          if (!nb) throw new ApiError('not_found', `There is no notebook "${q.notebook}".`);
          const within = new Set([nb.id]);
          for (let grew = true; grew; ) {
            grew = false;
            for (const x of notebooks) if (x.parentId && within.has(x.parentId) && !within.has(x.id)) { within.add(x.id); grew = true; }
          }
          notes = notes.filter((n) => n.notebookId != null && within.has(n.notebookId));
        }
        if (q.tag) {
          const want = q.tag.replace(/^#/, '').toLowerCase();
          notes = notes.filter((n) => n.tags.some((t) => t.replace(/^#/, '').toLowerCase() === want));
        }
        if (q.updatedSince) {
          const since = Date.parse(q.updatedSince);
          notes = notes.filter((n) => n.updatedAt >= since);
        }
        // Keyset pagination on (updatedAt desc, id desc): stable while notes are added or edited.
        notes.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
        const after = decodeCursor(q.cursor, (v): v is { u: number; i: string } => !!v && typeof (v as { u?: unknown }).u === 'number' && typeof (v as { i?: unknown }).i === 'string');
        if (after) notes = notes.filter((n) => n.updatedAt < after.u || (n.updatedAt === after.u && n.id < after.i));
        const data = notes.slice(0, q.limit);
        const last = data[data.length - 1];
        return { status: 200, body: { data: data.map((n) => summary(n, notebooks)), nextCursor: notes.length > q.limit && last ? encodeCursor({ u: last.updatedAt, i: last.id }) : null } };
      },
    }),
    defineRoute({
      method: 'POST', path: '/notes', operationId: 'createNote', tag: 'Notes', scope: 'notes:write', writes: true, idempotent: true,
      summary: 'Create a note',
      description: 'Creates a note with typed text (Markdown). Logged in Activity under the caller’s name, where it can be undone.',
      body: S.NoteCreate,
      responses: { 201: { ...json(S.Note, 'The new note.'), headers: { location: { description: 'URL of the new note.', schema: { type: 'string' } }, ...ETAG_HEADER } } },
      async handler(req: ApiRequest<unknown, unknown, z.infer<typeof S.NoteCreate>>) {
        const r = await write(d, req, 'create_note', req.body, createNote);
        const res = await getNote(ctx, r.id as string);
        return { ...res, status: 201, headers: { location: `${req.baseUrl}/notes/${r.id}` } };
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}', operationId: 'getNote', tag: 'Notes', scope: 'notes:read',
      summary: 'Get a note',
      description: 'Metadata, Markdown (typed text and recognized handwriting) and page details. Supports If-None-Match.',
      params: IdParams,
      responses: { 200: { ...json(S.Note, 'The note.'), headers: ETAG_HEADER }, 304: { description: 'Not modified (If-None-Match matched).' } },
      handler: (req: ApiRequest<{ id: string }>) => getNote(ctx, req.params.id),
    }),
    defineRoute({
      method: 'PATCH', path: '/notes/{id}', operationId: 'updateNote', tag: 'Notes', scope: 'notes:write', writes: true, conditional: true,
      summary: 'Update a note',
      description: 'Changes title, tags, notebook, pin or summary. Send If-Match with the ETag you read to avoid overwriting someone else’s change (412 if it changed).',
      params: IdParams,
      body: S.NoteUpdate,
      responses: { 200: { ...json(S.Note, 'The updated note.'), headers: ETAG_HEADER } },
      async handler(req: ApiRequest<{ id: string }, unknown, z.infer<typeof S.NoteUpdate>>) {
        const { etag } = await loadNote(ctx, req.params.id);
        checkIfMatch(req, etag);
        await write(d, req, 'update_note', { id: req.params.id, ...req.body }, updateNote);
        return getNote(ctx, req.params.id);
      },
    }),
    defineRoute({
      method: 'DELETE', path: '/notes/{id}', operationId: 'trashNote', tag: 'Notes', scope: 'notes:write', writes: true, conditional: true,
      summary: 'Move a note to the Trash',
      description: 'Reversible: restore it with POST /notes/{id}/restore (or in the app) within 30 days.',
      params: IdParams,
      responses: { 200: json(S.NoteSummary, 'The note, now in the Trash.') },
      async handler(req: ApiRequest<{ id: string }>) {
        const { etag } = await loadNote(ctx, req.params.id);
        checkIfMatch(req, etag);
        await write(d, req, 'trash_note', { id: req.params.id }, trashNote);
        const { note } = await loadNote(ctx, req.params.id);
        return { status: 200, body: summary(note, await ctx.vault.listNotebooks()) };
      },
    }),
    defineRoute({
      method: 'POST', path: '/notes/{id}/restore', operationId: 'restoreNote', tag: 'Notes', scope: 'notes:write', writes: true,
      summary: 'Restore a note from the Trash',
      params: IdParams,
      responses: { 200: json(S.NoteSummary, 'The restored note.') },
      async handler(req: ApiRequest<{ id: string }>) {
        await loadNote(ctx, req.params.id);
        await write(d, req, 'restore_note', { id: req.params.id }, restoreNote);
        const { note } = await loadNote(ctx, req.params.id);
        return { status: 200, body: summary(note, await ctx.vault.listNotebooks()) };
      },
    }),
    defineRoute({
      method: 'POST', path: '/notes/{id}/append', operationId: 'appendToNote', tag: 'Notes', scope: 'notes:write', writes: true, idempotent: true, conditional: true,
      summary: 'Append text to a note',
      description: 'Adds Markdown as typed text below the content, continuing onto new pages when the page is full.',
      params: IdParams,
      body: S.NoteAppend,
      responses: { 200: { ...json(S.Note, 'The note after the change.'), headers: ETAG_HEADER } },
      async handler(req: ApiRequest<{ id: string }, unknown, z.infer<typeof S.NoteAppend>>) {
        const { etag } = await loadNote(ctx, req.params.id);
        checkIfMatch(req, etag);
        await write(d, req, 'append_to_note', { id: req.params.id, ...req.body }, appendToNote);
        return getNote(ctx, req.params.id);
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}/markdown', operationId: 'getNoteMarkdown', tag: 'Notes', scope: 'notes:read',
      summary: 'Get a note as Markdown',
      params: IdParams,
      responses: { 200: text('text/markdown', 'The note as Markdown with YAML front matter.') },
      async handler(req: ApiRequest<{ id: string }>) {
        const { note, etag } = await loadNote(ctx, req.params.id);
        return { status: 200, raw: exportMarkdown(note, await ctx.vault.readPages(note)), contentType: 'text/markdown; charset=utf-8', etag };
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}/export', operationId: 'exportNote', tag: 'Notes', scope: 'notes:read',
      summary: 'Export a note',
      description: '`md` (Markdown), `pdf` (every page; needs the optional @resvg/resvg-js renderer), or `json` (the note’s vault files: note.json and every page’s ink, for backups and other tools).',
      params: IdParams,
      query: z.object({ format: z.enum(['md', 'pdf', 'json']).describe('Export format.') }),
      responses: {
        200: { description: 'The exported file.', content: { 'text/markdown': { schema: { type: 'string' } }, 'application/pdf': { schema: { type: 'string', contentMediaType: 'application/pdf' } }, 'application/json': { schema: { type: 'object' } } } },
        501: json(S.Problem, 'PDF rendering is not available on this server.'),
      },
      async handler(req: ApiRequest<{ id: string }, { format: 'md' | 'pdf' | 'json' }>) {
        const { note, etag } = await loadNote(ctx, req.params.id);
        const pages = await ctx.vault.readPages(note);
        const name = (note.title || 'Note').replace(/[\\/:*?"<>|]+/g, ' ').trim().slice(0, 80) || 'Note';
        if (req.query.format === 'md') return { status: 200, raw: exportMarkdown(note, pages), contentType: 'text/markdown; charset=utf-8', etag, headers: disposition(`${name}.md`) };
        if (req.query.format === 'json') return { status: 200, body: { note, pages }, etag, headers: disposition(`${name}.json`) };
        const pdf = await notePdf(ctx, note, pages);
        return { status: 200, raw: pdf, contentType: 'application/pdf', etag, headers: disposition(`${name}.pdf`) };
      },
    }),

    // ---- Pages ----
    defineRoute({
      method: 'GET', path: '/notes/{id}/pages', operationId: 'listPages', tag: 'Pages', scope: 'notes:read',
      summary: 'List a note’s pages',
      params: IdParams,
      responses: { 200: json(S.PageList, 'Every page, in order.') },
      async handler(req: ApiRequest<{ id: string }>) {
        const { note } = await loadNote(ctx, req.params.id);
        const pages = await ctx.vault.readPages(note);
        return { status: 200, body: { data: pages.map((p, i) => pageInfo(note, p, i)), nextCursor: null } };
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}/pages/{n}', operationId: 'getPage', tag: 'Pages', scope: 'notes:read',
      summary: 'Get a page’s details',
      params: PageParams,
      responses: { 200: json(S.PageInfo, 'The page.') },
      async handler(req: ApiRequest<{ id: string; n: number }>) {
        const { note, page, index } = await loadPage(ctx, req.params.id, req.params.n);
        return { status: 200, body: pageInfo(note, page, index) };
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}/pages/{n}/ink', operationId: 'getPageInk', tag: 'Pages', scope: 'notes:read',
      summary: 'Get a page’s ink as JSON',
      description: 'The page file (PageInk) exactly as in the vault: strokes with points, text boxes, images and objects (docs/VAULT_FORMAT.md).',
      params: PageParams,
      responses: { 200: { description: 'PageInk JSON.', content: { 'application/json': { schema: { type: 'object' } } } } },
      async handler(req: ApiRequest<{ id: string; n: number }>) {
        const { page } = await loadPage(ctx, req.params.id, req.params.n);
        return { status: 200, body: page };
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}/pages/{n}/text', operationId: 'getPageText', tag: 'Pages', scope: 'notes:read',
      summary: 'Get a page’s text',
      description: 'Typed text and recognized handwriting of the page.',
      params: PageParams,
      responses: { 200: text('text/plain', 'The text.') },
      async handler(req: ApiRequest<{ id: string; n: number }>) {
        const { page } = await loadPage(ctx, req.params.id, req.params.n);
        return { status: 200, raw: pageText(page), contentType: 'text/plain; charset=utf-8' };
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}/pages/{n}/svg', operationId: 'getPageSvg', tag: 'Pages', scope: 'notes:read',
      summary: 'Render a page as SVG',
      params: PageParams,
      query: z.object({ embedAssets: bool.default(true).describe('Inline images as data URLs (default true).') }),
      responses: { 200: binary('image/svg+xml', 'The page as SVG.') },
      async handler(req: ApiRequest<{ id: string; n: number }, { embedAssets: boolean }>) {
        const { note, page } = await loadPage(ctx, req.params.id, req.params.n);
        return { status: 200, raw: await pageSvg(ctx, note, page, { embedAssets: req.query.embedAssets }), contentType: 'image/svg+xml' };
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}/pages/{n}/png', operationId: 'getPagePng', tag: 'Pages', scope: 'notes:read',
      summary: 'Render a page as PNG',
      params: PageParams,
      query: z.object({ width: z.coerce.number().int().min(64).max(4096).default(1200).describe('Width in pixels (default 1200).') }),
      responses: { 200: binary('image/png', 'The page as PNG.'), 501: json(S.Problem, 'PNG rendering is not available on this server.') },
      async handler(req: ApiRequest<{ id: string; n: number }, { width: number }>) {
        const { note, page } = await loadPage(ctx, req.params.id, req.params.n);
        const png = await ctx.renderPng(await pageSvg(ctx, note, page, { embedAssets: true }), req.query.width);
        if (!png) throw new ApiError('not_implemented', 'This server cannot render PNG: install the optional @resvg/resvg-js package. SVG works everywhere.');
        return { status: 200, raw: png, contentType: 'image/png' };
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}/pages/{n}/pdf', operationId: 'getPagePdf', tag: 'Pages', scope: 'notes:read',
      summary: 'Render a page as PDF',
      params: PageParams,
      responses: { 200: binary('application/pdf', 'The page as a one-page PDF.'), 501: json(S.Problem, 'PDF rendering is not available on this server.') },
      async handler(req: ApiRequest<{ id: string; n: number }>) {
        const { note, page } = await loadPage(ctx, req.params.id, req.params.n);
        return { status: 200, raw: await notePdf(ctx, note, [page]), contentType: 'application/pdf' };
      },
    }),

    // ---- Notebooks and tags ----
    defineRoute({
      method: 'GET', path: '/notebooks', operationId: 'listNotebooks', tag: 'Notebooks', scope: 'notes:read',
      summary: 'List notebooks',
      query: z.object({ limit: LIMIT(100, 500), cursor: Cursor }),
      responses: { 200: json(S.NotebookList, 'Notebooks by path.') },
      async handler(req: ApiRequest<unknown, { limit: number; cursor?: string }>) {
        await ctx.refresh();
        const notebooks = await ctx.vault.listNotebooks();
        const notes = await ctx.vault.listNotes();
        const counts = new Map<string, number>();
        for (const n of notes) if (n.notebookId) counts.set(n.notebookId, (counts.get(n.notebookId) ?? 0) + 1);
        const all = notebooks
          .map((nb) => ({ id: nb.id, name: nb.name, path: notebookPath(notebooks, nb.id) ?? nb.name, parentId: nb.parentId ?? null, color: nb.color ?? null, notes: counts.get(nb.id) ?? 0, createdAt: iso(nb.createdAt)! }))
          .sort((a, b) => a.path.localeCompare(b.path));
        return { status: 200, body: offsetPage(all, req.query.limit, req.query.cursor) };
      },
    }),
    defineRoute({
      method: 'POST', path: '/notebooks', operationId: 'createNotebook', tag: 'Notebooks', scope: 'notes:write', writes: true, idempotent: true,
      summary: 'Create a notebook',
      description: 'Answers 200 with the existing notebook when one with that name already exists at that level.',
      body: S.NotebookCreate,
      responses: { 201: json(S.Notebook, 'The new notebook.'), 200: json(S.Notebook, 'A notebook with this name already existed here.') },
      async handler(req: ApiRequest<unknown, unknown, z.infer<typeof S.NotebookCreate>>) {
        const r = await write(d, req, 'create_notebook', req.body, createNotebook);
        const nb = r.notebook as NotebookMeta & { path?: string };
        return { status: r.created ? 201 : 200, body: { id: nb.id, name: nb.name, path: nb.path ?? nb.name, parentId: nb.parentId ?? null, color: nb.color ?? null, notes: 0, createdAt: iso(nb.createdAt)! }, ...(r.created ? { headers: { location: `${req.baseUrl}/notebooks` } } : {}) };
      },
    }),
    defineRoute({
      method: 'GET', path: '/tags', operationId: 'listTags', tag: 'Notebooks', scope: 'notes:read',
      summary: 'List tags',
      description: 'Every tag on a live note (set by hand or written as #tag), with how many notes carry it, most used first.',
      query: z.object({ limit: LIMIT(200, 1000), cursor: Cursor }),
      responses: { 200: json(S.TagList, 'Tags with counts.') },
      async handler(req: ApiRequest<unknown, { limit: number; cursor?: string }>) {
        const tags = (await knowledgeIndex(ctx)).allTags();
        return { status: 200, body: offsetPage(tags, req.query.limit, req.query.cursor) };
      },
    }),

    // ---- Search, links, graph ----
    defineRoute({
      method: 'GET', path: '/search', operationId: 'search', tag: 'Search', scope: 'notes:read',
      summary: 'Search notes',
      description: '`keyword` (default) matches words, prefixes and accents in typed text and recognized handwriting. `semantic` and `hybrid` rank passages by meaning and need the server to be started with an embedding model (--embeddings-model); otherwise they answer 501.',
      query: z.object({
        q: z.string().trim().min(1).max(500).describe('What to look for.'),
        mode: z.enum(['keyword', 'semantic', 'hybrid']).default('keyword'),
        limit: LIMIT(10, 100),
        noteId: S.Id.optional().describe('Only search inside this note (semantic/hybrid).'),
      }),
      responses: { 200: json(S.SearchResult, 'Matches, best first.'), 501: json(S.Problem, 'Semantic search is not configured.') },
      async handler(req: ApiRequest<unknown, { q: string; mode: 'keyword' | 'semantic' | 'hybrid'; limit: number; noteId?: string }>) {
        const q = req.query;
        if (q.mode === 'keyword') {
          await ctx.refresh();
          const hits = (await ctx.searchIndex()).search(q.q, { limit: q.limit });
          return { status: 200, body: { query: q.q, mode: q.mode, data: hits.map((h) => ({ noteId: h.noteId, title: h.title, page: h.pageIndex + 1, snippet: h.snippet, score: Math.round(h.score * 1000) / 1000, source: 'note' as const })) } };
        }
        if (!d.semantic) throw new ApiError('not_implemented', 'Semantic search needs an embedding model: start the server with --embeddings-model (and --embeddings-url for a provider other than OpenAI). Keyword search works without one.');
        const ranked = (await d.semantic.search(q.q, q.mode, q.limit, q.noteId)).filter((r) => r.score > 0);
        return { status: 200, body: { query: q.q, mode: q.mode, data: ranked.map((r) => ({ noteId: r.chunk.noteId, title: r.chunk.title, page: r.chunk.pageIndex + 1, snippet: r.snippet, score: Math.round(r.score * 10000) / 10000, source: r.chunk.source })) } };
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}/links', operationId: 'getNoteLinks', tag: 'Search', scope: 'notes:read',
      summary: 'Links and backlinks of a note',
      description: '`[[Links]]` the note makes (typed, handwritten or ink links) and the notes linking to it, each with the line around the link.',
      params: IdParams,
      responses: { 200: json(S.NoteLinks, 'Outgoing links and backlinks.') },
      async handler(req: ApiRequest<{ id: string }>) {
        await loadNote(ctx, req.params.id);
        const index = await knowledgeIndex(ctx);
        const notebooks = await ctx.vault.listNotebooks();
        return {
          status: 200,
          body: {
            outgoing: index.outgoing(req.params.id, notebooks).map(({ occ, note }) => ({ noteId: note?.id ?? null, title: note?.title ?? occ.title, page: occ.page ?? null, context: occ.context || null })),
            backlinks: index.backlinks(req.params.id, notebooks).map((b) => ({ noteId: b.noteId, title: b.title, page: b.pageIndex + 1, context: b.snippet || null })),
          },
        };
      },
    }),
    defineRoute({
      method: 'GET', path: '/graph', operationId: 'getGraph', tag: 'Search', scope: 'notes:read',
      summary: 'The knowledge graph',
      description: 'Notes, tags and notebooks as nodes; links, tags and notebook membership as edges.',
      query: z.object({ tags: bool.default(true).describe('Include tag nodes.'), notebooks: bool.default(true).describe('Include notebook nodes.'), tag: z.string().optional().describe('Only notes with this tag.') }),
      responses: { 200: json(S.Graph, 'Nodes and edges.') },
      async handler(req: ApiRequest<unknown, { tags: boolean; notebooks: boolean; tag?: string }>) {
        const index = await knowledgeIndex(ctx);
        const g = buildGraph(index, await ctx.vault.listNotebooks(), { tags: req.query.tags, notebooks: req.query.notebooks, ...(req.query.tag ? { tag: req.query.tag } : {}) });
        return {
          status: 200,
          body: {
            nodes: g.nodes.map((n) => ({ id: n.id, kind: n.kind, label: n.label, noteId: n.kind === 'note' ? n.id : null, degree: n.degree })),
            edges: g.edges.map((e) => ({ source: e.source, target: e.target, kind: e.kind, weight: e.weight })),
          },
        };
      },
    }),

    // ---- Assets and transcripts ----
    defineRoute({
      method: 'GET', path: '/notes/{id}/assets', operationId: 'listAssets', tag: 'Assets', scope: 'notes:read',
      summary: 'List a note’s files',
      description: 'Images, PDFs and audio recordings the note uses.',
      params: IdParams,
      responses: { 200: json(S.AssetList, 'The files.') },
      async handler(req: ApiRequest<{ id: string }>) {
        const { note } = await loadNote(ctx, req.params.id);
        const entries = (await ctx.fs.list(VaultLayout.assetsDir(note.id))).filter((e) => e.kind === 'file' && !e.name.startsWith('.'));
        return { status: 200, body: { data: entries.map((e) => ({ name: e.name, size: e.size ?? 0, mimeType: mimeOf(e.name), url: `${req.baseUrl}/notes/${note.id}/assets/${encodeURIComponent(e.name)}` })), nextCursor: null } };
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}/assets/{name}', operationId: 'getAsset', tag: 'Assets', scope: 'notes:read',
      summary: 'Download a note’s file',
      params: z.object({ id: S.Id, name: z.string().regex(/^[0-9A-Za-z_.-]{1,96}$/).describe('Asset file name.') }),
      responses: { 200: binary('application/octet-stream', 'The file (with its own media type).') },
      async handler(req: ApiRequest<{ id: string; name: string }>) {
        const { note } = await loadNote(ctx, req.params.id);
        const bytes = await ctx.vault.readAsset(note.id, req.params.name);
        if (!bytes) throw new ApiError('not_found', `The note has no file called ${req.params.name}.`);
        return { status: 200, raw: bytes, contentType: mimeOf(req.params.name), headers: { 'cache-control': 'private, max-age=3600' } };
      },
    }),
    defineRoute({
      method: 'GET', path: '/notes/{id}/transcripts', operationId: 'listTranscripts', tag: 'Assets', scope: 'notes:read',
      summary: 'Transcripts of a note’s recordings',
      params: IdParams,
      responses: { 200: json(S.TranscriptList, 'One transcript per recording that has one.') },
      async handler(req: ApiRequest<{ id: string }>) {
        const { note } = await loadNote(ctx, req.params.id);
        const out: z.infer<typeof S.Transcript>[] = [];
        for (const e of await ctx.fs.list(VaultLayout.assetsDir(note.id))) {
          if (e.kind !== 'file' || !e.name.endsWith(TRANSCRIPT_SUFFIX) || e.name === PAGE_SUMMARIES_ASSET || !clipIdOfTranscript(e.name)) continue;
          const raw = await ctx.fs.readText(VaultLayout.asset(note.id, e.name));
          if (!raw) continue;
          try {
            const t = decodeTranscript(raw);
            out.push({ clipId: t.clipId, engine: t.engine, where: t.where, language: t.language ?? null, complete: t.complete, updatedAt: iso(t.updatedAt)!, segments: t.segments, summary: t.lecture?.summary ?? null });
          } catch {
            /* half-synced file */
          }
        }
        return { status: 200, body: { data: out, nextCursor: null } };
      },
    }),

    // ---- Activity and routines ----
    defineRoute({
      method: 'GET', path: '/activity', operationId: 'listActivity', tag: 'Automation', scope: 'notes:read',
      summary: 'Recent AI and API activity',
      description: 'What the assistant, routines, MCP agents and API callers changed, newest first (undo lives in the app).',
      query: z.object({ limit: LIMIT(20, 100), cursor: Cursor, source: z.string().optional().describe('Only runs from this source (assistant, routine, external).') }),
      responses: { 200: json(S.ActivityList, 'Activity runs.') },
      async handler(req: ApiRequest<unknown, { limit: number; cursor?: string; source?: string }>) {
        let runs = await new ActivityStore(ctx.fs).list();
        if (req.query.source) runs = runs.filter((r) => r.source === req.query.source);
        const page = offsetPage(runs, req.query.limit, req.query.cursor);
        return {
          status: 200,
          body: {
            nextCursor: page.nextCursor,
            data: page.data.map((r) => ({ id: r.id, source: r.source, label: r.label, status: r.status, startedAt: iso(r.startedAt)!, endedAt: iso(r.endedAt), changes: r.ops.map((o) => ({ kind: o.kind, summary: o.summary, noteId: 'noteId' in o ? (o.noteId as string) : null })) })),
          },
        };
      },
    }),
    defineRoute({
      method: 'GET', path: '/routines', operationId: 'listRoutines', tag: 'Automation', scope: 'notes:read',
      summary: 'List routines',
      responses: { 200: json(S.RoutineList, 'The user’s routines.') },
      async handler() {
        const list = await routines.list();
        return { status: 200, body: { data: list.map((r) => ({ id: r.id, name: r.name, enabled: r.enabled, triggers: r.triggers.map((t) => t.kind), lastRunAt: iso(r.state.lastRunAt), lastStatus: r.state.lastStatus ?? null })), nextCursor: null } };
      },
    }),
    defineRoute({
      method: 'POST', path: '/routines/{id}/run', operationId: 'runRoutine', tag: 'Automation', scope: 'routines:run', writes: true, idempotent: true,
      summary: 'Run a routine now',
      description: 'Runs the routine with the server’s AI (start it with --ai-provider) and waits for it to finish. Moving notes to Trash is never done unattended: it becomes a pending approval in the app.',
      params: z.object({ id: z.string().min(1).describe('Routine id or name.') }),
      responses: { 200: json(S.RoutineRun, 'How the run went.'), 503: json(S.Problem, 'No AI is configured on this server.') },
      async handler(req: ApiRequest<{ id: string }>) {
        if (ctx.readOnly) throw new ApiError('read_only', 'This vault is served read-only (--read-only).');
        const r = findRoutine(await routines.list(), req.params.id);
        if (!r) throw new ApiError('not_found', `There is no routine "${req.params.id}".`);
        if (!d.services.ai) throw new ApiError('unavailable', 'This server has no AI to run routines with. Start it with --ai-provider (docs/AGENTS.md).');
        const res = await runRoutineOnServer(ctx, d.services.ai, r, { kind: 'manual', reason: `Run by ${req.principal.label}` }, deferringApprover(d.services.approvals));
        await routines.updateState(r.id, (s) => ({ ...s, lastRunAt: ctx.clock(), lastStatus: res.status, ...(res.error ? { lastError: res.error } : {}) }));
        d.events.poke();
        return { status: 200, body: { routineId: r.id, status: res.status, reply: res.reply, error: res.error ?? null, activityRunId: res.run.id, changes: res.run.ops.map((o) => o.summary) } };
      },
    }),

    // ---- Webhooks ----
    defineRoute({
      method: 'GET', path: '/webhooks', operationId: 'listWebhooks', tag: 'Webhooks', scope: 'webhooks',
      summary: 'List webhooks',
      responses: { 200: json(S.WebhookList, 'Subscriptions (secrets are not shown again).') },
      async handler() {
        return { status: 200, body: { data: d.webhooks.list().map(webhookOut), nextCursor: null } };
      },
    }),
    defineRoute({
      method: 'POST', path: '/webhooks', operationId: 'createWebhook', tag: 'Webhooks', scope: 'webhooks', idempotent: true,
      summary: 'Subscribe a URL to events',
      description: 'Events are POSTed per the Standard Webhooks spec, signed with the returned secret (see docs/API.md for verifying them).',
      body: S.WebhookCreate,
      responses: { 201: json(S.WebhookCreated, 'The subscription, with its signing secret (shown once).') },
      async handler(req: ApiRequest<unknown, unknown, z.infer<typeof S.WebhookCreate>>) {
        let rec;
        try {
          rec = await d.webhooks.create(req.body);
        } catch (e) {
          throw new ApiError('invalid_request', (e as Error).message);
        }
        d.events.start();
        return { status: 201, body: { ...webhookOut(rec), secret: rec.secret }, headers: { location: `${req.baseUrl}/webhooks/${rec.id}` } };
      },
    }),
    defineRoute({
      method: 'GET', path: '/webhooks/{id}', operationId: 'getWebhook', tag: 'Webhooks', scope: 'webhooks',
      summary: 'Get a webhook',
      params: z.object({ id: S.Id }),
      responses: { 200: json(S.Webhook, 'The subscription.') },
      async handler(req: ApiRequest<{ id: string }>) {
        const w = d.webhooks.get(req.params.id);
        if (!w) throw new ApiError('not_found', `There is no webhook ${req.params.id}.`);
        return { status: 200, body: webhookOut(w) };
      },
    }),
    defineRoute({
      method: 'DELETE', path: '/webhooks/{id}', operationId: 'deleteWebhook', tag: 'Webhooks', scope: 'webhooks',
      summary: 'Delete a webhook',
      params: z.object({ id: S.Id }),
      responses: { 204: { description: 'Deleted; pending deliveries are dropped.' } },
      async handler(req: ApiRequest<{ id: string }>) {
        if (!(await d.webhooks.remove(req.params.id))) throw new ApiError('not_found', `There is no webhook ${req.params.id}.`);
        return { status: 204 };
      },
    }),
    defineRoute({
      method: 'GET', path: '/webhooks/{id}/deliveries', operationId: 'listWebhookDeliveries', tag: 'Webhooks', scope: 'webhooks',
      summary: 'Delivery log of a webhook',
      description: 'The latest attempt of each message, newest first (the last 200 messages are kept).',
      params: z.object({ id: S.Id }),
      query: z.object({ limit: LIMIT(50, 200), cursor: Cursor }),
      responses: { 200: json(S.DeliveryList, 'Deliveries.') },
      async handler(req: ApiRequest<{ id: string }, { limit: number; cursor?: string }>) {
        if (!d.webhooks.get(req.params.id)) throw new ApiError('not_found', `There is no webhook ${req.params.id}.`);
        const rows = d.webhooks.deliveries(req.params.id).map((l) => ({ id: l.id, event: l.event, attempt: l.attempt, status: l.status, responseStatus: l.responseStatus, error: l.error, at: iso(l.at)!, nextAttemptAt: iso(l.nextAttemptAt) }));
        return { status: 200, body: offsetPage(rows, req.query.limit, req.query.cursor) };
      },
    }),
    defineRoute({
      method: 'POST', path: '/webhooks/{id}/test', operationId: 'testWebhook', tag: 'Webhooks', scope: 'webhooks',
      summary: 'Send a test event',
      description: 'Sends a `note.updated` event with sample data to this webhook only, and waits for the first attempt.',
      params: z.object({ id: S.Id }),
      responses: { 200: json(S.WebhookDelivery, 'The first attempt.') },
      async handler(req: ApiRequest<{ id: string }>) {
        const w = d.webhooks.get(req.params.id);
        if (!w) throw new ApiError('not_found', `There is no webhook ${req.params.id}.`);
        const [msgId] = d.webhooks.emit('note.updated', { id: 'test', title: 'Test event from Inkstone', updatedAt: new Date(ctx.clock()).toISOString(), test: true }, w.id);
        if (!msgId) throw new ApiError('conflict', 'This webhook is off or does not subscribe to note.updated.');
        await d.webhooks.pump();
        const l = d.webhooks.deliveries(w.id).find((x) => x.id === msgId)!;
        return { status: 200, body: { id: l.id, event: l.event, attempt: l.attempt, status: l.status, responseStatus: l.responseStatus, error: l.error, at: iso(l.at)!, nextAttemptAt: iso(l.nextAttemptAt) } };
      },
    }),

    // ---- API keys ----
    defineRoute({
      method: 'GET', path: '/keys', operationId: 'listApiKeys', tag: 'Keys', scope: 'admin',
      summary: 'List API keys',
      responses: { 200: json(S.ApiKeyList, 'Keys (never the secrets; only their prefixes).') },
      async handler() {
        return { status: 200, body: { data: (await d.keys.list()).map(keyOut), nextCursor: null } };
      },
    }),
    defineRoute({
      method: 'POST', path: '/keys', operationId: 'createApiKey', tag: 'Keys', scope: 'admin', writes: true,
      summary: 'Create an API key',
      body: S.ApiKeyCreate,
      responses: { 201: json(S.ApiKeyCreated, 'The key, shown once.') },
      async handler(req: ApiRequest<unknown, unknown, z.infer<typeof S.ApiKeyCreate>>) {
        const { key, record } = await d.keys.create({ ...req.body, createdBy: 'api' });
        return { status: 201, body: { ...keyOut(record), key } };
      },
    }),
    defineRoute({
      method: 'DELETE', path: '/keys/{id}', operationId: 'revokeApiKey', tag: 'Keys', scope: 'admin', writes: true,
      summary: 'Revoke an API key',
      params: z.object({ id: z.string().min(1) }),
      responses: { 200: json(S.ApiKey, 'The revoked key.') },
      async handler(req: ApiRequest<{ id: string }>) {
        const r = await d.keys.revoke(req.params.id);
        if (!r) throw new ApiError('not_found', `There is no API key ${req.params.id}.`);
        return { status: 200, body: keyOut(r) };
      },
    }),
  ];
}

async function getNote(ctx: ServerContext, id: string): Promise<ApiResult> {
  const { note, etag } = await loadNote(ctx, id);
  const pages = await ctx.vault.readPages(note);
  const notebooks = await ctx.vault.listNotebooks();
  const transcripts = new Set((await ctx.fs.list(VaultLayout.assetsDir(note.id))).map((e) => clipIdOfTranscript(e.name)).filter(Boolean));
  return {
    status: 200,
    etag,
    body: {
      ...summary(note, notebooks),
      markdown: exportMarkdown(note, pages),
      pageDetails: pages.map((p, i) => pageInfo(note, p, i)),
      recordings: (note.recordings ?? []).map((c) => ({ id: c.id, asset: c.asset, startedAt: iso(c.startedAt)!, durationMs: c.durationMs, mimeType: c.mimeType, title: c.title ?? null, hasTranscript: transcripts.has(c.id) })),
    },
  };
}

/** Pages rendered to PNG (2× for print sharpness) on PDF pages of the same physical size. */
async function notePdf(ctx: ServerContext, note: NoteMeta, pages: PageInk[]): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle(note.title || 'Note');
  doc.setCreator('Inkstone');
  for (const p of pages) {
    const size = pageSizeOf(note, p);
    const png = await ctx.renderPng(await pageSvg(ctx, note, p, { embedAssets: true }), Math.min(4096, Math.round(size.width * 2)));
    if (!png) throw new ApiError('not_implemented', 'This server cannot render PDF: install the optional @resvg/resvg-js package.');
    const img = await doc.embedPng(png);
    // 1 page unit = 1/96 inch; PDF points are 1/72 inch.
    const w = size.width * 0.75;
    const h = (img.height / img.width) * w;
    doc.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
  }
  return doc.save();
}

function disposition(fileName: string): Record<string, string> {
  return { 'content-disposition': `attachment; filename="${fileName.replace(/[^\x20-\x7e]/g, '_').replace(/"/g, "'")}"; filename*=UTF-8''${encodeURIComponent(fileName)}` };
}

const MIME: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', pdf: 'application/pdf', json: 'application/json', webm: 'audio/webm', ogg: 'audio/ogg', m4a: 'audio/mp4', mp4: 'audio/mp4', mp3: 'audio/mpeg', wav: 'audio/wav', txt: 'text/plain', md: 'text/markdown' };
const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';

function webhookOut(w: { id: string; url: string; events: string[]; description?: string; enabled: boolean; createdAt: number }) {
  return { id: w.id, url: w.url, events: w.events as z.infer<typeof S.WebhookEventType>[], description: w.description ?? null, enabled: w.enabled, createdAt: iso(w.createdAt)! };
}

function keyOut(k: { id: string; name: string; prefix: string; scopes: string[]; createdAt: number; expiresAt?: number; revokedAt?: number }) {
  return { id: k.id, name: k.name, prefix: k.prefix, scopes: k.scopes as z.infer<typeof S.ApiScopeSchema>[], createdAt: iso(k.createdAt)!, expiresAt: iso(k.expiresAt), revokedAt: iso(k.revokedAt) };
}
