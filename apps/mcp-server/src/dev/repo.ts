/**
 * Scanning a repository on disk into a vault (`inkwright scan`), and reading the vault's code
 * graphs and notes for drift (`inkwright drift`, the `drift_report` MCP tool).
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import {
  CodeStore, driftReport, ignoredPath, languageOf, scanRepository,
  type CodeGraph, type CodeSource, type DriftItem, type RepoFile, type ScanLimits, type ScanProgress, type Vault, type VaultFS,
} from '@inkwright/core';
import { nodeCodeParser } from './treesitter.ts';

/** Files of a repository folder worth parsing (code files, plus go.mod for Go import paths). */
export async function readRepoFolder(root: string, limits: ScanLimits = {}): Promise<{ files: RepoFile[]; skipped: number }> {
  const maxBytes = limits.maxFileBytes ?? 512 * 1024;
  const files: RepoFile[] = [];
  let skipped = 0;
  const walk = async (rel: string) => {
    let entries;
    try {
      entries = await readdir(path.join(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (!ignoredPath(`${p}/x`)) await walk(p);
        continue;
      }
      if (!e.isFile() || ignoredPath(p) || (!languageOf(p) && p !== 'go.mod')) continue;
      const st = await stat(path.join(root, p));
      if (st.size > maxBytes) { skipped++; continue; }
      files.push({ path: p, bytes: new Uint8Array(await readFile(path.join(root, p))) });
    }
  };
  await walk('');
  return { files, skipped };
}

/** A stable source id for a folder: its name, made id-safe (re-scans replace the same source). */
export function sourceIdFor(name: string): string {
  return name.replace(/[^0-9A-Za-z_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'repo';
}

export interface ScanResult {
  source: CodeSource;
  graph: CodeGraph;
}

/** Scans `repo` and writes its graph into the vault as a code source (replacing an earlier scan of it). */
export async function scanFolderIntoVault(fs: VaultFS, repo: string, o: { id?: string; name?: string; limits?: ScanLimits; onProgress?: (p: ScanProgress) => void; now?: number; head?: { ref: string | null; commit: string } } = {}): Promise<ScanResult> {
  const abs = path.resolve(repo);
  const st = await stat(abs).catch(() => null);
  if (!st?.isDirectory()) throw new Error(`Repository folder not found: ${repo}`);
  const name = o.name ?? path.basename(abs);
  const id = o.id ?? sourceIdFor(name);
  const store = new CodeStore(fs);
  const prev = await store.readSource(id);
  const { files, skipped } = await readRepoFolder(abs, o.limits);
  const graph = await scanRepository(files, nodeCodeParser(), { sourceId: id, name, now: o.now, limits: o.limits, onProgress: o.onProgress });
  if (skipped) graph.skipped = (graph.skipped ?? 0) + skipped;
  const source = await store.save({ id, name, kind: 'cli', origin: abs, createdAt: prev?.createdAt ?? graph.scannedAt, ...(o.head ? { head: o.head } : {}) }, graph);
  return { source, graph };
}

/** Drift across every note of a vault against every code source in it. */
export async function vaultDrift(vault: Vault): Promise<DriftItem[]> {
  const graphs = await new CodeStore(vault.fs).readAllGraphs();
  if (!graphs.length) return [];
  const notes = [];
  // Locked notes read as blank pages (their links stay private) and so never report drift.
  for (const meta of await vault.listNotes()) notes.push({ meta, pages: await vault.readPages(meta) });
  return driftReport(notes, graphs);
}
