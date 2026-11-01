import { richResult, type AgentTool } from '../agent.ts';
import type { JsonSchema } from '../types.ts';

/** Note metadata the tools expose. `NoteMeta` from @inkstone/core satisfies it. */
export interface NoteInfo {
  id: string;
  title: string;
  tags: string[];
  notebookId?: string;
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
  summary?: string;
  kind?: string;
  trashedAt?: number;
}

export interface NoteListItem extends NoteInfo {
  pageCount?: number;
  notebookName?: string;
}

export interface NoteSearchHit {
  noteId: string;
  title: string;
  pageIndex: number;
  snippet: string;
  score: number;
}

export interface NotePageContent {
  /** 0-based. */
  index: number;
  /** Typed text and recognized handwriting. */
  text: string;
  strokeCount: number;
  hasHandwriting: boolean;
  /** Handwriting on this page has been converted to text. */
  handwritingRecognized?: boolean;
  imageCount?: number;
}

export interface NoteContent {
  meta: NoteInfo;
  pages: NotePageContent[];
}

export interface NotebookInfo {
  id: string;
  name: string;
  parentId?: string;
  noteCount?: number;
}

export interface NotePatch {
  title?: string;
  tags?: string[];
  /** `null` moves the note out of its notebook. */
  notebookId?: string | null;
  pinned?: boolean;
  summary?: string;
}

/**
 * What the app implements (backed by @inkstone/core Vault + SearchIndex) so agents can work
 * with notes. `MemoryNoteToolHost` is the reference implementation.
 */
export interface NoteToolHost {
  listNotes(opts?: { notebookId?: string; tag?: string; pinned?: boolean; limit?: number }): Promise<NoteListItem[]>;
  searchNotes(query: string, opts?: { limit?: number }): Promise<NoteSearchHit[]>;
  readNote(id: string): Promise<NoteContent | null>;
  /** A rendering of one page for vision models. */
  getPageImage?(noteId: string, pageIndex: number): Promise<{ mediaType: string; base64: string } | null>;
  createNote(args: { title: string; text: string; notebookId?: string; tags?: string[] }): Promise<NoteInfo>;
  appendText(noteId: string, text: string, pageIndex?: number): Promise<{ noteId: string; pageIndex: number }>;
  updateNote(id: string, patch: NotePatch): Promise<NoteInfo | null>;
  listNotebooks(): Promise<NotebookInfo[]>;
  createNotebook(name: string, opts?: { parentId?: string }): Promise<NotebookInfo>;
  trashNote(id: string): Promise<boolean | void>;
}

export const NOTE_TOOL_NAMES = [
  'list_notes',
  'search_notes',
  'read_note',
  'get_page_image',
  'create_note',
  'append_to_note',
  'update_note',
  'list_notebooks',
  'create_notebook',
  'trash_note',
] as const;

export type NoteToolName = (typeof NOTE_TOOL_NAMES)[number];

export interface NoteToolsOptions {
  /** Only these tools. */
  include?: readonly NoteToolName[];
  /** All but these tools (e.g. read-only agents exclude every writer). */
  exclude?: readonly NoteToolName[];
  /** Max characters of note text returned per read_note (default 16k). */
  maxNoteChars?: number;
}

const iso = (ms: number) => (Number.isFinite(ms) ? new Date(ms).toISOString().slice(0, 16).replace('T', ' ') : undefined);

function noteView(n: NoteInfo & { pageCount?: number; notebookName?: string }) {
  const o: Record<string, unknown> = { id: n.id, title: n.title || 'Untitled' };
  if (n.tags?.length) o.tags = n.tags;
  if (n.notebookId) o.notebook_id = n.notebookId;
  if (n.notebookName) o.notebook = n.notebookName;
  if (n.pinned) o.pinned = true;
  if (n.pageCount != null) o.page_count = n.pageCount;
  o.updated = iso(n.updatedAt);
  if (n.summary) o.summary = n.summary;
  return o;
}

