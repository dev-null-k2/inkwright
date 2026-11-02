import type { ModuleDefinition } from '../modules/registry.ts';

/**
 * "Ink that does things" as six modules (Settings › Modules), each switchable on its own. Turning
 * one off removes its menu items, palette actions, tools and drop handling; what it already put
 * in notes stays (AI ink is ink, result tables are tables, traced strokes are strokes, paper notes
 * are notes).
 */
export const INK_ACTION_MODULES: ModuleDefinition[] = [
  {
    id: 'ink-answers',
    name: 'AI answers in ink',
    description: 'Lasso a question and the AI writes the answer next to it, in handwriting or as typed text; the assistant can write on pages too.',
    defaultEnabled: true,
    contributes: { menuItems: ['Write the answer here'], paletteActions: ['ink.answer'], aiTools: ['write_in_ink'] },
    whenOff: 'Answers already written stay on the page as AI ink.',
    async aiTools() {
      const { writeInInkTool } = await import('../inkanswer/tool.ts');
      return [writeInInkTool()];
    },
  },
  {
    id: 'canvas-run',
    name: 'Executable diagrams',
    description: 'Draw boxes and arrows, lasso them and Run: each box is a step — fetch, filter, sum, chart on the device, anything else by the AI — with results beside the boxes.',
    defaultEnabled: true,
    contributes: { menuItems: ['Run diagram'], paletteActions: ['ink.canvas-run'], panels: ['Diagram overlay'] },
    whenOff: 'Diagrams stay ink; results you kept stay as sticky notes, tables and charts.',
  },
  {
    id: 'data-sandbox',
    name: 'Data sandbox',
    description: 'Drop CSV, JSON or spreadsheet files on a page and query them with SQL (DuckDB on the device), ask in words, and chart the results.',
    defaultEnabled: true,
    contributes: {
      menuItems: ['Add data', 'Query data'],
      paletteActions: ['ink.data-add', 'ink.data-query'],
      panels: ['Data'],
      aiTools: ['list_datasets', 'query_data'],
      importers: ['CSV, TSV, JSON, NDJSON, Excel and OpenDocument spreadsheets'],
    },
    whenOff: 'Data files stay with their notes (runbook SQL blocks still read them); tables stay on the page.',
    async activate() {
      const { installDataDrop } = await import('../datasandbox/actions.ts');
      return installDataDrop();
    },
    async aiTools() {
      const { dataTools } = await import('../datasandbox/tool.ts');
      return dataTools();
    },
  },
  {
    id: 'photo-ink',
    name: 'Photo to ink',
    description: 'Turn a photo of handwriting or a diagram on paper into real, editable strokes on a new page.',
    defaultEnabled: true,
    contributes: { menuItems: ['Photo to ink', 'Show the original photo'], paletteActions: ['ink.photo'], importers: ['Photos of paper'] },
    whenOff: 'Traced pages stay; their photos stay with them, hidden.',
  },
  {
    id: 'accessibility',
    name: 'Reading and read aloud',
    description: 'Read a page or a selection aloud with the ink highlighted as it is read, and a reading view with your own font, spacing and line focus.',
    defaultEnabled: true,
    contributes: { menuItems: ['Read aloud', 'Reading view'], paletteActions: ['ink.read-aloud', 'ink.reading-view'], settingsSections: ['reading'] },
  },
  {
    id: 'papers',
    name: 'Paper workbench',
    description: 'A library of papers from Zotero exports (BibTeX, CSL-JSON) with PDFs attached, [@key] citations with autocomplete, and bibliographies in APA or IEEE.',
    defaultEnabled: true,
    contributes: {
      menuItems: ['Bibliography'],
      paletteActions: ['papers.library', 'papers.bibliography'],
      panels: ['Library of papers', 'Bibliography'],
      importers: ['BibTeX', 'CSL-JSON', 'PDFs matched to papers'],
      exporters: ['BibTeX', 'APA and IEEE reference lists'],
    },
    whenOff: 'Paper notes stay notes; citations stay as typed text.',
  },
];

export const INK_ACTION_MODULE_IDS = INK_ACTION_MODULES.map((m) => m.id);
