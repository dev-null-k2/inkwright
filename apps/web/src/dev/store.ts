/**
 * Code sources in the app: mounting a repository (a folder on desktop Chromium, a .zip or GitHub
 * .tar.gz anywhere), scanning it with tree-sitter in the page, importing graphify / generic graph
 * JSON, and keeping the graphs in memory for code links, drift and the agent tools.
 *
 * Everything lands in the vault (`code/sources/<id>/`, @inkwright/core CodeStore) so it syncs to the
 * user's other devices and is readable by the MCP server and the `inkwright` CLI. No server is
 * involved: archives are read in the page, folders through the File System Access API.
 */
import { create } from 'zustand';
import {
  CodeIndex, CodeStore, driftReport, ignoredPath, importCodeGraph, languageOf, newId, readTarball, scanRepository, stripCommonRoot,
  type CodeGraph, type CodeSource, type CodeSourceKind, type DriftItem, type NoteMeta, type PageInk, type RepoFile,
} from '@inkwright/core';
import { readZip } from '@inkwright/sync';
import { activeSession } from '../lib/session.ts';
import type { AppVault } from '../lib/vault.ts';
import { useApp } from '../state/app.ts';
import { forgetFolderHandle, loadFolderHandle, saveFolderHandle } from './handles.ts';
import { browserCodeParser } from './treesitter.ts';
import { WASM_AVAILABLE } from './wasm-assets.ts';

export interface ScanStatus {
  label: string;
  done: number;
  total: number;
}

interface DevState {
  sources: CodeSource[];
  graphs: CodeGraph[];
  indexes: CodeIndex[];
  /** Bumps whenever the graphs change, so views recompute drift. */
  version: number;
  scanning: ScanStatus | null;
  loaded: boolean;
}

export const useDev = create<DevState>(() => ({ sources: [], graphs: [], indexes: [], version: 0, scanning: null, loaded: false }));

const app = () => useApp.getState();
const store = (v: AppVault) => new CodeStore(v.fs);
let watching: AppVault | null = null;

/** Reads every code source and graph from the vault (on start, after a scan, after sync pulls). */
export async function loadCode(vault: AppVault | null = app().vault): Promise<void> {
  if (!vault) return;
  if (watching !== vault) {
    watching = vault;
    vault.vault.onChange((c) => { if (c.type === 'reloaded') void loadCode(vault); });
  }
  const s = store(vault);
  const sources = await s.listSources();
  const graphs: CodeGraph[] = [];
  for (const src of sources) {
    const g = await s.readGraph(src.id);
    if (g) graphs.push(g);
  }
  useDev.setState((st) => ({ sources, graphs, indexes: graphs.map((g) => new CodeIndex(g)), version: st.version + 1, loaded: true }));
}

/** Loads once (cheap afterwards). */
export async function ensureCodeLoaded(): Promise<void> {
  if (!useDev.getState().loaded) await loadCode();
}

export const canScan = WASM_AVAILABLE;
export const canOpenFolder = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const keep = (path: string, size: number) => !ignoredPath(path) && (!!languageOf(path) || path === 'go.mod' || path.endsWith('/go.mod')) && size <= 512 * 1024;

const idFor = (name: string) => name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, '').replace(/[^0-9A-Za-z_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'repo';

/** Scans files into a code source (an existing id re-scans that source in place). */
export async function scanFiles(files: RepoFile[], o: { id?: string; name: string; kind: CodeSourceKind; origin?: string }): Promise<CodeSource> {
  const vault = app().vault;
  if (!vault) throw new Error('Your notes are still opening.');
  if (!canScan) throw new Error('Scanning code needs the full app (this preview has no code parsers). Import a graph JSON instead.');
  const s = store(vault);
  const existing = (await s.listSources()).map((x) => x.id);
  const id = o.id ?? (existing.includes(idFor(o.name)) ? `${idFor(o.name)}-${newId().slice(-4).toLowerCase()}` : idFor(o.name));
  const prev = await s.readSource(id);
  useDev.setState({ scanning: { label: o.name, done: 0, total: files.length } });
  try {
    const graph = await scanRepository(stripCommonRoot(files), browserCodeParser(), {
      sourceId: id,
      name: o.name,
      onProgress: (p) => { if (p.done % 20 === 0 || p.done === p.total) useDev.setState({ scanning: { label: o.name, done: p.done, total: p.total } }); },
    });
    const src = await s.save({ id, name: o.name, kind: o.kind, ...(o.origin ? { origin: o.origin } : {}), createdAt: prev?.createdAt ?? graph.scannedAt }, graph);
    await loadCode(vault);
    return src;
  } finally {
    useDev.setState({ scanning: null });
  }
}

/** A .zip, .tar.gz/.tgz or .tar of a repository → its code files (top folder dropped by the scan). */
export async function readArchive(file: Blob & { name: string }): Promise<{ files: RepoFile[]; kind: CodeSourceKind }> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const entries = await readZip(bytes);
    return { files: entries.filter((e) => !e.path.endsWith('/') && keep(e.path, e.bytes.length)).map((e) => ({ path: e.path, bytes: e.bytes })), kind: 'zip' };
  }
  if ((bytes[0] === 0x1f && bytes[1] === 0x8b) || /\.tar$/i.test(file.name)) return { files: await readTarball(bytes, keep), kind: 'tarball' };
  throw new Error(`${file.name} is not a .zip or .tar.gz archive.`);
}

