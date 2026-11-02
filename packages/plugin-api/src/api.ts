/**
 * The API a plugin receives (`activate(inkstone)`), also exposed to power users as
 * `window.inkstone` when Settings › Developer › Automation API is on. Every method is async and
 * goes through the host, which checks the caller's permissions; a refused call rejects with a
 * `PluginApiError` whose `code` is `permission_denied`.
 */
import type { Permission } from './permissions.ts';

/** A note as plugins see it: metadata and its text (typed text and recognized handwriting). */
export interface NoteSummary {
  id: string;
  title: string;
  tags: string[];
  /** "Parent / Child" notebook path, or null when unfiled. */
  notebook: string | null;
  createdAt: string;
  updatedAt: string;
  pages: number;
}

export interface NoteContent extends NoteSummary {
  /** The note as Markdown (front matter stripped): typed text and recognized handwriting, page by page. */
  markdown: string;
}

export interface SearchHit {
  id: string;
  title: string;
  /** 1-based page of the best match. */
  page: number;
  snippet: string;
}

export interface EditorState {
  noteId: string;
  title: string;
  /** 1-based page in view. */
  page: number;
  pages: number;
}

export interface FetchInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  headers?: Record<string, string>;
  /** Request body as text (send JSON with JSON.stringify and a content-type header). */
  body?: string;
}

export interface FetchResult {
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  /** Response body as text (at most 5 MB). */
  body: string;
}

export type NoteEvent = 'note.created' | 'note.updated' | 'note.opened' | 'note.trashed' | 'selection.changed';

export interface EventPayloads {
  'note.created': { id: string; title: string };
  'note.updated': { id: string; title: string };
  'note.opened': { id: string; title: string };
  'note.trashed': { id: string; title: string };
  'selection.changed': { noteId: string; text: string };
}

/** What an importer returns: the host creates one note per item (undoable, recorded as imported). */
export interface ImportedNote {
  title: string;
  /** Markdown body, placed as typed text. */
  text: string;
  tags?: string[];
}

export interface ImportInput {
  name: string;
  /** File contents as text (UTF-8). */
  text: string;
}

export interface ExportInput {
  note: NoteContent;
}

export interface ExportOutput {
  /** File contents as text. */
  text: string;
  /** Suggested file name (the host adds the extension when missing). */
  fileName?: string;
}

export interface AppInfo {
  /** Inkstone version, e.g. 1.0.0. */
  version: string;
  /** Plugin API version (1). */
  apiVersion: number;
  platform: 'web' | 'android' | 'ios' | 'desktop';
  /** Permissions currently granted to this caller (the user can revoke them at any time). */
  permissions: Permission[];
}

export type CommandHandler = () => void | Promise<void>;
export type ToolHandler = (args: Record<string, unknown>) => unknown | Promise<unknown>;
export type ImportHandler = (file: ImportInput) => ImportedNote | ImportedNote[] | Promise<ImportedNote | ImportedNote[]>;
export type ExportHandler = (input: ExportInput) => ExportOutput | Promise<ExportOutput>;

export interface InkstoneAPI {
  readonly app: {
    info(): Promise<AppInfo>;
  };
  readonly notes: {
    /** Newest first. `tag` and `notebook` filter; `limit` defaults to 50 (max 500). */
    list(opts?: { tag?: string; notebook?: string; limit?: number }): Promise<NoteSummary[]>;
    search(query: string, opts?: { limit?: number }): Promise<SearchHit[]>;
    get(id: string): Promise<NoteContent>;
    create(note: { title: string; text?: string; tags?: string[] }): Promise<NoteSummary>;
    /** Adds Markdown as typed text below the note's content. */
    append(id: string, text: string): Promise<NoteSummary>;
    update(id: string, patch: { title?: string; tags?: string[] }): Promise<NoteSummary>;
  };
  readonly editor: {
    /** The open note, or null in the library. */
    current(): Promise<EditorState | null>;
    /** Text of the current selection (typed text and recognized handwriting), '' when none. */
    selection(): Promise<string>;
    /** Places typed text on the page in view (one undo step). */
    insertText(text: string): Promise<void>;
  };
  readonly commands: {
    /** Supplies the handler for a command declared in `contributes.commands`. */
    register(id: string, run: CommandHandler): void;
  };
  readonly ai: {
    /** Supplies the handler for a tool declared in `contributes.aiTools`. Its result goes back to the model as JSON. */
    registerTool(name: string, run: ToolHandler): void;
  };
  readonly importers: {
    register(id: string, run: ImportHandler): void;
  };
  readonly exporters: {
    register(id: string, run: ExportHandler): void;
  };
  readonly events: {
    /** Returns an unsubscribe function. */
    on<E extends NoteEvent>(event: E, listener: (data: EventPayloads[E]) => void): () => void;
  };
  /** Private key-value storage, kept in the vault with the plugin (synced). Values are JSON. */
  readonly storage: {
    get<T = unknown>(key: string): Promise<T | undefined>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  /** The plugin's settings (`contributes.settings`), as the user set them in Settings › Plugins. */
  readonly settings: {
    get(): Promise<Record<string, string | number | boolean>>;
  };
  readonly net: {
    /** HTTP through the host, only to the manifest's `network.hosts`. */
    fetch(url: string, init?: FetchInit): Promise<FetchResult>;
  };
  readonly ui: {
    toast(text: string, tone?: 'info' | 'success' | 'error'): Promise<void>;
    openNote(id: string, page?: number): Promise<void>;
    /** Panels only: asks the host to resize the panel's frame to its content. */
    setHeight?(px: number): void;
  };
  readonly clipboard: {
    writeText(text: string): Promise<void>;
  };
  /** Messages between a plugin's main code and its panels (both run sandboxed, in separate frames). */
  readonly messages: {
    post(data: unknown): void;
    on(listener: (data: unknown) => void): () => void;
  };
}

/** What a plugin's entry module exports (as `default`). */
export interface PluginModule {
  /** Runs once when the plugin starts (sandboxed). Register command, tool, importer and exporter handlers here. */
  activate?(inkstone: InkstoneAPI): void | Promise<void>;
  /** Runs when the plugin stops (disabled, uninstalled, updated). */
  deactivate?(): void | Promise<void>;
  /** Panel renderers by panel id; each runs in the panel's own sandboxed frame. */
  panels?: Record<string, (root: HTMLElement, inkstone: InkstoneAPI) => void | Promise<void>>;
}

/** Identity helper that gives plugin code full types (`export default definePlugin({...})`). */
export function definePlugin(plugin: PluginModule): PluginModule {
  return plugin;
}
