import { fingerprintOf, type SignerInfo } from '@inkstone/core';
import { useSettings } from '../state/settings.ts';

/**
 * This device's authorship signing key: ECDSA P-256 made with WebCrypto as a *non-extractable*
 * key — the private half can sign but can never be read out by any script, including Inkstone's
 * own. The CryptoKey objects themselves are kept in IndexedDB (browsers store them opaquely; in
 * the Android app this is the WebView's app-private storage), so the same key signs across
 * sessions. The public key and its fingerprint are shown to the user and put in certificates.
 *
 * Clearing the app's data deletes the key; certificates signed earlier still verify (they carry
 * their public key), but new ones get a new fingerprint.
 */

const DB = 'inkstone-authorship';
const STORE = 'keys';
const ID = 'device';

interface StoredKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  createdAt: number;
}

export interface DeviceKey {
  privateKey: CryptoKey;
  publicJwk: JsonWebKey;
  fingerprint: string;
  createdAt: number;
  /** False when IndexedDB is unavailable (private window, preview): the key lasts this session only. */
  persistent: boolean;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

async function generate(): Promise<StoredKey> {
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', kp.publicKey);
  return { privateKey: kp.privateKey, publicJwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y }, createdAt: Date.now() };
}

let cached: Promise<DeviceKey> | null = null;

/** The device key, created on first use. */
export function deviceKey(): Promise<DeviceKey> {
  cached ??= (async () => {
    let db: IDBDatabase | null = null;
    try { db = await openDb(); } catch { db = null; }
    if (db) {
      try {
        let k = await tx<StoredKey | undefined>(db, 'readonly', (s) => s.get(ID));
        if (!k?.privateKey || !k.publicJwk) {
          k = await generate();
          await tx(db, 'readwrite', (s) => s.put(k!, ID));
        }
        return { ...k, fingerprint: fingerprintOf(k.publicJwk), persistent: true };
      } catch (e) {
        console.warn('Authorship key store unavailable; using a session key', e);
      } finally {
        db.close();
      }
    }
    const k = await generate();
    return { ...k, fingerprint: fingerprintOf(k.publicJwk), persistent: false };
  })();
  cached.catch(() => { cached = null; });
  return cached;
}

/** Short device id stamped on chain events: the first group of the fingerprint. */
export function shortDeviceId(fingerprint: string): string {
  return fingerprint.replace(/\s/g, '').slice(0, 8).toLowerCase();
}

/** Signer details for a certificate (name from Settings, if the user set one). */
export async function deviceSigner(): Promise<{ info: SignerInfo; key: CryptoKey; persistent: boolean }> {
  const k = await deviceKey();
  const name = useSettings.getState().authorship.deviceName.trim();
  return { info: { alg: 'ES256', publicKey: k.publicJwk, fingerprint: k.fingerprint, ...(name ? { name } : {}) }, key: k.privateKey, persistent: k.persistent };
}
