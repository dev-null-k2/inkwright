import { variantFiles, getLocalModel, type ModelRef, type RepoFile } from '@inkstone/ai';

/**
 * Model weights on this device, in the Origin Private File System (OPFS): one folder per
 * repository, files written in place as they download so an interrupted download resumes where it
 * stopped (HTTP Range) instead of starting over. A small index records each file's expected size;
 * a file counts as present only when its size matches, and a variant counts as installed when all
 * of its files are present. Nothing here is synced: models are per device.
 *
 * Reading (status, size, delete) works on the main thread; writing uses synchronous access handles,
 * which only exist in workers, so downloads run in the AI worker.
 */

const ROOT = 'inkstone-models';
const INDEX = '.index.json';
export const HF_HOST = 'https://huggingface.co';

export type FileIndex = Record<string, number>;

const dirName = (repo: string) => repo.replace(/\//g, '__');
const fileName = (path: string) => path.replace(/\//g, '__');

export function opfsAvailable(): boolean {
  return typeof navigator !== 'undefined' && typeof navigator.storage?.getDirectory === 'function';
}

async function root(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(ROOT, { create: true });
}

export async function repoDir(repo: string, create = true): Promise<FileSystemDirectoryHandle | null> {
  try {
    return await (await root()).getDirectoryHandle(dirName(repo), { create });
  } catch {
    return null;
  }
}

export async function readIndex(dir: FileSystemDirectoryHandle): Promise<FileIndex> {
  try {
    const f = await (await dir.getFileHandle(INDEX)).getFile();
    return JSON.parse(await f.text()) as FileIndex;
  } catch {
    return {};
  }
}

/** Size of a stored file (0 when absent). */
export async function storedSize(dir: FileSystemDirectoryHandle, path: string): Promise<number> {
  try {
    return (await (await dir.getFileHandle(fileName(path))).getFile()).size;
  } catch {
    return 0;
  }
}

export async function fileHandle(dir: FileSystemDirectoryHandle, path: string, create: boolean): Promise<FileSystemFileHandle | null> {
  try {
    return await dir.getFileHandle(fileName(path), { create });
  } catch {
    return null;
  }
}

/** A complete stored file, or null. */
export async function readStored(repo: string, path: string): Promise<File | null> {
  const dir = await repoDir(repo, false);
  if (!dir) return null;
  const idx = await readIndex(dir);
  const want = idx[path];
  const h = await fileHandle(dir, path, false);
  if (!h) return null;
  const f = await h.getFile();
  return want != null && f.size === want ? f : null;
}

/** Repository listing with sizes (Hugging Face API). */
export async function listRepo(repo: string, signal?: AbortSignal, fetchFn: typeof fetch = fetch): Promise<RepoFile[]> {
  const res = await fetchFn(`${HF_HOST}/api/models/${repo}/tree/main?recursive=true`, { signal });
  if (!res.ok) throw new Error(`Couldn't list ${repo} on Hugging Face (HTTP ${res.status}).`);
  const rows = (await res.json()) as { type: string; path: string; size: number; lfs?: { size: number } }[];
  return rows.filter((r) => r.type === 'file').map((r) => ({ path: r.path, size: r.lfs?.size ?? r.size }));
}

/** The files a model variant needs, using the stored index when offline. */
export async function filesFor(ref: ModelRef, signal?: AbortSignal): Promise<RepoFile[]> {
  const spec = getLocalModel(ref.id);
  if (!spec) throw new Error(`Unknown on-device model ${ref.id}.`);
  return variantFiles(spec, { device: ref.device, dtype: ref.dtype, bytes: ref.bytes }, await listRepo(ref.repo, signal));
}

const manifestName = (ref: ModelRef) => `.manifest-${ref.dtype}.json`;

/** Records the variant's file list once every file is complete. */
export async function writeManifest(dir: FileSystemDirectoryHandle, ref: ModelRef, files: RepoFile[]): Promise<void> {
  const h = await dir.getFileHandle(manifestName(ref), { create: true });
  const w = await (h as any).createWritable?.();
  const body = JSON.stringify({ files, completedAt: Date.now() });
  if (w) {
    await w.write(body);
    await w.close();
  } else {
    const a = await (h as any).createSyncAccessHandle();
    try {
      const bytes = new TextEncoder().encode(body);
      a.truncate(0);
      a.write(bytes, { at: 0 });
      a.flush();
    } finally {
      a.close();
    }
  }
}

export interface StoredStatus {
  installed: boolean;
  bytesOnDevice: number;
}

/** Whether a variant is fully on this device, and how much of it is (for "resume" UI). */
export async function storedStatus(ref: ModelRef): Promise<StoredStatus> {
  const dir = await repoDir(ref.repo, false);
  if (!dir) return { installed: false, bytesOnDevice: 0 };
  let manifest: { files: RepoFile[] } | null = null;
  try {
    manifest = JSON.parse(await (await (await dir.getFileHandle(manifestName(ref))).getFile()).text());
  } catch {
    /* not complete */
  }
  const idx = await readIndex(dir);
  const files = manifest?.files ?? Object.entries(idx).map(([path, size]) => ({ path, size }));
  let bytes = 0;
  let complete = !!manifest;
  for (const f of files) {
    const have = await storedSize(dir, f.path);
    bytes += Math.min(have, f.size);
    if (have !== f.size) complete = false;
  }
  return { installed: complete, bytesOnDevice: bytes };
}

/**
 * Deletes a variant's weights. Side files (tokenizer, config) shared with other variants of the
 * same repository are kept unless no variant remains.
 */
export async function removeStored(ref: ModelRef): Promise<void> {
  const dir = await repoDir(ref.repo, false);
  if (!dir) return;
  const others: string[] = [];
  for await (const [name] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (name.startsWith('.manifest-') && name !== manifestName(ref)) others.push(name);
  }
  if (!others.length) {
    await (await root()).removeEntry(dirName(ref.repo), { recursive: true });
    return;
  }
  const prefix = fileName(`onnx/${ref.onnxBase}`);
  const suffix = ref.dtype === 'fp32' ? '.onnx' : `_${ref.dtype}.onnx`;
  for await (const [name] of (dir as any).entries() as AsyncIterable<[string, FileSystemHandle]>) {
    if (name === manifestName(ref) || (name.startsWith(prefix) && name.slice(prefix.length).startsWith(suffix))) await dir.removeEntry(name);
  }
}

/** Maps a transformers.js cache key (remote URL or local path) to repository and file. */
export function parseCacheKey(key: string): { repo: string; path: string } | null {
  const k = key.replace(/^https?:\/\/[^/]+/, '');
  const m = /^\/?([^/]+\/[^/]+)\/resolve\/[^/]+\/(.+)$/.exec(k) ?? /^\/?models\/([^/]+\/[^/]+)\/(.+)$/.exec(k);
  return m ? { repo: decodeURIComponent(m[1]!), path: decodeURIComponent(m[2]!.split('?')[0]!) } : null;
}
