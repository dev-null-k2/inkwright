/**
 * Branches for proposed edits (docs/VAULT_FORMAT.md, "Branches"): instead of approving an
 * agent's dry-run proposal straight into your notes, you can try it on a named branch — a shadow
 * copy of only the notes it touches — open it, compare it with your notes side by side, and then
 * merge it or throw it away.
 *
 *   branches/<branchId>.json                      the branch: name, status, and per note its
 *                                                 base (main when the branch first touched it)
 *                                                 and head (the branch's version)
 *   notes/<noteId>/history/blobs/<hash>.json      page contents, content-addressed and shared
 *                                                 with version history (history.ts)
 *
 * A branch stores page *references*, not copies: a page that the branch did not change is the
 * same blob as the version history's (and as the base's), so a branch that adds a paragraph to a
 * 40-page note costs one page file. Pruning version history keeps blobs that open branches use.
 *
 * Changes are made on a branch through `OverlayFS`: a copy-on-write view of the vault in which
 * the branch's notes are already in their head state. Whatever runs on it — an agent's recorded
 * operation, applied by the same code that would apply it for real — writes only to the overlay;
 * `capture` then records the notes it changed as the branch's new heads.
 */
import { VaultLayout, decodeNote, decodePage, encodeNote, encodePage } from './codec.ts';
import { normalizePath, type FsEntry, type VaultFS } from './fs.ts';
import { isSafeId, newId, requireSafeId } from './ids.ts';
import type { NoteMeta, PageInk } from './model.ts';
import { sha256, toHex } from './sha256.ts';
import { Vault } from './vault.ts';

export const BRANCHES_DIR = 'branches';

/** A note as a branch records it: metadata and its pages as blob names, in page order. */
export interface BranchNoteState {
  meta: NoteMeta;
  pageIds: string[];
  blobs: string[];
}

export interface BranchNote {
  /** Title when the branch last touched it (for lists). */
  title: string;
  /** Main's version when the branch first changed the note; null when the branch created it. */
  base: BranchNoteState | null;
  head: BranchNoteState;
}

export type BranchStatus = 'open' | 'merged' | 'discarded';

export interface Branch {
  v: 1;
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  status: BranchStatus;
  decidedAt?: number;
  /** Who made the changes on it ("Assistant", a routine's name). */
  origin: { source: string; label: string };
  /** Proposal ids applied on it, in order. */
  proposals: string[];
  notes: Record<string, BranchNote>;
}

const branchPath = (id: string) => `${BRANCHES_DIR}/${id}.json`;
const blobPath = (noteId: string, hash: string) => `${VaultLayout.noteDir(noteId)}/history/blobs/${hash}.json`;
/** Same naming as version history (unlocked notes), so equal pages are one file. */
const blobName = (json: string) => toHex(sha256(json)).slice(0, 40);

// ---- Copy-on-write overlay --------------------------------------------------------------------------

/**
 * A copy-on-write view of a VaultFS: reads see the overlay's own writes and deletions first, then
 * the base; nothing is ever written to the base. `changed` lists what was written or deleted.
 */
export class OverlayFS implements VaultFS {
  private files = new Map<string, Uint8Array | null>();

  constructor(readonly base: VaultFS) {}

  private mark = new Map<string, Uint8Array | null>();

  /** Paths written (bytes) or deleted (null) through the overlay. */
  get changed(): ReadonlyMap<string, Uint8Array | null> {
    return this.files;
  }

  /** Remembers the overlay as it is, so `changedSinceCheckpoint` reports only later writes. */
  checkpoint(): void {
    this.mark = new Map(this.files);
  }

  /** Paths written or deleted since the last `checkpoint` (all of them if there was none). */
  changedSinceCheckpoint(): string[] {
    return [...this.files.keys()].filter((p) => !this.mark.has(p) || this.mark.get(p) !== this.files.get(p));
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.readBytes(path);
    return b == null ? null : new TextDecoder().decode(b);
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const p = normalizePath(path);
    if (this.files.has(p)) return this.files.get(p)?.slice() ?? null;
    return this.base.readBytes(p);
  }

  async writeText(path: string, text: string): Promise<void> {
    this.files.set(normalizePath(path), new TextEncoder().encode(text));
  }

