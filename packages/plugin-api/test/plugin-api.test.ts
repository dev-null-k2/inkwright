import { describe, expect, it } from 'vitest';
import {
  METHODS,
  PERMISSIONS,
  PluginApiError,
  addedPermissions,
  compareVersions,
  createPluginClient,
  describeScope,
  envelope,
  hostAllowed,
  isProtocolMessage,
  noteInScope,
  permissionFor,
  validateManifest,
  type ClientTransport,
  type PluginManifest,
  type PluginToHost,
} from '../src/index.ts';

const base = {
  id: 'com.example.word-count',
  name: 'Word count',
  version: '1.0.0',
  author: 'Example',
  description: 'Counts words.',
  minAppVersion: '1.0.0',
  permissions: ['notes:read', 'editor:read'],
  contributes: { commands: [{ id: 'count', title: 'Count words' }], panels: [{ id: 'stats', title: 'Stats' }] },
};

describe('validateManifest', () => {
  it('accepts a minimal manifest and fills defaults', () => {
    const r = validateManifest(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.manifest.entry).toBe('main.js');
    expect(r.manifest.activation).toBe('onUse');
    expect(r.manifest.apiVersion).toBe(1);
    expect(r.manifest.contributes.commands?.[0]).toEqual({ id: 'count', title: 'Count words', context: 'app' });
    expect(r.warnings).toEqual([]);
  });

  it('reports every problem at once', () => {
    const r = validateManifest({ ...base, id: 'Bad Id', version: 'one', permissions: ['notes:read', 'root'], entry: '../evil.js', contributes: { commands: [{ id: 'x', title: '' }, { id: 'x', title: 'Dup' }] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.errors.join('\n');
    expect(all).toMatch(/"id"/);
    expect(all).toMatch(/"version"/);
    expect(all).toMatch(/Unknown permission "root"/);
    expect(all).toMatch(/"entry"/);
    expect(all).toMatch(/title is required/);
    expect(all).toMatch(/has "x" twice/);
  });

  it('requires hosts for network and ai:tools for AI tools', () => {
    const r = validateManifest({ ...base, permissions: ['network'], contributes: { aiTools: [{ name: 'lookup', description: 'Looks up', parameters: { type: 'object', properties: {} } }] } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.join('\n')).toMatch(/network.*hosts/);
    expect(r.errors.join('\n')).toMatch(/ai:tools/);
  });

  it('rejects unsupported API versions and warns about unknown fields', () => {
    expect(validateManifest({ ...base, apiVersion: 2 }).ok).toBe(false);
    const r = validateManifest({ ...base, surprise: true });
    expect(r.ok && r.warnings).toEqual(['Unknown field "surprise" is ignored.']);
  });

  it('validates settings defaults against their type', () => {
    const r = validateManifest({ ...base, contributes: { settings: [{ key: 'url', type: 'string', title: 'URL', default: 3 }] } });
    expect(r.ok).toBe(false);
  });

  it('finds permissions an update adds, including new hosts', () => {
    const a = (validateManifest({ ...base, permissions: ['network'], network: { hosts: ['https://a.example'] } }) as { manifest: PluginManifest }).manifest;
    const b = (validateManifest({ ...base, version: '1.1.0', permissions: ['network', 'notes:write'], network: { hosts: ['https://a.example', 'https://b.example'] } }) as { manifest: PluginManifest }).manifest;
    expect(addedPermissions(a, b).sort()).toEqual(['network', 'notes:write']);
    expect(addedPermissions(b, b)).toEqual([]);
  });
});

describe('compareVersions', () => {
  it('orders semantic versions including pre-releases', () => {
    const sorted = ['1.10.0', '1.2.0', '1.2.0-beta.2', '1.2.0-beta.10', '1.2.0-alpha', '0.9.9', '2.0.0'].sort(compareVersions);
    expect(sorted).toEqual(['0.9.9', '1.2.0-alpha', '1.2.0-beta.2', '1.2.0-beta.10', '1.2.0', '1.10.0', '2.0.0']);
    expect(compareVersions('1.0.0', '1.0.0+build.5')).toBe(0);
    expect(compareVersions('nope', '0.0.1')).toBeLessThan(0);
  });
});

describe('permissions', () => {
  it('describes every permission and maps every method to a known one', () => {
    for (const m of Object.keys(METHODS) as (keyof typeof METHODS)[]) {
      const p = permissionFor(m);
      if (p) expect(PERMISSIONS).toContain(p);
    }
    expect(permissionFor('notes.create')).toBe('notes:write');
    expect(permissionFor('storage.set')).toBeNull();
  });

  it('checks note scopes by tag and notebook path', () => {
    const note = { tags: ['#Work'], notebookPath: [{ id: 'nb1', name: 'Projects' }, { id: 'nb2', name: 'Alpha' }] };
    expect(noteInScope(undefined, note)).toBe(true);
    expect(noteInScope({ tags: ['work'] }, note)).toBe(true);
    expect(noteInScope({ tags: ['home'] }, note)).toBe(false);
    expect(noteInScope({ notebooks: ['projects'] }, note)).toBe(true);
    expect(noteInScope({ notebooks: ['nb2'], tags: ['work'] }, note)).toBe(true);
    expect(noteInScope({ notebooks: ['Other'] }, note)).toBe(false);
    expect(describeScope({ tags: ['work'], notebooks: ['Projects'] })).toBe('notes tagged #work in Projects');
    expect(describeScope({})).toBe('all notes');
  });

  it('allows only listed https hosts (and loopback http when named)', () => {
    expect(hostAllowed(['https://hooks.example.com'], 'https://hooks.example.com/x?y=1')).toBe(true);
    expect(hostAllowed(['https://hooks.example.com'], 'https://evil.example.com/')).toBe(false);
    expect(hostAllowed(['https://*.example.com'], 'https://a.b.example.com/')).toBe(true);
    expect(hostAllowed(['https://*.example.com'], 'https://example.com.evil.net/')).toBe(false);
    expect(hostAllowed(['*'], 'https://anything.dev/')).toBe(true);
    expect(hostAllowed(['*'], 'http://anything.dev/')).toBe(false);
    expect(hostAllowed(['*'], 'http://127.0.0.1:8080/')).toBe(false);
    expect(hostAllowed(['http://127.0.0.1:8080'], 'http://127.0.0.1:8080/hook')).toBe(true);
    expect(hostAllowed(['https://hooks.example.com'], 'https://user:pw@hooks.example.com/')).toBe(false);
    expect(hostAllowed(['https://hooks.example.com'], 'https://hooks.example.com:8443/')).toBe(false);
    expect(hostAllowed(['https://hooks.example.com'], 'javascript:alert(1)')).toBe(false);
  });
});

/** A host double: answers calls from a table and can invoke the plugin's handlers. */
function fakeHost(answer: (method: string, params: unknown[]) => unknown) {
  const toPlugin = new Set<(m: unknown) => void>();
  const sent: PluginToHost[] = [];
  const replies = new Map<number, (m: PluginToHost) => void>();
  const transport: ClientTransport = {
    send(m) {
      sent.push(m);
      if (m.kind === 'call') {
        queueMicrotask(() => {
          let msg;
          try {
            msg = envelope({ kind: 'result' as const, id: m.id, ok: true as const, value: answer(m.method, m.params) });
          } catch (e) {
            msg = envelope({ kind: 'result' as const, id: m.id, ok: false as const, error: { code: (e as PluginApiError).code ?? 'internal', message: (e as Error).message } });
          }
          for (const l of toPlugin) l(msg);
        });
      }
      if (m.kind === 'reply') replies.get(m.id)?.(m);
    },
    listen(h) {
      toPlugin.add(h);
      return () => toPlugin.delete(h);
    },
  };
  const invoke = (id: number, target: 'command' | 'aiTool' | 'importer' | 'exporter', name: string, args: unknown) =>
    new Promise<PluginToHost>((resolve) => {
      replies.set(id, resolve);
      for (const l of toPlugin) l(envelope({ kind: 'invoke' as const, id, target, name, args }));
    });
  const emit = (name: string, data: unknown) => { for (const l of toPlugin) l(envelope({ kind: 'event' as const, name, data })); };
  return { transport, sent, invoke, emit };
}

describe('createPluginClient', () => {
  it('turns API calls into protocol calls and resolves results', async () => {
    const host = fakeHost((method, params) => (method === 'notes.get' ? { id: params[0], title: 'T' } : null));
    const { api } = createPluginClient(host.transport);
    await expect(api.notes.get('n1')).resolves.toEqual({ id: 'n1', title: 'T' });
    expect(host.sent[0]).toMatchObject({ p: 'inkwright-plugin', v: 1, kind: 'call', method: 'notes.get', params: ['n1'] });
  });

  it('rejects with the host error code', async () => {
    const host = fakeHost(() => { throw new PluginApiError('permission_denied', 'No.'); });
    const { api } = createPluginClient(host.transport);
    await expect(api.notes.create({ title: 'x' })).rejects.toMatchObject({ name: 'PluginApiError', code: 'permission_denied' });
  });

  it('answers host invocations with registered handlers', async () => {
    const host = fakeHost(() => null);
    const { api } = createPluginClient(host.transport);
    api.ai.registerTool('double', (args) => (args.n as number) * 2);
    api.commands.register('boom', () => { throw new Error('kaput'); });
    await expect(host.invoke(1, 'aiTool', 'double', { n: 21 })).resolves.toMatchObject({ kind: 'reply', id: 1, ok: true, value: 42 });
    await expect(host.invoke(2, 'command', 'boom', null)).resolves.toMatchObject({ ok: false, error: { code: 'internal', message: 'kaput' } });
    await expect(host.invoke(3, 'exporter', 'missing', null)).resolves.toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('subscribes once per event and delivers events and messages', async () => {
    const host = fakeHost(() => null);
    const { api } = createPluginClient(host.transport);
    const got: unknown[] = [];
    api.events.on('note.created', (d) => got.push(d));
    const off = api.events.on('note.created', (d) => got.push(['second', d]));
    api.messages.on((d) => got.push(['msg', d]));
    expect(host.sent.filter((m) => m.kind === 'call' && m.method === 'events.subscribe')).toHaveLength(1);
    host.emit('note.created', { id: 'a', title: 'A' });
    off();
    host.emit('note.created', { id: 'b', title: 'B' });
    host.emit('message', { hello: 1 });
    expect(got).toEqual([{ id: 'a', title: 'A' }, ['second', { id: 'a', title: 'A' }], { id: 'b', title: 'B' }, ['msg', { hello: 1 }]]);
  });

  it('times out calls and fails pending calls on close', async () => {
    const silent: ClientTransport = { send() {}, listen: () => () => {} };
    const a = createPluginClient(silent, { timeoutMs: 20 });
    await expect(a.api.app.info()).rejects.toMatchObject({ code: 'timeout' });
    const b = createPluginClient(silent);
    const p = b.api.notes.list();
    b.close();
    await expect(p).rejects.toMatchObject({ code: 'unavailable' });
  });

  it('ignores messages of other protocols or versions', () => {
    expect(isProtocolMessage({ p: 'inkwright-plugin', v: 1, kind: 'event' })).toBe(true);
    expect(isProtocolMessage({ p: 'inkwright-plugin', v: 2, kind: 'event' })).toBe(false);
    expect(isProtocolMessage({ kind: 'event' })).toBe(false);
    expect(isProtocolMessage('hi')).toBe(false);
  });
});
