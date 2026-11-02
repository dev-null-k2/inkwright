/**
 * The host side of the plugin API: one function, `dispatch`, answers every method a plugin (or
 * the `window.inkwright` automation API) can call. It is the only path from plugin code to the
 * app, so this is where permissions are enforced:
 *
 * 1. the method must be in the protocol's `METHODS` table;
 * 2. the caller must hold the permission that table names — checked on every call, so a
 *    permission revoked in Settings stops working immediately;
 * 3. notes outside the caller's note scope (and locked notes) do not exist for it;
 * 4. network requests go only to the hosts its manifest lists, and are made by the host.
 *
 * Everything the app itself does is behind the `HostEnv` and `NotesBackend` interfaces, so this
 * file is plain logic with unit tests (dispatcher.test.ts).
 */
import {
  PluginApiError,
  hostAllowed,
  isMethod,
  noteInScope,
  permissionFor,
  type AppInfo,
  type EditorState,
  type FetchInit,
  type FetchResult,
  type NoteContent,
  type NoteScope,
  type NoteSummary,
  type Permission,
  type SearchHit,
} from '@inkwright/plugin-api';

/** A note as the backend sees it, with what scope checks need. */
export interface BackendNote extends NoteSummary {
  notebookPath: { id: string; name: string }[];
  locked: boolean;
}

/** Notes, as the app (or a test) provides them. */
export interface NotesBackend {
  list(): Promise<BackendNote[]>;
  get(id: string): Promise<(BackendNote & { markdown: string }) | null>;
  search(query: string, limit: number): Promise<{ id: string; page: number; snippet: string }[]>;
  create(note: { title: string; text: string; tags: string[] }, by: string): Promise<string>;
  append(id: string, text: string, by: string): Promise<void>;
  update(id: string, patch: { title?: string; tags?: string[] }, by: string): Promise<void>;
}

export interface HostEnv {
  notes: NotesBackend;
  editor: {
    state(): EditorState | null;
    selection(): string;
    insertText(text: string, label: string): void;
  };
  toast(text: string, tone: 'info' | 'success' | 'error'): void;
  openNote(id: string, page?: number): void;
  clipboard(text: string): Promise<void>;
  fetch: typeof globalThis.fetch;
  appVersion: string;
  platform: AppInfo['platform'];
}

/** Who is calling. Plugins get one per plugin; the automation API has its own. */
export interface Caller {
  id: string;
  /** "Word count (plugin)" — shown in Activity next to its changes and in toasts. */
  label: string;
  /** Read on every call, so revocation is immediate. */
  permissions(): ReadonlySet<Permission>;
  noteScope?: NoteScope;
  networkHosts?: string[];
  storage: {
    get(key: string): Promise<unknown>;
    set(key: string, value: unknown): Promise<void>;
    delete(key: string): Promise<void>;
    keys(): Promise<string[]>;
  };
  settings(): Promise<Record<string, string | number | boolean>>;
  subscribe(event: string): void;
  postMessage(data: unknown): void;
  setHeight?(px: number): void;
  /** Automation API only: adds a command to the search palette. */
  addCommand?(id: string, title: string): void;
}

const EVENTS = new Set(['note.created', 'note.updated', 'note.opened', 'note.trashed', 'selection.changed']);
const MAX_TEXT = 200_000;
const MAX_FETCH_BODY = 5 * 1024 * 1024;
const MAX_STORAGE_VALUE = 1024 * 1024;

const bad = (msg: string) => new PluginApiError('invalid_argument', msg);

function str(v: unknown, what: string, max = MAX_TEXT): string {
  if (typeof v !== 'string') throw bad(`${what} must be text.`);
  if (v.length > max) throw bad(`${what} is too long (at most ${max} characters).`);
  return v;
}

