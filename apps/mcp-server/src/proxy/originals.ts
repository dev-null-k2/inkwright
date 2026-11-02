/**
 * Originals of shortened blocks, kept on this computer so the model (or anything holding the
 * handle) can get the full text back: `<dir>/<ref>.txt`, where `ref` is the first 16 hex digits of
 * the text's SHA-256 (the budgeter's content address). Shared by the context-saving proxy and the
 * MCP tools `compress_and_store` / `retrieve_original`, so a model talking through the proxy can
 * fetch an original with the Inkwright MCP server's tool.
 *
 * Tool output and logs can hold secrets, so the folder is outside the vault (it never syncs),
 * 0700, files 0600. It is bounded: files older than `maxAgeDays` and, past `maxBytes`, the least
 * recently used go first (reads touch the file's time).
 */
import { mkdirSync, chmodSync } from 'node:fs';
import { readdir, readFile, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { contentRef, type ContentStore } from '@inkwright/ai';

export function defaultOriginalsDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.INKWRIGHT_ORIGINALS_DIR) return path.resolve(env.INKWRIGHT_ORIGINALS_DIR);
  if (process.platform === 'win32') return path.join(env.LOCALAPPDATA || path.join(homedir(), 'AppData', 'Local'), 'Inkwright', 'originals');
  return path.join(env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'inkwright', 'originals');
}

export interface DiskContentStoreOptions {
  /** Total size kept (default 512 MiB). */
  maxBytes?: number;
  /** Age after which originals are removed (default 30 days). */
  maxAgeDays?: number;
  clock?: () => number;
}

export class DiskContentStore implements ContentStore {
  private puts = 0;
  constructor(readonly dir: string, private o: DiskContentStoreOptions = {}) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') chmodSync(dir, 0o700);
  }

  private file(ref: string) {
    if (!/^[0-9a-f]{16}$/.test(ref)) throw new Error('Not a content ref.');
    return path.join(this.dir, `${ref}.txt`);
  }

  async put(text: string): Promise<string> {
    const ref = contentRef(text);
    const f = this.file(ref);
    if (!(await stat(f).catch(() => null))) await writeFile(f, text, { mode: 0o600 });
    else await this.touch(f);
    // Prune now and then, not on every write.
    if (++this.puts % 50 === 1) void this.prune().catch(() => {});
    return ref;
  }

  async get(ref: string): Promise<string | null> {
    if (!/^[0-9a-f]{16}$/.test(ref)) return null;
    const f = this.file(ref);
    const text = await readFile(f, 'utf8').catch(() => null);
    if (text != null) await this.touch(f);
    return text;
  }

  private async touch(f: string) {
    const t = new Date(this.o.clock?.() ?? Date.now());
    await utimes(f, t, t).catch(() => {});
  }

  /** Removes expired originals, then the least recently used beyond the size limit. */
  async prune(): Promise<{ removed: number; bytes: number }> {
    const now = this.o.clock?.() ?? Date.now();
    const maxAge = (this.o.maxAgeDays ?? 30) * 86_400_000;
    const maxBytes = this.o.maxBytes ?? 512 * 1024 * 1024;
    const files: Array<{ f: string; size: number; at: number }> = [];
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!/^[0-9a-f]{16}\.txt$/.test(name)) continue;
      const f = path.join(this.dir, name);
      const st = await stat(f).catch(() => null);
      if (st) files.push({ f, size: st.size, at: st.mtimeMs });
    }
    files.sort((a, b) => b.at - a.at);
    let kept = 0;
    let removed = 0;
    for (const x of files) {
      if (now - x.at > maxAge || kept + x.size > maxBytes) {
        await rm(x.f, { force: true });
        removed++;
      } else kept += x.size;
    }
    return { removed, bytes: kept };
  }
}