  async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(normalizePath(path), bytes.slice());
  }

  async delete(path: string): Promise<void> {
    this.files.set(normalizePath(path), null);
  }

  async deleteDir(path: string): Promise<void> {
    const p = normalizePath(path);
    const stack = [p];
    while (stack.length) {
      const d = stack.pop()!;
      for (const e of await this.list(d)) {
        const child = d ? `${d}/${e.name}` : e.name;
        if (e.kind === 'dir') stack.push(child);
        else this.files.set(child, null);
      }
    }
  }

  async list(dir: string): Promise<FsEntry[]> {
    const p = normalizePath(dir);
    const prefix = p ? `${p}/` : '';
    const out = new Map<string, FsEntry>();
    for (const e of await this.base.list(p)) out.set(e.name, e);
    // Overlay entries: files written here, and directories that hold them.
    for (const [path, bytes] of this.files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 0) {
        if (bytes) out.set(rest, { name: rest, kind: 'file', size: bytes.length });
        else out.delete(rest);
      } else if (bytes && !out.has(rest.slice(0, slash))) out.set(rest.slice(0, slash), { name: rest.slice(0, slash), kind: 'dir' });
    }
    // A directory whose every file was deleted here is gone.
    for (const [name, e] of [...out]) {
      if (e.kind !== 'dir') continue;
      if (!(await this.hasFiles(`${prefix}${name}`))) out.delete(name);
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async hasFiles(dir: string): Promise<boolean> {
    for (const [path, bytes] of this.files) if (bytes && path.startsWith(`${dir}/`)) return true;
    const deletedUnder = [...this.files].some(([path, b]) => b === null && path.startsWith(`${dir}/`));
    if (!deletedUnder) return (await this.base.list(dir)).length > 0;
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop()!;
      for (const e of await this.base.list(d)) {
        const child = `${d}/${e.name}`;
        if (e.kind === 'dir') stack.push(child);
        else if (this.files.get(child) !== null) return true;
      }
    }
    return false;
  }
}

// ---- The store ----------------------------------------------------------------------------------------

export interface BranchInfo {
  id: string;
  name: string;
  status: BranchStatus;
  createdAt: number;
  updatedAt: number;
  origin: Branch['origin'];
  /** Notes it changes: id and title. */
  notes: { id: string; title: string; isNew: boolean }[];
  proposals: number;
}

/** A note's two sides on a branch, for comparing and merging. */
export interface BranchSides {
  noteId: string;
  base: { meta: NoteMeta; pages: PageInk[] } | null;
  head: { meta: NoteMeta; pages: PageInk[] };
}

export class BranchStore {
  constructor(private readonly fs: VaultFS, private readonly clock: () => number = Date.now) {}

