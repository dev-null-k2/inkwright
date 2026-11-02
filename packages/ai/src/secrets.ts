/**
 * API-key storage. Keys never leave the device: `WebCryptoSecretStore` encrypts each secret with
 * AES-GCM under a non-extractable key that lives in IndexedDB, so page scripts (and anything that
 * reads the vault or settings) can only use it to encrypt and decrypt in this origin, never read
 * it out. It is not protection against a copy of the browser profile: IndexedDB stores the key's
 * bytes on disk next to the ciphertexts, so whoever copies both files has the secrets. That is why
 * the Android app allows no cloud backup (security review SR-03) and why the threat model treats
 * a copied profile as a compromised device. Native apps can implement SecretStore over the
 * platform keychain instead.
 */
export interface SecretStore {
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  delete(name: string): Promise<void>;
  /** Names of stored secrets (never the values). */
  list?(): Promise<string[]>;
}

/** Plain in-memory store (tests, ephemeral sessions). */
export class MemorySecretStore implements SecretStore {
  private m = new Map<string, string>();
  async get(name: string) {
    return this.m.get(name) ?? null;
  }
  async set(name: string, value: string) {
    this.m.set(name, value);
  }
  async delete(name: string) {
    this.m.delete(name);
  }
  async list() {
    return [...this.m.keys()].sort();
  }
}

export interface EncryptedSecret {
  v: 1;
  iv: Uint8Array;
  data: Uint8Array;
}

/** Where WebCryptoSecretStore keeps its key and ciphertexts. Values must survive structured clone. */
export interface SecretBackend {
  getKey(): Promise<CryptoKey | null>;
  /** Stores `key` unless a key already exists (atomically); returns the key now stored. */
  putKeyIfAbsent(key: CryptoKey): Promise<CryptoKey>;
  get(name: string): Promise<EncryptedSecret | null>;
  put(name: string, rec: EncryptedSecret): Promise<void>;
  delete(name: string): Promise<void>;
  list(): Promise<string[]>;
}

export class MemorySecretBackend implements SecretBackend {
  key: CryptoKey | null = null;
  readonly records = new Map<string, EncryptedSecret>();
  async getKey() {
    return this.key;
  }
  async putKeyIfAbsent(key: CryptoKey) {
    if (!this.key) this.key = key;
    return this.key;
  }
  async get(name: string) {
    return this.records.get(name) ?? null;
  }
  async put(name: string, rec: EncryptedSecret) {
    this.records.set(name, rec);
  }
  async delete(name: string) {
    this.records.delete(name);
  }
  async list() {
    return [...this.records.keys()].sort();
  }
}

const KEY_ID = 'master';

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

/** IndexedDB backend: object stores `keys` (the CryptoKey) and `secrets` (ciphertexts). */
export class IndexedDBSecretBackend implements SecretBackend {
  private db: Promise<IDBDatabase> | null = null;
  private factory: IDBFactory;
  private name: string;

  constructor(opts: { dbName?: string; indexedDB?: IDBFactory } = {}) {
    const f = opts.indexedDB ?? (globalThis as { indexedDB?: IDBFactory }).indexedDB;
    if (!f) throw new Error('IndexedDB is not available; pass a SecretBackend.');
    this.factory = f;
    this.name = opts.dbName ?? 'inkwright-secrets';
  }

  private open(): Promise<IDBDatabase> {
    if (!this.db) {
      this.db = new Promise((resolve, reject) => {
        const r = this.factory.open(this.name, 1);
        r.onupgradeneeded = () => {
          const db = r.result;
          if (!db.objectStoreNames.contains('keys')) db.createObjectStore('keys');
          if (!db.objectStoreNames.contains('secrets')) db.createObjectStore('secrets');
        };
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
        r.onblocked = () => reject(new Error('Secret storage is blocked by another open tab.'));
      });
      this.db.catch(() => (this.db = null));
    }
    return this.db;
  }

