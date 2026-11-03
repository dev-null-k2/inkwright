import type { ModuleDefinition } from '../modules/registry.ts';
import type { ImporterKind } from './convert.ts';

/** Which module owns each importer (Settings › Import & clip shows the ones that are on). */
export const IMPORTER_MODULE_OF: Record<ImporterKind, string> = {
  notion: 'import-notion',
  evernote: 'import-evernote',
  onenote: 'import-onenote',
  'pdf-notebook': 'import-pdf-notebooks',
};

const KEPT = 'Notes already imported stay as they are; only the importer goes away.';

/**
 * Bringing notes in from other apps, one module each (docs/IMPORTERS.md), plus the web clipper
 * and runbook shell blocks. Nothing here runs in the background except the clipper, which only
 * looks at the address the app was opened with.
 */
export const IMPORT_MODULES: ModuleDefinition[] = [
  {
    id: 'import-notion',
    name: 'Import from Notion',
    description: 'Brings in a Notion workspace export (Markdown & CSV): pages with their nesting, links and pictures, and databases as tables.',
    defaultEnabled: true,
    contributes: { importers: ['Notion export (zip)'] },
    whenOff: KEPT,
  },
  {
    id: 'import-evernote',
    name: 'Import from Evernote',
    description: 'Brings in Evernote notebooks exported as .enex: notes with tags, dates, pictures, PDFs and to-dos.',
    defaultEnabled: true,
    contributes: { importers: ['Evernote .enex'] },
    whenOff: KEPT,
  },
  {
    id: 'import-onenote',
    name: 'Import from OneNote',
    description: 'Brings in pages OneNote exported as Word documents, single-file web pages, web pages or PDF.',
    defaultEnabled: true,
    contributes: { importers: ['OneNote exports (.docx, .mht, .html, .pdf)'] },
    whenOff: KEPT,
  },
  {
    id: 'import-pdf-notebooks',
    name: 'Import GoodNotes and Notability',
    description: 'Brings in notebooks exported as PDF, split into notes by their outline, as pages you can write on.',
    defaultEnabled: true,
    contributes: { importers: ['GoodNotes and Notability PDF exports'] },
    whenOff: KEPT,
  },
  {
    id: 'web-clipper',
    name: 'Web clipper',
    description: 'A bookmarklet that saves a web page’s readable text (or your selection) as a note, read in your browser with no server in between.',
    defaultEnabled: true,
    contributes: { importers: ['Web pages (bookmarklet)'], background: ['Looks for a clip in the address the app was opened with'] },
    whenOff: 'Clipped notes stay. A clip arriving while it is off is not saved.',
    async activate() {
      const { startClipper } = await import('./clipper.ts');
      return startClipper();
    },
  },
  {
    id: 'runbook-shell',
    name: 'Runbook shell blocks',
    description: 'Run ```sh blocks in runbooks on one of your computers, through the always-on runner, after you approve each run on this device.',
    defaultEnabled: false,
    dependencies: ['code'],
    contributes: { panels: ['Run on <computer> for sh blocks', 'Settings › Code & runbooks › Shell blocks'] },
    whenOff: 'Shell blocks are plain text; results already shown stay in the vault.',
  },
];
