/**
 * Vault files of the developer platform (docs/VAULT_FORMAT.md § Plugins and § API keys):
 *
 * - `plugins/<id>/…` — an installed plugin's manifest and code, exactly as published;
 *   `plugins/<id>/data.json` — its private storage and settings.
 * - `plugins/plugins.json` — which plugins are installed, enabled, and what they were granted.
 * - `api/keys.json` — API keys for the local REST API, **hashed** (SHA-256; the key itself is
 *   shown once when created and never stored).
 *
 * They live in the vault so they sync: a plugin installed on the laptop appears on the phone, and
 * a key created in the app works with the server running on another computer.
 */
import { sha256, toBase64Url, toHex } from './sha256.ts';

export const PLUGINS_DIR = 'plugins';
export const PLUGINS_CONFIG = 'plugins/plugins.json';
export const API_KEYS_FILE = 'api/keys.json';

export const pluginDir = (id: string) => `${PLUGINS_DIR}/${id}`;
export const pluginFile = (id: string, rel: string) => `${PLUGINS_DIR}/${id}/${rel}`;
export const pluginDataFile = (id: string) => `${PLUGINS_DIR}/${id}/data.json`;

export type PluginSource =
  | { kind: 'url'; url: string }
  | { kind: 'catalog'; catalogId: string }
  | { kind: 'zip'; name: string }
  | { kind: 'folder'; name: string };

export interface InstalledPlugin {
  /** The manifest id (also the folder name under plugins/). */
  id: string;
  version: string;
  enabled: boolean;
  /** Permissions the user granted (a subset of the manifest's; revoked ones are absent). */
  granted: string[];
  source: PluginSource;
  installedAt: number;
  /** Bumped on every change to this record; the newer record wins when two devices disagree. */
  updatedAt: number;
}

export interface PluginsConfig {
  formatVersion: 1;
  plugins: InstalledPlugin[];
}

export const emptyPluginsConfig = (): PluginsConfig => ({ formatVersion: 1, plugins: [] });

export function decodePluginsConfig(text: string): PluginsConfig {
  const raw = JSON.parse(text) as Partial<PluginsConfig>;
  const plugins = Array.isArray(raw.plugins) ? raw.plugins.filter((p): p is InstalledPlugin => !!p && typeof p.id === 'string' && typeof p.version === 'string') : [];
  return {
    formatVersion: 1,
    plugins: plugins.map((p) => ({
      id: p.id,
      version: p.version,
      enabled: p.enabled !== false,
      granted: Array.isArray(p.granted) ? p.granted.filter((g) => typeof g === 'string') : [],
      source: p.source && typeof p.source === 'object' ? p.source : { kind: 'folder', name: p.id },
      installedAt: Number(p.installedAt) || 0,
      updatedAt: Number(p.updatedAt) || 0,
    })),
  };
}

export const encodePluginsConfig = (c: PluginsConfig) => `${JSON.stringify(c, null, 2)}\n`;

// ---- API keys --------------------------------------------------------------------------------

/**
 * What an API key may do. `admin` manages keys and webhooks; `federation:search` is for a
 * teammate's server: only the shared-notes search (docs/FEDERATION.md), nothing else.
 */
export const API_SCOPES = ['notes:read', 'notes:write', 'routines:run', 'webhooks', 'admin', 'federation:search'] as const;
export type ApiScope = (typeof API_SCOPES)[number];

export interface ApiKeyRecord {
  id: string;
  name: string;
  /** First characters of the key (`ink_<id>`), shown in lists so people can tell keys apart. */
  prefix: string;
  /** Hex SHA-256 of the whole key. */
  hash: string;
  scopes: ApiScope[];
  createdAt: number;
  /** Optional expiry (epoch ms). */
  expiresAt?: number;
  /** Set when revoked; a revoked key never works again (revocation wins in sync merges). */
  revokedAt?: number;
  /** Where it was created ("app", "cli", "api"). */
  createdBy?: string;
  updatedAt: number;
}

