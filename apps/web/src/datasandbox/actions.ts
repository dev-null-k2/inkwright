import type { NoteDocument } from '@inkwright/core';
import type { InkEngine } from '../canvas/engine.ts';
import type { AppVault } from '../lib/vault.ts';
import { registerNoteFileHandler } from '../lib/openFiles.ts';
import { pickFiles } from '../platform/files.ts';
import { useApp } from '../state/app.ts';
import { isModuleOn } from '../modules/registry.ts';
import { DATA_FILE_ACCEPT, dataTableObject, importDataFiles, invalidateEngine, isDataFile } from './data.ts';
import { openDataPanel } from './DataPanel.tsx';

/**
 * Data in, the two ways: dropping files on a page (a file handler while the module is on) and
 * ••• › Insert › Add data. Each file becomes a dataset (a note asset) plus a table on the page showing its
 * first rows, linked to the full data; one undo step per file removes the table (the file stays,
 * like an attached PDF, so undo never loses data).
 */
export async function addDataFiles(vault: AppVault, doc: NoteDocument, engine: InkEngine | null, files: File[], pageIndex: number, at: { x: number; y: number }): Promise<number> {
  const added = await importDataFiles(vault, doc.meta.id, files);
  let y = at.y;
  for (const { asset, dataset } of added) {
    const t = dataTableObject({
      columns: dataset.columns.map((c) => c.name),
      rows: dataset.rows,
      x: at.x,
      y,
      origin: 'import',
      data: { asset, table: dataset.name, rowCount: dataset.rows.length, columns: dataset.columns.map((c) => ({ name: c.name, type: c.type })) },
    });
    doc.editObjects(pageIndex, `Add ${asset}`, { upsert: [t] });
    y += t.rows.reduce((a, b) => a + b, 0) + 28;
  }
  invalidateEngine();
  if (added.length) {
    const first = added[0]!;
    useApp.getState().toast({
      text: added.length === 1 ? `Added ${first.dataset.name} · ${first.dataset.rows.length} rows` : `Added ${added.length} tables`,
      tone: 'success',
      action: { label: 'Query', run: () => openDataPanel(vault, doc, engine) },
    });
  }
  return added.length;
}

export async function pickAndAddData(vault: AppVault, doc: NoteDocument, engine: InkEngine | null): Promise<void> {
  const files = (await pickFiles(DATA_FILE_ACCEPT, true)).filter(isDataFile);
  if (!files.length) return;
  const i = engine?.currentPageIndex ?? 0;
  const c = engine?.visibleCenter(i) ?? { x: 160, y: 160 };
  try {
    await addDataFiles(vault, doc, engine, files, i, { x: Math.max(40, c.x - 200), y: Math.max(40, c.y - 120) });
  } catch (e) {
    useApp.getState().fail(`Couldn't read that data: ${(e as Error).message}`);
  }
}

/** While the module is on, data files dropped on a note become datasets. */
export function installDataDrop(): () => void {
  return registerNoteFileHandler(async (f, ctx) => {
    if (!isModuleOn('data-sandbox') || !isDataFile(f)) return false;
    await addDataFiles(ctx.vault, ctx.doc, ctx.engine, [f], ctx.pageIndex, ctx.at);
    return true;
  });
}
