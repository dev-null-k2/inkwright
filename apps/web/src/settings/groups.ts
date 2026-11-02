/**
 * How Settings is organised: eight groups people can scan, each with one or more sections shown
 * as tabs, and an index of individual settings for the search field.
 *
 * Section ids are stable: they are the deep links (`#settings/<id>`) other screens, docs and
 * tests use, and they are the ids modules own (`contributes.settingsSections`). Group ids are new
 * and also work as links. Ids from before the regrouping keep working because every old section
 * is still a section; it simply opens inside its group now.
 *
 * Pure data and functions (no React), so the layout and the search are unit-tested.
 */

export type SectionId =
  | 'writing' | 'input' | 'handwriting'
  | 'appearance' | 'reading'
  | 'ai' | 'ink-actions'
  | 'sync' | 'devices'
  | 'knowledge'
  | 'trust' | 'authorship'
  | 'modules' | 'plugins' | 'agents' | 'code' | 'developer'
  | 'about';

export type GroupId = 'writing' | 'appearance' | 'ai' | 'sync' | 'knowledge' | 'privacy' | 'extend' | 'about';

export interface SettingsGroup {
  id: GroupId;
  label: string;
  /** What is inside, in a few plain words (the second line of the group list on phones). */
  hint: string;
  sections: SectionId[];
}

export const GROUPS: readonly SettingsGroup[] = [
  { id: 'writing', label: 'Writing', hint: 'Feel, pen and touch, handwriting', sections: ['writing', 'input', 'handwriting'] },
  { id: 'appearance', label: 'Appearance', hint: 'Theme, paper, reading', sections: ['appearance', 'reading'] },
  { id: 'ai', label: 'AI', hint: 'Models, keys, assistant, ink actions', sections: ['ai', 'ink-actions'] },
  { id: 'sync', label: 'Sync & devices', hint: 'Google Drive, WebDAV, backup, pairing', sections: ['sync', 'devices'] },
  { id: 'knowledge', label: 'Knowledge', hint: 'Links, daily notes, templates, Obsidian', sections: ['knowledge'] },
  { id: 'privacy', label: 'Privacy & trust', hint: 'What AI may see, usage, audit, authorship', sections: ['trust', 'authorship'] },
  { id: 'extend', label: 'Extend', hint: 'Modules, plugins, agents, developer tools', sections: ['modules', 'plugins', 'agents', 'code', 'developer'] },
  { id: 'about', label: 'About', hint: 'Version, your data, check this device', sections: ['about'] },
];

/** Tab names inside a group: short, because they sit side by side on a folded phone. */
export const SECTION_LABELS: Record<SectionId, string> = {
  writing: 'Feel',
  input: 'Pen & touch',
  handwriting: 'Handwriting',
  appearance: 'Theme & paper',
  reading: 'Reading',
  ai: 'Models & assistant',
  'ink-actions': 'Ink actions',
  sync: 'Sync & backup',
  devices: 'Devices & sharing',
  knowledge: 'Notes & links',
  trust: 'AI privacy',
  authorship: 'Authorship',
  modules: 'Modules',
  plugins: 'Plugins',
  agents: 'Agents',
  code: 'Code & runbooks',
  developer: 'Developer',
  about: 'About',
};

export const groupOf = (section: SectionId): SettingsGroup => GROUPS.find((g) => g.sections.includes(section))!;

export interface SettingsTarget { group: GroupId; section: SectionId }

/**
 * Where a link like `#settings/<id>` goes. Accepts group ids and section ids (including every id
 * from before the regrouping). `visible` lists the sections that are shown (modules can hide some);
 * a hidden section falls back to the first shown section of its group. Unknown ids give null:
 * the Settings home.
 */
export function resolveSettingsTarget(id: string | undefined, visible: ReadonlySet<SectionId> = ALL_SECTIONS): SettingsTarget | null {
  if (!id) return null;
  const firstShown = (g: SettingsGroup): SettingsTarget | null => {
    const s = g.sections.find((x) => visible.has(x));
    return s ? { group: g.id, section: s } : null;
  };
  const asSection = GROUPS.find((g) => g.sections.includes(id as SectionId));
  if (asSection) return visible.has(id as SectionId) ? { group: asSection.id, section: id as SectionId } : firstShown(asSection);
  const asGroup = GROUPS.find((g) => g.id === id);
  return asGroup ? firstShown(asGroup) : null;
}

