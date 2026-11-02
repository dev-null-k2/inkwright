import type { ModuleDefinition } from '../modules/registry.ts';

/**
 * The desktop app, the memory timeline and the journal that writes itself (docs/DESKTOP.md,
 * docs/MEMORY_TIMELINE.md). The timeline and the journal are off by default and are never
 * switched on by a preset (`OPT_IN_ONLY`): they read what is on your screen and write in your
 * journal, so only you turn them on.
 */
export const OPT_IN_ONLY = new Set(['memory-timeline', 'journal']);

export const MEMORY_MODULES: ModuleDefinition[] = [
  {
    id: 'desktop',
    name: 'Desktop app',
    description: 'In the desktop app: your notes in a folder on disk, the tray, launch at login, inkwright:// links, opening PDFs with Inkwright, updates, and agents (MCP) while the window is closed.',
    defaultEnabled: true,
    contributes: { settingsSections: ['desktop'], background: ['Links, opened files, tray and updates (desktop app only)'] },
    whenOff: 'The desktop app still opens your notes folder; links, opened files and update checks are ignored until it is on.',
    async activate() {
      const { startDesktop } = await import('../desktop/integration.ts');
      return startDesktop();
    },
  },
  {
    id: 'memory-timeline',
    name: 'Memory timeline',
    description: 'What was on your screen, captured by the desktop app as text, redacted before it is saved and kept for the days you choose. Scrub by day and hour, search it in plain words, and see what you wrote at the same moment.',
    defaultEnabled: false,
    contributes: {
      settingsSections: ['recall'],
      paletteActions: ['recall.open', 'recall.pause'],
      panels: ['Memory timeline'],
      aiTools: ['search_timeline'],
      background: ['Screen capture (desktop app, when you switch it on for that computer)', 'Deleting moments past the retention period'],
    },
    whenOff: 'Nothing is captured and the timeline is hidden. Moments already kept stay in recall/ in your vault until you erase them or switch it on again (retention then resumes).',
    async activate() {
      const [{ startRecall, togglePause }, { installRecallLinks, openTimeline }, { registerPaletteActions }] = await Promise.all([import('./service.ts'), import('./ui.ts'), import('../lib/palette.ts')]);
      const stopService = startRecall();
      const stopLinks = installRecallLinks();
      const stopActions = registerPaletteActions('memory-timeline', () => [
        { id: 'recall.open', label: 'Memory timeline', keywords: 'recall screen history what did I see search timeline', run: () => openTimeline() },
        { id: 'recall.pause', label: 'Pause or resume screen capture', keywords: 'memory timeline privacy stop', run: () => togglePause() },
      ]);
      return () => { stopService(); stopLinks(); stopActions(); };
    },
    async aiTools() {
      const { searchTimelineTool } = await import('./tool.ts');
      return [searchTimelineTool()];
    },
  },
  {
    id: 'journal',
    name: 'Journal that writes itself',
    description: 'Each evening, a draft of your day in your journal — from what you wrote, what was said in recordings, your calendar and the memory timeline — in AI handwriting you correct with your pen, every sentence with its sources.',
    defaultEnabled: false,
    dependencies: ['assistant'],
    contributes: {
      settingsSections: ['journal'],
      routineTemplates: ['daily-journal'],
      aiTools: ['journal_sources', 'write_journal_draft'],
      importers: ['Calendars (.ics files and addresses)'],
    },
    whenOff: 'Drafts already written stay in your journal; the evening routine finds no journal tools and says so.',
    async aiTools() {
      const { journalAgentTools } = await import('../journal/service.ts');
      return journalAgentTools();
    },
  },
];