export interface ApiKeysFile {
  formatVersion: 1;
  keys: ApiKeyRecord[];
}

export const emptyApiKeys = (): ApiKeysFile => ({ formatVersion: 1, keys: [] });

export function decodeApiKeys(text: string): ApiKeysFile {
  const raw = JSON.parse(text) as Partial<ApiKeysFile>;
  const keys = Array.isArray(raw.keys) ? raw.keys : [];
  return {
    formatVersion: 1,
    keys: keys
      .filter((k): k is ApiKeyRecord => !!k && typeof k.id === 'string' && typeof k.hash === 'string' && /^[0-9a-f]{64}$/.test(k.hash))
      .map((k) => ({ ...k, scopes: (Array.isArray(k.scopes) ? k.scopes : []).filter((s): s is ApiScope => (API_SCOPES as readonly string[]).includes(s)), updatedAt: Number(k.updatedAt) || Number(k.createdAt) || 0 })),
  };
}

export const encodeApiKeys = (f: ApiKeysFile) => `${JSON.stringify(f, null, 2)}\n`;

/** Hex SHA-256 of a key, as stored. */
export const hashApiKey = (key: string) => toHex(sha256(key));

const KEY_RE = /^ink_([0-9a-z]{10})_([A-Za-z0-9_-]{43})$/;

/**
 * Makes a new key: `ink_<10-char id>_<32 random bytes, base64url>`. The id half is public (it is
 * stored and shown); the random half is 256 bits, so a fast hash is the right way to store it —
 * slow password hashes protect low-entropy secrets, which these are not.
 */
export function createApiKey(o: { name: string; scopes: ApiScope[]; now: number; createdBy?: string; expiresAt?: number; random?: (n: number) => Uint8Array }): { key: string; record: ApiKeyRecord } {
  const random = o.random ?? ((n: number) => crypto.getRandomValues(new Uint8Array(n)));
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
  const id = [...random(10)].map((b) => alphabet[b % 36]).join('');
  const key = `ink_${id}_${toBase64Url(random(32))}`;
  const record: ApiKeyRecord = { id, name: o.name.trim() || 'API key', prefix: `ink_${id}`, hash: hashApiKey(key), scopes: [...new Set(o.scopes)], createdAt: o.now, updatedAt: o.now };
  if (o.createdBy) record.createdBy = o.createdBy;
  if (o.expiresAt) record.expiresAt = o.expiresAt;
  return { key, record };
}

/** True when a string has the shape of an Inkwright API key. */
export const looksLikeApiKey = (s: string) => KEY_RE.test(s);

/** The live record for a presented key, or why it was refused. */
export function verifyApiKey(file: ApiKeysFile, key: string, now: number): { ok: true; record: ApiKeyRecord } | { ok: false; reason: 'malformed' | 'unknown' | 'revoked' | 'expired' } {
  const m = KEY_RE.exec(key);
  if (!m) return { ok: false, reason: 'malformed' };
  const record = file.keys.find((k) => k.id === m[1]);
  if (!record) return { ok: false, reason: 'unknown' };
  // Constant-time compare of the two hex digests.
  const given = hashApiKey(key);
  let diff = given.length ^ record.hash.length;
  for (let i = 0; i < Math.min(given.length, record.hash.length); i++) diff |= given.charCodeAt(i) ^ record.hash.charCodeAt(i);
  if (diff !== 0) return { ok: false, reason: 'unknown' };
  if (record.revokedAt) return { ok: false, reason: 'revoked' };
  if (record.expiresAt && record.expiresAt <= now) return { ok: false, reason: 'expired' };
  return { ok: true, record };
}

export function revokeApiKey(file: ApiKeysFile, id: string, now: number): ApiKeysFile {
  return { ...file, keys: file.keys.map((k) => (k.id === id && !k.revokedAt ? { ...k, revokedAt: now, updatedAt: now } : k)) };
}
