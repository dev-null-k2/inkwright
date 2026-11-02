import { create } from 'zustand';
import { DEFAULT_PAPER, PAGE_SIZES, type PageSize, type PaperSpec } from '@inkwright/core';
import { safeStorage } from '../platform/env.ts';

/**
 * Per-device preferences for the knowledge-base features: how "Today" makes daily notes and how
 * the graph looks. Kept apart from the main settings so the two evolve independently.
 */
export interface KnowledgePrefs {
  /** Paper for new daily notes. */
  journalPaper: PaperSpec;
  journalPageSize: PageSize;
  /** Template daily notes start from (id in templates/), or null for a blank page. */
  journalTemplateId: string | null;
  /** The Journal notebook, once made (found by name otherwise). */
  journalNotebookId: string | null;
  graph: {
    mode: '3d' | '2d';
    tags: boolean;
    notebooks: boolean;
    related: boolean;
  };
}

const KEY = 'inkwright.knowledge.v1';

export const DEFAULT_KNOWLEDGE: KnowledgePrefs = {
  journalPaper: { ...DEFAULT_PAPER, style: 'dot_grid' },
  journalPageSize: PAGE_SIZES.A5,
  journalTemplateId: null,
  journalNotebookId: null,
  graph: { mode: '3d', tags: true, notebooks: true, related: false },
};

function load(): KnowledgePrefs {
  try {
    const raw = safeStorage.get(KEY);
    if (!raw) return DEFAULT_KNOWLEDGE;
    const o = JSON.parse(raw) as Partial<KnowledgePrefs>;
    return { ...DEFAULT_KNOWLEDGE, ...o, graph: { ...DEFAULT_KNOWLEDGE.graph, ...(o.graph ?? {}) } };
  } catch {
    return DEFAULT_KNOWLEDGE;
  }
}

export const useKnowledge = create<KnowledgePrefs & { update: (fn: (p: KnowledgePrefs) => Partial<KnowledgePrefs>) => void }>((set, get) => ({
  ...load(),
  update: (fn) => {
    const { update: _u, ...cur } = get();
    const next = { ...cur, ...fn(cur) };
    set(next);
    safeStorage.set(KEY, JSON.stringify(next));
  },
}));
