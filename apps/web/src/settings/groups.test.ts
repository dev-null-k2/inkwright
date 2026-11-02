import { describe, expect, it } from 'vitest';
import { ALL_SECTIONS, GROUPS, SECTION_LABELS, SETTINGS_INDEX, resolveSettingsTarget, searchSettings, type SectionId } from './groups.ts';

/** Every section id Settings had before the regrouping (links to them must keep working). */
const OLD_IDS = ['writing', 'input', 'handwriting', 'ai', 'sync', 'devices', 'agents', 'authorship', 'appearance', 'knowledge', 'ink-actions', 'reading', 'modules', 'plugins', 'code', 'developer', 'about'];

describe('settings groups', () => {
  it('has a small number of groups covering every section exactly once', () => {
    expect(GROUPS.length).toBeLessThanOrEqual(8);
    const all = GROUPS.flatMap((g) => g.sections);
    expect(new Set(all).size).toBe(all.length);
    for (const id of all) expect(SECTION_LABELS[id]).toBeTruthy();
  });

  it('opens every old section id inside its group', () => {
    for (const id of OLD_IDS) {
      const t = resolveSettingsTarget(id);
      expect(t, id).not.toBeNull();
      expect(t!.section).toBe(id);
      expect(GROUPS.find((g) => g.id === t!.group)!.sections).toContain(id);
    }
    expect(resolveSettingsTarget('input')).toEqual({ group: 'writing', section: 'input' });
    expect(resolveSettingsTarget('authorship')).toEqual({ group: 'privacy', section: 'authorship' });
    expect(resolveSettingsTarget('modules')).toEqual({ group: 'extend', section: 'modules' });
  });

  it('opens a group at its first shown section, and skips sections a module hides', () => {
    expect(resolveSettingsTarget('extend')).toEqual({ group: 'extend', section: 'modules' });
    expect(resolveSettingsTarget('privacy')).toEqual({ group: 'privacy', section: 'trust' });
    const withoutDeveloper = new Set([...ALL_SECTIONS].filter((s) => s !== 'developer'));
    expect(resolveSettingsTarget('developer', withoutDeveloper)).toEqual({ group: 'extend', section: 'modules' });
    // Knowledge holds the notes settings plus the opt-in memory timeline and journal.
    const withoutKnowledge = new Set([...ALL_SECTIONS].filter((s) => !['knowledge', 'import', 'recall', 'journal'].includes(s)));
    expect(resolveSettingsTarget('knowledge', withoutKnowledge)).toBeNull();
  });

  it('sends unknown ids to the Settings home', () => {
    expect(resolveSettingsTarget(undefined)).toBeNull();
    expect(resolveSettingsTarget('nope')).toBeNull();
  });
});

describe('settings search', () => {
  const first = (q: string, visible?: ReadonlySet<SectionId>) => searchSettings(q, visible)[0]?.entry.label;

  it('finds settings by their name', () => {
    expect(first('pen button')).toBe('Pen button');
    expect(first('scribble')).toBe('Scribble to erase');
    expect(first('webdav')).toBe('WebDAV');
    expect(first('check this')).toBe('Check this device');
  });

  it('finds them by the words people use', () => {
    expect(first('dark mode')).toBe('Theme');
    // Both the AI provider keys and the developer's REST keys answer "api key".
    expect(searchSettings('api key').map((m) => m.entry.label)).toEqual(expect.arrayContaining(['Your AI providers', 'API keys']));
    expect(first('latency')).toBe('Instant ink');
    expect(first('backup')).toBe('Backup');
    expect(first('mcp')).toBe('Let any AI agent use your notes');
  });

  it('ignores case, accents and punctuation, and needs every word', () => {
    expect(first('PEN & Touch')).toBeTruthy();
    expect(first('pressúre')).toBe('Pressure response');
    expect(searchSettings('pen zebra')).toEqual([]);
    expect(searchSettings('   ')).toEqual([]);
  });

  it('ranks label matches above keyword matches', () => {
    const labels = searchSettings('voice').map((m) => m.entry.label);
    expect(labels[0]).toBe('Voice');
  });

  it('leaves out sections a module hides', () => {
    const visible = new Set([...ALL_SECTIONS].filter((s) => s !== 'knowledge'));
    expect(searchSettings('obsidian').map((m) => m.entry.section)).toContain('knowledge');
    expect(searchSettings('obsidian', visible).map((m) => m.entry.section)).not.toContain('knowledge');
  });

  it('leaves out settings this device does not have', () => {
    expect(searchSettings('instant ink')[0]?.entry.label).toBe('Instant ink');
    expect(searchSettings('instant ink', ALL_SECTIONS, (r) => r !== 'android-app').map((m) => m.entry.label)).not.toContain('Instant ink');
  });

  it('indexes only sections that exist', () => {
    for (const e of SETTINGS_INDEX) expect(ALL_SECTIONS.has(e.section), e.label).toBe(true);
  });
});