export const ALL_SECTIONS: ReadonlySet<SectionId> = new Set(GROUPS.flatMap((g) => g.sections));

// ---- Search ------------------------------------------------------------------------------------

export interface SettingEntry {
  /** What people call it; shown in the results. */
  label: string;
  section: SectionId;
  /** Other words people might type. */
  keywords?: string;
  /**
   * The visible text on the page to scroll to and highlight (a heading or a row label), when it
   * differs from `label`. The e2e suite checks that every target exists where the index says.
   */
  target?: string;
  /** Shown only in some states (e.g. once a device is paired); the page may not have it now. */
  optional?: boolean;
  /** Exists only where this is available; search leaves it out elsewhere. */
  requires?: Requirement;
}

/** What some settings need: the Android app's native layer, or access to folders on a computer. */
export type Requirement = 'android-app' | 'folder-access';

/**
 * Every setting worth finding by name. Headings and row labels as they appear on screen, plus the
 * words people use for them ("dark mode", "API key", "backup").
 */
export const SETTINGS_INDEX: readonly SettingEntry[] = [
  // Writing › Feel
  { label: 'Paper feel', section: 'writing', keywords: 'haptics vibration grain texture' },
  { label: 'Writing sound', section: 'writing', keywords: 'audio scratch noise volume' },
  { label: 'Paper grain', section: 'writing', keywords: 'haptic vibration texture', requires: 'android-app' },
  { label: 'Writing sound volume', section: 'writing', keywords: 'volume loud quiet', target: 'Volume' },
  { label: 'Pressure response', section: 'writing', keywords: 'pressure curve soft firm' },
  // Writing › Pen & touch
  { label: 'Writing hand', section: 'input', keywords: 'left handed right handed lefty tray side' },
  { label: 'Pen button', section: 'input', keywords: 'stylus barrel button eraser moto pen s pen' },
  { label: 'One finger', section: 'input', keywords: 'finger draws scrolls palm touch' },
  { label: 'Two-finger tap to undo, three to redo', section: 'input', keywords: 'gestures undo redo tap' },
  { label: 'Scribble to erase', section: 'input', keywords: 'scratch out gesture delete' },
  { label: 'Instant ink', section: 'input', keywords: 'latency lag front buffer', requires: 'android-app' },
  { label: 'Hold to perfect shapes', section: 'input', keywords: 'shapes snap line circle' },
  { label: 'Snap to guides', section: 'input', keywords: 'snapping align margins' },
  { label: 'Two-page view', section: 'input', keywords: 'spread side by side pages' },
  { label: 'Smart ink suggestions', section: 'input', keywords: 'table solve calendar chips' },
  { label: 'Keyboard shortcuts', section: 'input', keywords: 'keys hotkeys' },
  // Writing › Handwriting
  { label: 'Handwriting recognition', section: 'handwriting', keywords: 'ocr text convert transcribe' },
  { label: 'Recognition language', section: 'handwriting', keywords: 'language english', target: 'Language' },
  // Appearance
  { label: 'Theme', section: 'appearance', keywords: 'dark mode night light day colour color palette aizome celadon sumi' },
  { label: 'Paper for new notes', section: 'appearance', keywords: 'default paper lined grid dotted' },
  { label: 'Page size', section: 'appearance', keywords: 'a4 letter size' },
  { label: 'Sort notes by', section: 'appearance', keywords: 'library order' },
  { label: 'Reading view', section: 'reading', keywords: 'dyslexia font spacing accessibility' },
  { label: 'Read aloud', section: 'reading', keywords: 'speech voice tts speak' },
  // AI
  { label: 'On this device', section: 'ai', keywords: 'on-device local offline model private' },
  { label: 'Search everything', section: 'ai', keywords: 'embeddings semantic index' },
  { label: 'Speech to text', section: 'ai', keywords: 'transcription whisper recording' },
  { label: 'Your AI providers', section: 'ai', keywords: 'api key openai anthropic claude gemini model provider' },
  { label: 'Add an AI provider', section: 'ai', keywords: 'api key new provider' },
  { label: 'Ask before the assistant deletes or moves notes', section: 'ai', keywords: 'safety confirm' },
  { label: 'Assistant', section: 'ai', keywords: 'activity routines connected apps skills memory' },
  { label: 'Voice', section: 'ai', keywords: 'talk microphone read replies aloud' },
  { label: 'AI answers', section: 'ink-actions', keywords: 'answer in ink handwriting style' },
  { label: 'Papers and citations', section: 'ink-actions', keywords: 'citation style bibliography' },
  // Sync & devices
  { label: 'Google account', section: 'sync', keywords: 'google drive sign in' },
  { label: 'Sync status', section: 'sync', keywords: 'sync now' },
  { label: 'WebDAV', section: 'sync', keywords: 'nextcloud owncloud synology server', target: 'WebDAV (Nextcloud, ownCloud, Synology…)' },
  { label: 'A folder on this computer', section: 'sync', keywords: 'dropbox icloud obsidian folder', requires: 'folder-access' },
  { label: 'Backup', section: 'sync', keywords: 'download restore zip export' },
  { label: 'Pair, sync and join', section: 'devices', keywords: 'pair device phone laptop code' },
  { label: 'Paired devices', section: 'devices', keywords: 'devices remove', optional: true },
  // Knowledge
  { label: 'Daily notes', section: 'knowledge', keywords: 'journal today template' },
  { label: 'Templates', section: 'knowledge', keywords: 'template' },
  { label: 'Obsidian', section: 'knowledge', keywords: 'import export markdown vault' },
  // Privacy & trust
  { label: 'Routing & privacy', section: 'trust', keywords: 'where ai runs local only budget policy what ai may see' },
  { label: 'AI usage', section: 'trust', keywords: 'tokens cost budget' },
  { label: 'Audit trail', section: 'trust', keywords: 'log signed verify' },
  { label: 'Name in certificates', section: 'authorship', keywords: 'certificate device name' },
  { label: 'Verify a certificate', section: 'authorship', keywords: 'proof authorship check' },
  // Extend
  { label: 'Start from a preset', section: 'modules', keywords: 'student writer minimal preset' },
  { label: 'Modules', section: 'modules', keywords: 'features switch off turn off' },
  { label: 'Installed plugins', section: 'plugins', keywords: 'plugins extensions', target: 'Installed' },
  { label: 'Browse plugins', section: 'plugins', keywords: 'plugins extensions store', target: 'Browse' },
  { label: 'Let any AI agent use your notes', section: 'agents', keywords: 'mcp claude desktop claude code cursor server' },
  { label: 'Code-aware notes', section: 'code', keywords: 'code links runbooks repository' },
  { label: 'API keys', section: 'developer', keywords: 'rest api token', optional: true },
  { label: 'Automation API', section: 'developer', keywords: 'window.inkwright scripting', optional: true },
  // About
  { label: 'Your data', section: 'about', keywords: 'storage notes count version' },
  { label: 'Check this device', section: 'about', keywords: 'diagnostics latency pen pressure screen report test' },
  { label: 'Reset settings to defaults', section: 'about', keywords: 'reset defaults' },
];

