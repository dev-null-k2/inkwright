/**
 * The information architecture of the editor's ••• menu, in one place.
 *
 * Features contribute flat lists of items (studio, ink actions, the compiler, live sharing,
 * plugins…) without knowing where they end up; this module decides where each one belongs, so the
 * menu stays a short, predictable list whatever is switched on:
 *
 *   Fill & sign (PDF notes only) · Search everything · Pages
 *   Insert › · Page › · Audio › · Study › · Share & export › · Note › · Tools ›
 *   Move to Trash
 *
 * Items that act on a lasso selection ("Lasso first") are not page commands: they live in the
 * selection bar and are left out here. Sections with nothing in them disappear; a section with a
 * single entry is shown as that entry, so nobody opens a sub-sheet to find one row.
 */
import type { ReactNode } from 'react';
import { AudioLines, BookOpen, FilePlus2, FileSliders, NotebookText, Share2, Wrench } from 'lucide-react';
import { isBranch, type MenuBranch, type MenuLeaf, type MenuNode } from './MenuTree.tsx';

export type EditorMenuSection = 'insert' | 'page' | 'audio' | 'study' | 'share' | 'note' | 'tools';

/** Where an item goes: a section, the top level, or nowhere (it belongs to the selection bar). */
export type Placement = EditorMenuSection | 'top' | 'selection';

/** Who contributed a list of items; each source has its own placement rules. */
export type FeatureSource = 'studio' | 'ink' | 'compiler' | 'live' | 'dev' | 'plugins';

/** Order and names of the sub-sheets. Plain nouns; the names are what people scan for. */
export const SECTIONS: ReadonlyArray<{ id: EditorMenuSection; label: string; icon: ReactNode }> = [
  { id: 'insert', label: 'Insert', icon: <FilePlus2 size={16} /> },
  { id: 'page', label: 'Page', icon: <FileSliders size={16} /> },
  { id: 'audio', label: 'Audio', icon: <AudioLines size={16} /> },
  { id: 'study', label: 'Study', icon: <BookOpen size={16} /> },
  { id: 'share', label: 'Share & export', icon: <Share2 size={16} /> },
  { id: 'note', label: 'Note', icon: <NotebookText size={16} /> },
  { id: 'tools', label: 'Tools', icon: <Wrench size={16} /> },
];

/**
 * Placement of feature items by label (first match wins), then the source's fallback. Labels that
 * change with state ("Lock note" / "Remove lock", "Show" / "Hide the original photo") match by
 * pattern. A new item a feature adds lands in its source's fallback section until placed here.
 */
const RULES: Record<FeatureSource, { match: [RegExp, Placement][]; fallback: Placement }> = {
  studio: { match: [[/^View$/, 'page']], fallback: 'note' }, // Version history, Lock note / Remove lock
  ink: {
    match: [
      [/^Write the answer here$/, 'selection'],
      [/^Run diagram$/, 'selection'],
      [/^(Add|Query) data$/, 'insert'],
      [/^Photo to ink$/, 'insert'],
      [/original photo$/, 'page'],
      [/^Reading view$/, 'page'],
      [/^Read aloud$/, 'audio'],
      [/^Bibliography$/, 'study'],
    ],
    fallback: 'tools',
  },
  compiler: { match: [[/^Context pack$/, 'share']], fallback: 'study' }, // Study this note, Teach me back, Sources of AI text
  live: { match: [], fallback: 'share' },
  dev: { match: [], fallback: 'tools' },
  plugins: { match: [], fallback: 'tools' },
};

export function placeFeatureItem(source: FeatureSource, label: string): Placement {
  const r = RULES[source];
  return r.match.find(([re]) => re.test(label))?.[1] ?? r.fallback;
}

export interface EditorMenuInput {
  /** Entries that stay at the top level, in order (contextual ones are simply left out when they don't apply). */
  top: MenuLeaf[];
  /** The editor's own entries per section, in order; `'sep'` separates groups inside a section. */
  own: Partial<Record<EditorMenuSection, MenuNode[]>>;
  /** Items contributed by features, placed by {@link placeFeatureItem} after the section's own entries. */
  features: Partial<Record<FeatureSource, MenuLeaf[]>>;
  /** The editor's entries that close a section, after the features' (e.g. Authorship under Share & export). */
  after?: Partial<Record<EditorMenuSection, MenuNode[]>>;
  /** Last, after a separator: Move to Trash. */
  end: MenuLeaf[];
}

/** Drops leading, trailing and doubled separators. */
export function tidy(nodes: MenuNode[]): MenuNode[] {
  const out: MenuNode[] = [];
  for (const n of nodes) {
    if (n === 'sep' && (!out.length || out[out.length - 1] === 'sep')) continue;
    out.push(n);
  }
  while (out[out.length - 1] === 'sep') out.pop();
  return out;
}

/** Builds the ••• menu tree. Pure: the same input always gives the same menu. */
export function buildEditorMenu(input: EditorMenuInput): MenuNode[] {
  const bySection = new Map<EditorMenuSection, MenuNode[]>(SECTIONS.map((s) => [s.id, [...(input.own[s.id] ?? [])]]));
  const top: MenuNode[] = [...input.top];
  // Feature items follow the section's own entries as one group of their own.
  const added = new Set<EditorMenuSection>();
  for (const [source, items] of Object.entries(input.features) as [FeatureSource, MenuLeaf[]][]) {
    for (const item of items) {
      const where = placeFeatureItem(source, item.label);
      if (where === 'selection') continue;
      if (where === 'top') { top.push(item); continue; }
      const list = bySection.get(where)!;
      if (!added.has(where) && list.length) list.push('sep');
      added.add(where);
      list.push(item);
    }
  }
  for (const [id, items] of Object.entries(input.after ?? {}) as [EditorMenuSection, MenuNode[]][]) {
    if (items.length) bySection.get(id)!.push('sep', ...items);
  }
  const sections: MenuNode[] = [];
  for (const s of SECTIONS) {
    const items = tidy(bySection.get(s.id)!);
    const entries = items.filter((n) => n !== 'sep');
    if (!entries.length) continue;
    // One entry needs no sub-sheet of its own.
    if (entries.length === 1 && !isBranch(entries[0]!)) sections.push(entries[0]!);
    else sections.push({ label: s.label, icon: s.icon, items } satisfies MenuBranch);
  }
  return tidy([...top, 'sep', ...sections, 'sep', ...input.end]);
}

/** Every command in a menu tree with its path, e.g. `['Share & export', 'PDF']` (for tests and search). */
export function flattenMenu(nodes: MenuNode[], path: string[] = []): { path: string[]; item: MenuLeaf }[] {
  const out: { path: string[]; item: MenuLeaf }[] = [];
  for (const n of nodes) {
    if (n === 'sep') continue;
    if (isBranch(n)) out.push(...flattenMenu(n.items, [...path, n.label]));
    else out.push({ path: [...path, n.label], item: n });
  }
  return out;
}
