/**
 * The curated list in Settings › Plugins › Browse. Entries ship inside the app (so the list works
 * offline and cannot be changed by a server), built from the repository's examples/plugins
 * folders; installing one goes through the same validation and permission prompt as any plugin.
 */
import type { PluginSource } from '@inkstone/core';
import wordCountManifest from '../../../../examples/plugins/word-count/manifest.json?raw';
import wordCountMain from '../../../../examples/plugins/word-count/main.js?raw';
import wordCountReadme from '../../../../examples/plugins/word-count/README.md?raw';
import webhookManifest from '../../../../examples/plugins/webhook/manifest.json?raw';
import webhookMain from '../../../../examples/plugins/webhook/main.js?raw';
import webhookReadme from '../../../../examples/plugins/webhook/README.md?raw';
import { packageFromFiles } from './install.ts';
import type { PluginPackage } from './store.ts';

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  version: string;
  load(appVersion: string): PluginPackage;
}

const enc = new TextEncoder();

function entry(files: Record<string, string>): CatalogEntry {
  const m = JSON.parse(files['manifest.json']!) as { id: string; name: string; description: string; author: string; version: string };
  return {
    id: m.id,
    name: m.name,
    description: m.description,
    author: m.author,
    version: m.version,
    load(appVersion) {
      const source: PluginSource = { kind: 'catalog', catalogId: m.id };
      return packageFromFiles(new Map(Object.entries(files).map(([k, v]) => [k, enc.encode(v)])), source, appVersion);
    },
  };
}

export const CATALOG: CatalogEntry[] = [
  entry({ 'manifest.json': wordCountManifest, 'main.js': wordCountMain, 'README.md': wordCountReadme }),
  entry({ 'manifest.json': webhookManifest, 'main.js': webhookMain, 'README.md': webhookReadme }),
];
