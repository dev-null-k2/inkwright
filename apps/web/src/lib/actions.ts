import { newId, newPage, PAGE_SIZES, type NoteKind, type NoteMeta, type NotebookMeta, type PageInk, type PageSize, type PaperSpec } from '@inkstone/core';
import { useApp } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';
import { askConfirm, askText } from '../ui/prompts.tsx';
import { inspectPdf } from '../canvas/assets.ts';
import { scheduleSync } from './sync.ts';
import { classifyFile, isHeic, readText, textToPages } from './openFiles.ts';

const app = () => useApp.getState();

async function reindex(id: string) {
  const v = app().vault;
  if (!v) return;
  const n = await v.vault.readNote(id);
  if (n) v.indexNote(n, await v.vault.readPages(n));
  else v.search.remove(id);
}

async function after(id?: string) {
  if (id) await reindex(id);
  await app().refresh();
  scheduleSync();
}

/** Re-indexes a note written outside these actions (e.g. "Extract pages") and refreshes the library. */
export const noteChanged = (id: string) => after(id);

export async function createNote(opts: { title?: string; kind?: NoteKind; paper?: PaperSpec; pageSize?: PageSize; notebookId?: string } = {}): Promise<string | null> {
  const v = app().vault;
  if (!v) return null;
  const s = useSettings.getState();
  const title = opts.title ?? defaultTitle();
  const { note } = await v.vault.createNote({
    title,
    kind: opts.kind ?? 'paged',
    paper: opts.paper ?? s.defaultPaper,
    pageSize: opts.pageSize ?? s.defaultPageSize,
    notebookId: opts.notebookId,
  });
  await after(note.id);
  return note.id;
}

function defaultTitle() {
  const d = new Date();
  return `Note ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
}

export async function renameNote(id: string) {
  const v = app().vault;
  const n = await v?.vault.readNote(id);
  if (!v || !n) return;
  const title = await askText('Rename note', 'Title', n.title, 'Rename');
  if (!title) return;
  // Links to the note ([[Old title]]) are rewritten to the new title.
  const { renameNoteKeepingLinks } = await import('./knowledge.ts');
  await renameNoteKeepingLinks(id, title);
}

export async function togglePin(id: string) {
  const v = app().vault;
  if (!v) return;
  await v.vault.updateNote(id, (x) => ({ ...x, pinned: !x.pinned }), { touch: false });
  await after(id);
}

export async function moveNote(id: string, notebookId: string | undefined) {
  const v = app().vault;
  if (!v) return;
  await v.vault.updateNote(id, (x) => ({ ...x, notebookId }));
  await after(id);
}

export async function setTags(id: string, tags: string[]) {
  const v = app().vault;
  if (!v) return;
  await v.vault.updateNote(id, (x) => ({ ...x, tags }));
  await after(id);
}

export async function trashNote(id: string) {
  const v = app().vault;
  if (!v) return;
  await v.vault.trashNote(id);
  v.search.remove(id);
  await after();
  app().toast({ text: 'Moved to Trash', action: { label: 'Undo', run: () => void restoreNote(id) } });
}

export async function restoreNote(id: string) {
  const v = app().vault;
  if (!v) return;
  await v.vault.restoreNote(id);
  await after(id);
}

export async function deleteForever(id: string) {
  const v = app().vault;
  if (!v) return;
  if (!(await askConfirm('Delete forever?', 'This note and its pages, images and recordings will be permanently deleted from this device and your sync storage.', 'Delete forever', true))) return;
  await v.vault.deleteNote(id);
  v.search.remove(id);
  await after();
}

export async function duplicateNote(id: string) {
  const v = app().vault;
  if (!v) return;
  const copy = await v.vault.duplicateNote(id);
  if (copy) await after(copy.id);
}

const NOTEBOOK_COLORS = ['#FF3D5A80', '#FFB8432F', '#FF3D7A5A', '#FF7A3E9D', '#FFB07D1C', '#FF2F6FB5', '#FF6B5E55', '#FFB0477A'];

export async function createNotebook(parentId?: string): Promise<NotebookMeta | null> {
  const v = app().vault;
  if (!v) return null;
  const name = await askText(parentId ? 'New notebook inside' : 'New notebook', 'Name', '', 'Create');
  if (!name) return null;
  const color = NOTEBOOK_COLORS[app().notebooks.length % NOTEBOOK_COLORS.length]!;
  const nb = await v.vault.createNotebook(name, color, parentId);
  await after();
  return nb;
}

export async function renameNotebook(id: string) {
  const v = app().vault;
  const nb = app().notebooks.find((n) => n.id === id);
  if (!v || !nb) return;
  const name = await askText('Rename notebook', 'Name', nb.name, 'Rename');
  if (!name) return;
  await v.vault.writeNotebook({ ...nb, name });
  await after();
}

export async function deleteNotebook(id: string) {
  const v = app().vault;
  const nb = app().notebooks.find((n) => n.id === id);
  if (!v || !nb) return;
  if (!(await askConfirm(`Delete “${nb.name}”?`, 'The notebook is removed. Its notes are kept and moved to Unfiled.', 'Delete notebook', true))) return;
  await v.vault.deleteNotebook(id);
  app().setFilter({ kind: 'all' });
  await after();
}

const readBytes = async (f: Blob) => new Uint8Array(await f.arrayBuffer());

/** Imports PDFs (annotatable pages), images (one per page) or a vault backup zip. Returns the first note id. */
export async function importFiles(files: File[], notebookId?: string): Promise<string | null> {
  const v = app().vault;
  if (!v || !files.length) return null;
  let first: string | null = null;
  const images: File[] = [];
  for (const f of files) {
    try {
      const kind = classifyFile(f);
      if (kind === 'pdf') {
        app().toast({ text: `Importing ${f.name}…` });
        const id = await importPdf(f, notebookId);
        first ??= id;
      } else if (kind === 'image') {
        // HEIC opens only where the browser can decode it (Safari); say so instead of failing later.
        if (isHeic(f)) {
          try { (await createImageBitmap(f)).close(); } catch { app().fail(`${f.name}: this browser can't open HEIC photos. Save it as JPEG, or open it on a device that can.`); continue; }
        }
        images.push(f);
      } else if (kind === 'text') {
        const id = await importText(await readText(f), f.name.replace(/\.(txt|md|markdown|text)$/i, ''), notebookId);
        first ??= id;
      } else if (kind === 'backup') {
        // A zip of Markdown notes (an Obsidian vault) is imported as notes, not restored as a backup.
        const md = await import('./obsidian.ts');
        if (await md.isMarkdownVaultZip(f)) { await md.importMarkdownVault([f]); continue; }
        await importBackup(f);
      } else app().fail(`${f.name} isn't a PDF, image, text file or Inkstone backup.`);
    } catch (e) {
      console.error(e);
      app().fail(`Couldn't import ${f.name}: ${(e as Error).message}`);
    }
  }
  if (images.length) {
    const id = await importImages(images, notebookId);
    first ??= id;
  }
  return first;
}

