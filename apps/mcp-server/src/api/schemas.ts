/**
 * The REST API's resource schemas (zod). They are the single source of truth for three things:
 * request validation, the OpenAPI 3.1 document (`openapi.ts` turns them into JSON Schema 2020-12
 * components) and, through that document, the generated TypeScript SDK (`@inkwright/sdk`).
 *
 * Every schema that appears in the document is registered in `components` with a stable name.
 */
import { z } from 'zod';
import { API_SCOPES } from '@inkwright/core';

/** Named schemas → `#/components/schemas/<id>`. */
export const components = z.registry<{ id: string; description?: string }>();

const named = <T extends z.ZodType>(id: string, schema: T, description?: string): T => {
  components.add(schema, description ? { id, description } : { id });
  return schema;
};

export const Id = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/, 'Ids are 1–64 characters of [0-9A-Za-z_-]');
const Iso = z.string().describe('RFC 3339 date-time');

export const Problem = named(
  'Problem',
  z.object({
    type: z.string().describe('URI identifying the problem type (a link to its documentation).'),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    instance: z.string().optional(),
    code: z.string().describe('Stable machine-readable code, e.g. "not_found".'),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional().describe('Validation errors, one per field.'),
  }),
  'An RFC 9457 problem details object (application/problem+json).',
);

export const NoteSummary = named(
  'NoteSummary',
  z.object({
    id: Id,
    title: z.string(),
    kind: z.enum(['paged', 'board']),
    tags: z.array(z.string()),
    notebookId: Id.nullable(),
    notebook: z.string().nullable().describe('"Parent / Child" path of the notebook.'),
    pages: z.number().int(),
    pinned: z.boolean(),
    summary: z.string().nullable(),
    createdAt: Iso,
    updatedAt: Iso,
    trashedAt: Iso.nullable(),
    locked: z.boolean().describe('Locked notes keep their content encrypted; only metadata is readable.'),
  }),
);

export const PageInfo = named(
  'PageInfo',
  z.object({
    number: z.number().int().describe('1-based page number.'),
    id: Id,
    strokes: z.number().int(),
    textBoxes: z.number().int(),
    images: z.number().int(),
    objects: z.number().int(),
    background: z.enum(['pdf', 'image']).nullable(),
    handwritingRecognized: z.boolean(),
    width: z.number(),
    height: z.number(),
  }),
);

export const Recording = named(
  'Recording',
  z.object({ id: Id, asset: z.string(), startedAt: Iso, durationMs: z.number().int(), mimeType: z.string(), title: z.string().nullable(), hasTranscript: z.boolean() }),
);

export const Note = named(
  'Note',
  NoteSummary.extend({
    markdown: z.string().describe('The note as Markdown: front matter, typed text and recognized handwriting.'),
    pageDetails: z.array(PageInfo),
    recordings: z.array(Recording),
  }),
);

export const NoteCreate = named(
  'NoteCreate',
  z.object({
    title: z.string().trim().min(1).max(300),
    text: z.string().max(200_000).optional().describe('Markdown body, placed as typed text and flowing onto more pages when long.'),
    notebookId: z.string().min(1).optional().describe('Notebook id or exact name.'),
    tags: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  }),
);

export const NoteUpdate = named(
  'NoteUpdate',
  z
    .object({
      title: z.string().trim().min(1).max(300).optional(),
      tags: z.array(z.string().trim().min(1).max(100)).max(50).optional().describe('Replaces the tag list.'),
      notebookId: z.string().min(1).nullable().optional().describe('Notebook id or exact name; null makes the note unfiled.'),
      pinned: z.boolean().optional(),
      summary: z.string().max(5000).nullable().optional(),
    })
    .refine((o) => Object.values(o).some((v) => v !== undefined), { message: 'Pass at least one field to change.' }),
);

export const NoteAppend = named(
  'NoteAppend',
  z.object({
    text: z.string().min(1).max(200_000).describe('Markdown added as typed text below the existing content.'),
    page: z.number().int().min(1).optional().describe('1-based page to add to (default: the last page, continuing onto new pages).'),
  }),
);

export const Notebook = named(
  'Notebook',
  z.object({ id: Id, name: z.string(), path: z.string(), parentId: Id.nullable(), color: z.string().nullable(), notes: z.number().int(), createdAt: Iso }),
);