  async list(): Promise<BranchInfo[]> {
    const out: BranchInfo[] = [];
    for (const e of await this.fs.list(BRANCHES_DIR)) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      const b = await this.get(e.name.slice(0, -5));
      if (b) out.push(info(b));
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async get(id: string): Promise<Branch | null> {
    if (!isSafeId(id)) return null;
    const raw = await this.fs.readText(branchPath(id));
    if (!raw) return null;
    try {
      const b = JSON.parse(raw) as Branch;
      return b && b.v === 1 && b.id === id && typeof b.notes === 'object' ? b : null;
    } catch {
      return null;
    }
  }

  /** An open branch with this name, if there is one. */
  async findOpen(name: string): Promise<Branch | null> {
    for (const i of await this.list()) if (i.status === 'open' && i.name === name) return this.get(i.id);
    return null;
  }

  async create(name: string, origin: Branch['origin']): Promise<Branch> {
    const now = this.clock();
    const b: Branch = { v: 1, id: newId(now), name: name.trim() || 'Untitled branch', createdAt: now, updatedAt: now, status: 'open', origin, proposals: [], notes: {} };
    await this.save(b);
    return b;
  }

  private async save(b: Branch): Promise<void> {
    await this.fs.writeText(branchPath(b.id), `${JSON.stringify(b, null, 2)}\n`);
  }

  /**
   * A workspace to change the branch in: an overlay of the vault where the branch's notes are
   * already at their heads, and a Vault over it.
   */
  async workspace(b: Branch): Promise<{ fs: OverlayFS; vault: Vault }> {
    const fs = new OverlayFS(this.fs);
    for (const [noteId, n] of Object.entries(b.notes)) {
      const head = await this.readState(noteId, n.head);
      await fs.writeText(VaultLayout.noteMeta(noteId), encodeNote(head.meta));
      for (const p of head.pages) await fs.writeText(VaultLayout.pageInk(noteId, p.id), encodePage(p));
    }
    fs.checkpoint();
    return { fs, vault: new Vault(fs, this.clock) };
  }

  /**
   * Records what changed in a workspace as the branch's new heads (and, for notes it touches for
   * the first time, main's version as their base). Returns the ids of the notes it recorded.
   */
  async capture(b: Branch, ws: { fs: OverlayFS }, proposalId?: string): Promise<string[]> {
    const touched = new Set<string>();
    for (const path of ws.fs.changedSinceCheckpoint()) {
      const m = /^notes\/([^/]+)\/(note\.json|pages\/[^/]+\.ink\.json)$/.exec(path);
      if (m && isSafeId(m[1]!)) touched.add(m[1]!);
    }
    const main = new Vault(this.fs, this.clock);
    const branchVault = new Vault(ws.fs, this.clock);
    for (const noteId of touched) {
      const meta = await branchVault.readNote(noteId);
      if (!meta) continue;
      if (meta.lock) throw new Error('A locked note can’t be changed on a branch.');
      const pages = await branchVault.readPages(meta);
      const existing = b.notes[noteId];
      let base = existing ? existing.base : null;
      if (!existing) {
        const mainMeta = await main.readNote(noteId);
        if (mainMeta?.lock) throw new Error('A locked note can’t be changed on a branch.');
        base = mainMeta ? await this.writeState(mainMeta, await main.readPages(mainMeta)) : null;
      }
      b.notes[noteId] = { title: meta.title, base, head: await this.writeState(meta, pages) };
    }
    if (proposalId && !b.proposals.includes(proposalId)) b.proposals.push(proposalId);
    b.updatedAt = this.clock();
    await this.save(b);
    return [...touched];
  }

  /** Both sides of a note on a branch. */
  async sides(b: Branch, noteId: string): Promise<BranchSides | null> {
    const n = b.notes[noteId];
    if (!n) return null;
    return { noteId, base: n.base ? await this.readState(noteId, n.base) : null, head: await this.readState(noteId, n.head) };
  }

  /** Marks a branch merged or discarded. Discarding also removes what only the branch used. */
  async decide(id: string, status: 'merged' | 'discarded'): Promise<Branch | null> {
    const b = await this.get(id);
    if (!b || b.status !== 'open') return b;
    b.status = status;
    b.decidedAt = this.clock();
    await this.save(b);
    if (status === 'discarded') await this.collect(b);
    return b;
  }

  /** Deletes a decided branch's file (its blobs go with the next history prune). */
  async remove(id: string): Promise<void> {
    requireSafeId(id);
    const b = await this.get(id);
    if (b?.status === 'open') throw new Error('Merge or discard the branch first.');
    if (b) await this.collect(b);
    await this.fs.delete(branchPath(id));
  }

  /** Blobs of notes that exist only on this branch (no note in main): nothing else can use them. */
  private async collect(b: Branch): Promise<void> {
    for (const [noteId, n] of Object.entries(b.notes)) {
      if (n.base || b.status === 'merged') continue;
      if ((await this.fs.readText(VaultLayout.noteMeta(noteId))) != null) continue;
      await this.fs.deleteDir(VaultLayout.noteDir(noteId));
    }
  }

  private async writeState(meta: NoteMeta, pages: readonly PageInk[]): Promise<BranchNoteState> {
    const blobs: string[] = [];
    for (const p of pages) {
      const json = encodePage(p);
      const name = blobName(json);
      blobs.push(name);
      const path = blobPath(meta.id, name);
      if ((await this.fs.readText(path)) == null) await this.fs.writeText(path, json);
    }
    const { lock: _l, ...plain } = meta;
    return { meta: plain as NoteMeta, pageIds: pages.map((p) => p.id), blobs };
  }

  private async readState(noteId: string, s: BranchNoteState): Promise<{ meta: NoteMeta; pages: PageInk[] }> {
    const pages: PageInk[] = [];
    for (let i = 0; i < s.blobs.length; i++) {
      const raw = await this.fs.readText(blobPath(noteId, s.blobs[i]!));
      if (raw == null) throw new Error('Part of this branch is missing on this device (it may still be syncing).');
      pages.push({ ...decodePage(raw), id: s.pageIds[i] ?? decodePage(raw).id });
    }
    return { meta: decodeNote(encodeNote({ ...s.meta, pageIds: s.pageIds })), pages };
  }
}

function info(b: Branch): BranchInfo {
  return {
    id: b.id,
    name: b.name,
    status: b.status,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    origin: b.origin,
    notes: Object.entries(b.notes).map(([id, n]) => ({ id, title: n.title, isNew: !n.base })),
    proposals: b.proposals.length,
  };
}

/** Page blobs of a note that open branches still need (version-history pruning keeps them). */
export async function branchBlobsInUse(fs: VaultFS, noteId: string): Promise<Set<string>> {
  const used = new Set<string>();
  for (const e of await fs.list(BRANCHES_DIR)) {
    if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
    try {
      const b = JSON.parse((await fs.readText(`${BRANCHES_DIR}/${e.name}`)) ?? 'null') as Branch | null;
      const n = b?.status === 'open' ? b.notes?.[noteId] : undefined;
      if (!n) continue;
      for (const h of [...(n.base?.blobs ?? []), ...n.head.blobs]) used.add(h);
    } catch {
      /* a half-synced branch file is ignored */
    }
  }
  return used;
}
