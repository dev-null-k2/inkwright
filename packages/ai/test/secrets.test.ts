import { IDBFactory } from 'fake-indexeddb';
import { describe, expect, it } from 'vitest';
import { IndexedDBSecretBackend, MemorySecretBackend, MemorySecretStore, WebCryptoSecretStore, apiKeySecretName } from '../src/index.ts';

const SECRET = 'sk-ant-api03-very-secret-key-💡';

describe('WebCryptoSecretStore (memory backend)', () => {
  it('round-trips secrets', async () => {
    const store = new WebCryptoSecretStore({ backend: new MemorySecretBackend() });
    expect(await store.get('missing')).toBeNull();
    await store.set(apiKeySecretName('anthropic'), SECRET);
    await store.set(apiKeySecretName('openai'), 'sk-openai');
    expect(await store.get('ai.apiKey.anthropic')).toBe(SECRET);
    expect(await store.list()).toEqual(['ai.apiKey.anthropic', 'ai.apiKey.openai']);
    await store.set('ai.apiKey.openai', 'sk-rotated');
    expect(await store.get('ai.apiKey.openai')).toBe('sk-rotated');
    await store.delete('ai.apiKey.openai');
    expect(await store.get('ai.apiKey.openai')).toBeNull();
  });

  it('stores only ciphertext under a non-extractable AES-GCM key', async () => {
    const backend = new MemorySecretBackend();
    const store = new WebCryptoSecretStore({ backend });
    await store.set('k', SECRET);
    const rec = backend.records.get('k')!;
    expect(rec.v).toBe(1);
    expect(rec.iv).toHaveLength(12);
    const stored = new TextDecoder().decode(rec.data);
    expect(stored).not.toContain('secret');
    expect(rec.data.length).toBe(new TextEncoder().encode(SECRET).length + 16); // GCM tag
    expect(backend.key!.extractable).toBe(false);
    expect(backend.key!.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 });
    await expect(crypto.subtle.exportKey('raw', backend.key!)).rejects.toThrow();
  });

  it('uses a fresh IV per write', async () => {
    const backend = new MemorySecretBackend();
    const store = new WebCryptoSecretStore({ backend });
    await store.set('a', SECRET);
    const iv1 = backend.records.get('a')!.iv;
    await store.set('a', SECRET);
    expect(Buffer.from(backend.records.get('a')!.iv).equals(Buffer.from(iv1))).toBe(false);
  });

  it('binds ciphertext to its name and detects tampering', async () => {
    const backend = new MemorySecretBackend();
    const store = new WebCryptoSecretStore({ backend });
    await store.set('a', 'alpha');
    backend.records.set('b', backend.records.get('a')!);
    expect(await store.get('b')).toBeNull();
    const rec = backend.records.get('a')!;
    const data = rec.data.slice();
    data[0]! ^= 1;
    backend.records.set('a', { ...rec, data });
    expect(await store.get('a')).toBeNull();
  });

  it('shares one key across store instances and concurrent first use', async () => {
    const backend = new MemorySecretBackend();
    const s1 = new WebCryptoSecretStore({ backend });
    const s2 = new WebCryptoSecretStore({ backend });
    await Promise.all([s1.set('x', '1'), s2.set('y', '2')]);
    expect(await s1.get('y')).toBe('2');
    expect(await s2.get('x')).toBe('1');
  });

  it('returns null when the device key was lost', async () => {
    const backend = new MemorySecretBackend();
    await new WebCryptoSecretStore({ backend }).set('x', '1');
    backend.key = null;
    expect(await new WebCryptoSecretStore({ backend }).get('x')).toBeNull();
  });
});

describe('WebCryptoSecretStore (IndexedDB backend)', () => {
  it('persists the CryptoKey and ciphertexts in IndexedDB', async () => {
    const indexedDB = new IDBFactory();
    const b1 = new IndexedDBSecretBackend({ indexedDB, dbName: 'test-secrets' });
    await new WebCryptoSecretStore({ backend: b1 }).set('ai.apiKey.gemini', SECRET);
    b1.close();

    // A new "page load": fresh backend + store over the same database.
    const b2 = new IndexedDBSecretBackend({ indexedDB, dbName: 'test-secrets' });
    const store = new WebCryptoSecretStore({ backend: b2 });
    expect(await store.get('ai.apiKey.gemini')).toBe(SECRET);
    expect(await store.list()).toEqual(['ai.apiKey.gemini']);
    const key = await b2.getKey();
    expect(key!.extractable).toBe(false);
    expect((await b2.putKeyIfAbsent(await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])))).toEqual(key);
    await store.delete('ai.apiKey.gemini');
    expect(await store.get('ai.apiKey.gemini')).toBeNull();
    b2.close();
  });

  it('throws a clear error without IndexedDB', () => {
    expect(() => new IndexedDBSecretBackend({ indexedDB: undefined })).toThrow(/IndexedDB is not available/);
  });
});

describe('MemorySecretStore', () => {
  it('works', async () => {
    const s = new MemorySecretStore();
    await s.set('a', '1');
    expect(await s.get('a')).toBe('1');
    expect(await s.list()).toEqual(['a']);
    await s.delete('a');
    expect(await s.get('a')).toBeNull();
  });
});
