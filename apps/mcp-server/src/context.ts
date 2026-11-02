import { watch, statSync, type FSWatcher } from 'node:fs';
import { SearchIndex, Vault, VaultLayout, decodeNote, isSafeId, type NoteMeta, type NotebookMeta } from '@inkwright/core';
import { NodeFS, TEMP_PREFIX } from './nodefs.ts';
import { loadResvgRenderer, type PngRenderer } from './render.ts';
import { PolicySource, PolicyVault, createServerTrust, loadAuditSigner, type ServerTrust } from './trust.ts';

export interface ContextOptions {
  /** Absolute or relative path of the vault folder. Must exist. */
  root: string;
  /** Disables every tool that writes. */
  readOnly?: boolean;
  /** Watch the folder for external changes (default true). Without it every call re-checks mtimes. */
  watch?: boolean;
  clock?: () => number;
  /** PNG rasterizer; default lazily loads @resvg/resvg-js. Pass `null` to force SVG-only. */
  renderPng?: PngRenderer | null;
  /** Caches are re-validated at least this often even when the watcher is quiet (default 30 s). */
  maxStaleMs?: number;
  /** A managed AI policy file (enterprise deployments): users can tighten it but not loosen it. */
  managedPolicyFile?: string;
  /** P-256 private JWK file that signs the audit trail (default: a key for this process). */
  auditKeyFile?: string;
}

/**
 * Everything a tool handler needs. Handlers are plain `(ctx, args)` functions so tests (and other
 * hosts, e.g. a CLI) can call them without an MCP transport.
 */
export interface ServerContext {
  readonly root: string;
  readonly fs: NodeFS;
  /** The vault as the AI policy lets agents see it (hidden and local-only notes are missing). */
  readonly vault: PolicyVault;
  /** The AI policy (`ai/policy.json`, plus the managed policy), re-read on refresh. */
  readonly policy: PolicySource;
  /** Audit trail, usage meter, proposals and originals for the trust layer (trust.ts). */
  readonly trust: ServerTrust;
  readonly readOnly: boolean;
  readonly clock: () => number;
  /** True when this context created `inkwright.json` (the folder was not a vault yet). */
  readonly createdVault: boolean;
  /** Drops stale caches after external changes (another device, the app, a sync client). */
  refresh(): Promise<void>;
  /** A search index that reflects the vault's current files. */
  searchIndex(): Promise<SearchIndex>;
  /** Notes changed by this process; makes the next read/search pick them up immediately. */
  markDirty(): void;
  /** Serializes writes from this process (HTTP mode can run calls concurrently). */
  withWriteLock<T>(fn: () => Promise<T>): Promise<T>;
  renderPng(svg: string, width: number): Promise<Uint8Array | null>;
  close(): void;
}

export async function createContext(opts: ContextOptions): Promise<ServerContext> {
  const st = statSync(opts.root, { throwIfNoEntry: false });
  if (!st || !st.isDirectory()) throw new Error(`Vault folder not found: ${opts.root}`);
  const clock = opts.clock ?? Date.now;
  const fs = new NodeFS(opts.root);
  const policy = new PolicySource(fs, opts.managedPolicyFile);
  const vault = new PolicyVault(fs, clock, () => policy.current);
  const readOnly = Boolean(opts.readOnly);
  let createdVault = false;
  if (!readOnly && (await fs.readText(VaultLayout.MANIFEST)) == null) {
    await vault.init();
    createdVault = true;
  }
  await policy.refresh();
  const trust = createServerTrust(fs, fs.root, () => policy.current, { signer: await loadAuditSigner(opts.auditKeyFile), clock });

  const maxStaleMs = opts.maxStaleMs ?? 30_000;
  let generation = 1;
  let watcher: FSWatcher | null = null;
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  // The index sees every note; search results are filtered through the policy vault.
  const index = new IncrementalIndex(fs, new Vault(fs, clock));

  if (opts.watch ?? true) {
    try {
      watcher = watch(fs.root, { recursive: true, persistent: false }, (_event, file) => {
        const name = typeof file === 'string' ? file : '';
        if (name.includes(TEMP_PREFIX)) return;
        generation++;
        // Warm the index once the burst of writes (a sync, an app save) has settled.
        if (warmTimer) clearTimeout(warmTimer);
        warmTimer = setTimeout(() => void index.update().catch(() => {}), 400);
        warmTimer.unref?.();
      });
      watcher.on('error', () => {
        watcher?.close();
        watcher = null;
      });
      watcher.unref?.();
    } catch {
      watcher = null; // Unsupported (e.g. some network/cloud mounts): fall back to mtime checks.
    }
  }

  let vaultCheckedGen = 0;
  let vaultCheckedAt = 0;
  let indexCheckedGen = 0;
  let indexCheckedAt = 0;
  let lock: Promise<unknown> = Promise.resolve();
  let pngLoader: Promise<PngRenderer | null> | null = opts.renderPng === undefined ? null : Promise.resolve(opts.renderPng);

  const fresh = (checkedGen: number, checkedAt: number) => watcher != null && checkedGen === generation && clock() - checkedAt < maxStaleMs;

  return {
    root: fs.root,
    fs,
    vault,
    readOnly,
    clock,
    createdVault,
    policy,
    trust,
    async refresh() {
      if (fresh(vaultCheckedGen, vaultCheckedAt)) return;
      await policy.refresh();
      vaultCheckedGen = generation;
      vaultCheckedAt = clock();
      vault.invalidate();
    },
    async searchIndex() {
      if (!fresh(indexCheckedGen, indexCheckedAt)) {
        const gen = generation;
        await index.update();
        indexCheckedGen = gen;
        indexCheckedAt = clock();
      }
      return index.index;
    },
    markDirty() {
      generation++;
    },
    withWriteLock<T>(fn: () => Promise<T>): Promise<T> {
      const run = lock.then(fn, fn);
      lock = run.catch(() => {});
      return run;
    },
    async renderPng(svg: string, width: number) {
      pngLoader ??= loadResvgRenderer();
      const r = await pngLoader;
      return r ? r(svg, width) : null;
    },
    close() {
      // Shutdown flushes first (index.ts, agent-cli.ts); closing never writes after the fact.
      trust.audit.close();
      trust.usage.close();
      if (warmTimer) clearTimeout(warmTimer);
      watcher?.close();
      watcher = null;
    },
  };
}

