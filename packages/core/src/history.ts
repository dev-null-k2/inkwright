import { decodePage, encodePage, encodeStroke, VaultLayout } from './codec.ts';
import { requireSafeId, newId } from './ids.ts';
import type { InkStroke, NoteMeta, PageInk, SealedBox } from './model.ts';
import { openJson, sealJson } from './lock.ts';
import { sha256, toHex } from './sha256.ts';
import type { Vault } from './vault.ts';

/**
 * Version history: automatic snapshots of a note, stored in the vault next to it so they sync
 * with it (docs/VAULT_FORMAT.md, "Version history").
 *
 *   notes/<noteId>/history/<snapshotId>.json        one manifest per snapshot (small)
 *   notes/<noteId>/history/blobs/<hash>.json         page contents, shared between snapshots
 *
 * Pages are stored content-addressed, so a snapshot of a 50-page note where one page changed adds
 * one page file. Every file is written once and never changed, so two devices can't conflict over
 * one; pruning only deletes. Snapshots of a locked note are encrypted with the note's key (the
 * manifest keeps only the time, reason and blob names in the clear), and blob names are salted
 * with the lock's salt so equal pages can't be recognised across notes.
 */

export type SnapshotReason = 'open' | 'close' | 'interval' | 'agent' | 'restore' | 'manual';

export const SNAPSHOT_REASONS: Record<SnapshotReason, string> = {
  open: 'Opened',
  close: 'Closed',
  interval: 'While editing',
  agent: 'Before an assistant edit',
  restore: 'Before restoring',
  manual: 'Saved version',
};

/** What a snapshot manifest holds (`history/<id>.json`). */
export interface SnapshotManifest {
  v: 1;
  id: string;
  noteId: string;
  takenAt: number;
  reason: SnapshotReason;
  /** Page blobs in page order (also what pruning needs to collect garbage without a key). */
  blobs: string[];
  /** Fingerprint of the content, to skip snapshots identical to the latest. */
  digest: string;
  /** Plain notes: the metadata and page ids at the time. */
  meta?: NoteMeta;
  pageIds?: string[];
  /** Locked notes: `{ meta, pageIds }` encrypted with the note's key. */
  sealed?: SealedBox;
  /** Optional name of the device that took it. */
  device?: string;
}

export interface SnapshotInfo {
  id: string;
  takenAt: number;
  reason: SnapshotReason;
  pageCount: number;
  /** Title at the time (absent for locked notes until opened). */
  title?: string;
  locked: boolean;
}

export interface Snapshot {
  info: SnapshotInfo;
  meta: NoteMeta;
  pages: PageInk[];
}

const dir = (noteId: string) => `${VaultLayout.noteDir(noteId)}/history`;
const manifestPath = (noteId: string, id: string) => `${dir(noteId)}/${id}.json`;
const blobPath = (noteId: string, hash: string) => `${dir(noteId)}/blobs/${hash}.json`;

const HOUR = 3600_000;
const DAY = 24 * HOUR;

/**
 * Which snapshots to keep (retention): everything from the last two hours; the newest of each
 * hour for a day; the newest of each day for 30 days; the newest of each week for a year; never
 * more than `max`. The newest snapshot is always kept.
 */
export function retainSnapshots(list: readonly { id: string; takenAt: number }[], now: number, max = 300): Set<string> {
  const sorted = [...list].sort((a, b) => b.takenAt - a.takenAt);
  const keep = new Set<string>();
  const seen = new Set<string>();
  sorted.forEach((s, i) => {
    const age = now - s.takenAt;
    let bucket: string | null;
    if (i === 0 || age < 2 * HOUR) bucket = `all:${s.id}`;
    else if (age < DAY) bucket = `h:${Math.floor(s.takenAt / HOUR)}`;
    else if (age < 30 * DAY) bucket = `d:${Math.floor(s.takenAt / DAY)}`;
    else if (age < 365 * DAY) bucket = `w:${Math.floor(s.takenAt / (7 * DAY))}`;
    else bucket = null;
    if (!bucket || seen.has(bucket) || keep.size >= max) return;
    seen.add(bucket);
    keep.add(s.id);
  });
  return keep;
}

/** The parts of a note's metadata a snapshot fingerprint covers. */
function metaDigestPart(m: NoteMeta) {
  return { title: m.title, kind: m.kind, paper: m.paper, pageSize: m.pageSize, tags: m.tags, pageIds: m.pageIds, forms: m.forms, summary: m.summary };
}

export class VersionHistory {
  constructor(private vault: Vault, private clock: () => number = Date.now) {}

  private get fs() { return this.vault.fs; }

  /** Snapshots of a note, newest first (unreadable manifests are skipped). */
  async list(noteId: string): Promise<SnapshotInfo[]> {
    requireSafeId(noteId);
    const out: SnapshotInfo[] = [];
    for (const m of await this.manifests(noteId)) out.push(this.info(m));
    return out.sort((a, b) => b.takenAt - a.takenAt);
  }