  private async tx<T>(store: 'keys' | 'secrets', mode: IDBTransactionMode, fn: (s: IDBObjectStore) => Promise<T>): Promise<T> {
    const db = await this.open();
    const t = db.transaction(store, mode);
    const done = new Promise<void>((resolve, reject) => {
      t.oncomplete = () => resolve();
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error ?? new Error('Transaction aborted'));
    });
    const out = await fn(t.objectStore(store));
    await done;
    return out;
  }

  async getKey(): Promise<CryptoKey | null> {
    return (await this.tx('keys', 'readonly', (s) => req(s.get(KEY_ID)))) ?? null;
  }

  async putKeyIfAbsent(key: CryptoKey): Promise<CryptoKey> {
    return this.tx('keys', 'readwrite', async (s) => {
      const existing = (await req(s.get(KEY_ID))) as CryptoKey | undefined;
      if (existing) return existing;
      await req(s.add(key, KEY_ID));
      return key;
    });
  }

  async get(name: string): Promise<EncryptedSecret | null> {
    return ((await this.tx('secrets', 'readonly', (s) => req(s.get(name)))) as EncryptedSecret | undefined) ?? null;
  }

  async put(name: string, rec: EncryptedSecret): Promise<void> {
    await this.tx('secrets', 'readwrite', (s) => req(s.put(rec, name)));
  }

  async delete(name: string): Promise<void> {
    await this.tx('secrets', 'readwrite', (s) => req(s.delete(name)));
  }

  async list(): Promise<string[]> {
    const keys = await this.tx('secrets', 'readonly', (s) => req(s.getAllKeys()));
    return keys.map(String).sort();
  }

  close(): void {
    void this.db?.then((d) => d.close());
    this.db = null;
  }
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export interface WebCryptoSecretStoreOptions {
  /** Default: IndexedDBSecretBackend. */
  backend?: SecretBackend;
  /** Default: globalThis.crypto. */
  crypto?: Crypto;
}

/** AES-GCM-encrypted SecretStore with a non-extractable device key. */
export class WebCryptoSecretStore implements SecretStore {
  private backend: SecretBackend;
  private crypto: Crypto;
  private key: Promise<CryptoKey> | null = null;

  constructor(opts: WebCryptoSecretStoreOptions = {}) {
    const c = opts.crypto ?? (globalThis as { crypto?: Crypto }).crypto;
    if (!c?.subtle) throw new Error('Web Crypto is not available (needs a secure context: https or localhost).');
    this.crypto = c;
    this.backend = opts.backend ?? new IndexedDBSecretBackend();
  }

  private getKey(): Promise<CryptoKey> {
    if (!this.key) {
      this.key = (async () => {
        const existing = await this.backend.getKey();
        if (existing) return existing;
        const fresh = await this.crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
        return this.backend.putKeyIfAbsent(fresh);
      })();
      this.key.catch(() => (this.key = null));
    }
    return this.key;
  }

  /** Binds each ciphertext to its name so records can't be swapped between names. */
  private aad(name: string): Uint8Array<ArrayBuffer> {
    return enc.encode(`inkwright-secret:v1:${name}`);
  }

  async set(name: string, value: string): Promise<void> {
    const key = await this.getKey();
    const iv = this.crypto.getRandomValues(new Uint8Array(12));
    const data = await this.crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: this.aad(name) }, key, enc.encode(value));
    await this.backend.put(name, { v: 1, iv, data: new Uint8Array(data) });
  }

  /** The secret, or null when missing or undecryptable (e.g. the device key was cleared). */
  async get(name: string): Promise<string | null> {
    const rec = await this.backend.get(name);
    if (!rec) return null;
    const key = await this.getKey();
    try {
      const iv = new Uint8Array(rec.iv);
      const data = new Uint8Array(rec.data);
      const plain = await this.crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: this.aad(name) }, key, data);
      return dec.decode(plain);
    } catch {
      return null;
    }
  }

  async delete(name: string): Promise<void> {
    await this.backend.delete(name);
  }

  async list(): Promise<string[]> {
    return this.backend.list();
  }
}

/** Conventional secret name for a provider's API key. */
export const apiKeySecretName = (providerId: string) => `ai.apiKey.${providerId}`;
