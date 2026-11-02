/**
 * Note templates: any note saved as a starting point — its kind, paper, page size and starter
 * content (typed text, ink, images, imported-PDF pages). New notes made from a template get fresh
 * ids for everything and their `{{date}}`/`{{title}}` placeholders filled in (see daily.ts).
 *
 * Stored in the vault, so they sync with the notes:
 *   templates/<id>/template.json   NoteTemplate
 *   templates/<id>/assets/<name>   files the template's pages use (images, PDFs)
 */
import { expandTemplate } from './daily.ts';
import type { VaultFS } from './fs.ts';
import { isSafeId, newId as defaultNewId, requireSafeId } from './ids.ts';
import { VAULT_FORMAT_VERSION, type NoteKind, type NoteMeta, type PageInk, type PageSize, type PaperSpec } from './model.ts';
import { pageAssets } from './pagetools.ts';
import type { Vault } from './vault.ts';

export interface NoteTemplate {
  id: string;
  name: string;
  kind: NoteKind;
  paper: PaperSpec;
  pageSize: PageSize;
  /** Starter pages. Ids inside are placeholders; they are replaced when the template is used. */
  pages: PageInk[];
  /** Tags given to notes made from it. */
  tags: string[];
  createdAt: number;
  updatedAt: number;
  formatVersion: number;
}

export const TEMPLATES_DIR = 'templates';
const templatePath = (id: string) => `${TEMPLATES_DIR}/${requireSafeId(id)}/template.json`;
const assetPath = (id: string, name: string) => `${TEMPLATES_DIR}/${requireSafeId(id)}/assets/${name}`;
const SAFE_ASSET = /^[0-9A-Za-z_.-]{1,96}$/;

/** Asset names a set of pages refers to (images and backgrounds). */
function templateAssets(pages: readonly PageInk[]): string[] {
  return [...new Set(pages.flatMap(pageAssets))].filter((n) => SAFE_ASSET.test(n) && !n.includes('..'));
}

/**
 * A template from a note as it is now. Handwriting recognition results are dropped (the new note
 * recognizes its own ink); links on ink are kept.
 */
export function templateFromNote(note: NoteMeta, pages: readonly PageInk[], name: string, opts: { id?: string; now?: number } = {}): NoteTemplate {
  const now = opts.now ?? Date.now();
  return {
    id: opts.id ?? defaultNewId(now),
    name: name.trim() || note.title,
    kind: note.kind,
    paper: note.paper,
    pageSize: note.pageSize,
    pages: pages.map((p) => {
      const { recognizedText: _r, recognizedAt: _a, recognizedBy: _b, ...rest } = p;
      return rest as PageInk;
    }),
    tags: note.tags.filter((t) => !(note.inlineTags ?? []).includes(t)),
    createdAt: now,
    updatedAt: now,
    formatVersion: VAULT_FORMAT_VERSION,
  };
}

/**
 * The note a template makes: fresh ids for the note, its pages and every item, links remapped to
 * the new stroke ids, and placeholders in typed text expanded.
 */
