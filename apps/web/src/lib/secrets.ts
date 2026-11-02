import { MemorySecretStore, WebCryptoSecretStore, type SecretStore } from '@inkwright/ai';

/**
 * API keys and passwords: encrypted with a non-extractable AES-GCM key that lives in this
 * browser/app's IndexedDB, so they never appear in settings exports, sync, or local storage.
 * Falls back to memory (this session only) where IndexedDB or Web Crypto is unavailable.
 */
let store: SecretStore | null = null;

export function secrets(): SecretStore {
  if (!store) {
    try {
      store = new WebCryptoSecretStore();
    } catch {
      store = new MemorySecretStore();
    }
  }
  return store;
}

export async function getSecret(name: string): Promise<string | null> {
  try {
    return (await secrets().get(name)) ?? null;
  } catch (e) {
    // Don't swap stores on a transient error: that would silently hide every saved key.
    console.error('Could not read a saved key', e);
    return null;
  }
}

/** Saves (or with null/empty, deletes) a secret. Throws so the caller can tell the user. */
export async function setSecret(name: string, value: string | null): Promise<void> {
  if (value == null || value === '') await secrets().delete(name);
  else await secrets().set(name, value);
}
