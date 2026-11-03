/**
 * Creating document notes (richdoc.ts in core): an ordinary paged note, marked with
 * `NoteMeta.document`, whose first page holds the Markdown body in a `role: "document"` text box.
 * Kept free of Tiptap so the library and the "+" menu can create documents without loading the
 * editor; importing a file loads it on demand.
 */
import { DEFAULT_PAPER, DOCUMENT_PAGE_SIZE, DOCUMENT_ROLE, DOCUMENT_WIDTH, newId, type TextBox } from '@inkwright/core';
import { noteChanged } from '../lib/actions.ts';
import { pickFiles } from '../platform/files.ts';
import { useApp } from '../state/app.ts';

/** Where the body box sits on the page (used by the canvas fallback and thumbnails). */
export function documentBodyBox(markdown: string, now = Date.now()): TextBox {
  return { id: newId(now), x: 48, y: 56, width: DOCUMENT_WIDTH - 96, text: markdown, fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: now, role: DOCUMENT_ROLE };
}

/** A new document note; returns its id. Images are written into the note's assets first. */
export async function createDocumentNote(opts: { notebookId?: string; title?: string; markdown?: string; images?: { name: string; bytes: Uint8Array }[] } = {}): Promise<string | null> {
  const v = useApp.getState().vault;
  if (!v) return null;
  const title = opts.title?.trim() || `Document ${new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
  const { note, pages } = await v.vault.createNote({ title, kind: 'paged', paper: { ...DEFAULT_PAPER, style: 'blank', tint: 'white' }, pageSize: { ...DOCUMENT_PAGE_SIZE }, notebookId: opts.notebookId });
  for (const im of opts.images ?? []) await v.vault.writeAsset(note.id, im.name, im.bytes);
  const meta = { ...note, document: { width: DOCUMENT_WIDTH } };
  const page = { ...pages[0]!, texts: [documentBodyBox(opts.markdown ?? '')] };
  await v.vault.saveNote(meta, [page]);
  await noteChanged(note.id);
  return note.id;
}

/** "New document": creates one and opens it. */
export async function newDocument(notebookId?: string): Promise<string | null> {
  const id = await createDocumentNote({ notebookId });
  if (id) useApp.getState().navigate({ name: 'editor', noteId: id });
  return id;
}

/** "Open a Word, Markdown or HTML file" as a new document. */
export async function importDocument(notebookId?: string, file?: File): Promise<string | null> {
  const { DOCUMENT_FILES, readDocumentFile, htmlToMarkdown } = await import('./convert.ts');
  const [f] = file ? [file] : await pickFiles(DOCUMENT_FILES, false);
  if (!f) return null;
  const app = useApp.getState();
  try {
    const prefix = `doc-${newId().slice(-6).toLowerCase()}`;
    const r = await readDocumentFile(f, prefix);
    const md = htmlToMarkdown(r.html);
    const id = await createDocumentNote({ notebookId, title: r.title, markdown: md, images: r.images });
    if (id) app.navigate({ name: 'editor', noteId: id });
    return id;
  } catch (e) {
    app.fail(`Couldn't open ${f.name}: ${(e as Error).message}`);
    return null;
  }
}
