import { exportObsidianVault, importObsidianVault, type ObsidianImportReport, type VaultFile } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';
import { saveFile } from '../platform/files.ts';
import { isArtifact, isNative } from '../platform/env.ts';
import { canvasBytes } from './canvasBytes.ts';
import { scheduleSync } from './sync.ts';

/**
 * Obsidian export and import in the app: page pictures are rendered as PNG (with PDF pages and
 * images, exactly as on screen), files go into a zip or straight into a folder the user picks,
 * and Markdown vaults come in from a folder or a zip. The mapping itself is @inkwright/core's
 * obsidian.ts (docs/OBSIDIAN.md).
 */

const app = () => useApp.getState();

/** Same notebook colours the app gives new notebooks. */
const COLORS = ['#FF3D5A80', '#FFB8432F', '#FF3D7A5A', '#FF7A3E9D', '#FFB07D1C', '#FF2F6FB5', '#FF6B5E55', '#FFB0477A'];

async function exportFiles(onProgress?: (done: number, total: number) => void): Promise<VaultFile[]> {
  const v = app().vault;
  if (!v) throw new Error('Notes are not open yet');
  await (await import('./session.ts')).activeSession()?.flush();
  const { renderPageStandalone } = await import('../canvas/engine.ts');
  return exportObsidianVault(v.vault, {
    onProgress,
    pageImage: async (note, pages, i) => {
      const width = note.kind === 'board' ? 1200 : (pages[i]?.size?.width || note.pageSize.width || 794);
      // ~1600 px wide: sharp in Obsidian without making the vault huge.
      const canvas = await renderPageStandalone({ meta: note, pages: [...pages] }, i, Math.min(3, 1600 / width), v.assets);
      return { ext: 'png', bytes: await canvasBytes(canvas, 'image/png') };
    },
  });
}

/** Whether "Export into a folder" can work here (desktop Chromium browsers). */
export const canExportToFolder = () => typeof window !== 'undefined' && 'showDirectoryPicker' in window && !isNative && !isArtifact;

/** Downloads (or shares) the whole vault as an Obsidian vault in a .zip. Returns the file count. */
export async function exportObsidianZip(): Promise<number> {
  app().toast({ text: 'Preparing your Obsidian vault…' });
  const files = await exportFiles();
  const { writeZip } = await import('@inkwright/sync');
  const zip = await writeZip(files.map((f) => ({ path: `Inkwright/${f.path}`, bytes: f.bytes, mtime: f.mtime })));
  await saveFile(`Inkwright for Obsidian ${new Date().toISOString().slice(0, 10)}.zip`, zip, 'application/zip');
  return files.length;
}

/**
 * Writes the Obsidian vault into a folder the user picks (an existing Obsidian vault works: the
 * notes go into an "Inkwright" folder inside it, so nothing of theirs is overwritten).
 */
export async function exportObsidianToFolder(): Promise<{ folder: string; files: number } | null> {
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await (window as unknown as { showDirectoryPicker: (o: unknown) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker({ id: 'inkwright-obsidian', mode: 'readwrite' });
  } catch (e) {
    if ((e as Error).name === 'AbortError') return null;
    throw e;
  }
  const files = await exportFiles();
  const { FileSystemAccessFS } = await import('@inkwright/sync');
  const fs = new FileSystemAccessFS(handle);
  for (const f of files) await fs.writeBytes(`Inkwright/${f.path}`, f.bytes);
  return { folder: handle.name, files: files.length };
}

const isZip = (f: File) => /\.zip$/i.test(f.name) || f.type === 'application/zip' || f.type === 'application/x-zip-compressed';

/** True when a zip holds Markdown notes and is not an Inkwright backup. */
export async function isMarkdownVaultZip(f: File): Promise<boolean> {
  if (!isZip(f)) return false;
  const { readZip } = await import('@inkwright/sync');
  const entries = await readZip(new Uint8Array(await f.arrayBuffer()));
  const names = entries.map((e) => e.path.replace(/^[^/]+\//, ''));
  if (entries.some((e) => /(^|\/)inkwright\.json$/.test(e.path)) && names.some((n) => n.startsWith('notes/'))) return false;
  return entries.some((e) => /\.(md|markdown)$/i.test(e.path));
}

/** Turns picked files (a folder via webkitdirectory, loose files, or zips) into vault files. */
async function toVaultFiles(files: readonly File[]): Promise<VaultFile[]> {
  const out: VaultFile[] = [];
  for (const f of files) {
    if (isZip(f)) {
      const { readZip } = await import('@inkwright/sync');
      for (const e of await readZip(new Uint8Array(await f.arrayBuffer()))) out.push({ path: e.path, bytes: e.bytes, mtime: e.mtime });
    } else {
      const rel = (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name;
      out.push({ path: rel, bytes: new Uint8Array(await f.arrayBuffer()), mtime: f.lastModified || undefined });
    }
  }
  return out;
}

/** Imports an Obsidian (or any Markdown) vault: a folder's files or a zip. */
export async function importMarkdownVault(files: readonly File[]): Promise<ObsidianImportReport | null> {
  const v = app().vault;
  if (!v || !files.length) return null;
  const s = useSettings.getState();
  app().toast({ text: 'Importing notes…' });
  const { inspectPdf } = await import('../canvas/assets.ts');
  const report = await importObsidianVault(v.vault, await toVaultFiles(files), {
    paper: s.defaultPaper,
    pageSize: s.defaultPageSize,
    notebookColors: COLORS,
    pdfPageSizes: async (bytes) => (await inspectPdf(bytes)).sizes,
  });
  await v.buildIndex();
  await app().refresh();
  scheduleSync();
  const n = report.noteIds.length;
  app().toast({
    text: n ? `Imported ${n} ${n === 1 ? 'note' : 'notes'}${report.notebooksCreated ? ` into ${report.notebooksCreated} new ${report.notebooksCreated === 1 ? 'notebook' : 'notebooks'}` : ''}` : 'No Markdown notes found there',
    tone: n ? 'success' : 'error',
  });
  return report;
}

/** Opens a folder picker (all files under it) for importing a vault folder. */
export function pickFolder(): Promise<File[]> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.multiple = true;
    input.setAttribute('webkitdirectory', '');
    input.style.display = 'none';
    input.onchange = () => { resolve([...(input.files ?? [])]); input.remove(); };
    input.oncancel = () => { resolve([]); input.remove(); };
    document.body.appendChild(input);
    input.click();
  });
}
