/**
 * API keys, stored hashed in the vault (`api/keys.json`, docs/VAULT_FORMAT.md § API keys) so a key
 * created in the app's Settings › Developer works with this server too, wherever it runs. The
 * file is re-read when it changes on disk (a sync bringing a new or revoked key), checked at most
 * once a second.
 */
import { API_KEYS_FILE, createApiKey, decodeApiKeys, emptyApiKeys, encodeApiKeys, revokeApiKey, verifyApiKey, type ApiKeyRecord, type ApiKeysFile, type ApiScope } from '@inkwright/core';
import type { ServerContext } from '../context.ts';

export class KeyStore {
  private file: ApiKeysFile = emptyApiKeys();
  private sig = '';
  private checkedAt = -Infinity;
  private forcedAt = -Infinity;
  /** In memory only: when each key was last used (writing it to the vault would churn sync). */
  readonly lastUsed = new Map<string, number>();

  constructor(private ctx: ServerContext) {}

  private async load(force = false): Promise<ApiKeysFile> {
    const now = this.ctx.clock();
    if (!force && now - this.checkedAt < 1000) return this.file;
    this.checkedAt = now;
    const st = await this.ctx.fs.stat(API_KEYS_FILE);
    const sig = st ? `${st.mtime}:${st.size}` : '';
    if (sig === this.sig && !force) return this.file;
    this.sig = sig;
    const text = st ? await this.ctx.fs.readText(API_KEYS_FILE) : null;
    try {
      this.file = text ? decodeApiKeys(text) : emptyApiKeys();
    } catch {
      // A half-synced or hand-broken file: keep the last good copy rather than locking everyone out.
    }
    return this.file;
  }

  async list(): Promise<ApiKeyRecord[]> {
    return (await this.load()).keys;
  }

  async verify(key: string): Promise<{ ok: true; record: ApiKeyRecord } | { ok: false; reason: string }> {
    let r = verifyApiKey(await this.load(), key, this.ctx.clock());
    // A key created a moment ago (the app, the CLI, another server) may not be in the cached copy
    // yet: re-read once, at most four times a second so unknown keys can't make us thrash the disk.
    if (!r.ok && r.reason === 'unknown' && this.ctx.clock() - this.forcedAt > 250) {
      this.forcedAt = this.ctx.clock();
      r = verifyApiKey(await this.load(true), key, this.ctx.clock());
    }
    if (r.ok) this.lastUsed.set(r.record.id, this.ctx.clock());
    return r;
  }

  async create(o: { name: string; scopes: ApiScope[]; expiresInDays?: number; createdBy: string }): Promise<{ key: string; record: ApiKeyRecord }> {
    if (this.ctx.readOnly) throw new Error('The vault is mounted read-only; keys cannot be created.');
    return this.ctx.withWriteLock(async () => {
      const file = await this.load(true);
      const now = this.ctx.clock();
      const made = createApiKey({ name: o.name, scopes: o.scopes, now, createdBy: o.createdBy, ...(o.expiresInDays ? { expiresAt: now + o.expiresInDays * 86_400_000 } : {}) });
      await this.ctx.fs.writeText(API_KEYS_FILE, encodeApiKeys({ ...file, keys: [...file.keys, made.record] }));
      await this.load(true);
      return made;
    });
  }

  /** Revokes a key by id; false when there is no such key. */
  async revoke(id: string): Promise<ApiKeyRecord | null> {
    if (this.ctx.readOnly) throw new Error('The vault is mounted read-only; keys cannot be revoked.');
    return this.ctx.withWriteLock(async () => {
      const file = await this.load(true);
      if (!file.keys.some((k) => k.id === id)) return null;
      const next = revokeApiKey(file, id, this.ctx.clock());
      await this.ctx.fs.writeText(API_KEYS_FILE, encodeApiKeys(next));
      await this.load(true);
      return next.keys.find((k) => k.id === id) ?? null;
    });
  }
}
