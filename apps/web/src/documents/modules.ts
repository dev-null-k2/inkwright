import type { ModuleDefinition } from '../modules/registry.ts';
import { registerPaletteActions } from '../lib/palette.ts';
import { useApp } from '../state/app.ts';

/**
 * Documents: typed, formatted notes with ink on top (docs/VAULT_FORMAT.md › Documents), and the
 * front door to Fill & sign. Declared here so builtin.ts stays a list.
 */
export const DOCUMENT_MODULES: ModuleDefinition[] = [
  {
    id: 'documents',
    name: 'Documents',
    description: 'Typed documents with headings, lists, checklists, tables and pictures that you can also mark up with the pen. Export to PDF, Word, Markdown or HTML, print, or bring in .docx, .md and .html files.',
    defaultEnabled: true,
    contributes: {
      menuItems: ['New document', 'Open a Word, Markdown or HTML file'],
      paletteActions: ['new-document', 'import-document'],
      screens: ['Document editor'],
      aiTools: ['read_document', 'edit_document'],
      importers: ['Word (.docx)', 'Markdown', 'HTML'],
      exporters: ['PDF', 'Word (.docx)', 'Markdown', 'HTML'],
    },
    whenOff: 'Documents open in the ink editor as one text box holding their Markdown, so nothing is lost; formatting tools come back when it is on.',
  },
];

/** The current library notebook, so new things land where the user is looking. */
const currentNotebook = () => {
  const f = useApp.getState().filter;
  return f.kind === 'notebook' ? f.id : undefined;
};

/**
 * Search-palette commands that work from any screen: new document, open a document file, sign a
 * document. Owned by their modules (`contributes.paletteActions`), so they hide when those are off.
 */
export function registerDocumentPaletteActions(): void {
  registerPaletteActions('documents', () => [
    { id: 'new-document', label: 'New document', keywords: 'write type word doc report letter rich text', run: () => void import('./create.ts').then((m) => m.newDocument(currentNotebook())) },
    { id: 'import-document', label: 'Open a Word, Markdown or HTML file', keywords: 'docx word md markdown html import document', run: () => void import('./create.ts').then((m) => m.importDocument(currentNotebook())) },
    { id: 'sign-document', label: 'Sign a document', keywords: 'pdf signature fill form sign esign contract', run: () => void import('../fill/signFlow.ts').then((m) => m.startSigning(currentNotebook())) },
  ]);
}