const S = {
  str: (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'string', description, ...extra }),
  int: (description: string, extra: JsonSchema = {}): JsonSchema => ({ type: 'integer', description, ...extra }),
  bool: (description: string): JsonSchema => ({ type: 'boolean', description }),
  tags: (description: string): JsonSchema => ({ type: 'array', items: { type: 'string' }, description }),
  obj: (properties: Record<string, JsonSchema>, required: string[] = []): JsonSchema => ({ type: 'object', properties, required, additionalProperties: false }),
};

function notFound(id: string): Error {
  return new Error(`No note with id "${id}". Use search_notes or list_notes to find the right id.`);
}

/** Normalizes tags: trims, drops '#', lowercases, de-duplicates. */
export function normalizeTags(tags: readonly unknown[] | undefined): string[] {
  const out: string[] = [];
  for (const t of tags ?? []) {
    const s = String(t).trim().replace(/^#+/, '').trim().toLowerCase();
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** The agent's tools for working with the user's notes. */
export function createNoteTools(host: NoteToolHost, opts: NoteToolsOptions = {}): AgentTool[] {
  const maxChars = opts.maxNoteChars ?? 16_000;
  const tools: AgentTool[] = [
    {
      name: 'list_notes',
      description:
        'List the user\'s notes, most recently edited first, with id, title, tags, notebook and summary. Use it to browse ("my recent notes", "what\'s in my Work notebook", "pinned notes"). To find notes about a topic, prefer search_notes.',
      parameters: S.obj({
        notebook_id: S.str('Only notes in this notebook (id from list_notebooks).'),
        tag: S.str('Only notes with this tag.'),
        pinned_only: S.bool('Only pinned notes.'),
        limit: S.int('Maximum notes to return (default 30).', { minimum: 1, maximum: 200 }),
      }),
      readOnly: true,
      async execute(a: { notebook_id?: string; tag?: string; pinned_only?: boolean; limit?: number }) {
        const notes = await host.listNotes({ notebookId: a.notebook_id, tag: a.tag ? normalizeTags([a.tag])[0] : undefined, pinned: a.pinned_only || undefined, limit: a.limit ?? 30 });
        return { count: notes.length, notes: notes.map(noteView) };
      },
    },
    {
      name: 'search_notes',
      description:
        'Full-text search across note titles, tags, summaries, typed text and recognized handwriting. Returns the best matching notes with a snippet («» marks matches) and the page_index where it matched. Use short keyword queries ("launch budget", not a full question); try synonyms or fewer words if nothing comes back. Then use read_note for full content.',
      parameters: S.obj({ query: S.str('Keywords to search for.', { minLength: 1 }), limit: S.int('Maximum results (default 8).', { minimum: 1, maximum: 50 }) }, ['query']),
      readOnly: true,
      async execute(a: { query: string; limit?: number }) {
        const hits = await host.searchNotes(a.query, { limit: a.limit ?? 8 });
        return {
          query: a.query,
          count: hits.length,
          results: hits.map((h) => ({ note_id: h.noteId, title: h.title || 'Untitled', page_index: h.pageIndex, snippet: h.snippet })),
          ...(hits.length ? {} : { hint: 'No matches. Try fewer or different keywords, or list_notes.' }),
        };
      },
    },
    {
      name: 'read_note',
      description:
        'Read a note\'s full content: metadata plus each page\'s text (typed text and recognized handwriting). Pages are 0-based. A page with has_handwriting=true and handwriting_recognized=false has ink that is not converted to text yet — use get_page_image to look at it if you need it.',
      parameters: S.obj({ note_id: S.str('The note id (from search_notes or list_notes).') }, ['note_id']),
      readOnly: true,
      async execute(a: { note_id: string }) {
        const n = await host.readNote(a.note_id);
        if (!n) throw notFound(a.note_id);
        let budget = maxChars;
        const pages = n.pages.map((p) => {
          const text = p.text.length > budget ? `${p.text.slice(0, Math.max(0, budget))}…[truncated]` : p.text;
          budget = Math.max(0, budget - p.text.length);
          const o: Record<string, unknown> = { page_index: p.index, text: text || (p.hasHandwriting ? '' : '(blank)') };
          if (p.hasHandwriting) {
            o.has_handwriting = true;
            o.handwriting_recognized = p.handwritingRecognized ?? !!p.text;
          }
          if (p.imageCount) o.images = p.imageCount;
          return o;
        });
        return { ...noteView({ ...n.meta, pageCount: n.pages.length }), created: iso(n.meta.createdAt), pages };
      },
    },
    {
      name: 'get_page_image',
      description:
        'Look at one page of a note as an image — handwriting, drawings, diagrams, annotated PDFs. Use it when read_note shows unrecognized handwriting or the user asks about something visual. page_index is 0-based.',
      parameters: S.obj({ note_id: S.str('The note id.'), page_index: S.int('0-based page number (default 0).', { minimum: 0 }) }, ['note_id']),
      readOnly: true,
      async execute(a: { note_id: string; page_index?: number }) {
        const idx = a.page_index ?? 0;
        const img = await host.getPageImage!(a.note_id, idx);
        if (!img) throw new Error(`No page ${idx} in note "${a.note_id}" (or it cannot be rendered).`);
        return richResult([
          { type: 'text', text: `Page ${idx} of note ${a.note_id}:` },
          { type: 'image', mediaType: img.mediaType, data: img.base64 },
        ]);
      },
    },
    {
      name: 'create_note',
      description:
        'Create a new note with a title and typed text (Markdown: headings, "- " bullets, "- [ ] " checkboxes, [[wiki links]]). Use it when the user asks to write, save, draft or jot something down. Put all the content in text — don\'t leave it empty. Returns the new note\'s id.',
      parameters: S.obj(
        {
          title: S.str('Short descriptive title.', { minLength: 1 }),
          text: S.str('The note body (Markdown).'),
          notebook_id: S.str('Put the note in this notebook (id from list_notebooks or create_notebook).'),
          tags: S.tags('Tags without "#".'),
        },
        ['title', 'text'],
      ),
      async execute(a: { title: string; text: string; notebook_id?: string; tags?: string[] }) {
        const n = await host.createNote({ title: a.title.trim(), text: a.text, notebookId: a.notebook_id, tags: normalizeTags(a.tags) });
        return { created: true, note: noteView(n) };
      },
    },
    {
      name: 'append_to_note',
      description:
        'Add typed text (Markdown) to an existing note, below what is already there. Without page_index it goes on the last page (a new page is added when that one is full). Use it for "add X to my … note". Never use it to replace content.',
      parameters: S.obj(
        {
          note_id: S.str('The note id.'),
          text: S.str('Text to add (Markdown).', { minLength: 1 }),
          page_index: S.int('0-based page to add to (default: the last page).', { minimum: 0 }),
        },
        ['note_id', 'text'],
      ),
      async execute(a: { note_id: string; text: string; page_index?: number }) {
        const r = await host.appendText(a.note_id, a.text, a.page_index);
        return { appended: true, note_id: r.noteId, page_index: r.pageIndex };
      },
    },
    {
      name: 'update_note',
      description:
        'Change a note\'s metadata: rename it, set its tags (replaces the whole tag list — include existing tags you want to keep), move it to a notebook (notebook_id, or "" to unfile it), pin/unpin it, or set its one-or-two-sentence summary. Does not change the note\'s content.',
      parameters: S.obj(
        {
          note_id: S.str('The note id.'),
          title: S.str('New title.'),
          tags: S.tags('The complete new tag list.'),
          notebook_id: S.str('Notebook id to move the note into; empty string removes it from its notebook.'),
          pinned: S.bool('Pin (true) or unpin (false).'),
          summary: S.str('Short summary shown in the library.'),
        },
        ['note_id'],
      ),
      async execute(a: { note_id: string; title?: string; tags?: string[]; notebook_id?: string; pinned?: boolean; summary?: string }) {
        const patch: NotePatch = {};
        if (a.title !== undefined) patch.title = a.title.trim();
        if (a.tags !== undefined) patch.tags = normalizeTags(a.tags);
        if (a.notebook_id !== undefined) patch.notebookId = a.notebook_id === '' ? null : a.notebook_id;
        if (a.pinned !== undefined) patch.pinned = a.pinned;
        if (a.summary !== undefined) patch.summary = a.summary.trim();
        if (!Object.keys(patch).length) throw new Error('Nothing to change: pass at least one of title, tags, notebook_id, pinned, summary.');
        const n = await host.updateNote(a.note_id, patch);
        if (!n) throw notFound(a.note_id);
        return { updated: true, note: noteView(n) };
      },
    },
    {
      name: 'list_notebooks',
      description: 'List the user\'s notebooks (folders for notes) with ids, names and note counts. Nested notebooks have a parent_id.',
      parameters: S.obj({}),
      readOnly: true,
      async execute() {
        const nbs = await host.listNotebooks();
        return {
          count: nbs.length,
          notebooks: nbs.map((n) => ({ id: n.id, name: n.name, ...(n.parentId ? { parent_id: n.parentId } : {}), ...(n.noteCount != null ? { notes: n.noteCount } : {}) })),
        };
      },
    },
    {
      name: 'create_notebook',
      description: 'Create a new notebook (folder). Check list_notebooks first so you don\'t create a duplicate. Returns its id for create_note / update_note.',
      parameters: S.obj({ name: S.str('Notebook name.', { minLength: 1 }), parent_id: S.str('Optional parent notebook id, to nest it.') }, ['name']),
      async execute(a: { name: string; parent_id?: string }) {
        const nb = await host.createNotebook(a.name.trim(), a.parent_id ? { parentId: a.parent_id } : undefined);
        return { created: true, notebook: { id: nb.id, name: nb.name } };
      },
    },
    {
      name: 'trash_note',
      description:
        'Move a note to the Trash (recoverable for 30 days). Only when the user clearly asks to delete/trash/remove a specific note. The user is asked to confirm before it happens.',
      parameters: S.obj({ note_id: S.str('The note id.') }, ['note_id']),
      destructive: true,
      async execute(a: { note_id: string }) {
        const ok = await host.trashNote(a.note_id);
        if (ok === false) throw notFound(a.note_id);
        return { trashed: true, note_id: a.note_id };
      },
    },
  ];
  return tools.filter((t) => {
    if (t.name === 'get_page_image' && !host.getPageImage) return false;
    if (opts.include && !opts.include.includes(t.name as NoteToolName)) return false;
    if (opts.exclude?.includes(t.name as NoteToolName)) return false;
    return true;
  });
}

/** Read-only subset (for "ask about my notes" without write access). */
export const READ_ONLY_NOTE_TOOLS: readonly NoteToolName[] = ['list_notes', 'search_notes', 'read_note', 'get_page_image', 'list_notebooks'];

/** System prompt for the in-app notes agent. */
export function notesAgentSystemPrompt(opts: { now?: Date; appName?: string; extra?: string } = {}): string {
  const now = opts.now ?? new Date();
  const app = opts.appName ?? 'Inkstone';
  return [
    `You are the assistant inside ${app}, a handwriting note-taking app. You can search, read, create and organize the user's notes with tools.`,
    `Today is ${now.toISOString().slice(0, 10)}.`,
    '',
    'How to work:',
    '- Find before you act: use search_notes (short keyword queries) or list_notes to get note ids; never guess an id.',
    '- Read a note (read_note) before answering questions about its content. Quote or paraphrase what is actually written; say so when the notes don\'t contain the answer.',
    '- When you mention a note, use its title in square brackets, e.g. [Beta launch plan].',
    '- To save something new, create_note with a clear title and the full content as Markdown (use "- [ ] " for to-dos). To add to an existing note, append_to_note.',
    '- Only trash notes when the user explicitly asks; the app will ask them to confirm. If an action is declined, accept it and don\'t retry.',
    '- Make the changes the user asked for — no more. Briefly confirm what you did at the end.',
    '- Handwriting that has not been recognized shows up as has_handwriting without text; use get_page_image (if available) to read it.',
    '- Be concise.',
    opts.extra ?? '',
  ]
    .join('\n')
    .trim();
}