  private info(m: SnapshotManifest): SnapshotInfo {
    return { id: m.id, takenAt: m.takenAt, reason: m.reason, pageCount: m.blobs.length, title: m.meta?.title, locked: !!m.sealed };
  }

  private async manifests(noteId: string): Promise<SnapshotManifest[]> {
    const out: SnapshotManifest[] = [];
    for (const e of await this.fs.list(dir(noteId))) {
      if (e.kind !== 'file' || !e.name.endsWith('.json')) continue;
      const text = await this.fs.readText(`${dir(noteId)}/${e.name}`);
      if (!text) continue;
      try {
        const m = JSON.parse(text) as SnapshotManifest;
        if (m && m.v === 1 && typeof m.id === 'string' && Array.isArray(m.blobs) && typeof m.takenAt === 'number') out.push(m);
      } catch { /* a half-synced or corrupt manifest is ignored */ }
    }
    return out;
  }

  private async latest(noteId: string): Promise<SnapshotManifest | null> {
    const all = await this.manifests(noteId);
    return all.sort((a, b) => b.takenAt - a.takenAt)[0] ?? null;
  }

  /** Blob name of a page: its content hash (salted per note while locked). */
  private blobName(meta: NoteMeta, json: string): string {
    return toHex(sha256((meta.lock ? `${meta.lock.kdf.salt}:` : '') + json)).slice(0, 40);
  }

  /**
   * Takes a snapshot of a note as given (the editor passes its current, unlocked content).
   * Skipped (returns null) when nothing changed since the latest snapshot, unless `force`.
   */
  async take(meta: NoteMeta, pages: readonly PageInk[], reason: SnapshotReason, opts: { force?: boolean; device?: string } = {}): Promise<SnapshotInfo | null> {
    requireSafeId(meta.id);
    const key = meta.lock ? this.vault.keyFor(meta.id) : undefined;
    if (meta.lock && !key) return null;
    const blobs: string[] = [];
    const writes: { name: string; json: string }[] = [];
    for (const p of pages) {
      const json = encodePage(p);
      const name = this.blobName(meta, json);
      blobs.push(name);
      writes.push({ name, json });
    }
    const pageIds = pages.map((p) => p.id);
    const digest = toHex(sha256(JSON.stringify({ m: metaDigestPart(meta), blobs, pageIds }))).slice(0, 32);
    const prev = await this.latest(meta.id);
    if (!opts.force && prev?.digest === digest) return null;
    const existing = new Set((await this.fs.list(`${dir(meta.id)}/blobs`)).map((e) => e.name));
    for (const w of writes) {
      if (existing.has(`${w.name}.json`)) continue;
      existing.add(`${w.name}.json`);
      await this.fs.writeText(blobPath(meta.id, w.name), key ? JSON.stringify(await sealJson(key, w.json, `inkstone:history:${w.name}`)) : w.json);
    }
    const now = this.clock();
    const id = newId(now);
    const { lock: _lock, ...plainMeta } = meta;
    const m: SnapshotManifest = { v: 1, id, noteId: meta.id, takenAt: now, reason, blobs, digest };
    if (key) m.sealed = await sealJson(key, { meta: plainMeta, pageIds }, `inkstone:snapshot:${id}`);
    else { m.meta = plainMeta as NoteMeta; m.pageIds = pageIds; }
    if (opts.device) m.device = opts.device;
    await this.fs.writeText(manifestPath(meta.id, id), JSON.stringify(m));
    return this.info(m);
  }

  /** A snapshot's metadata and pages (decrypted for a locked note that is unlocked here). */
  async read(noteId: string, id: string): Promise<Snapshot | null> {
    requireSafeId(noteId);
    requireSafeId(id);
    const text = await this.fs.readText(manifestPath(noteId, id));
    if (!text) return null;
    const m = JSON.parse(text) as SnapshotManifest;
    const key = this.vault.keyFor(noteId);
    let meta: NoteMeta, pageIds: string[];
    if (m.sealed) {
      if (!key) return null;
      ({ meta, pageIds } = await openJson<{ meta: NoteMeta; pageIds: string[] }>(key, m.sealed, `inkstone:snapshot:${m.id}`));
    } else {
      meta = m.meta!;
      pageIds = m.pageIds ?? meta.pageIds;
    }
    const pages: PageInk[] = [];
    for (let i = 0; i < m.blobs.length; i++) {
      const raw = await this.fs.readText(blobPath(noteId, m.blobs[i]!));
      if (raw == null) throw new Error('Part of this version is missing on this device (it may still be syncing).');
      let json = raw;
      const o = JSON.parse(raw);
      if (o && o.v === 1 && typeof o.iv === 'string' && typeof o.data === 'string') {
        if (!key) return null;
        json = await openJson<string>(key, o as SealedBox, `inkstone:history:${m.blobs[i]}`);
      }
      const page = decodePage(json);
      pages.push({ ...page, id: pageIds[i] ?? page.id });
    }
    return { info: this.info(m), meta, pages };
  }