export const NotebookCreate = named(
  'NotebookCreate',
  z.object({
    name: z.string().trim().min(1).max(200),
    color: z.string().regex(/^#?([0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/).optional(),
    parentId: Id.optional(),
  }),
);

export const Tag = named('Tag', z.object({ tag: z.string(), count: z.number().int() }));

export const SearchHit = named(
  'SearchHit',
  z.object({
    noteId: Id,
    title: z.string(),
    page: z.number().int().describe('1-based page of the match.'),
    snippet: z.string().describe('Text around the match; «» marks matched words.'),
    score: z.number(),
    source: z.enum(['note', 'text', 'handwriting', 'pdf', 'speech', 'meta']),
  }),
);

export const SearchResult = named(
  'SearchResult',
  z.object({ query: z.string(), mode: z.enum(['keyword', 'semantic', 'hybrid']), data: z.array(SearchHit) }),
);

export const LinkRef = named(
  'LinkRef',
  z.object({ noteId: Id.nullable().describe('Null when the link points at a note that does not exist yet.'), title: z.string(), page: z.number().int().nullable(), context: z.string().nullable() }),
);

export const NoteLinks = named('NoteLinks', z.object({ outgoing: z.array(LinkRef), backlinks: z.array(LinkRef) }));

export const Graph = named(
  'Graph',
  z.object({
    nodes: z.array(z.object({ id: z.string(), kind: z.enum(['note', 'tag', 'notebook']), label: z.string(), noteId: Id.nullable(), degree: z.number().int() })),
    edges: z.array(z.object({ source: z.string(), target: z.string(), kind: z.enum(['link', 'tag', 'notebook', 'related']), weight: z.number() })),
  }),
);

export const Asset = named('Asset', z.object({ name: z.string(), size: z.number().int(), mimeType: z.string(), url: z.string() }));

export const ActivityRun = named(
  'ActivityRun',
  z.object({
    id: Id,
    source: z.string(),
    label: z.string(),
    status: z.string(),
    startedAt: Iso,
    endedAt: Iso.nullable(),
    changes: z.array(z.object({ kind: z.string(), summary: z.string(), noteId: z.string().nullable() })),
  }),
);

export const Routine = named(
  'Routine',
  z.object({ id: Id, name: z.string(), enabled: z.boolean(), triggers: z.array(z.string()), lastRunAt: Iso.nullable(), lastStatus: z.string().nullable() }),
);

export const RoutineRun = named(
  'RoutineRun',
  z.object({ routineId: Id, status: z.enum(['done', 'error', 'cancelled']), reply: z.string(), error: z.string().nullable(), activityRunId: z.string(), changes: z.array(z.string()) }),
);

export const Transcript = named(
  'Transcript',
  z.object({
    clipId: Id,
    engine: z.string(),
    where: z.enum(['device', 'browser', 'provider']),
    language: z.string().nullable(),
    complete: z.boolean(),
    updatedAt: Iso,
    segments: z.array(z.object({ id: z.string(), startMs: z.number(), endMs: z.number(), text: z.string() })),
    summary: z.string().nullable(),
  }),
);

export const WEBHOOK_EVENTS = ['note.created', 'note.updated', 'note.trashed', 'note.restored', 'recording.ended', 'routine.finished'] as const;
export const WebhookEventType = z.enum(WEBHOOK_EVENTS);

export const Webhook = named(
  'Webhook',
  z.object({
    id: Id,
    url: z.string(),
    events: z.array(WebhookEventType),
    description: z.string().nullable(),
    enabled: z.boolean(),
    createdAt: Iso,
  }),
);

export const WebhookCreated = named(
  'WebhookCreated',
  Webhook.extend({ secret: z.string().describe('Signing secret (whsec_…). Shown once; store it to verify signatures.') }),
);

export const WebhookCreate = named(
  'WebhookCreate',
  z.object({
    url: z.url({ protocol: /^https?$/ }).describe('Where to POST events (https; http only for localhost).'),
    events: z.array(WebhookEventType).min(1),
    description: z.string().max(200).optional(),
  }),
);

export const WebhookDelivery = named(
  'WebhookDelivery',
  z.object({
    id: z.string().describe('The webhook-id header value (same for every attempt of one message).'),
    event: WebhookEventType,
    attempt: z.number().int(),
    status: z.enum(['pending', 'succeeded', 'failed', 'retrying']),
    responseStatus: z.number().int().nullable(),
    error: z.string().nullable(),
    at: Iso,
    nextAttemptAt: Iso.nullable(),
  }),
);

export const ApiScopeSchema = z.enum(API_SCOPES);

export const ApiKey = named(
  'ApiKey',
  z.object({ id: z.string(), name: z.string(), prefix: z.string(), scopes: z.array(ApiScopeSchema), createdAt: Iso, expiresAt: Iso.nullable(), revokedAt: Iso.nullable() }),
);

export const ApiKeyCreated = named('ApiKeyCreated', ApiKey.extend({ key: z.string().describe('The key. Shown once; it is stored only as a hash.') }));

export const ApiKeyCreate = named(
  'ApiKeyCreate',
  z.object({ name: z.string().trim().min(1).max(100), scopes: z.array(ApiScopeSchema).min(1), expiresInDays: z.number().int().min(1).max(3650).optional() }),
);

/** A page of results with an opaque cursor for the next page. */
export const page = <T extends z.ZodType>(id: string, item: T) => named(id, z.object({ data: z.array(item), nextCursor: z.string().nullable().describe('Pass as `cursor` to get the next page; null on the last page.') }));

export const NoteList = page('NoteList', NoteSummary);
export const NotebookList = page('NotebookList', Notebook);
export const TagList = page('TagList', Tag);
export const ActivityList = page('ActivityList', ActivityRun);
export const RoutineList = page('RoutineList', Routine);
export const WebhookList = page('WebhookList', Webhook);
export const DeliveryList = page('DeliveryList', WebhookDelivery);
export const ApiKeyList = page('ApiKeyList', ApiKey);
export const AssetList = page('AssetList', Asset);
export const PageList = page('PageList', PageInfo);
export const TranscriptList = page('TranscriptList', Transcript);
