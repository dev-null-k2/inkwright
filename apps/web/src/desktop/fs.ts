import { normalizePath, type FsEntry, type VaultFS } from '@inkwright/core';
import { bytesOf, invoke } from './bridge.ts';

/**
 * The vault as a folder on disk, through the desktop shell (src-tauri/src/vault.rs). Paths are
 * checked on both sides: `normalizePath` here (no `..`), and again in Rust (relative, inside the
 * vault folder, no symlinks out). Writes are atomic there (temp file + rename). File bytes travel
 * as raw IPC bodies, not JSON, so large PDFs and recordings stay fast.
 */
export class DesktopFS implements VaultFS {
  private enc = new TextEncoder();
  private dec = new TextDecoder();

  async readBytes(path: string): Promise<Uint8Array | null> {
    try {
      return bytesOf(await invoke<ArrayBuffer>('vault_read', { path: normalizePath(path) }));
    } catch (e) {
      if (String((e as Error)?.message ?? e) === 'ENOENT' || e === 'ENOENT') return null;
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.readBytes(path);
    return b ? this.dec.decode(b) : null;
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    await invoke('vault_write', bytes, { 'x-vault-path': encodeURIComponent(normalizePath(path)) });
  }

  writeText(path: string, text: string): Promise<void> {
    return this.writeBytes(path, this.enc.encode(text));
  }

  async delete(path: string): Promise<void> {
    await invoke('vault_delete', { path: normalizePath(path) });
  }

  async deleteDir(path: string): Promise<void> {
    await invoke('vault_delete_dir', { path: normalizePath(path) });
  }

  async list(dir: string): Promise<FsEntry[]> {
    return invoke<FsEntry[]>('vault_list', { path: dir ? normalizePath(dir) : '' });
  }
}
