import {
  KnowledgeIndex,
  MemoryFS,
  SearchIndex,
  Vault,
  newId,
  type NoteMeta,
  type NotebookMeta,
  type PageInk,
  type VaultFS,
} from '@inkwright/core';
import { IndexedDBFS, CapacitorFS } from '@inkwright/sync/storage';
import { Filesystem } from '@capacitor/filesystem';
import { isNative } from '../platform/env.ts';
import { AssetCache } from '../canvas/assets.ts';
import { renderPageStandalone } from '../canvas/engine.ts';
import { seedWelcome } from './welcome.ts';
import { isDesktop } from '../desktop/bridge.ts';
import { DesktopFS } from '../desktop/fs.ts';

/**
 * The app's single gateway to the vault: storage backend for this platform, search index and
 * thumbnails. Files are the source of truth; the index and thumbnails are rebuilt from them.
 */
export class AppVault {
  readonly vault: Vault;
  readonly search = new SearchIndex();
  /** Links, backlinks, mentions, tags and relatedness (lib/knowledge.ts, the graph). */
  readonly knowledge = new KnowledgeIndex();
  private thumbs = new Map<string, { at: number; url: string }>();
  private thumbJobs = new Map<string, Promise<string | null>>();
  readonly assets: AssetCache;
  readonly persistent: boolean;

  private constructor(readonly fs: VaultFS, persistent: boolean) {
    this.vault = new Vault(fs);
    this.persistent = persistent;
    this.assets = new AssetCache((noteId, name) => this.vault.readAsset(noteId, name), () => {});
    // Metadata-only changes (rename, move, trash) and deletions reach the knowledge index here;
    // content changes come through indexNote.
    this.vault.onChange((c) => {
      if (c.type === 'note-deleted') this.knowledge.remove(c.noteId);
      else if (c.type === 'note') void this.vault.readNote(c.noteId).then((n) => { if (n) this.knowledge.updateMeta(n); });
    });
  }

  /**
   * A non-persistent AppVault over another file system: the vault as of a date (time travel,
   * core timeline.ts). It never syncs, and what is written to it is not kept.
   */
  static over(fs: VaultFS, asOf: number): AppVault {
    const v = new AppVault(fs, false);
    v.asOf = asOf;
    return v;
  }

  /** Set when this is a read-only view of the vault at that moment (epoch ms). */
  asOf: number | null = null;

  static async open(): Promise<AppVault> {
    let fs: VaultFS;
    let persistent = true;
    try {
      if (isNative) fs = new CapacitorFS(Filesystem as any, { directory: 'DATA', root: 'Inkwright' });
      // The desktop app: a real folder on disk, shared with the MCP sidecar (docs/DESKTOP.md).
      else if (isDesktop) {
        fs = new DesktopFS();
        await fs.list('');
      } else {
        const idb = new IndexedDBFS({ dbName: 'inkwright-vault' });
        await idb.list(''); // probe: throws when IndexedDB is unavailable (some sandboxes)
        fs = idb;
      }
    } catch (e) {
      console.warn('Persistent storage unavailable; notes will last for this session only', e);
      fs = new MemoryFS();
      persistent = false;
    }
    const app = new AppVault(fs, persistent);
    await app.vault.init();
    if ((await app.vault.listNotes({ includeTrashed: true })).length === 0) await seedWelcome(app.vault);
    // Best effort and never awaited: Firefox asks the user first (a permission prompt) and keeps
    // the promise pending until they answer, which left the app on its start screen.
    try { void navigator.storage?.persist?.()?.catch(() => {}); } catch { /* best effort */ }
    return app;
  }

  async listNotes(includeTrashed = false): Promise<NoteMeta[]> {
    return this.vault.listNotes({ includeTrashed });
  }

  async listNotebooks(): Promise<NotebookMeta[]> {
    return this.vault.listNotebooks();
  }

  /** Indexes every note (title, tags, summary, typed text, recognized handwriting). */
  async buildIndex(): Promise<void> {
    this.search.clear();
    this.knowledge.clear();
    for (const n of await this.vault.listNotes({ includeTrashed: true })) {
      try {
        const pages = await this.vault.readPages(n);
        this.search.indexNote(n, pages);
        this.knowledge.update(n, pages);
      } catch (e) {
        console.warn(`Skipping unreadable note ${n.id}`, e);
      }
    }
  }

  indexNote(note: NoteMeta, pages: PageInk[]) {
    // Never index the content of a locked note (callers pass blank views; this is the backstop).
    if (note.lock) pages = pages.map((p) => ({ id: p.id, strokes: [], formatVersion: p.formatVersion }));
    this.search.indexNote(note, pages);
    this.knowledge.update(note, pages);
  }

  /** First-page thumbnail as a data URL, cached per note version. */
  async thumbnail(note: NoteMeta): Promise<string | null> {
    // Locked notes show a frosted cover instead (their pages are encrypted).
    if (note.lock) return null;
    const c = this.thumbs.get(note.id);
    if (c && c.at === note.updatedAt) return c.url;
    const key = `${note.id}@${note.updatedAt}`;
    let job = this.thumbJobs.get(key);
    if (!job) {
      job = (async () => {
        try {
          const firstId = note.pageIds[0];
          if (!firstId) return null;
          const page = await this.vault.readPage(note.id, firstId);
          const width = note.kind === 'board' ? 900 : note.pageSize.width || 794;
          const canvas = await renderPageStandalone({ meta: note, pages: [page] }, 0, 360 / width, this.assets);
          const url = canvas.toDataURL('image/webp', 0.82);
          this.thumbs.set(note.id, { at: note.updatedAt, url });
          return url;
        } catch (e) {
          console.warn('thumbnail failed', e);
          return null;
        } finally {
          this.thumbJobs.delete(key);
        }
      })();
      this.thumbJobs.set(key, job);
    }
    return job;
  }

  forgetThumb(noteId: string) {
    this.thumbs.delete(noteId);
  }

  newAssetName(ext: string) {
    return `${newId()}.${ext.replace(/[^a-z0-9]/gi, '').toLowerCase() || 'bin'}`;
  }
}