/** Plain text or Markdown becomes a typed note: the text flows over as many pages as it needs. */
export async function importText(text: string, title: string, notebookId?: string): Promise<string> {
  const v = app().vault!;
  const s = useSettings.getState();
  const { note, pages } = await v.vault.createNote({ title: title.trim() || 'Text', paper: s.defaultPaper, pageSize: s.defaultPageSize, notebookId });
  const boxes = textToPages(text, note.pageSize);
  const out: PageInk[] = boxes.map((texts, i) => ({ ...(i === 0 ? pages[0]! : newPage(newId())), texts }));
  await v.vault.saveNote({ ...note, pageIds: out.map((p) => p.id) }, out);
  await after(note.id);
  return note.id;
}

async function importPdf(f: File, notebookId?: string): Promise<string> {
  const v = app().vault!;
  const bytes = await readBytes(f);
  const info = await inspectPdf(bytes);
  const now = Date.now();
  const noteId = newId(now);
  const asset = v.newAssetName('pdf');
  await v.vault.writeAsset(noteId, asset, bytes);
  const pages: PageInk[] = info.sizes.map((size, i) => ({
    ...newPage(newId(now)),
    size: { name: 'PDF', width: size.width, height: size.height },
    background: { kind: 'pdf', asset, pageNumber: i + 1 },
  }));
  const note: NoteMeta = {
    id: noteId,
    title: f.name.replace(/\.pdf$/i, ''),
    kind: 'paged',
    paper: { style: 'blank', tint: 'white', texture: 'smooth', spacing: 0 },
    pageSize: { name: 'PDF', width: info.sizes[0]?.width ?? PAGE_SIZES.LETTER.width, height: info.sizes[0]?.height ?? PAGE_SIZES.LETTER.height },
    pageIds: pages.map((p) => p.id),
    notebookId,
    tags: ['pdf'],
    createdAt: now,
    updatedAt: now,
    pinned: false,
    formatVersion: 2,
  };
  await v.vault.saveNote(note, pages);
  await after(noteId);
  app().toast({ text: `Imported ${info.count} ${info.count === 1 ? 'page' : 'pages'} from ${f.name}`, tone: 'success' });
  return noteId;
}

export async function imageSize(blob: Blob): Promise<{ width: number; height: number }> {
  const bmp = await createImageBitmap(blob);
  const out = { width: bmp.width, height: bmp.height };
  bmp.close();
  return out;
}

async function importImages(files: File[], notebookId?: string): Promise<string> {
  const v = app().vault!;
  const s = useSettings.getState();
  const { note, pages } = await v.vault.createNote({ title: files.length === 1 ? files[0]!.name.replace(/\.[^.]+$/, '') : `Images ${new Date().toLocaleDateString()}`, paper: { ...s.defaultPaper, style: 'blank' }, pageSize: s.defaultPageSize, notebookId });
  const size = note.pageSize;
  const out: PageInk[] = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i]!;
    const ext = (f.type.split('/')[1] ?? 'png').replace('jpeg', 'jpg');
    const asset = v.newAssetName(ext);
    await v.vault.writeAsset(note.id, asset, await readBytes(f));
    const dim = await imageSize(f);
    const maxW = size.width - 96, maxH = size.height - 160;
    const k = Math.min(maxW / dim.width, maxH / dim.height, 1.5);
    const w = dim.width * k, h = dim.height * k;
    const page = i === 0 ? pages[0]! : newPage(newId());
    out.push({ ...page, images: [{ id: newId(), x: (size.width - w) / 2, y: 96, width: w, height: h, asset, rotation: 0, createdAt: Date.now() }] });
  }
  await v.vault.saveNote({ ...note, pageIds: out.map((p) => p.id) }, out);
  await after(note.id);
  return note.id;
}

async function importBackup(f: File) {
  const v = app().vault!;
  const sync = await import('@inkstone/sync');
  const mode = (await askConfirm('Restore backup', 'Merge the notes in this backup with the notes on this device? Notes with the same id are replaced by the newer copy.', 'Merge backup')) ? 'merge' : null;
  if (!mode) return;
  await (sync as any).importVaultZip(v.fs, await readBytes(f), { mode });
  v.vault.invalidate();
  await v.buildIndex();
  await after();
  app().toast({ text: 'Backup restored', tone: 'success' });
}
