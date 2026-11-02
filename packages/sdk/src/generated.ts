// Generated from the Inkwright OpenAPI document by packages/sdk/scripts/generate.ts.
// Do not edit: run `npm run generate -w @inkwright/sdk` after changing the API.
/* eslint-disable */
import { BaseClient, type Operation, type RequestOptions } from './runtime.ts';

/** API version this client was generated for. */
export const API_VERSION = "1.0.0";

export interface ActivityList {
  data: ActivityRun[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export interface ActivityRun {
  id: string;
  source: string;
  label: string;
  status: string;
  /** RFC 3339 date-time */
  startedAt: string;
  endedAt: string | null;
  changes: Array<{
    kind: string;
    summary: string;
    noteId: string | null;
  }>;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  scopes: Array<"notes:read" | "notes:write" | "routines:run" | "webhooks" | "admin">;
  /** RFC 3339 date-time */
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiKeyCreate {
  name: string;
  scopes: Array<"notes:read" | "notes:write" | "routines:run" | "webhooks" | "admin">;
  expiresInDays?: number;
}

export interface ApiKeyCreated {
  id: string;
  name: string;
  prefix: string;
  scopes: Array<"notes:read" | "notes:write" | "routines:run" | "webhooks" | "admin">;
  /** RFC 3339 date-time */
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  /** The key. Shown once; it is stored only as a hash. */
  key: string;
}

export interface ApiKeyList {
  data: ApiKey[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export interface Asset {
  name: string;
  size: number;
  mimeType: string;
  url: string;
}

export interface AssetList {
  data: Asset[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export interface DeliveryList {
  data: WebhookDelivery[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export interface Graph {
  nodes: Array<{
    id: string;
    kind: "note" | "tag" | "notebook";
    label: string;
    noteId: string | null;
    degree: number;
  }>;
  edges: Array<{
    source: string;
    target: string;
    kind: "link" | "tag" | "notebook" | "related";
    weight: number;
  }>;
}

export interface LinkRef {
  /** Null when the link points at a note that does not exist yet. */
  noteId: string | null;
  title: string;
  page: number | null;
  context: string | null;
}

export interface Note {
  id: string;
  title: string;
  kind: "paged" | "board";
  tags: string[];
  notebookId: string | null;
  /** "Parent / Child" path of the notebook. */
  notebook: string | null;
  pages: number;
  pinned: boolean;
  summary: string | null;
  /** RFC 3339 date-time */
  createdAt: string;
  /** RFC 3339 date-time */
  updatedAt: string;
  trashedAt: string | null;
  /** Locked notes keep their content encrypted; only metadata is readable. */
  locked: boolean;
  /** The note as Markdown: front matter, typed text and recognized handwriting. */
  markdown: string;
  pageDetails: PageInfo[];
  recordings: Recording[];
}

export interface NoteAppend {
  /** Markdown added as typed text below the existing content. */
  text: string;
  /** 1-based page to add to (default: the last page, continuing onto new pages). */
  page?: number;
}

export interface NoteCreate {
  title: string;
  /** Markdown body, placed as typed text and flowing onto more pages when long. */
  text?: string;
  /** Notebook id or exact name. */
  notebookId?: string;
  tags?: string[];
}

export interface NoteLinks {
  outgoing: LinkRef[];
  backlinks: LinkRef[];
}

export interface NoteList {
  data: NoteSummary[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export interface NoteSummary {
  id: string;
  title: string;
  kind: "paged" | "board";
  tags: string[];
  notebookId: string | null;
  /** "Parent / Child" path of the notebook. */
  notebook: string | null;
  pages: number;
  pinned: boolean;
  summary: string | null;
  /** RFC 3339 date-time */
  createdAt: string;
  /** RFC 3339 date-time */
  updatedAt: string;
  trashedAt: string | null;
  /** Locked notes keep their content encrypted; only metadata is readable. */
  locked: boolean;
}

export interface NoteUpdate {
  title?: string;
  /** Replaces the tag list. */
  tags?: string[];
  /** Notebook id or exact name; null makes the note unfiled. */
  notebookId?: string | null;
  pinned?: boolean;
  summary?: string | null;
}

export interface Notebook {
  id: string;
  name: string;
  path: string;
  parentId: string | null;
  color: string | null;
  notes: number;
  /** RFC 3339 date-time */
  createdAt: string;
}

export interface NotebookCreate {
  name: string;
  color?: string;
  parentId?: string;
}

export interface NotebookList {
  data: Notebook[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export interface PageInfo {
  /** 1-based page number. */
  number: number;
  id: string;
  strokes: number;
  textBoxes: number;
  images: number;
  objects: number;
  background: "pdf" | "image" | null;
  handwritingRecognized: boolean;
  width: number;
  height: number;
}

export interface PageList {
  data: PageInfo[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export interface Problem {
  /** URI identifying the problem type (a link to its documentation). */
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  /** Stable machine-readable code, e.g. "not_found". */
  code: string;
  /** Validation errors, one per field. */
  errors?: {
    path: string;
    message: string;
  }[];
}

export interface Recording {
  id: string;
  asset: string;
  /** RFC 3339 date-time */
  startedAt: string;
  durationMs: number;
  mimeType: string;
  title: string | null;
  hasTranscript: boolean;
}

export interface Routine {
  id: string;
  name: string;
  enabled: boolean;
  triggers: string[];
  lastRunAt: string | null;
  lastStatus: string | null;
}

export interface RoutineList {
  data: Routine[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export interface RoutineRun {
  routineId: string;
  status: "done" | "error" | "cancelled";
  reply: string;
  error: string | null;
  activityRunId: string;
  changes: string[];
}

export interface SearchHit {
  noteId: string;
  title: string;
  /** 1-based page of the match. */
  page: number;
  /** Text around the match; «» marks matched words. */
  snippet: string;
  score: number;
  source: "note" | "text" | "handwriting" | "pdf" | "speech" | "meta";
}

export interface SearchResult {
  query: string;
  mode: "keyword" | "semantic" | "hybrid";
  data: SearchHit[];
}

export interface Tag {
  tag: string;
  count: number;
}

export interface TagList {
  data: Tag[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export interface Transcript {
  clipId: string;
  engine: string;
  where: "device" | "browser" | "provider";
  language: string | null;
  complete: boolean;
  /** RFC 3339 date-time */
  updatedAt: string;
  segments: {
    id: string;
    startMs: number;
    endMs: number;
    text: string;
  }[];
  summary: string | null;
}

export interface TranscriptList {
  data: Transcript[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

export interface Webhook {
  id: string;
  url: string;
  events: Array<"note.created" | "note.updated" | "note.trashed" | "note.restored" | "recording.ended" | "routine.finished">;
  description: string | null;
  enabled: boolean;
  /** RFC 3339 date-time */
  createdAt: string;
}

export interface WebhookCreate {
  /** Where to POST events (https; http only for localhost). */
  url: string;
  events: Array<"note.created" | "note.updated" | "note.trashed" | "note.restored" | "recording.ended" | "routine.finished">;
  description?: string;
}

export interface WebhookCreated {
  id: string;
  url: string;
  events: Array<"note.created" | "note.updated" | "note.trashed" | "note.restored" | "recording.ended" | "routine.finished">;
  description: string | null;
  enabled: boolean;
  /** RFC 3339 date-time */
  createdAt: string;
  /** Signing secret (whsec_…). Shown once; store it to verify signatures. */
  secret: string;
}

export interface WebhookDelivery {
  /** The webhook-id header value (same for every attempt of one message). */
  id: string;
  event: "note.created" | "note.updated" | "note.trashed" | "note.restored" | "recording.ended" | "routine.finished";
  attempt: number;
  status: "pending" | "succeeded" | "failed" | "retrying";
  responseStatus: number | null;
  error: string | null;
  /** RFC 3339 date-time */
  at: string;
  nextAttemptAt: string | null;
}

export interface WebhookList {
  data: Webhook[];
  /** Pass as `cursor` to get the next page; null on the last page. */
  nextCursor: string | null;
}

const listActivityOp: Operation = {"method":"GET","path":"/activity","pathParams":[],"queryParams":["limit","cursor","source"],"hasBody":false,"idempotent":false,"response":"json"};
const getGraphOp: Operation = {"method":"GET","path":"/graph","pathParams":[],"queryParams":["tags","notebooks","tag"],"hasBody":false,"idempotent":false,"response":"json"};
const listApiKeysOp: Operation = {"method":"GET","path":"/keys","pathParams":[],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const createApiKeyOp: Operation = {"method":"POST","path":"/keys","pathParams":[],"queryParams":[],"hasBody":true,"idempotent":false,"response":"json"};
const revokeApiKeyOp: Operation = {"method":"DELETE","path":"/keys/{id}","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const listNotebooksOp: Operation = {"method":"GET","path":"/notebooks","pathParams":[],"queryParams":["limit","cursor"],"hasBody":false,"idempotent":false,"response":"json"};
const createNotebookOp: Operation = {"method":"POST","path":"/notebooks","pathParams":[],"queryParams":[],"hasBody":true,"idempotent":true,"response":"json"};
const listNotesOp: Operation = {"method":"GET","path":"/notes","pathParams":[],"queryParams":["limit","cursor","notebook","tag","updatedSince","status"],"hasBody":false,"idempotent":false,"response":"json"};
const createNoteOp: Operation = {"method":"POST","path":"/notes","pathParams":[],"queryParams":[],"hasBody":true,"idempotent":true,"response":"json"};
const getNoteOp: Operation = {"method":"GET","path":"/notes/{id}","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const updateNoteOp: Operation = {"method":"PATCH","path":"/notes/{id}","pathParams":["id"],"queryParams":[],"hasBody":true,"idempotent":false,"response":"json"};
const trashNoteOp: Operation = {"method":"DELETE","path":"/notes/{id}","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const appendToNoteOp: Operation = {"method":"POST","path":"/notes/{id}/append","pathParams":["id"],"queryParams":[],"hasBody":true,"idempotent":true,"response":"json"};
const listAssetsOp: Operation = {"method":"GET","path":"/notes/{id}/assets","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const getAssetOp: Operation = {"method":"GET","path":"/notes/{id}/assets/{name}","pathParams":["id","name"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"bytes"};
const exportNoteOp: Operation = {"method":"GET","path":"/notes/{id}/export","pathParams":["id"],"queryParams":["format"],"hasBody":false,"idempotent":false,"response":"bytes"};
const getNoteLinksOp: Operation = {"method":"GET","path":"/notes/{id}/links","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const getNoteMarkdownOp: Operation = {"method":"GET","path":"/notes/{id}/markdown","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"text"};
const listPagesOp: Operation = {"method":"GET","path":"/notes/{id}/pages","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const getPageOp: Operation = {"method":"GET","path":"/notes/{id}/pages/{n}","pathParams":["id","n"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const getPageInkOp: Operation = {"method":"GET","path":"/notes/{id}/pages/{n}/ink","pathParams":["id","n"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const getPagePdfOp: Operation = {"method":"GET","path":"/notes/{id}/pages/{n}/pdf","pathParams":["id","n"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"bytes"};
const getPagePngOp: Operation = {"method":"GET","path":"/notes/{id}/pages/{n}/png","pathParams":["id","n"],"queryParams":["width"],"hasBody":false,"idempotent":false,"response":"bytes"};
const getPageSvgOp: Operation = {"method":"GET","path":"/notes/{id}/pages/{n}/svg","pathParams":["id","n"],"queryParams":["embedAssets"],"hasBody":false,"idempotent":false,"response":"text"};
const getPageTextOp: Operation = {"method":"GET","path":"/notes/{id}/pages/{n}/text","pathParams":["id","n"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"text"};
const restoreNoteOp: Operation = {"method":"POST","path":"/notes/{id}/restore","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const listTranscriptsOp: Operation = {"method":"GET","path":"/notes/{id}/transcripts","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const listRoutinesOp: Operation = {"method":"GET","path":"/routines","pathParams":[],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const runRoutineOp: Operation = {"method":"POST","path":"/routines/{id}/run","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":true,"response":"json"};
const searchOp: Operation = {"method":"GET","path":"/search","pathParams":[],"queryParams":["q","mode","limit","noteId"],"hasBody":false,"idempotent":false,"response":"json"};
const listTagsOp: Operation = {"method":"GET","path":"/tags","pathParams":[],"queryParams":["limit","cursor"],"hasBody":false,"idempotent":false,"response":"json"};
const listWebhooksOp: Operation = {"method":"GET","path":"/webhooks","pathParams":[],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const createWebhookOp: Operation = {"method":"POST","path":"/webhooks","pathParams":[],"queryParams":[],"hasBody":true,"idempotent":true,"response":"json"};
const getWebhookOp: Operation = {"method":"GET","path":"/webhooks/{id}","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};
const deleteWebhookOp: Operation = {"method":"DELETE","path":"/webhooks/{id}","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"none"};
const listWebhookDeliveriesOp: Operation = {"method":"GET","path":"/webhooks/{id}/deliveries","pathParams":["id"],"queryParams":["limit","cursor"],"hasBody":false,"idempotent":false,"response":"json"};
const testWebhookOp: Operation = {"method":"POST","path":"/webhooks/{id}/test","pathParams":["id"],"queryParams":[],"hasBody":false,"idempotent":false,"response":"json"};

/** Typed client for the Inkwright REST API. Each method is one API operation. */
export class InkwrightClient extends BaseClient {
  /**
   * Recent AI and API activity
   *
   * What the assistant, routines, MCP agents and API callers changed, newest first (undo lives in the app).
   *
   * `GET /activity` — scope `notes:read`
   */
  listActivity(args?: {
      /** Page size (default 20, at most 100). */
      limit?: number;
      /** Opaque cursor from a previous page’s nextCursor. */
      cursor?: string;
      /** Only runs from this source (assistant, routine, external). */
      source?: string;
    }, options?: RequestOptions): Promise<ActivityList> {
    return this.request<ActivityList>(listActivityOp, args ?? {}, options);
  }

  /**
   * The knowledge graph
   *
   * Notes, tags and notebooks as nodes; links, tags and notebook membership as edges.
   *
   * `GET /graph` — scope `notes:read`
   */
  getGraph(args?: {
      /** Include tag nodes. */
      tags?: "true" | "false";
      /** Include notebook nodes. */
      notebooks?: "true" | "false";
      /** Only notes with this tag. */
      tag?: string;
    }, options?: RequestOptions): Promise<Graph> {
    return this.request<Graph>(getGraphOp, args ?? {}, options);
  }

  /**
   * List API keys
   *
   * `GET /keys` — scope `admin`
   */
  listApiKeys(args?: Record<string, never>, options?: RequestOptions): Promise<ApiKeyList> {
    return this.request<ApiKeyList>(listApiKeysOp, args ?? {}, options);
  }

  /**
   * Create an API key
   *
   * `POST /keys` — scope `admin`
   */
  createApiKey(args: {
      body: ApiKeyCreate;
    }, options?: RequestOptions): Promise<ApiKeyCreated> {
    return this.request<ApiKeyCreated>(createApiKeyOp, args, options);
  }

  /**
   * Revoke an API key
   *
   * `DELETE /keys/{id}` — scope `admin`
   */
  revokeApiKey(args: {
      id: string;
    }, options?: RequestOptions): Promise<ApiKey> {
    return this.request<ApiKey>(revokeApiKeyOp, args, options);
  }

  /**
   * List notebooks
   *
   * `GET /notebooks` — scope `notes:read`
   */
  listNotebooks(args?: {
      /** Page size (default 100, at most 500). */
      limit?: number;
      /** Opaque cursor from a previous page’s nextCursor. */
      cursor?: string;
    }, options?: RequestOptions): Promise<NotebookList> {
    return this.request<NotebookList>(listNotebooksOp, args ?? {}, options);
  }

  /**
   * Create a notebook
   *
   * Answers 200 with the existing notebook when one with that name already exists at that level.
   *
   * `POST /notebooks` — scope `notes:write`
   */
  createNotebook(args: {
      body: NotebookCreate;
    }, options?: RequestOptions): Promise<Notebook> {
    return this.request<Notebook>(createNotebookOp, args, options);
  }

  /**
   * List notes
   *
   * Newest first (by last change). Filter by notebook (with its sections), tag, change time or trash state. Paginated with an opaque cursor that stays stable while notes change.
   *
   * `GET /notes` — scope `notes:read`
   */
  listNotes(args?: {
      /** Page size (default 50, at most 200). */
      limit?: number;
      /** Opaque cursor from a previous page’s nextCursor. */
      cursor?: string;
      /** Notebook id or exact name; includes its sections. */
      notebook?: string;
      /** Only notes with this tag (case-insensitive, # optional). */
      tag?: string;
      /** Only notes changed at or after this time. */
      updatedSince?: string;
      /** Live notes (default), notes in the Trash, or both. */
      status?: "active" | "trashed" | "all";
    }, options?: RequestOptions): Promise<NoteList> {
    return this.request<NoteList>(listNotesOp, args ?? {}, options);
  }

  /**
   * Create a note
   *
   * Creates a note with typed text (Markdown). Logged in Activity under the caller’s name, where it can be undone.
   *
   * `POST /notes` — scope `notes:write`
   */
  createNote(args: {
      body: NoteCreate;
    }, options?: RequestOptions): Promise<Note> {
    return this.request<Note>(createNoteOp, args, options);
  }

  /**
   * Get a note
   *
   * Metadata, Markdown (typed text and recognized handwriting) and page details. Supports If-None-Match.
   *
   * `GET /notes/{id}` — scope `notes:read`
   */
  getNote(args: {
      /** Note id. */
      id: string;
    }, options?: RequestOptions): Promise<Note | null> {
    return this.request<Note | null>(getNoteOp, args, options);
  }

  /**
   * Update a note
   *
   * Changes title, tags, notebook, pin or summary. Send If-Match with the ETag you read to avoid overwriting someone else’s change (412 if it changed).
   *
   * `PATCH /notes/{id}` — scope `notes:write`
   */
  updateNote(args: {
      /** Note id. */
      id: string;
      body: NoteUpdate;
    }, options?: RequestOptions): Promise<Note> {
    return this.request<Note>(updateNoteOp, args, options);
  }

  /**
   * Move a note to the Trash
   *
   * Reversible: restore it with POST /notes/{id}/restore (or in the app) within 30 days.
   *
   * `DELETE /notes/{id}` — scope `notes:write`
   */
  trashNote(args: {
      /** Note id. */
      id: string;
    }, options?: RequestOptions): Promise<NoteSummary> {
    return this.request<NoteSummary>(trashNoteOp, args, options);
  }

  /**
   * Append text to a note
   *
   * Adds Markdown as typed text below the content, continuing onto new pages when the page is full.
   *
   * `POST /notes/{id}/append` — scope `notes:write`
   */
  appendToNote(args: {
      /** Note id. */
      id: string;
      body: NoteAppend;
    }, options?: RequestOptions): Promise<Note> {
    return this.request<Note>(appendToNoteOp, args, options);
  }

  /**
   * List a note’s files
   *
   * Images, PDFs and audio recordings the note uses.
   *
   * `GET /notes/{id}/assets` — scope `notes:read`
   */
  listAssets(args: {
      /** Note id. */
      id: string;
    }, options?: RequestOptions): Promise<AssetList> {
    return this.request<AssetList>(listAssetsOp, args, options);
  }

  /**
   * Download a note’s file
   *
   * `GET /notes/{id}/assets/{name}` — scope `notes:read`
   */
  getAsset(args: {
      id: string;
      /** Asset file name. */
      name: string;
    }, options?: RequestOptions): Promise<Uint8Array> {
    return this.request<Uint8Array>(getAssetOp, args, options);
  }

  /**
   * Export a note
   *
   * `md` (Markdown), `pdf` (every page; needs the optional @resvg/resvg-js renderer), or `json` (the note’s vault files: note.json and every page’s ink, for backups and other tools).
   *
   * `GET /notes/{id}/export` — scope `notes:read`
   */
  exportNote(args: {
      /** Note id. */
      id: string;
      /** Export format. */
      format: "md" | "pdf" | "json";
    }, options?: RequestOptions): Promise<Uint8Array> {
    return this.request<Uint8Array>(exportNoteOp, args, options);
  }

  /**
   * Links and backlinks of a note
   *
   * `[[Links]]` the note makes (typed, handwritten or ink links) and the notes linking to it, each with the line around the link.
   *
   * `GET /notes/{id}/links` — scope `notes:read`
   */
  getNoteLinks(args: {
      /** Note id. */
      id: string;
    }, options?: RequestOptions): Promise<NoteLinks> {
    return this.request<NoteLinks>(getNoteLinksOp, args, options);
  }

  /**
   * Get a note as Markdown
   *
   * `GET /notes/{id}/markdown` — scope `notes:read`
   */
  getNoteMarkdown(args: {
      /** Note id. */
      id: string;
    }, options?: RequestOptions): Promise<string> {
    return this.request<string>(getNoteMarkdownOp, args, options);
  }

  /**
   * List a note’s pages
   *
   * `GET /notes/{id}/pages` — scope `notes:read`
   */
  listPages(args: {
      /** Note id. */
      id: string;
    }, options?: RequestOptions): Promise<PageList> {
    return this.request<PageList>(listPagesOp, args, options);
  }

  /**
   * Get a page’s details
   *
   * `GET /notes/{id}/pages/{n}` — scope `notes:read`
   */
  getPage(args: {
      /** Note id. */
      id: string;
      /** 1-based page number. */
      n: number;
    }, options?: RequestOptions): Promise<PageInfo> {
    return this.request<PageInfo>(getPageOp, args, options);
  }

  /**
   * Get a page’s ink as JSON
   *
   * The page file (PageInk) exactly as in the vault: strokes with points, text boxes, images and objects (docs/VAULT_FORMAT.md).
   *
   * `GET /notes/{id}/pages/{n}/ink` — scope `notes:read`
   */
  getPageInk(args: {
      /** Note id. */
      id: string;
      /** 1-based page number. */
      n: number;
    }, options?: RequestOptions): Promise<Record<string, unknown>> {
    return this.request<Record<string, unknown>>(getPageInkOp, args, options);
  }

  /**
   * Render a page as PDF
   *
   * `GET /notes/{id}/pages/{n}/pdf` — scope `notes:read`
   */
  getPagePdf(args: {
      /** Note id. */
      id: string;
      /** 1-based page number. */
      n: number;
    }, options?: RequestOptions): Promise<Uint8Array> {
    return this.request<Uint8Array>(getPagePdfOp, args, options);
  }

  /**
   * Render a page as PNG
   *
   * `GET /notes/{id}/pages/{n}/png` — scope `notes:read`
   */
  getPagePng(args: {
      /** Note id. */
      id: string;
      /** 1-based page number. */
      n: number;
      /** Width in pixels (default 1200). */
      width?: number;
    }, options?: RequestOptions): Promise<Uint8Array> {
    return this.request<Uint8Array>(getPagePngOp, args, options);
  }

  /**
   * Render a page as SVG
   *
   * `GET /notes/{id}/pages/{n}/svg` — scope `notes:read`
   */
  getPageSvg(args: {
      /** Note id. */
      id: string;
      /** 1-based page number. */
      n: number;
      /** Inline images as data URLs (default true). */
      embedAssets?: "true" | "false";
    }, options?: RequestOptions): Promise<string> {
    return this.request<string>(getPageSvgOp, args, options);
  }

  /**
   * Get a page’s text
   *
   * Typed text and recognized handwriting of the page.
   *
   * `GET /notes/{id}/pages/{n}/text` — scope `notes:read`
   */
  getPageText(args: {
      /** Note id. */
      id: string;
      /** 1-based page number. */
      n: number;
    }, options?: RequestOptions): Promise<string> {
    return this.request<string>(getPageTextOp, args, options);
  }

  /**
   * Restore a note from the Trash
   *
   * `POST /notes/{id}/restore` — scope `notes:write`
   */
  restoreNote(args: {
      /** Note id. */
      id: string;
    }, options?: RequestOptions): Promise<NoteSummary> {
    return this.request<NoteSummary>(restoreNoteOp, args, options);
  }

  /**
   * Transcripts of a note’s recordings
   *
   * `GET /notes/{id}/transcripts` — scope `notes:read`
   */
  listTranscripts(args: {
      /** Note id. */
      id: string;
    }, options?: RequestOptions): Promise<TranscriptList> {
    return this.request<TranscriptList>(listTranscriptsOp, args, options);
  }

  /**
   * List routines
   *
   * `GET /routines` — scope `notes:read`
   */
  listRoutines(args?: Record<string, never>, options?: RequestOptions): Promise<RoutineList> {
    return this.request<RoutineList>(listRoutinesOp, args ?? {}, options);
  }

  /**
   * Run a routine now
   *
   * Runs the routine with the server’s AI (start it with --ai-provider) and waits for it to finish. Moving notes to Trash is never done unattended: it becomes a pending approval in the app.
   *
   * `POST /routines/{id}/run` — scope `routines:run`
   */
  runRoutine(args: {
      /** Routine id or name. */
      id: string;
    }, options?: RequestOptions): Promise<RoutineRun> {
    return this.request<RoutineRun>(runRoutineOp, args, options);
  }

  /**
   * Search notes
   *
   * `keyword` (default) matches words, prefixes and accents in typed text and recognized handwriting. `semantic` and `hybrid` rank passages by meaning and need the server to be started with an embedding model (--embeddings-model); otherwise they answer 501.
   *
   * `GET /search` — scope `notes:read`
   */
  search(args: {
      /** What to look for. */
      q: string;
      mode?: "keyword" | "semantic" | "hybrid";
      /** Page size (default 10, at most 100). */
      limit?: number;
      /** Only search inside this note (semantic/hybrid). */
      noteId?: string;
    }, options?: RequestOptions): Promise<SearchResult> {
    return this.request<SearchResult>(searchOp, args, options);
  }

  /**
   * List tags
   *
   * Every tag on a live note (set by hand or written as #tag), with how many notes carry it, most used first.
   *
   * `GET /tags` — scope `notes:read`
   */
  listTags(args?: {
      /** Page size (default 200, at most 1000). */
      limit?: number;
      /** Opaque cursor from a previous page’s nextCursor. */
      cursor?: string;
    }, options?: RequestOptions): Promise<TagList> {
    return this.request<TagList>(listTagsOp, args ?? {}, options);
  }

  /**
   * List webhooks
   *
   * `GET /webhooks` — scope `webhooks`
   */
  listWebhooks(args?: Record<string, never>, options?: RequestOptions): Promise<WebhookList> {
    return this.request<WebhookList>(listWebhooksOp, args ?? {}, options);
  }

  /**
   * Subscribe a URL to events
   *
   * Events are POSTed per the Standard Webhooks spec, signed with the returned secret (see docs/API.md for verifying them).
   *
   * `POST /webhooks` — scope `webhooks`
   */
  createWebhook(args: {
      body: WebhookCreate;
    }, options?: RequestOptions): Promise<WebhookCreated> {
    return this.request<WebhookCreated>(createWebhookOp, args, options);
  }

  /**
   * Get a webhook
   *
   * `GET /webhooks/{id}` — scope `webhooks`
   */
  getWebhook(args: {
      id: string;
    }, options?: RequestOptions): Promise<Webhook> {
    return this.request<Webhook>(getWebhookOp, args, options);
  }

  /**
   * Delete a webhook
   *
   * `DELETE /webhooks/{id}` — scope `webhooks`
   */
  deleteWebhook(args: {
      id: string;
    }, options?: RequestOptions): Promise<void> {
    return this.request<void>(deleteWebhookOp, args, options);
  }

  /**
   * Delivery log of a webhook
   *
   * The latest attempt of each message, newest first (the last 200 messages are kept).
   *
   * `GET /webhooks/{id}/deliveries` — scope `webhooks`
   */
  listWebhookDeliveries(args: {
      id: string;
      /** Page size (default 50, at most 200). */
      limit?: number;
      /** Opaque cursor from a previous page’s nextCursor. */
      cursor?: string;
    }, options?: RequestOptions): Promise<DeliveryList> {
    return this.request<DeliveryList>(listWebhookDeliveriesOp, args, options);
  }

  /**
   * Send a test event
   *
   * Sends a `note.updated` event with sample data to this webhook only, and waits for the first attempt.
   *
   * `POST /webhooks/{id}/test` — scope `webhooks`
   */
  testWebhook(args: {
      id: string;
    }, options?: RequestOptions): Promise<WebhookDelivery> {
    return this.request<WebhookDelivery>(testWebhookOp, args, options);
  }

}
