/**
 * Inkwright's own features as modules, and the presets that switch sensible sets of them.
 *
 * Writing, pages, notebooks, search, sync, export and undo are the core and always on; everything
 * here can be switched off in Settings › Modules. Module code stays lazily loaded: declarations are
 * plain data, and `activate` hooks import their implementation only when the module is on.
 */
import { useApp } from '../state/app.ts';
import { registerModule, registerPreset, type ModuleDefinition } from './registry.ts';
import { INK_ACTION_MODULES } from '../inkactions/modules.ts';
import { MEMORY_MODULES, OPT_IN_ONLY } from '../recall/modules.ts';
import { IMPORT_MODULES } from '../importers/modules.ts';

export const BUILTIN_MODULES: ModuleDefinition[] = [
  {
    id: 'fill-sign',
    name: 'Fill & sign',
    description: 'Type into PDF form fields, place signatures and checkmarks on flat forms, and export the original document filled in.',
    defaultEnabled: true,
    contributes: { menuItems: ['Fill & sign', 'Export › Filled form'], panels: ['Form layer', 'Signature library'], exporters: ['Filled PDF form'] },
    whenOff: 'Values already typed into forms still show on the page and in exports; they can’t be edited until it is back on.',
  },
  {
    id: 'smart-ink',
    name: 'Smart ink',
    description: 'Turns drawn grids into tables, solves handwritten maths, plots graphs and adds circled dates to your calendar.',
    defaultEnabled: true,
    contributes: { panels: ['Suggestion chips', 'Selection: Solve, Make a table'], objectTypes: ['table', 'math', 'graph'], settingsSections: [] },
    whenOff: 'Tables, results and graphs stay on the page, drawn as they were; they stop updating and can’t be edited.',
  },
  {
    id: 'listen',
    name: 'Notes that listen',
    description: 'Live transcripts of recordings lined up with your ink, questions about what was said, page summaries and dictation.',
    defaultEnabled: true,
    contributes: { menuItems: ['Transcript', 'Dictate'], panels: ['Transcript'], background: ['Transcribing recordings'], aiTools: [] },
    whenOff: 'Recording audio still works. Existing transcripts are kept in the note and come back when it is on.',
  },
  {
    id: 'knowledge',
    name: 'Links & daily notes',
    description: '[[Links]] between notes with backlinks and unlinked mentions, #tags, daily notes, templates and Obsidian import and export.',
    defaultEnabled: true,
    contributes: {
      menuItems: ['Links', 'Use as template'],
      paletteActions: ['kb-today', 'kb-obsidian-export', 'kb-obsidian-import'],
      panels: ['Links panel', 'Link threads on ink'],
      importers: ['Obsidian vault'],
      exporters: ['Obsidian zip'],
      settingsSections: ['knowledge'],
    },
    whenOff: 'Typed [[links]] stay as text and ink links stay as ink; they just aren’t followed or drawn as threads.',
  },
  {
    id: 'graph',
    name: 'Graph',
    description: 'A map of your notes, links, tags and notebooks, in 3D or 2D.',
    defaultEnabled: true,
    dependencies: ['knowledge'],
    contributes: { screens: ['Graph'], paletteActions: ['kb-graph'], menuItems: ['Graph (library)'] },
  },
  {
    id: 'studio',
    name: 'Studio tools',
    description: 'Layers, sticky notes, tape for studying, two-page view, version history and locking notes with a passcode.',
    defaultEnabled: true,
    contributes: { menuItems: ['View', 'Version history', 'Lock note'], objectTypes: ['sticky', 'tape'], panels: ['Version history'] },
    whenOff: 'Sticky notes and tape stay on the page. Locked notes still open with their passcode.',
  },
  {
    id: 'assistant',
    name: 'Assistant & routines',
    description: 'The AI panel, routines that run on a schedule, Agent Skills, memory, connected apps (MCP) and the activity log with undo.',
    defaultEnabled: true,
    contributes: {
      menuItems: ['AI'],
      paletteActions: ['assistant'],
      panels: ['Assistant'],
      aiTools: ['note tools', 'load_skill', 'remember', 'connected-app tools'],
      routineTemplates: ['file-notes', 'todos-to-tasks', 'exam-flashcards', 'email-draft'],
      background: ['Routines on schedule', 'Connected apps'],
    },
    whenOff: 'Routines don’t run and the AI panel is hidden. Past activity stays in the vault.',
    async activate() {
      const vault = useApp.getState().vault;
      if (!vault) return;
      const [{ initAgentHub }, { startAgents, stopAgents }] = await Promise.all([import('../lib/agent/hub.ts'), import('../lib/agent/routines.ts')]);
      await initAgentHub(vault);
      void startAgents(vault).catch((e) => console.warn('Routines could not start', e));
      return () => stopAgents();
    },
  },
  {
    id: 'compiler',
    name: 'Compiled wiki & study',
    description: 'Compiles your notes into a reviewed wiki with sources, flags contradictions between notes, collects meeting follow-ups and turns notes into flashcards.',
    defaultEnabled: true,
    dependencies: ['assistant'],
    contributes: {
      menuItems: ['Sources of AI text', 'Study this note', 'Teach me back', 'Context pack'],
      panels: ['Compiled wiki', 'Conflicts', 'Study', 'Memory eval (Settings › AI)'],
      aiTools: ['compile_wiki', 'list_conflicts', 'list_followups'],
      routineTemplates: ['compile-wiki', 'meeting-followups'],
      background: ['Extraction and contradiction checks after notes change'],
    },
    whenOff: 'The compiled wiki, decks and provenance stay in the vault; nothing is recompiled until it is on again.',
    async activate() {
      const vault = useApp.getState().vault;
      if (!vault) return;
      const { startCompiler, stopCompiler } = await import('../compiler/service.ts');
      startCompiler(vault);
      return () => stopCompiler();
    },
  },
  {
    id: 'local-ai',
    name: 'On-device AI',
    description: 'Run AI models on this device: handwriting, speech and meaning-based search without sending anything away.',
    defaultEnabled: true,
    contributes: { settingsSections: [], panels: ['On-device AI settings'], aiTools: ['search_memory'] },
    whenOff: 'Downloaded models stay on the device until you remove them.',
  },
  {
    id: 'search',
    name: 'Search everything',
    description: 'The palette (Ctrl/⌘-K) that finds notes, passages, handwriting and actions, and answers questions from your notes.',
    defaultEnabled: true,
    contributes: { menuItems: ['Search everything'], panels: ['Search palette'], background: ['Passage index'] },
    whenOff: 'The library’s own search still finds notes by title and text.',
    async activate() {
      const vault = useApp.getState().vault;
      if (!vault) return;
      const { attachMemory, appMemory, detachMemory } = await import('../lib/memory.ts');
      if (!appMemory()) {
        attachMemory(vault);
        await vault.buildIndex();
      }
      return () => detachMemory();
    },
  },
  {
    id: 'authorship',
    name: 'Proof of authorship',
    description: 'Signed certificates that your handwriting is yours, embedded in exported PDFs and verifiable offline.',
    defaultEnabled: true,
    contributes: { menuItems: ['Authorship'], panels: ['Authorship'], settingsSections: ['authorship'] },
    whenOff: 'The record of how a page was written keeps being kept, so certificates made later still cover it.',
  },
  {
    id: 'themes',
    name: 'Colour palettes',
    description: 'Aizome, Celadon and Sumi (high contrast for e-ink) besides the default Duan.',
    defaultEnabled: true,
    contributes: { panels: ['Palette picker'] },
    whenOff: 'The app uses the Duan palette.',
  },
  {
    id: 'plugins',
    name: 'Plugins',
    description: 'Run plugins made by others, each in a sandbox with only the permissions you grant.',
    defaultEnabled: true,
    contributes: { settingsSections: ['plugins'], menuItems: ['Plugins'], panels: ['Plugin panels'], aiTools: ['plugin tools'], importers: ['plugin importers'], exporters: ['plugin exporters'], background: ['Plugins set to start with the app'] },
    whenOff: 'Installed plugins stay in the vault, switched off. Their stored data is kept.',
    async activate() {
      const { startPluginHost } = await import('../plugins/host.ts');
      return startPluginHost();
    },
    async aiTools() {
      const { pluginAgentTools } = await import('../plugins/host.ts');
      return pluginAgentTools();
    },
  },
  {
    id: 'developer',
    name: 'Developer tools',
    description: 'API keys for the local REST API, the window.inkwright automation API for scripts and extensions, and the deep-link reference.',
    defaultEnabled: false,
    dependencies: ['plugins'],
    contributes: { settingsSections: ['developer'], background: ['window.inkwright (when switched on)'] },
    async activate() {
      const { startAutomationApi } = await import('../developer/automation.ts');
      return startAutomationApi();
    },
  },
  {
    id: 'code',
    name: 'Code-aware notes',
    description: 'Link notes to functions in your repositories and see when the code drifts; verified architecture diagrams; runbooks with HTTP, SQL and JavaScript blocks; lessons from coding-agent sessions.',
    defaultEnabled: true,
    contributes: {
      settingsSections: ['code'],
      menuItems: ['Developer'],
      objectTypes: ['diagram'],
      aiTools: ['create_diagram', 'code_search', 'propose_lessons'],
      background: ['Re-scans mounted repositories when asked'],
    },
    whenOff: 'Code links stay as plain links and diagrams stay drawn; nothing scans or runs.',
    // The module's own switch (dev/settings.ts) is what its parts listen to; follow the registry.
    async activate() {
      const { useDevSettings } = await import('../dev/settings.ts');
      useDevSettings.getState().set({ devTools: true });
      return () => useDevSettings.getState().set({ devTools: false });
    },
  },
  {
    id: 'peer',
    name: 'Devices & live sharing',
    description: 'Pair your devices by QR code and sync them directly, with no cloud in between, and write on a note together with other people in real time. End to end encrypted.',
    defaultEnabled: true,
    contributes: {
      settingsSections: ['devices'],
      menuItems: ['Share live'],
      paletteActions: ['peer.devices'],
      panels: ['Live sharing', 'Collaborators’ cursors and ink'],
      background: ['Answering paired devices through your signalling server (when one is set)'],
    },
    whenOff: 'Paired devices are remembered but can’t connect; live sessions end. Notes others wrote with you stay, marked as theirs.',
    async activate() {
      const { startPeerService } = await import('../peer/service.ts');
      return startPeerService();
    },
  },
  {
    id: 'timeline',
    name: 'Time travel & branches',
    description: 'See all your notes as they were on any date, and try an assistant’s proposed changes on a branch you can compare with your notes, then merge or discard.',
    defaultEnabled: true,
    dependencies: ['studio'],
    contributes: {
      paletteActions: ['timeline.asof', 'timeline.today'],
      panels: ['Time travel bar', 'Branches (Activity)'],
      menuItems: ['Try on a branch (proposals)'],
    },
    whenOff: 'Version history and branches stay in the vault; open branches can be merged or discarded when it is on again.',
  },
  {
    id: 'deep-links',
    name: 'Links from other apps',
    description: 'inkwright:// links and web links that create notes, open pages, search and capture — for Shortcuts, Tasker and launchers.',
    defaultEnabled: true,
    contributes: { background: ['Opening links'] },
    async activate() {
      const { startDeepLinks } = await import('../developer/deeplinks.ts');
      return startDeepLinks();
    },
  },
  // Ink that does things: AI answers in ink, executable diagrams, data, photo to ink, reading, papers.
  ...INK_ACTION_MODULES,
  // The desktop app, the memory timeline and the journal that writes itself (opt-in only).
  ...MEMORY_MODULES,
  {
    id: 'device-check',
    name: 'Device check',
    description: 'Settings › About › Check this device: measures the pen, the screen and how fast ink appears on this device, and makes a report to copy or share.',
    defaultEnabled: true,
    contributes: { panels: ['Check this device'] },
  },
  // Notes from other apps, the web clipper, and runbook shell blocks on a computer.
  ...IMPORT_MODULES,
];

