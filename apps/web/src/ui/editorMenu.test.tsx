import { describe, expect, it } from 'vitest';
import { buildEditorMenu, flattenMenu, placeFeatureItem, tidy, type EditorMenuInput } from './editorMenu.tsx';
import { isBranch, type MenuLeaf, type MenuNode } from './MenuTree.tsx';

const leaf = (label: string): MenuLeaf => ({ label, onClick: () => {} });
const labels = (nodes: MenuNode[]) => nodes.map((n) => (n === 'sep' ? '—' : n.label));

/** Everything the editor can contribute with every module on, on a PDF note, on a phone. */
const everything: EditorMenuInput = {
  top: [leaf('Fill & sign'), leaf('Search everything'), leaf('Pages')],
  own: {
    insert: ['Image', 'Photo from camera', 'Scan document', 'PDF pages', 'Blank page', 'Text box'].map(leaf),
    page: ['Paper', 'Writing sound & feel', 'Fit to width'].map(leaf),
    audio: ['Record audio', 'Transcript', 'Dictate'].map(leaf),
    share: ['PDF', 'PNG image', 'SVG', 'Markdown', 'Filled form', 'Plain text'].map(leaf),
    note: [leaf('Links'), leaf('Tags'), 'sep', leaf('Duplicate note'), leaf('Save as template'), leaf('Save now')],
  },
  features: {
    studio: ['View', 'Version history', 'Lock note'].map(leaf),
    ink: ['Write the answer here', 'Run diagram', 'Add data', 'Query data', 'Photo to ink', 'Show the original photo', 'Read aloud', 'Reading view', 'Bibliography'].map(leaf),
    compiler: ['Sources of AI text', 'Study this note', 'Teach me back', 'Context pack'].map(leaf),
    live: [leaf('Share live')],
    dev: [leaf('Developer')],
    plugins: [leaf('Plugins')],
  },
  after: { share: [leaf('Authorship')] },
  end: [{ ...leaf('Move to Trash'), danger: true }],
};

describe('editor ••• menu', () => {
  it('keeps the top level to about ten entries with everything switched on', () => {
    const menu = buildEditorMenu(everything);
    const entries = menu.filter((n) => n !== 'sep');
    expect(entries.length).toBeLessThanOrEqual(11);
    expect(labels(menu)).toEqual([
      'Fill & sign', 'Search everything', 'Pages', '—',
      'Insert', 'Page', 'Audio', 'Study', 'Share & export', 'Note', 'Tools', '—',
      'Move to Trash',
    ]);
  });

  it('puts every contributed command somewhere reachable, except selection commands', () => {
    const paths = flattenMenu(buildEditorMenu(everything)).map((x) => x.path.join(' › '));
    expect(paths).toContain('Insert › Query data');
    expect(paths).toContain('Page › View');
    expect(paths).toContain('Page › Show the original photo');
    expect(paths).toContain('Audio › Read aloud');
    expect(paths).toContain('Study › Bibliography');
    expect(paths).toContain('Share & export › Context pack');
    expect(paths).toContain('Share & export › Share live');
    expect(paths).toContain('Note › Version history');
    expect(paths).toContain('Tools › Developer');
    // "Lasso first" commands live in the selection bar, not in the page menu.
    expect(paths.some((p) => /Write the answer here|Run diagram/.test(p))).toBe(false);
    // Nothing is lost: every other item appears exactly once.
    const all = [...everything.top, ...Object.values(everything.own).flat(), ...Object.values(everything.features).flat(), ...Object.values(everything.after!).flat(), ...everything.end]
      .filter((n): n is MenuLeaf => n !== 'sep' && !/Write the answer here|Run diagram/.test(n.label));
    expect(paths).toHaveLength(all.length);
  });

  it('shows a section with one entry as that entry, and drops empty sections', () => {
    const menu = buildEditorMenu({ top: [leaf('Pages')], own: { page: [leaf('Paper')], insert: [] }, features: { dev: [leaf('Developer')] }, end: [leaf('Move to Trash')] });
    expect(labels(menu)).toEqual(['Pages', '—', 'Paper', 'Developer', '—', 'Move to Trash']);
    expect(menu.some((n) => n !== 'sep' && isBranch(n))).toBe(false);
  });

  it('keeps feature items together after the section’s own entries, and closing entries last', () => {
    const menu = buildEditorMenu(everything);
    const share = menu.find((n) => n !== 'sep' && n.label === 'Share & export');
    expect(share && isBranch(share) ? labels(share.items) : null).toEqual(['PDF', 'PNG image', 'SVG', 'Markdown', 'Filled form', 'Plain text', '—', 'Context pack', 'Share live', '—', 'Authorship']);
  });

  it('separates feature items from the section’s own entries', () => {
    const menu = buildEditorMenu({ top: [], own: { note: [leaf('Tags')] }, features: { studio: [leaf('Version history'), leaf('Lock note')] }, end: [] });
    const note = menu.find((n) => n !== 'sep' && n.label === 'Note');
    expect(note && isBranch(note) ? labels(note.items) : null).toEqual(['Tags', '—', 'Version history', 'Lock note']);
  });

  it('places items whose label changes with state, and unknown items by their source', () => {
    expect(placeFeatureItem('ink', 'Hide the original photo')).toBe('page');
    expect(placeFeatureItem('studio', 'Remove lock')).toBe('note');
    expect(placeFeatureItem('ink', 'Something new')).toBe('tools');
    expect(placeFeatureItem('compiler', 'Something new')).toBe('study');
  });

  it('tidies separators', () => {
    expect(labels(tidy(['sep', leaf('a'), 'sep', 'sep', leaf('b'), 'sep']))).toEqual(['a', '—', 'b']);
  });
});
