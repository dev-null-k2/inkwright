import { VAULT_FORMAT_VERSION, copyPagesForNewNote, newId, pageSizeOf, rotatePageQuarter, type NoteDocument, type NoteMeta } from '@inkstone/core';
import type { AppVault } from './vault.ts';

/**
 * Page tools for the Pages panel that go beyond the document's own page operations: turning a
 * page, and pulling selected pages out into a note of their own.
 */

/** Turns page `i` a quarter turn (ink, images and an imported PDF/image background turn with it). */
export function rotatePage(doc: NoteDocument, i: number, clockwise = true): void {
  if (doc.meta.kind === 'board') return;
  const page = doc.page(i);
  const r = rotatePageQuarter(page, pageSizeOf(doc.meta, page), clockwise);
  doc.replacePage(i, r.page);
}

/** "Pages 2–3, 5" for a title. */
export function describePages(indexes: number[]): string {
  const ns = [...new Set(indexes)].sort((a, b) => a - b).map((i) => i + 1);
  const parts: string[] = [];
  for (let k = 0; k < ns.length; k++) {
    let j = k;
    while (j + 1 < ns.length && ns[j + 1] === ns[j]! + 1) j++;
    parts.push(j > k ? `${ns[k]}–${ns[j]}` : `${ns[k]}`);
    k = j;
  }
  return `${ns.length === 1 ? 'page' : 'pages'} ${parts.join(', ')}`;
}

/**
 * Copies the selected pages (in document order) into a new note next to this one, with their
 * PDFs, images and form values, and returns its id. The original note is left as it is.
 */
export async function extractPages(vault: AppVault, doc: NoteDocument, indexes: number[]): Promise<string> {
  const order = [...new Set(indexes)].filter((i) => i >= 0 && i < doc.pageCount).sort((a, b) => a - b);
  if (!order.length) throw new Error('No pages selected');
  const { pages, assets, forms } = copyPagesForNewNote(doc.meta, order.map((i) => doc.page(i)));
  const now = Date.now();
  const id = newId(now);
  for (const a of assets) {
    const bytes = await vault.vault.readAsset(doc.meta.id, a);
    if (bytes) await vault.vault.writeAsset(id, a, bytes);
  }
  const first = pages[0]!;
  const meta: NoteMeta = {
    id,
    title: `${doc.meta.title} (${describePages(order)})`,
    kind: 'paged',
    paper: doc.meta.paper,
    pageSize: first.size ?? doc.meta.pageSize,
    pageIds: pages.map((p) => p.id),
    notebookId: doc.meta.notebookId,
    tags: [...doc.meta.tags],
    createdAt: now,
    updatedAt: now,
    pinned: false,
    forms,
    formatVersion: VAULT_FORMAT_VERSION,
  };
  await vault.vault.saveNote(meta, pages);
  const { noteChanged } = await import('./actions.ts');
  await noteChanged(id);
  return id;
}
