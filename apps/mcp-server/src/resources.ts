import type { ListResourcesResult, ReadResourceResult } from '@modelcontextprotocol/server';
import { CompilerStore } from '@inkwright/ai';
import { requireId, readNoteFresh, type ServerContext } from './context.ts';
import { pageSvg } from './render.ts';
import { noteMarkdown, noteUri, pageUri } from './tools.ts';

/** URI templates served by the server (also listed by resources/templates/list). */
export const NOTE_TEMPLATE = 'inkwright://notes/{id}';
export const PAGE_SVG_TEMPLATE = 'inkwright://notes/{id}/pages/{n}.svg';

const one = (v: string | string[] | undefined): string => (Array.isArray(v) ? (v[0] ?? '') : (v ?? ''));

/** `inkwright://notes/{id}` → the note as Markdown. */
export async function readNoteResource(ctx: ServerContext, id: string | string[] | undefined): Promise<ReadResourceResult> {
  const noteId = requireId(decodeURIComponent(one(id)), 'note id');
  await ctx.refresh();
  const { markdown } = await noteMarkdown(ctx, noteId);
  return { contents: [{ uri: noteUri(noteId), mimeType: 'text/markdown', text: markdown }] };
}

/** `inkwright://notes/{id}/pages/{n}.svg` → page n (1-based) as SVG. */
export async function readPageSvgResource(ctx: ServerContext, id: string | string[] | undefined, n: string | string[] | undefined): Promise<ReadResourceResult> {
  const noteId = requireId(decodeURIComponent(one(id)), 'note id');
  const num = Number(one(n));
  if (!Number.isInteger(num) || num < 1) throw new Error(`Invalid page number: ${one(n)}`);
  await ctx.refresh();
  const found = await readNoteFresh(ctx, noteId);
  if (!found) throw new Error(`Note not found: ${noteId}`);
  const pageId = found.note.pageIds[num - 1];
  if (!pageId) throw new Error(`Page ${num} does not exist; the note has ${found.note.pageIds.length} page(s).`);
  const page = await ctx.vault.readPage(noteId, pageId);
  return { contents: [{ uri: pageUri(noteId, num), mimeType: 'image/svg+xml', text: await pageSvg(ctx, found.note, page) }] };
}

/** Every note (not in Trash) as a Markdown resource, newest first. */
export async function listNoteResources(ctx: ServerContext, limit = 1000): Promise<ListResourcesResult> {
  await ctx.refresh();
  const notes = (await ctx.vault.listNotes()).slice(0, limit);
  return {
    resources: notes.map((n) => ({
      uri: noteUri(n.id),
      name: n.title || 'Untitled',
      mimeType: 'text/markdown',
      description: n.summary || `${n.pageIds.length} page${n.pageIds.length === 1 ? '' : 's'}, updated ${new Date(n.updatedAt).toISOString()}`,
    })),
  };
}

// ---- Context packs (docs/COMPILER.md) ------------------------------------------------------------

/** Saved context packs: `ai/packs/<id>/pack.md` (Markdown) and `pack.json`. */
export const PACK_TEMPLATE = 'inkwright://packs/{id}';
export const packUri = (id: string) => `inkwright://packs/${encodeURIComponent(id)}`;

/** Every context pack the user saved in the app, newest first. */
export async function listPackResources(ctx: ServerContext): Promise<ListResourcesResult> {
  const packs = await new CompilerStore(ctx.fs).packs();
  return { resources: packs.map((p) => ({ uri: packUri(p.id), name: p.title, mimeType: 'text/markdown', description: `Context pack from the user's notes (compiled facts with sources, notes, handwriting)${p.createdAt ? `, made ${p.createdAt.slice(0, 10)}` : ''}.` })) };
}

/** `inkwright://packs/{id}` → the pack's Markdown (cited), plus its JSON. */
export async function readPackResource(ctx: ServerContext, id: string | string[] | undefined): Promise<ReadResourceResult> {
  const packId = requireId(decodeURIComponent(one(id)), 'pack id');
  const md = await ctx.fs.readText(`ai/packs/${packId}/pack.md`);
  if (md == null) throw new Error(`No context pack "${packId}". List resources to see saved packs.`);
  const json = await ctx.fs.readText(`ai/packs/${packId}/pack.json`);
  return { contents: [{ uri: packUri(packId), mimeType: 'text/markdown', text: md }, ...(json ? [{ uri: `${packUri(packId)}/pack.json`, mimeType: 'application/json', text: json }] : [])] };
}
