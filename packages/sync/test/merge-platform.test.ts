import { describe, expect, it } from 'vitest';
import { encodeApiKeys, encodePluginsConfig, decodeApiKeys, decodePluginsConfig, type ApiKeyRecord, type InstalledPlugin } from '@inkwright/core';
import { mergeApiKeys, mergeFileBytes, mergeKindOf, mergePluginsConfig, utf8Decode, utf8Encode } from '../src/index.ts';

const plugin = (id: string, p: Partial<InstalledPlugin> = {}): InstalledPlugin => ({ id, version: '1.0.0', enabled: true, granted: [], source: { kind: 'catalog', catalogId: id }, installedAt: 1, updatedAt: 1, ...p });
const key = (id: string, p: Partial<ApiKeyRecord> = {}): ApiKeyRecord => ({ id, name: id, prefix: `ink_${id}`, hash: 'a'.repeat(64), scopes: ['notes:read'], createdAt: 1, updatedAt: 1, ...p });
const cfg = (...plugins: InstalledPlugin[]) => ({ formatVersion: 1 as const, plugins });
const keys = (...k: ApiKeyRecord[]) => ({ formatVersion: 1 as const, keys: k });

describe('plugins.json merge', () => {
  it('keeps plugins installed on either device and the newer change to the same plugin', () => {
    const base = cfg(plugin('a'));
    const local = cfg(plugin('a', { enabled: false, updatedAt: 5 }), plugin('b'));
    const remote = cfg(plugin('a', { version: '1.1.0', updatedAt: 9 }), plugin('c'));
    const m = mergePluginsConfig(base, local, remote);
    expect(m.plugins.map((p) => p.id)).toEqual(['a', 'b', 'c']);
    expect(m.plugins[0]).toMatchObject({ version: '1.1.0', enabled: true });
  });

  it('keeps an uninstall unless the other device changed the plugin meanwhile', () => {
    const base = cfg(plugin('a'), plugin('b'));
    const local = cfg(plugin('b', { enabled: false, updatedAt: 3 })); // uninstalled a, changed b
    const remote = cfg(plugin('a'));                                    // uninstalled b, a untouched
    expect(mergePluginsConfig(base, local, remote).plugins.map((p) => p.id)).toEqual(['b']);
  });

  it('is wired into mergeFileBytes', () => {
    expect(mergeKindOf('plugins/plugins.json')).toBe('plugins');
    const out = mergeFileBytes('plugins/plugins.json', null, utf8Encode(encodePluginsConfig(cfg(plugin('a')))), utf8Encode(encodePluginsConfig(cfg(plugin('b')))));
    expect(decodePluginsConfig(utf8Decode(out!)).plugins.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('api/keys.json merge', () => {
  it('never drops a key and revocation always wins', () => {
    const base = keys(key('k1'), key('k2'));
    const local = keys(key('k1', { revokedAt: 7, updatedAt: 7 }), key('k2'));
    const remote = keys(key('k1', { name: 'renamed', updatedAt: 9 }), key('k3'));
    const m = mergeApiKeys(base, local, remote);
    expect(m.keys.map((k) => k.id)).toEqual(['k1', 'k2', 'k3']);
    expect(m.keys[0]).toMatchObject({ name: 'renamed', revokedAt: 7 });
  });

  it('is wired into mergeFileBytes', () => {
    expect(mergeKindOf('api/keys.json')).toBe('api-keys');
    const out = mergeFileBytes('api/keys.json', null, utf8Encode(encodeApiKeys(keys(key('a')))), utf8Encode(encodeApiKeys(keys(key('b', { revokedAt: 2 })))));
    expect(decodeApiKeys(utf8Decode(out!)).keys.map((k) => [k.id, k.revokedAt ?? null])).toEqual([['a', null], ['b', 2]]);
  });
});
