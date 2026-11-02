/**
 * Runs an importer in the app: convert the picked files (convert.ts), lay them out as notes with
 * the Markdown importer, index, sync, and say what happened. Imported text is typed text with
 * origin `import` (the Markdown importer marks it so), never handwriting or AI.
 */
import { importObsidianVault, type VaultFile } from '@inkwright/core';
import { useApp } from '../state/app.ts';
import { useSettings } from '../state/settings.ts';
import { scheduleSync } from '../lib/sync.ts';
import { convert, type ImporterKind } from './convert.ts';

const COLORS = ['#FF3D5A80', '#FFB8432F', '#FF3D7A5A', '#FF7A3E9D', '#FFB07D1C', '#FF2F6FB5', '#FF6B5E55', '#FFB0477A'];

export const IMPORTER_LABEL: Record<ImporterKind, string> = {
  notion: 'Notion',
  evernote: 'Evernote',
  onenote: 'OneNote',
  'pdf-notebook': 'GoodNotes / Notability',
};

export interface ImportOutcome {
  notes: number;
  notebooks: number;
  warnings: string[];
}

/** Lays converted files into the vault (shared with tests through `importVaultFiles`). */
export async function importVaultFiles(files: VaultFile[]): Promise<{ noteIds: string[]; notebooksCreated: number }> {
  const v = useApp.getState().vault;
  if (!v) throw new Error('The vault is not open yet.');
  const s = useSettings.getState();
  const { inspectPdf } = await import('../canvas/assets.ts');
  const r = await importObsidianVault(v.vault, files, { paper: s.defaultPaper, pageSize: s.defaultPageSize, notebookColors: COLORS, pdfPageSizes: async (b) => (await inspectPdf(b)).sizes, origin: 'import' });
  await v.buildIndex();
  await useApp.getState().refresh();
  scheduleSync();
  return r;
}

export async function runImport(kind: ImporterKind, files: readonly File[]): Promise<ImportOutcome | null> {
  if (!files.length) return null;
  const app = useApp.getState();
  app.toast({ text: `Importing from ${IMPORTER_LABEL[kind]}…` });
  const c = await convert(kind, files);
  const r = c.files.length ? await importVaultFiles(c.files) : { noteIds: [], notebooksCreated: 0 };
  const n = r.noteIds.length;
  app.toast({
    text: n ? `Imported ${n} ${n === 1 ? 'note' : 'notes'} from ${IMPORTER_LABEL[kind]}${c.warnings.length ? ` (${c.warnings.length} ${c.warnings.length === 1 ? 'thing' : 'things'} to check)` : ''}` : `Nothing to import from those files${c.warnings[0] ? `: ${c.warnings[0]}` : ''}`,
    tone: n ? 'success' : 'error',
  });
  return { notes: n, notebooks: r.notebooksCreated, warnings: c.warnings };
}