export function applyTemplate(t: NoteTemplate, opts: { title: string; date?: Date; notebookId?: string; now?: number; newId?: () => string; locale?: string; daily?: string }): { note: NoteMeta; pages: PageInk[] } {
  const now = opts.now ?? Date.now();
  const id = opts.newId ?? (() => defaultNewId(now));
  const date = opts.date ?? new Date(now);
  const ctx = { date, title: opts.title, locale: opts.locale };
  const pages: PageInk[] = (t.pages.length ? t.pages : [{ id: 'p', strokes: [], formatVersion: VAULT_FORMAT_VERSION }]).map((p) => {
    const strokeIds = new Map<string, string>();
    const out: PageInk = {
      ...p,
      id: id(),
      strokes: p.strokes.map((s) => { const nid = id(); strokeIds.set(s.id, nid); return { ...s, id: nid, createdAt: now }; }),
      formatVersion: VAULT_FORMAT_VERSION,
    };
    if (p.texts) out.texts = p.texts.map((x) => ({ ...x, id: id(), text: expandTemplate(x.text, ctx), createdAt: now }));
    if (p.images) out.images = p.images.map((x) => ({ ...x, id: id(), createdAt: now }));
    if (p.links) out.links = p.links.map((l) => ({ ...l, id: id(), strokeIds: l.strokeIds.map((s) => strokeIds.get(s) ?? s), createdAt: now }));
    return out;
  });
  const note: NoteMeta = {
    id: id(),
    title: opts.title,
    kind: t.kind,
    paper: t.paper,
    pageSize: t.pageSize,
    pageIds: pages.map((p) => p.id),
    notebookId: opts.notebookId,
    tags: [...t.tags],
    createdAt: now,
    updatedAt: now,
    pinned: false,
    formatVersion: VAULT_FORMAT_VERSION,
  };
  if (opts.daily) note.daily = opts.daily;
  return { note, pages };
}

/** Templates in a vault folder. */
export class TemplateStore {
  constructor(private fs: VaultFS) {}

  async list(): Promise<NoteTemplate[]> {
    const out: NoteTemplate[] = [];
    for (const e of await this.fs.list(TEMPLATES_DIR)) {
      if (e.kind !== 'dir' || !isSafeId(e.name)) continue;
      const t = await this.read(e.name);
      if (t) out.push(t);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async read(id: string): Promise<NoteTemplate | null> {
    if (!isSafeId(id)) return null;
    const text = await this.fs.readText(templatePath(id));
    if (text == null) return null;
    try {
      const o = JSON.parse(text);
      if (!o || o.id !== id || !Array.isArray(o.pages)) return null;
      return { ...o, tags: Array.isArray(o.tags) ? o.tags.map(String) : [], name: String(o.name ?? 'Template') } as NoteTemplate;
    } catch {
      return null;
    }
  }

  /** Saves a template made from a vault note, copying the files its pages use. */
  async saveFromNote(vault: Vault, noteId: string, name: string, opts: { pages?: readonly PageInk[]; note?: NoteMeta; now?: number } = {}): Promise<NoteTemplate> {
    const note = opts.note ?? (await vault.readNote(noteId));
    if (!note) throw new Error('Note not found');
    const pages = opts.pages ?? (await vault.readPages(note));
    const t = templateFromNote(note, pages, name, { now: opts.now });
    for (const a of templateAssets(pages)) {
      const bytes = await vault.readAsset(note.id, a);
      if (bytes) await this.fs.writeBytes(assetPath(t.id, a), bytes);
    }
    await this.write(t);
    return t;
  }

  async write(t: NoteTemplate): Promise<void> {
    await this.fs.writeText(templatePath(t.id), JSON.stringify({ ...t, formatVersion: VAULT_FORMAT_VERSION }));
  }

  async rename(id: string, name: string): Promise<void> {
    const t = await this.read(id);
    if (t) await this.write({ ...t, name: name.trim() || t.name, updatedAt: Date.now() });
  }

  async delete(id: string): Promise<void> {
    if (isSafeId(id)) await this.fs.deleteDir(`${TEMPLATES_DIR}/${id}`);
  }

  /** Creates a note from a template in the vault (assets copied in) and returns it. */
  async createNote(vault: Vault, id: string, opts: Parameters<typeof applyTemplate>[1]): Promise<{ note: NoteMeta; pages: PageInk[] }> {
    const t = await this.read(id);
    if (!t) throw new Error('Template not found');
    const made = applyTemplate(t, opts);
    for (const a of templateAssets(made.pages)) {
      const bytes = await this.fs.readBytes(assetPath(t.id, a));
      if (bytes) await vault.writeAsset(made.note.id, a, bytes);
    }
    await vault.saveNote(made.note, made.pages);
    return made;
  }
}