/** Imports a repository archive as a new code source, or re-scans `sourceId` from a newer archive. */
export async function importArchive(file: File, sourceId?: string): Promise<CodeSource> {
  const { files, kind } = await readArchive(file);
  if (!files.length) throw new Error(`No TypeScript, JavaScript, Python, Go, Rust or Java files in ${file.name}.`);
  const prev = sourceId ? await store(app().vault!).readSource(sourceId) : null;
  return scanFiles(files, { id: sourceId, name: prev?.name ?? file.name.replace(/\.(zip|tar\.gz|tgz|tar)$/i, ''), kind, origin: file.name });
}

/** Imports graphify `graph.json` or a generic nodes/edges JSON file. */
export async function importGraphFile(file: File): Promise<CodeSource> {
  const vault = app().vault;
  if (!vault) throw new Error('Your notes are still opening.');
  let doc: unknown;
  try { doc = JSON.parse(await file.text()); } catch { throw new Error(`${file.name} is not JSON.`); }
  const name = file.name === 'graph.json' ? 'graphify' : file.name.replace(/\.json$/i, '');
  const id = `${idFor(name)}-${newId().slice(-4).toLowerCase()}`;
  const graph = importCodeGraph(doc, { sourceId: id, name });
  const src = await store(vault).save({ id, name, kind: graph.generator.startsWith('graphify') ? 'graphify' : 'generic', origin: file.name, createdAt: graph.scannedAt }, graph);
  await loadCode(vault);
  return src;
}

// ---- Folders (desktop Chromium) ---------------------------------------------------------------

type DirHandle = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle & { kind: 'file' | 'directory'; name: string }> };

async function walkFolder(dir: DirHandle, prefix = '', out: RepoFile[] = []): Promise<RepoFile[]> {
  for await (const h of dir.values()) {
    const path = prefix ? `${prefix}/${h.name}` : h.name;
    if (h.kind === 'directory') {
      if (!ignoredPath(`${path}/x`)) await walkFolder(h as DirHandle, path, out);
    } else {
      const f = await (h as FileSystemFileHandle).getFile();
      if (keep(path, f.size)) out.push({ path, bytes: new Uint8Array(await f.arrayBuffer()) });
    }
  }
  return out;
}

/** Picks a repository folder and scans it; the folder is remembered on this device for re-scans. */
export async function addFolder(): Promise<CodeSource | null> {
  let dir: DirHandle;
  try {
    dir = await (window as unknown as { showDirectoryPicker: (o: unknown) => Promise<DirHandle> }).showDirectoryPicker({ id: 'inkwright-code', mode: 'read' });
  } catch {
    return null; // cancelled
  }
  const files = await walkFolder(dir);
  if (!files.length) throw new Error(`No TypeScript, JavaScript, Python, Go, Rust or Java files in ${dir.name}.`);
  const src = await scanFiles(files, { name: dir.name, kind: 'folder', origin: dir.name });
  await saveFolderHandle(src.id, dir);
  return src;
}

/**
 * Re-scans a source. Folders are read again (after the browser re-confirms access); archives and
 * imported graphs need the newer file, which the caller picks and passes in.
 */
export async function rescan(source: CodeSource, file?: File): Promise<CodeSource | null> {
  if (source.kind === 'folder') {
    const dir = (await loadFolderHandle(source.id)) as DirHandle | null;
    if (!dir) throw new Error(`This device has no access to “${source.name}”. Add the folder again.`);
    const h = dir as unknown as { queryPermission?(o: unknown): Promise<string>; requestPermission?(o: unknown): Promise<string> };
    if ((await h.queryPermission?.({ mode: 'read' })) !== 'granted' && (await h.requestPermission?.({ mode: 'read' })) !== 'granted') return null;
    return scanFiles(await walkFolder(dir), { id: source.id, name: source.name, kind: 'folder', origin: source.origin });
  }
  if (!file) return null;
  if (source.kind === 'graphify' || source.kind === 'generic') {
    const vault = app().vault!;
    const graph = importCodeGraph(JSON.parse(await file.text()), { sourceId: source.id, name: source.name });
    const src = await store(vault).save({ id: source.id, name: source.name, kind: source.kind, origin: file.name, createdAt: source.createdAt }, graph);
    await loadCode(vault);
    return src;
  }
  return importArchive(file, source.id);
}

export async function removeSource(id: string): Promise<void> {
  const vault = app().vault;
  if (!vault) return;
  await store(vault).remove(id);
  await forgetFolderHandle(id);
  await loadCode(vault);
}

// ---- Drift across notes -----------------------------------------------------------------------

/** Every drifted code link in the vault (the open note read live from its document). */
export async function allDrift(): Promise<DriftItem[]> {
  const vault = app().vault;
  await ensureCodeLoaded();
  const { indexes } = useDev.getState();
  if (!vault || !indexes.length) return [];
  const open = activeSession()?.doc;
  const notes: { meta: NoteMeta; pages: readonly PageInk[] }[] = [];
  for (const meta of app().notes) {
    if (open && open.meta.id === meta.id) notes.push({ meta: open.meta, pages: open.pages });
    else notes.push({ meta, pages: await vault.vault.readPages(meta) });
  }
  return driftReport(notes, indexes);
}
