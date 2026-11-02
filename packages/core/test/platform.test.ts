import { describe, expect, it } from 'vitest';
import { createApiKey, decodeApiKeys, decodePluginsConfig, encodeApiKeys, emptyApiKeys, hashApiKey, looksLikeApiKey, revokeApiKey, verifyApiKey } from '../src/index.ts';

let n = 0;
const random = (len: number) => Uint8Array.from({ length: len }, () => (n = (n * 1103515245 + 12345) & 0xff));

describe('API keys', () => {
  it('creates keys that verify, and stores only their hash', () => {
    const { key, record } = createApiKey({ name: 'Shortcuts', scopes: ['notes:read', 'notes:read'], now: 1000, random });
    expect(looksLikeApiKey(key)).toBe(true);
    expect(key.startsWith(`${record.prefix}_`)).toBe(true);
    expect(record.hash).toBe(hashApiKey(key));
    expect(record.scopes).toEqual(['notes:read']);
    const file = decodeApiKeys(encodeApiKeys({ ...emptyApiKeys(), keys: [record] }));
    expect(JSON.stringify(file)).not.toContain(key.slice(15));
    expect(verifyApiKey(file, key, 2000)).toMatchObject({ ok: true, record: { id: record.id } });
  });

  it('refuses malformed, unknown, revoked and expired keys', () => {
    const a = createApiKey({ name: 'A', scopes: ['notes:read'], now: 0, random, expiresAt: 5000 });
    const b = createApiKey({ name: 'B', scopes: ['admin'], now: 0, random });
    let file = { ...emptyApiKeys(), keys: [a.record, b.record] };
    expect(verifyApiKey(file, 'nope', 1)).toEqual({ ok: false, reason: 'malformed' });
    const forged = `${b.record.prefix}_${'A'.repeat(43)}`;
    expect(verifyApiKey(file, forged, 1)).toEqual({ ok: false, reason: 'unknown' });
    expect(verifyApiKey(file, a.key, 5000)).toEqual({ ok: false, reason: 'expired' });
    file = revokeApiKey(file, b.record.id, 10);
    expect(verifyApiKey(file, b.key, 11)).toEqual({ ok: false, reason: 'revoked' });
  });

  it('drops records that are not hashed keys and unknown scopes when decoding', () => {
    const f = decodeApiKeys(JSON.stringify({ keys: [{ id: 'x', hash: 'plaintext' }, { id: 'y', hash: 'a'.repeat(64), scopes: ['notes:read', 'root'], createdAt: 3 }] }));
    expect(f.keys.map((k) => k.id)).toEqual(['y']);
    expect(f.keys[0]!.scopes).toEqual(['notes:read']);
    expect(f.keys[0]!.updatedAt).toBe(3);
  });
});

describe('plugins.json', () => {
  it('decodes with defaults and ignores junk', () => {
    const c = decodePluginsConfig(JSON.stringify({ plugins: [{ id: 'a.b', version: '1.0.0', granted: ['notes:read', 3] }, { nope: true }] }));
    expect(c.plugins).toEqual([{ id: 'a.b', version: '1.0.0', enabled: true, granted: ['notes:read'], source: { kind: 'folder', name: 'a.b' }, installedAt: 0, updatedAt: 0 }]);
  });
});