// Presets never switch on modules that only you should turn on (screen capture, journal drafts).
const ALL = BUILTIN_MODULES.map((m) => m.id).filter((m) => !OPT_IN_ONLY.has(m));
const without = (...ids: string[]) => ALL.filter((m) => !ids.includes(m));

export const BUILTIN_PRESETS = [
  { id: 'student', name: 'Student', description: 'Lectures that listen, maths and tables, links and daily notes, flashcard routines, proof that the work is yours.', modules: without('developer', 'code') },
  { id: 'writer', name: 'Writer', description: 'Links and daily notes, the graph, the assistant and authorship certificates; no maths or forms.', modules: ['knowledge', 'graph', 'studio', 'assistant', 'search', 'authorship', 'themes', 'listen', 'deep-links', 'ink-answers', 'accessibility', 'papers', 'desktop'] },
  { id: 'developer', name: 'Developer', description: 'Everything, plus API keys, the automation API and plugin development.', modules: ALL },
  { id: 'researcher', name: 'Researcher', description: 'PDF reading and forms, transcripts, links, the graph, on-device AI and the assistant.', modules: without('authorship', 'developer', 'code') },
  { id: 'enterprise', name: 'Enterprise', description: 'Forms, authorship and the assistant on managed devices; no third-party plugins or developer access.', modules: ['fill-sign', 'listen', 'knowledge', 'studio', 'assistant', 'local-ai', 'search', 'authorship', 'deep-links', 'code', 'accessibility', 'data-sandbox', 'desktop'] },
  { id: 'minimal', name: 'Minimal', description: 'Just paper and pen: writing, pages, notebooks, sync and export.', modules: [] },
];

let registered = false;

/** Registers the built-in modules and presets (idempotent). */
export function registerBuiltinModules(): void {
  if (registered) return;
  registered = true;
  for (const m of BUILTIN_MODULES) registerModule(m);
  for (const p of BUILTIN_PRESETS) registerPreset(p);
}