  /**
   * Applies the retention rules (`retainSnapshots`) and deletes page blobs no snapshot uses.
   * Returns how many snapshots were removed.
   */
  async prune(noteId: string, now = this.clock()): Promise<number> {
    requireSafeId(noteId);
    const all = await this.manifests(noteId);
    const keep = retainSnapshots(all, now);
    let removed = 0;
    for (const m of all) {
      if (keep.has(m.id)) continue;
      await this.fs.delete(manifestPath(noteId, m.id));
      removed++;
    }
    const used = new Set(all.filter((m) => keep.has(m.id)).flatMap((m) => m.blobs));
    for (const e of await this.fs.list(`${dir(noteId)}/blobs`)) {
      const name = e.name.replace(/\.json$/, '');
      if (e.kind === 'file' && !used.has(name)) await this.fs.delete(blobPath(noteId, name));
    }
    return removed;
  }

  /**
   * Re-encrypts (or decrypts) every snapshot of a note when it is locked or its lock removed:
   * `from` is the key the files are sealed with now (none for plain), `meta` the note's metadata
   * after the change (its lock decides how files are written). Needs the new key unlocked in the vault.
   */
  async reseal(noteId: string, from: CryptoKey | undefined, meta: NoteMeta): Promise<void> {
    const snaps: Snapshot[] = [];
    const vaultKey = this.vault.keyFor(noteId);
    // Read everything with the old key first.
    if (from) this.vault.unlock(noteId, from); else this.vault.forget(noteId);
    try {
      for (const m of await this.manifests(noteId)) {
        const s = await this.read(noteId, m.id).catch(() => null);
        if (s) snaps.push(s);
      }
    } finally {
      if (vaultKey) this.vault.unlock(noteId, vaultKey); else this.vault.forget(noteId);
    }
    await this.fs.deleteDir(dir(noteId));
    for (const s of snaps.sort((a, b) => a.info.takenAt - b.info.takenAt)) {
      const key = meta.lock ? this.vault.keyFor(noteId) : undefined;
      const snapMeta: NoteMeta = { ...s.meta, lock: meta.lock };
      if (!snapMeta.lock) delete snapMeta.lock;
      const blobs: string[] = [];
      for (const p of s.pages) {
        const json = encodePage(p);
        const name = this.blobName(snapMeta, json);
        blobs.push(name);
        await this.fs.writeText(blobPath(noteId, name), key ? JSON.stringify(await sealJson(key, json, `inkstone:history:${name}`)) : json);
      }
      const pageIds = s.pages.map((p) => p.id);
      const digest = toHex(sha256(JSON.stringify({ m: metaDigestPart(s.meta), blobs, pageIds }))).slice(0, 32);
      const m: SnapshotManifest = { v: 1, id: s.info.id, noteId, takenAt: s.info.takenAt, reason: s.info.reason, blobs, digest };
      const { lock: _l, ...plainMeta } = s.meta;
      if (key) m.sealed = await sealJson(key, { meta: plainMeta, pageIds }, `inkstone:snapshot:${m.id}`);
      else { m.meta = plainMeta as NoteMeta; m.pageIds = pageIds; }
      await this.fs.writeText(manifestPath(noteId, m.id), JSON.stringify(m));
    }
  }
}

// ---- Restoring --------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);
/** Strokes compare as they are stored (coordinates rounded), since snapshots come from files. */
const sameStroke = (a: InkStroke, b: InkStroke) => a === b || JSON.stringify(encodeStroke(a)) === JSON.stringify(encodeStroke(b));

/**
 * A snapshot page made to share item objects with the current page wherever they are unchanged,
 * so the diff between them (`pageDiffBetween`, which compares by identity) is only what really
 * differs — restoring then undoes cleanly and adds only the real changes to the authorship chain.
 */
export function alignPage(current: PageInk | undefined, target: PageInk): PageInk {
  if (!current) return target;
  const reuse = <T extends { id: string }>(cur: readonly T[] | undefined, tgt: readonly T[] | undefined, eq: (a: T, b: T) => boolean = same): T[] | undefined => {
    if (!tgt) return cur && cur.length ? [] : tgt as T[] | undefined;
    const byId = new Map((cur ?? []).map((x) => [x.id, x]));
    const out = tgt.map((x) => { const c = byId.get(x.id); return c && eq(c, x) ? c : x; });
    // Same items in the same order: keep the current array (no diff at all).
    if (cur && cur.length === out.length && out.every((x, i) => x === cur[i])) return cur as T[];
    return out;
  };
  return {
    ...target,
    strokes: reuse(current.strokes, target.strokes, sameStroke) ?? [],
    texts: reuse(current.texts, target.texts),
    images: reuse(current.images, target.images),
    links: reuse(current.links, target.links),
    objects: reuse(current.objects, target.objects),
  };
}