/**
 * SearchIndex kept in step with the files: each note gets a signature from the mtimes/sizes of
 * note.json and its page files, and only notes whose signature changed are re-read. A rescan of an
 * unchanged vault is a couple of directory listings per note, so it is cheap enough to run before
 * every search when no watcher is available.
 */
class IncrementalIndex {
  readonly index = new SearchIndex();
  private sigs = new Map<string, string>();
  private running: Promise<void> | null = null;

  constructor(private fs: NodeFS, private vault: Vault) {}

  get size(): number {
    return this.sigs.size;
  }

  update(): Promise<void> {
    // Coalesce concurrent callers onto one scan, but always finish with a scan that started
    // after the latest request.
    const next = (this.running ?? Promise.resolve()).then(() => this.scan());
    this.running = next.finally(() => {
      if (this.running === next) this.running = null;
    });
    return next;
  }

  private async scan(): Promise<void> {
    const seen = new Set<string>();
    for (const e of await this.fs.list(VaultLayout.NOTES_DIR)) {
      if (e.kind !== 'dir' || !isSafeId(e.name)) continue;
      const id = e.name;
      const files = await this.fs.list(VaultLayout.noteDir(id));
      const meta = files.find((f) => f.name === 'note.json' && f.kind === 'file');
      if (!meta) continue;
      seen.add(id);
      const pages = await this.fs.list(VaultLayout.pagesDir(id));
      const sig = [`${meta.mtime}:${meta.size}`, ...pages.filter((p) => p.name.endsWith('.ink.json')).map((p) => `${p.name}:${p.mtime}:${p.size}`)].join('|');
      if (this.sigs.get(id) === sig) continue;
      const text = await this.fs.readText(VaultLayout.noteMeta(id));
      let note: NoteMeta | null = null;
      try {
        note = text == null ? null : decodeNote(text);
      } catch {
        note = null; // half-synced; retry next scan
      }
      if (!note || note.id !== id) {
        this.index.remove(id);
        this.sigs.delete(id);
        continue;
      }
      this.index.indexNote(note, await this.vault.readPages(note));
      this.sigs.set(id, sig);
    }
    for (const id of [...this.sigs.keys()]) {
      if (!seen.has(id)) {
        this.index.remove(id);
        this.sigs.delete(id);
      }
    }
  }
}

// ---- Shared helpers ------------------------------------------------------------------------------

/** Reads note.json straight from disk (bypassing caches); null when the note does not exist. */
export async function readNoteFresh(ctx: ServerContext, id: string): Promise<{ note: NoteMeta; raw: string } | null> {
  requireId(id);
  const raw = await ctx.fs.readText(VaultLayout.noteMeta(id));
  if (raw == null) return null;
  try {
    const note = decodeNote(raw);
    // Notes the AI policy hides from agents read as missing here too.
    if (note.id !== id || !(await ctx.vault.visible(note))) return null;
    return { note, raw };
  } catch {
    return null;
  }
}

export function requireId(id: string, what = 'id'): string {
  if (typeof id !== 'string' || !isSafeId(id)) throw new Error(`Invalid ${what}: ${JSON.stringify(id)} (ids are 1-64 chars of [0-9A-Za-z_-])`);
  return id;
}

export function requireWritable(ctx: ServerContext): void {
  if (ctx.readOnly) throw new Error('The Inkwright vault is mounted read-only (--read-only); write tools are disabled.');
}

/** "Parent / Child" path of a notebook. */
export function notebookPath(all: NotebookMeta[], id: string | undefined): string | null {
  if (!id) return null;
  const byId = new Map(all.map((n) => [n.id, n]));
  const parts: string[] = [];
  let cur = byId.get(id);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    guard.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.length ? parts.join(' / ') : null;
}
