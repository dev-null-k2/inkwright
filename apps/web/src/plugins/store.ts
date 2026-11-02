/**
 * Installed plugins in the vault (docs/VAULT_FORMAT.md § Plugins): the plugin's files exactly as
 * published under `plugins/<id>/`, its private data in `plugins/<id>/data.json`, and the list of
 * installed plugins with their enable switch and granted permissions in `plugins/plugins.json`.
 * Because it is all vault files, plugins sync to every device like notes do.
 */
import {
  PLUGINS_CONFIG,
  decodePluginsConfig,
  emptyPluginsConfig,
  encodePluginsConfig,
  pluginDataFile,
  pluginDir,
  pluginFile,
  type InstalledPlugin,
  type PluginSource,
  type PluginsConfig,
  type VaultFS,
} from '@inkstone/core';
import { validateManifest, type Permission, type PluginManifest } from '@inkstone/plugin-api';

/** A plugin ready to install: its manifest and files (paths relative to the plugin folder). */
export interface PluginPackage {
  manifest: PluginManifest;
  files: Map<string, Uint8Array>;
  source: PluginSource;
}

export interface PluginData {
  settings: Record<string, string | number | boolean>;
  storage: Record<string, unknown>;
}

const utf8 = new TextDecoder();

export class PluginStore {
  constructor(private fs: VaultFS, private clock: () => number = Date.now) {}

  async config(): Promise<PluginsConfig> {
    const text = await this.fs.readText(PLUGINS_CONFIG);
    if (!text) return emptyPluginsConfig();
    try {
      return decodePluginsConfig(text);
    } catch {
      return emptyPluginsConfig();
    }
  }

  private async writeConfig(c: PluginsConfig): Promise<void> {
    await this.fs.writeText(PLUGINS_CONFIG, encodePluginsConfig(c));
  }

  async record(id: string): Promise<InstalledPlugin | null> {
    return (await this.config()).plugins.find((p) => p.id === id) ?? null;
  }

  /** Changes one plugin's record (bumping `updatedAt`, which decides sync conflicts). */
  async updateRecord(id: string, change: (r: InstalledPlugin) => InstalledPlugin): Promise<InstalledPlugin | null> {
    const c = await this.config();
    const i = c.plugins.findIndex((p) => p.id === id);
    if (i < 0) return null;
    const next = { ...change(c.plugins[i]!), updatedAt: Math.max(this.clock(), c.plugins[i]!.updatedAt + 1) };
    c.plugins[i] = next;
    await this.writeConfig(c);
    return next;
  }

  /** The installed manifest, validated again (it may have been edited or synced half-way). */
  async manifest(id: string): Promise<{ manifest: PluginManifest } | { error: string }> {
    const text = await this.fs.readText(pluginFile(id, 'manifest.json'));
    if (!text) return { error: 'Its files are missing (still syncing?).' };
    try {
      const r = validateManifest(JSON.parse(text));
      if (!r.ok) return { error: r.errors.join(' ') };
      if (r.manifest.id !== id) return { error: `Its manifest says it is ${r.manifest.id}.` };
      return { manifest: r.manifest };
    } catch (e) {
      return { error: `Its manifest is not valid JSON: ${(e as Error).message}` };
    }
  }

  async code(id: string, entry: string): Promise<string | null> {
    return this.fs.readText(pluginFile(id, entry));
  }

  /**
   * Writes the plugin's files and its record. An update replaces every file except data.json
   * (the plugin's storage and settings survive updates). `granted` must be a subset of the
   * manifest's permissions.
   */
  async install(pkg: PluginPackage, granted: Permission[]): Promise<InstalledPlugin> {
    const id = pkg.manifest.id;
    const now = this.clock();
    const old = await this.record(id);
    for (const e of await this.fs.list(pluginDir(id))) {
      if (e.name === 'data.json') continue;
      if (e.kind === 'dir') await this.fs.deleteDir(`${pluginDir(id)}/${e.name}`);
      else await this.fs.delete(`${pluginDir(id)}/${e.name}`);
    }
    for (const [rel, bytes] of pkg.files) await this.fs.writeBytes(pluginFile(id, rel), bytes);
    const rec: InstalledPlugin = {
      id,
      version: pkg.manifest.version,
      enabled: old?.enabled ?? true,
      granted: granted.filter((p) => pkg.manifest.permissions.includes(p)),
      source: pkg.source,
      installedAt: old?.installedAt ?? now,
      updatedAt: Math.max(now, (old?.updatedAt ?? 0) + 1),
    };
    const c = await this.config();
    c.plugins = [...c.plugins.filter((p) => p.id !== id), rec].sort((a, b) => a.id.localeCompare(b.id));
    await this.writeConfig(c);
    return rec;
  }

  /** Removes the plugin, its data and its record. */
  async uninstall(id: string): Promise<void> {
    await this.fs.deleteDir(pluginDir(id));
    const c = await this.config();
    c.plugins = c.plugins.filter((p) => p.id !== id);
    await this.writeConfig(c);
  }

  async data(id: string): Promise<PluginData> {
    const text = await this.fs.readText(pluginDataFile(id));
    try {
      const d = text ? (JSON.parse(text) as Partial<PluginData>) : {};
      return { settings: d.settings && typeof d.settings === 'object' ? d.settings : {}, storage: d.storage && typeof d.storage === 'object' ? d.storage : {} };
    } catch {
      return { settings: {}, storage: {} };
    }
  }

  async saveData(id: string, d: PluginData): Promise<void> {
    await this.fs.writeText(pluginDataFile(id), `${JSON.stringify(d, null, 2)}\n`);
  }

  /** Text of a packaged file (README etc.). */
  async readText(id: string, rel: string): Promise<string | null> {
    const b = await this.fs.readBytes(pluginFile(id, rel));
    return b ? utf8.decode(b) : null;
  }
}
