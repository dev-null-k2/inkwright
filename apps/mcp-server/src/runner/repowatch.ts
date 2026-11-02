/**
 * Re-scans mounted repositories when their git HEAD moves (a commit, a checkout, a pull), so code
 * links in notes show drift without anyone pressing Re-scan (docs/DEVELOPERS.md). Used by the
 * always-on runner (`inkwright-agent run --watch-repo <folder>`) and, through the same class, by
 * the desktop app's sidecar.
 *
 * HEAD is read from the files git itself keeps — `.git/HEAD`, the branch's loose ref, or
 * `packed-refs` — with no git binary needed; worktrees and submodules (`.git` is a file with
 * `gitdir: …`) are followed. The check runs every `intervalMs` (default 30 s; file watching is
 * unreliable across network and synced folders). A scan replaces the repository's code source in
 * the vault (the same source `inkwright scan` writes), records the commit it was made at
 * (`source.json` › `head`), and logs how many code links now drift.
 */
import { readFile, stat } from 'node:fs/promises';
import * as path from 'node:path';
import { CodeStore } from '@inkwright/core';
import type { ServerContext } from '../context.ts';
import { scanFolderIntoVault, sourceIdFor, vaultDrift } from '../dev/repo.ts';

export interface GitHead {
  /** `refs/heads/main`, or null when detached. */
  ref: string | null;
  commit: string;
}

/** The `.git` folder of a working tree (following `gitdir:` files for worktrees and submodules). */
async function gitDir(repo: string): Promise<string | null> {
  const dot = path.join(repo, '.git');
  const st = await stat(dot).catch(() => null);
  if (!st) return null;
  if (st.isDirectory()) return dot;
  const m = /^gitdir:\s*(.+)\s*$/m.exec(await readFile(dot, 'utf8').catch(() => ''));
  return m ? path.resolve(repo, m[1]!.trim()) : null;
}

/** The current HEAD of a repository folder, or null when it isn't one (or HEAD can't be read). */
export async function readGitHead(repo: string): Promise<GitHead | null> {
  const dir = await gitDir(repo);
  if (!dir) return null;
  const head = (await readFile(path.join(dir, 'HEAD'), 'utf8').catch(() => '')).trim();
  if (/^[0-9a-f]{40,64}$/.test(head)) return { ref: null, commit: head };
  const ref = /^ref:\s*(\S+)$/.exec(head)?.[1];
  if (!ref || ref.split('/').includes('..')) return null;
  // Worktrees keep HEAD in their own dir and refs in the common dir.
  const common = (await readFile(path.join(dir, 'commondir'), 'utf8').catch(() => '')).trim();
  const dirs = [dir, ...(common ? [path.resolve(dir, common)] : [])];
  for (const d of dirs) {
    const loose = (await readFile(path.join(d, ref), 'utf8').catch(() => '')).trim();
    if (/^[0-9a-f]{40,64}$/.test(loose)) return { ref, commit: loose };
  }
  for (const d of dirs) {
    const packed = await readFile(path.join(d, 'packed-refs'), 'utf8').catch(() => '');
    for (const line of packed.split('\n')) {
      const [sha, name] = line.trim().split(' ');
      if (name === ref && /^[0-9a-f]{40,64}$/.test(sha ?? '')) return { ref, commit: sha! };
    }
  }
  return null; // an unborn branch (no commits yet)
}

export interface WatchedRepo {
  /** Folder of the working tree. */
  path: string;
  /** Code source id and name (default: from the folder name, as `inkwright scan`). */
  id?: string;
  name?: string;
}

export interface RepoWatchOptions {
  ctx: ServerContext;
  repos: WatchedRepo[];
  intervalMs?: number;
  log?: (m: string) => void;
  /** Called after each re-scan (tests, the sidecar's UI). */
  onScan?: (e: { repo: string; sourceId: string; head: GitHead; drifted: number }) => void;
}

export class RepoWatcher {
  private heads = new Map<string, string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private checking: Promise<void> | null = null;
  private log: (m: string) => void;

  constructor(private o: RepoWatchOptions) {
    this.log = o.log ?? (() => {});
  }

  /** Remembers each repository's HEAD, scanning those the vault has no scan of at that commit. */
  async start(): Promise<void> {
    if (this.o.ctx.readOnly) throw new Error('Watching repositories needs a writable vault (scans are written there).');
    await this.check();
    this.timer = setInterval(() => void this.check(), this.o.intervalMs ?? 30_000);
    this.timer.unref?.();
    this.log(`Watching git HEAD of ${this.o.repos.map((r) => r.path).join(', ')} (re-scan on change).`);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One pass over every repository; scans those whose HEAD moved. Public for tests. */
  check(): Promise<void> {
    this.checking ??= (async () => {
      try {
        for (const r of this.o.repos) await this.checkOne(r).catch((e) => this.log(`Watching ${r.path}: ${(e as Error).message}`));
      } finally {
        this.checking = null;
      }
    })();
    return this.checking;
  }

  private async checkOne(r: WatchedRepo): Promise<void> {
    const head = await readGitHead(r.path);
    if (!head) return;
    const id = r.id ?? sourceIdFor(r.name ?? path.basename(path.resolve(r.path)));
    const last = this.heads.get(r.path);
    if (last === head.commit) return;
    if (last === undefined) {
      // First look: scan only when the vault's scan was made at another commit (or never).
      const prev = (await new CodeStore(this.o.ctx.fs).readSource(id)) as ({ head?: GitHead } | null);
      this.heads.set(r.path, head.commit);
      if (prev?.head?.commit === head.commit) return;
    }
    this.heads.set(r.path, head.commit);
    const { source } = await this.o.ctx.withWriteLock(() => scanFolderIntoVault(this.o.ctx.fs, r.path, { id, ...(r.name ? { name: r.name } : {}), head }));
    this.o.ctx.markDirty();
    const drifted = (await vaultDrift(this.o.ctx.vault)).length;
    this.log(`${source.name}: HEAD moved to ${head.commit.slice(0, 10)}${head.ref ? ` (${head.ref.replace(/^refs\/heads\//, '')})` : ''}; re-scanned ${source.stats.files} files, ${drifted} code link${drifted === 1 ? '' : 's'} drifted.`);
    this.o.onScan?.({ repo: r.path, sourceId: source.id, head, drifted });
  }
}
