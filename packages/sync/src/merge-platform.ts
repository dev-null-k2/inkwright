import type { ApiKeyRecord, ApiKeysFile, InstalledPlugin, PluginsConfig } from '@inkwright/core';

/*
 * Three-way merges for the developer platform's vault files (docs/VAULT_FORMAT.md § Plugins,
 * § API keys).
 *
 * - `plugins/plugins.json`: one record per plugin id; when both sides changed a record the one
 *   with the newer `updatedAt` wins. A plugin uninstalled on one device and untouched on the other
 *   stays uninstalled; one uninstalled here but updated there (re-enabled, upgraded) survives.
 * - `api/keys.json`: keys are unioned by id. Revocation always wins — a key revoked anywhere stays
 *   revoked, even if another device renamed it meanwhile — and keys are never dropped by a merge
 *   (a deleted key would otherwise come back as valid from a stale copy).
 */

const same = (x: unknown, y: unknown) => JSON.stringify(x) === JSON.stringify(y);

function mergeRecords<T extends { id: string; updatedAt: number }>(base: readonly T[] | null, a: readonly T[], b: readonly T[], prefer: 'a' | 'b'): T[] {
  const baseMap = base ? new Map(base.map((x) => [x.id, x])) : null;
  const am = new Map(a.map((x) => [x.id, x]));
  const bm = new Map(b.map((x) => [x.id, x]));
  const out: T[] = [];
  for (const id of new Set([...am.keys(), ...bm.keys()])) {
    const x = am.get(id);
    const y = bm.get(id);
    const o = baseMap?.get(id);
    if (x && y) {
      if (same(x, y) || (o && same(y, o))) out.push(x);
      else if (o && same(x, o)) out.push(y);
      else out.push(x.updatedAt > y.updatedAt ? x : y.updatedAt > x.updatedAt ? y : prefer === 'a' ? x : y);
    } else {
      const only = (x ?? y)!;
      if (o && same(only, o)) continue; // removed on the other side, unchanged here
      out.push(only);
    }
  }
  return out.sort((p, q) => (p.id < q.id ? -1 : p.id > q.id ? 1 : 0));
}

export function mergePluginsConfig(base: PluginsConfig | null, local: PluginsConfig, remote: PluginsConfig, opts: { prefer?: 'local' | 'remote' } = {}): PluginsConfig {
  return { formatVersion: 1, plugins: mergeRecords<InstalledPlugin>(base?.plugins ?? null, local.plugins, remote.plugins, opts.prefer === 'remote' ? 'b' : 'a') };
}

export function mergeApiKeys(_base: ApiKeysFile | null, local: ApiKeysFile, remote: ApiKeysFile, opts: { prefer?: 'local' | 'remote' } = {}): ApiKeysFile {
  // Never drop keys: pass no base for presence, so a key missing on one side is kept.
  const merged = mergeRecords<ApiKeyRecord>(null, local.keys, remote.keys, opts.prefer === 'remote' ? 'b' : 'a');
  const l = new Map(local.keys.map((k) => [k.id, k]));
  const r = new Map(remote.keys.map((k) => [k.id, k]));
  return {
    formatVersion: 1,
    keys: merged.map((k) => {
      const revokedAt = [l.get(k.id)?.revokedAt, r.get(k.id)?.revokedAt].filter((t): t is number => typeof t === 'number');
      return revokedAt.length ? { ...k, revokedAt: Math.min(...revokedAt) } : k;
    }),
  };
}