function tags(v: unknown): string[] {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((t) => typeof t === 'string' && t.trim() && t.length <= 100) || v.length > 50) throw bad('tags must be a list of up to 50 short names.');
  return [...new Set(v.map((t: string) => t.trim().replace(/^#/, '')))];
}

const strip = ({ notebookPath: _p, locked: _l, ...n }: BackendNote): NoteSummary => n;

/** Visible = not locked and inside the caller's scope. Others answer "not found". */
async function visible(env: HostEnv, caller: Caller, id: unknown): Promise<BackendNote & { markdown: string }> {
  const n = await env.notes.get(str(id, 'id', 64));
  if (!n || n.locked || !noteInScope(caller.noteScope, n)) throw new PluginApiError('not_found', `There is no note ${String(id)}${caller.noteScope ? ' that this plugin may see' : ''}.`);
  return n;
}

/**
 * The editor's state if the open note is one the caller may see, else null — so a note outside
 * a plugin's scope (or a locked note, shown decrypted while open) looks exactly like "no note is
 * open" to the editor methods. A note the backend doesn't know yet (made a moment ago) is only
 * visible to callers without a scope, since nothing can be said about its tags or notebook.
 */
async function visibleEditor(env: HostEnv, caller: Caller): Promise<EditorState | null> {
  const s = env.editor.state();
  if (!s) return null;
  const n = await env.notes.get(s.noteId);
  if (!n) return caller.noteScope ? null : s;
  return n.locked || !noteInScope(caller.noteScope, n) ? null : s;
}

/**
 * Runs one API call for `caller`. Throws `PluginApiError` (with a stable code) for refusals and
 * bad input; anything else thrown is reported as `internal`.
 */
export async function dispatch(env: HostEnv, caller: Caller, method: unknown, params: unknown[]): Promise<unknown> {
  if (!isMethod(method)) throw new PluginApiError('not_found', `Unknown API method ${JSON.stringify(method)}.`);
  const need = permissionFor(method);
  if (need && !caller.permissions().has(need)) throw new PluginApiError('permission_denied', `${caller.label} does not have the “${need}” permission${caller.id === 'automation' ? ' (Settings › Developer › Automation API)' : ' (Settings › Plugins)'}.`);
  const p = Array.isArray(params) ? params : [];

  switch (method) {
    case 'app.info':
      return { version: env.appVersion, apiVersion: 1, platform: env.platform, permissions: [...caller.permissions()] } satisfies AppInfo;

    case 'notes.list': {
      const o = (p[0] ?? {}) as { tag?: unknown; notebook?: unknown; limit?: unknown };
      const limit = Math.min(500, Math.max(1, Number(o.limit ?? 50) || 50));
      let list = (await env.notes.list()).filter((n) => !n.locked && noteInScope(caller.noteScope, n));
      if (o.tag !== undefined) {
        const want = str(o.tag, 'tag', 100).replace(/^#/, '').toLowerCase();
        list = list.filter((n) => n.tags.some((t) => t.replace(/^#/, '').toLowerCase() === want));
      }
      if (o.notebook !== undefined) {
        const want = str(o.notebook, 'notebook', 200).toLowerCase();
        list = list.filter((n) => n.notebookPath.some((nb) => nb.id.toLowerCase() === want || nb.name.toLowerCase() === want));
      }
      return list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, limit).map(strip);
    }
    case 'notes.search': {
      const q = str(p[0], 'query', 500);
      const limit = Math.min(100, Math.max(1, Number((p[1] as { limit?: unknown } | undefined)?.limit ?? 10) || 10));
      const notes = new Map((await env.notes.list()).map((n) => [n.id, n]));
      const out: SearchHit[] = [];
      for (const h of await env.notes.search(q, limit * 3)) {
        const n = notes.get(h.id);
        if (!n || n.locked || !noteInScope(caller.noteScope, n)) continue;
        out.push({ id: h.id, title: n.title, page: h.page, snippet: h.snippet });
        if (out.length >= limit) break;
      }
      return out;
    }
    case 'notes.get': {
      const n = await visible(env, caller, p[0]);
      const { notebookPath: _p, locked: _l, ...rest } = n;
      return rest satisfies NoteContent;
    }
    case 'notes.create': {
      const o = (p[0] ?? {}) as { title?: unknown; text?: unknown; tags?: unknown };
      const title = str(o.title, 'title', 300).trim();
      if (!title) throw bad('title is required.');
      const t = tags(o.tags);
      // A scoped plugin may only create notes it can see afterwards.
      if (caller.noteScope?.tags?.length && !t.some((x) => caller.noteScope!.tags!.some((s) => s.replace(/^#/, '').toLowerCase() === x.toLowerCase()))) {
        t.push(caller.noteScope.tags[0]!.replace(/^#/, ''));
      }
      if (caller.noteScope?.notebooks?.length) throw new PluginApiError('out_of_scope', 'This plugin may only work inside some notebooks and cannot create notes elsewhere.');
      const id = await env.notes.create({ title, text: o.text === undefined ? '' : str(o.text, 'text'), tags: t }, caller.label);
      return strip((await env.notes.get(id))!);
    }
    case 'notes.append': {
      const n = await visible(env, caller, p[0]);
      const text = str(p[1], 'text');
      if (!text.trim()) throw bad('text is empty.');
      await env.notes.append(n.id, text, caller.label);
      return strip((await env.notes.get(n.id))!);
    }
    case 'notes.update': {
      const n = await visible(env, caller, p[0]);
      const patch = (p[1] ?? {}) as { title?: unknown; tags?: unknown };
      const out: { title?: string; tags?: string[] } = {};
      if (patch.title !== undefined) out.title = str(patch.title, 'title', 300).trim();
      if (patch.tags !== undefined) out.tags = tags(patch.tags);
      if (out.title === '' ) throw bad('title cannot be empty.');
      if (!Object.keys(out).length) throw bad('Pass title or tags to change.');
      const after = { ...n, tags: out.tags ?? n.tags };
      if (!noteInScope(caller.noteScope, after)) throw new PluginApiError('out_of_scope', 'That change would move the note outside what this plugin may see.');
      await env.notes.update(n.id, out, caller.label);
      return strip((await env.notes.get(n.id))!);
    }

    case 'editor.current':
      return visibleEditor(env, caller);
    case 'editor.selection':
      return (await visibleEditor(env, caller)) ? env.editor.selection() : '';
    case 'editor.insertText': {
      const text = str(p[0], 'text');
      if (!(await visibleEditor(env, caller))) throw new PluginApiError('unavailable', 'No note is open.');
      env.editor.insertText(text, caller.label);
      return null;
    }

    case 'events.subscribe': {
      const e = str(p[0], 'event', 40);
      if (!EVENTS.has(e)) throw bad(`Unknown event ${e}. Known: ${[...EVENTS].join(', ')}.`);
      caller.subscribe(e);
      return null;
    }

    case 'storage.get':
      return caller.storage.get(str(p[0], 'key', 200));
    case 'storage.set': {
      const key = str(p[0], 'key', 200);
      const json = JSON.stringify(p[1] ?? null);
      if (json.length > MAX_STORAGE_VALUE) throw bad('Stored values may be at most 1 MB of JSON.');
      await caller.storage.set(key, JSON.parse(json));
      return null;
    }
    case 'storage.delete':
      await caller.storage.delete(str(p[0], 'key', 200));
      return null;
    case 'storage.keys':
      return caller.storage.keys();
    case 'settings.get':
      return caller.settings();

    case 'net.fetch':
      return netFetch(env, caller, str(p[0], 'url', 4000), (p[1] ?? {}) as FetchInit);

    case 'ui.toast':
      env.toast(`${str(p[0], 'text', 300)}`, p[1] === 'error' || p[1] === 'success' ? p[1] : 'info');
      return null;
    case 'ui.openNote': {
      const n = await visible(env, caller, p[0]);
      env.openNote(n.id, typeof p[1] === 'number' ? p[1] : undefined);
      return null;
    }
    case 'ui.setHeight':
      caller.setHeight?.(Math.max(40, Math.min(4000, Number(p[0]) || 0)));
      return null;
    case 'clipboard.writeText':
      await env.clipboard(str(p[0], 'text'));
      return null;
    case 'messages.post':
      caller.postMessage(p[0] ?? null);
      return null;
    case 'commands.add':
      if (!caller.addCommand) throw new PluginApiError('unavailable', 'Plugins declare their commands in manifest.json (contributes.commands).');
      caller.addCommand(str(p[0], 'id', 64), str(p[1], 'title', 80));
      return null;
  }
}

async function netFetch(env: HostEnv, caller: Caller, url: string, init: FetchInit): Promise<FetchResult> {
  if (!hostAllowed(caller.networkHosts, url)) throw new PluginApiError('permission_denied', `${caller.label} may not connect to ${safeOrigin(url)}; its manifest allows ${caller.networkHosts?.join(', ') || 'no sites'}.`);
  const method = init.method ?? 'GET';
  if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) throw bad(`Method ${method} is not allowed.`);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(init.headers ?? {})) {
    // Credentials and hop-by-hop headers stay under the browser's control.
    if (/^(cookie|host|origin|referer|proxy-|sec-)/i.test(k)) continue;
    headers[k] = String(v);
  }
  if (init.body !== undefined && init.body.length > MAX_FETCH_BODY) throw bad('Request bodies may be at most 5 MB.');
  let res: Response;
  try {
    res = await env.fetch(url, { method, headers, body: init.body, credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  } catch (e) {
    throw new PluginApiError('unavailable', `Could not reach ${safeOrigin(url)}: ${(e as Error).message}`);
  }
  const text = await res.text();
  const out: Record<string, string> = {};
  res.headers.forEach((v, k) => { out[k] = v; });
  return { status: res.status, ok: res.ok, headers: out, body: text.length > MAX_FETCH_BODY ? text.slice(0, MAX_FETCH_BODY) : text };
}

function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return 'that address';
  }
}
