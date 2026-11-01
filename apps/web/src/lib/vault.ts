import {
  MemoryFS,
  SearchIndex,
  Vault,
  newId,
  type NoteMeta,
  type NotebookMeta,
  type PageInk,
  type VaultFS,
} from '@inkstone/core';
import { IndexedDBFS, CapacitorFS } from '@inkstone/sync';
import { Filesystem } from '@capacitor/filesystem';
import { isNative } from '../platform/env.ts';
import { AssetCache } from '../canvas/assets.ts';
import { renderPageStandalone } from '../canvas/engine.ts';
import { seedWelcome } from './welcome.ts';

/**
 * The app's single gateway to the vault: storage backend for this platform, search index and
 * thumbnails. Files are the source of truth; the index and thumbnails are rebuilt from them.
 */
export class AppVault {
  readonly vault: Vault;
  readonly search = new SearchIndex();
  private thumbs = new Map<string, { at: number; url: string }>();
  private thumbJobs = new Map<string, Promise<string | null>>();
  readonly assets: AssetCache;
  readonly persistent: boolean;

  private constructor(readonly fs: VaultFS, persistent: boolean) {
    this.vault = new Vault(fs);
    this.persistent = persistent;
    this.assets = new AssetCache((noteId, name) => this.vault.readAsset(noteId, name), () => {});
  }

  static async open(): Promise<AppVault> {
    let fs: VaultFS;
    let persistent = true;
    try {
      if (isNative) fs = new CapacitorFS(Filesystem as any, { directory: 'DATA', root: 'Inkstone' });
      else {
        const idb = new IndexedDBFS({ dbName: 'inkstone-vault' });
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
    try { await navigator.storage?.persist?.(); } catch { /* best effort */ }
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
    for (const n of await this.vault.listNotes({ includeTrashed: true })) {
      try {
        this.search.indexNote(n, await this.vault.readPages(n));
      } catch (e) {
        console.warn(`Skipping unreadable note ${n.id}`, e);
      }
    }
  }

  indexNote(note: NoteMeta, pages: PageInk[]) {
    this.search.indexNote(note, pages);
  }

  /** First-page thumbnail as a data URL, cached per note version. */
  async thumbnail(note: NoteMeta): Promise<string | null> {
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
