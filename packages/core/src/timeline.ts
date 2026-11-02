/**
 * Time travel across the whole vault: "show my notes as of <date>" (docs/VAULT_FORMAT.md,
 * "Time travel and branches").
 *
 * Nothing new is stored for this. Each note's version history (history.ts) already holds
 * content-addressed snapshots taken on open, close, while editing and before assistant edits;
 * `AsOfFS` is a read-only view of the vault folder in which every note is what it was at a given
 * moment, assembled from those snapshots. Because it is just a `VaultFS`, everything built on the
 * vault — the library, search, links, the graph — works on the past without knowing it.
 *
 * For each note, at time `t`:
 * - created after `t`: not there;
 * - unchanged since `t` (`updatedAt <= t`): as it is now (in the trash only if it was then);
 * - changed since: the newest snapshot taken at or before `t`;
 * - changed since but no snapshot that old (history pruned, or the note was never opened on a
 *   device that keeps history): left out and counted in `unknown`, rather than shown with
 *   content it did not have then.
 *
 * Notebooks, assets and everything outside `notes/` are shown as they are now. Writes are
 * accepted and dropped, so an editor that autosaves never fails — the past is read-only.
 */
import { VaultLayout, decodeNote, encodeNote, encodePage } from './codec.ts';
import type { FsEntry, VaultFS } from './fs.ts';
import { normalizePath } from './fs.ts';
import { VersionHistory } from './history.ts';
import { isSafeId } from './ids.ts';
import type { NoteMeta, PageInk } from './model.ts';
import { Vault } from './vault.ts';

export interface AsOfNote {
  meta: NoteMeta;
  /** Where the content comes from. */
  source: 'current' | 'snapshot';
  /** The snapshot shown (when `source` is `snapshot`). */
  snapshotId?: string;
  takenAt?: number;
  /** Pages as they were (only for `snapshot`; current notes read through to the vault). */
  pages?: PageInk[];
}

export interface AsOfReport {
  at: number;
  /** Notes shown, by id. */
  notes: Map<string, AsOfNote>;
  /** Notes that existed then but whose content then is not recorded anywhere. */
  unknown: { id: string; title: string }[];
}

/** Works out what every note looked like at `t` (see the module comment for the rules). */
export async function resolveVaultAt(fs: VaultFS, t: number): Promise<AsOfReport> {
  const vault = new Vault(fs);
  const history = new VersionHistory(vault);
  const notes = new Map<string, AsOfNote>();
  const unknown: AsOfReport['unknown'] = [];
  for (const e of await fs.list(VaultLayout.NOTES_DIR)) {
    if (e.kind !== 'dir' || !isSafeId(e.name)) continue;
    const text = await fs.readText(VaultLayout.noteMeta(e.name));
    if (text == null) continue;
    let meta: NoteMeta;
    try {
      meta = decodeNote(text);
    } catch {
      continue;
    }
    if (meta.id !== e.name || meta.createdAt > t) continue;
    if (meta.updatedAt <= t) {
      const m = { ...meta };
      if (m.trashedAt != null && m.trashedAt > t) delete m.trashedAt;
      notes.set(meta.id, { meta: m, source: 'current' });
      continue;
    }
    if (meta.lock) {
      // A locked note's history is sealed; its past can't be shown without its passcode.
      unknown.push({ id: meta.id, title: meta.title });
      continue;
    }
    const list = await history.list(meta.id).catch(() => []);
    const snap = list.find((s) => s.takenAt <= t && !s.locked);
    const full = snap ? await history.read(meta.id, snap.id).catch(() => null) : null;
    if (!snap || !full) {
      unknown.push({ id: meta.id, title: meta.title });
      continue;
    }
    // The snapshot's metadata is the note's then; where it is filed stays what the file says,
    // except the trash, which follows the time.
    const m: NoteMeta = { ...full.meta, id: meta.id, pageIds: full.pages.map((p) => p.id), createdAt: meta.createdAt, updatedAt: Math.min(full.meta.updatedAt ?? snap.takenAt, snap.takenAt) };
    if (meta.trashedAt != null && meta.trashedAt <= t) m.trashedAt = meta.trashedAt;
    else delete m.trashedAt;
    notes.set(meta.id, { meta: m, source: 'snapshot', snapshotId: snap.id, takenAt: snap.takenAt, pages: full.pages });
  }
  return { at: t, notes, unknown };
}

const enc = new TextEncoder();

/** A read-only view of a vault as it was at a moment (see `resolveVaultAt`). */
export class AsOfFS implements VaultFS {
  private constructor(private readonly base: VaultFS, readonly report: AsOfReport) {}

  static async open(base: VaultFS, t: number): Promise<AsOfFS> {
    return new AsOfFS(base, await resolveVaultAt(base, t));
  }

  get at(): number {
    return this.report.at;
  }

  /** `notes/<id>/…` → [id, rest], else null. */
  private split(path: string): [string, string] | null {
    const p = normalizePath(path);
    if (!p.startsWith(`${VaultLayout.NOTES_DIR}/`)) return null;
    const rest = p.slice(VaultLayout.NOTES_DIR.length + 1);
    const slash = rest.indexOf('/');
    return slash < 0 ? [rest, ''] : [rest.slice(0, slash), rest.slice(slash + 1)];
  }

  async readText(path: string): Promise<string | null> {
    const b = await this.readBytes(path);
    return b == null ? null : new TextDecoder().decode(b);
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    const s = this.split(path);
    if (!s) return this.base.readBytes(path);
    const [id, rest] = s;
    const n = this.report.notes.get(id);
    if (!n) return null;
    if (rest === 'note.json') return enc.encode(encodeNote(n.meta));
    if (n.source === 'current') return this.base.readBytes(path);
    const m = /^pages\/([^/]+)\.ink\.json$/.exec(rest);
    if (m) {
      const page = n.pages!.find((p) => p.id === m[1]);
      return page ? enc.encode(encodePage(page)) : null;
    }
    // Derived files (note.md, page SVGs) of the present would not match the past.
    if (rest === 'note.md' || /^pages\/[^/]+\.svg$/.test(rest)) return null;
    return this.base.readBytes(path);
  }

  async list(dir: string): Promise<FsEntry[]> {
    const p = normalizePath(dir);
    if (p === VaultLayout.NOTES_DIR) return (await this.base.list(dir)).filter((e) => e.kind !== 'dir' || this.report.notes.has(e.name));
    const s = this.split(p);
    if (!s) return this.base.list(dir);
    const n = this.report.notes.get(s[0]);
    if (!n) return [];
    if (n.source === 'snapshot' && s[1] === 'pages') return n.pages!.map((pg) => ({ name: `${pg.id}.ink.json`, kind: 'file' as const }));
    return this.base.list(dir);
  }

  // The past is read-only: writes are dropped (an editor's autosave must not fail or change the present).
  async writeText(): Promise<void> {}
  async writeBytes(): Promise<void> {}
  async delete(): Promise<void> {}
  async deleteDir(): Promise<void> {}
}
