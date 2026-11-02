import { describe, expect, it, vi } from 'vitest';
import type { Permission } from '@inkwright/plugin-api';
import { dispatch, type BackendNote, type Caller, type HostEnv } from './dispatcher.ts';

function note(id: string, p: Partial<BackendNote> & { markdown?: string } = {}): BackendNote & { markdown: string } {
  return { id, title: id, tags: [], notebook: null, notebookPath: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', pages: 1, locked: false, markdown: `# ${id}`, ...p };
}

function env(notes: (BackendNote & { markdown: string })[] = []) {
  const store = new Map(notes.map((n) => [n.id, n]));
  const calls: string[] = [];
  const e: HostEnv = {
    notes: {
      list: async () => [...store.values()],
      get: async (id) => store.get(id) ?? null,
      search: async () => [...store.values()].map((n) => ({ id: n.id, page: 1, snippet: n.markdown })),
      create: async (n, by) => { const id = `N${store.size}`; store.set(id, note(id, { title: n.title, tags: n.tags, markdown: n.text })); calls.push(`create by ${by}`); return id; },
      append: async (id, text) => { store.get(id)!.markdown += `\n${text}`; },
      update: async (id, patch) => { Object.assign(store.get(id)!, patch); },
    },
    editor: { state: () => ({ noteId: 'A', title: 'A', page: 1, pages: 1 }), selection: () => 'selected words', insertText: vi.fn() },
    toast: vi.fn(),
    openNote: vi.fn(),
    clipboard: vi.fn(async () => {}),
    fetch: vi.fn(async () => new Response('pong', { status: 200, headers: { 'x-a': 'b' } })) as unknown as typeof fetch,
    appVersion: '1.0.0',
    platform: 'web',
  };
  return { e, calls, store };
}

function caller(perms: Permission[], p: Partial<Caller> = {}): Caller & { granted: Set<Permission> } {
  const granted = new Set(perms);
  const data = new Map<string, unknown>();
  return {
    id: 'test.plugin',
    label: 'Test (plugin)',
    granted,
    permissions: () => granted,
    storage: { get: async (k) => data.get(k), set: async (k, v) => void data.set(k, v), delete: async (k) => void data.delete(k), keys: async () => [...data.keys()] },
    settings: async () => ({ a: 1 }),
    subscribe: vi.fn(),
    postMessage: vi.fn(),
    ...p,
  };
}

describe('plugin API dispatcher', () => {
  it('refuses methods without the permission, and revocation applies to the next call', async () => {
    const { e } = env([note('A')]);
    const c = caller(['notes:read']);
    await expect(dispatch(e, c, 'notes.create', [{ title: 'x' }])).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(dispatch(e, c, 'notes.get', ['A'])).resolves.toMatchObject({ id: 'A', markdown: '# A' });
    c.granted.delete('notes:read');
    await expect(dispatch(e, c, 'notes.get', ['A'])).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(dispatch(e, c, 'notes.nuke', [])).rejects.toMatchObject({ code: 'not_found' });
  });

  it('hides locked notes and notes outside the scope', async () => {
    const { e } = env([note('W', { tags: ['work'] }), note('H', { tags: ['home'] }), note('L', { tags: ['work'], locked: true })]);
    const c = caller(['notes:read', 'notes:write'], { noteScope: { tags: ['work'] } });
    expect((await dispatch(e, c, 'notes.list', [{}]) as { id: string }[]).map((n) => n.id)).toEqual(['W']);
    expect((await dispatch(e, c, 'notes.search', ['x']) as { id: string }[]).map((n) => n.id)).toEqual(['W']);
    await expect(dispatch(e, c, 'notes.get', ['H'])).rejects.toMatchObject({ code: 'not_found' });
    await expect(dispatch(e, c, 'notes.get', ['L'])).rejects.toMatchObject({ code: 'not_found' });
    await expect(dispatch(e, c, 'notes.update', ['W', { tags: ['home'] }])).rejects.toMatchObject({ code: 'out_of_scope' });
    // A scoped plugin's new notes carry its scope tag, so it can still see them.
    expect(await dispatch(e, c, 'notes.create', [{ title: 'New', tags: ['x'] }])).toMatchObject({ tags: ['x', 'work'] });
  });

  // Security review SR-04: the editor methods used to answer for whatever note was open, so a
  // plugin scoped to #work (or any plugin, for a locked note) could read the title and selection
  // of notes it may not see, write into them, and open them.
  it('treats an open note outside the scope, or locked, as no open note', async () => {
    const { e } = env([note('W', { tags: ['work'] }), note('H', { tags: ['home'] }), note('L', { locked: true })]);
    const scoped = caller(['editor:read', 'editor:write'], { noteScope: { tags: ['work'] } });
    e.editor.state = () => ({ noteId: 'H', title: 'Home secrets', page: 1, pages: 1 });
    expect(await dispatch(e, scoped, 'editor.current', [])).toBeNull();
    expect(await dispatch(e, scoped, 'editor.selection', [])).toBe('');
    await expect(dispatch(e, scoped, 'editor.insertText', ['x'])).rejects.toMatchObject({ code: 'unavailable' });
    expect(e.editor.insertText).not.toHaveBeenCalled();
    await expect(dispatch(e, scoped, 'ui.openNote', ['H'])).rejects.toMatchObject({ code: 'not_found' });
    expect(e.openNote).not.toHaveBeenCalled();

    e.editor.state = () => ({ noteId: 'W', title: 'W', page: 1, pages: 1 });
    expect(await dispatch(e, scoped, 'editor.current', [])).toMatchObject({ noteId: 'W' });
    expect(await dispatch(e, scoped, 'editor.selection', [])).toBe('selected words');

    // A locked note is hidden from every plugin, scoped or not.
    const open = caller(['editor:read', 'editor:write']);
    e.editor.state = () => ({ noteId: 'L', title: 'Locked', page: 1, pages: 1 });
    expect(await dispatch(e, open, 'editor.current', [])).toBeNull();
    expect(await dispatch(e, open, 'editor.selection', [])).toBe('');
    await expect(dispatch(e, open, 'editor.insertText', ['x'])).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('labels writes with the caller and validates input', async () => {
    const { e, calls } = env();
    const c = caller(['notes:write', 'notes:read']);
    await dispatch(e, c, 'notes.create', [{ title: 'T', text: 'body' }]);
    expect(calls).toEqual(['create by Test (plugin)']);
    await expect(dispatch(e, c, 'notes.create', [{ title: '' }])).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(dispatch(e, c, 'notes.create', [{ title: 'x', tags: 'nope' }])).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(dispatch(e, c, 'notes.append', ['N0', '   '])).rejects.toMatchObject({ code: 'invalid_argument' });
  });

  it('fetches only allowed hosts, without credentials', async () => {
    const { e } = env();
    const c = caller(['network'], { networkHosts: ['https://hooks.example.com'] });
    const r = await dispatch(e, c, 'net.fetch', ['https://hooks.example.com/x', { method: 'POST', headers: { cookie: 'x', 'content-type': 'application/json' }, body: '{}' }]);
    expect(r).toMatchObject({ status: 200, ok: true, body: 'pong', headers: { 'x-a': 'b' } });
    const init = (e.fetch as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    expect(init).toMatchObject({ credentials: 'omit', headers: { 'content-type': 'application/json' } });
    expect(init.headers).not.toHaveProperty('cookie');
    await expect(dispatch(e, c, 'net.fetch', ['https://evil.example.com/'])).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(dispatch(e, caller([], { networkHosts: ['*'] }), 'net.fetch', ['https://a.example/'])).rejects.toMatchObject({ code: 'permission_denied' });
  });

  it('gives storage, settings and editor access according to permissions', async () => {
    const { e } = env();
    const c = caller(['editor:read', 'editor:write', 'events']);
    await dispatch(e, c, 'storage.set', ['k', { n: 1 }]);
    expect(await dispatch(e, c, 'storage.get', ['k'])).toEqual({ n: 1 });
    expect(await dispatch(e, c, 'storage.keys', [])).toEqual(['k']);
    await expect(dispatch(e, c, 'storage.set', ['big', 'x'.repeat(1_100_000)])).rejects.toMatchObject({ code: 'invalid_argument' });
    expect(await dispatch(e, c, 'settings.get', [])).toEqual({ a: 1 });
    expect(await dispatch(e, c, 'editor.selection', [])).toBe('selected words');
    await dispatch(e, c, 'editor.insertText', ['hello']);
    expect(e.editor.insertText).toHaveBeenCalledWith('hello', 'Test (plugin)');
    await dispatch(e, c, 'events.subscribe', ['note.updated']);
    expect(c.subscribe).toHaveBeenCalledWith('note.updated');
    await expect(dispatch(e, c, 'events.subscribe', ['keystrokes'])).rejects.toMatchObject({ code: 'invalid_argument' });
    await expect(dispatch(e, c, 'clipboard.writeText', ['x'])).rejects.toMatchObject({ code: 'permission_denied' });
    expect(await dispatch(e, c, 'app.info', [])).toMatchObject({ apiVersion: 1, permissions: ['editor:read', 'editor:write', 'events'] });
    await expect(dispatch(e, c, 'commands.add', ['x', 'X'])).rejects.toMatchObject({ code: 'unavailable' });
  });
});