/** Lower-case, accents removed, so "réglages" finds "reglages" and "Pen & touch" finds "pen touch". */
const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9.]+/g, ' ').trim();

export interface SettingMatch { entry: SettingEntry; group: SettingsGroup; score: number }

/**
 * Finds settings by name. Every word typed must appear (as the start of a word) in the label, the
 * keywords, or the section and group names; matches in the label rank first, then by how early.
 */
export function searchSettings(query: string, visible: ReadonlySet<SectionId> = ALL_SECTIONS, has: (r: Requirement) => boolean = () => true, limit = 8): SettingMatch[] {
  const words = fold(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const out: SettingMatch[] = [];
  for (const entry of SETTINGS_INDEX) {
    if (!visible.has(entry.section) || (entry.requires && !has(entry.requires))) continue;
    const group = groupOf(entry.section);
    const label = ` ${fold(entry.label)}`;
    const rest = ` ${fold(`${entry.keywords ?? ''} ${SECTION_LABELS[entry.section]} ${group.label}`)}`;
    let score = 0;
    let ok = true;
    for (const w of words) {
      const inLabel = label.indexOf(` ${w}`);
      if (inLabel >= 0) score += 100 - Math.min(inLabel, 60) + (label.startsWith(` ${w}`) ? 40 : 0);
      else if (rest.includes(` ${w}`)) score += 20;
      else { ok = false; break; }
    }
    if (ok) out.push({ entry, group, score });
  }
  return out.sort((a, b) => b.score - a.score || a.entry.label.length - b.entry.label.length).slice(0, limit);
}
