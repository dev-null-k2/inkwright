/**
 * Vault files that changed underneath the app: a sync that pulled or merged files (lib/sync.ts),
 * or, in the desktop app, another program writing into the vault folder (desktop/integration.ts).
 *
 * Notes are refreshed by those sources directly. Features that keep their own state from vault
 * files (the memory timeline's shared settings and captures, for example) subscribe here, so a
 * setting changed on another device — "never capture this app" — applies at once instead of at
 * the next restart, and no sync source needs to know about every feature.
 */
type Listener = (paths: readonly string[]) => void;

const listeners = new Set<Listener>();

export function onVaultChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function vaultChanged(paths: readonly string[]): void {
  if (!paths.length) return;
  for (const fn of [...listeners]) {
    try {
      fn(paths);
    } catch (e) {
      console.warn('A vault change listener failed', e);
    }
  }
}
