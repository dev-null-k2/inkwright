import { useEffect, useRef, type ReactNode } from 'react';
import { create } from 'zustand';
import { matchScore } from '@inkstone/core';

/**
 * Commands the search palette can run ("New note", "Export PDF", "Writing sound"…). Screens
 * register what makes sense where they are — the editor adds export and page actions while a note
 * is open — so the palette always offers what the visible screen can do.
 */
export interface PaletteAction {
  id: string;
  label: string;
  /** Extra words people might type for it. */
  keywords?: string;
  /** Short right-aligned hint, e.g. a shortcut or the current value. */
  hint?: string;
  icon?: ReactNode;
  run: () => void | Promise<void>;
}

const sources = new Map<string, () => PaletteAction[]>();

/** Registers a screen's actions (a function, so they are read fresh each time the palette opens). */
export function registerPaletteActions(source: string, actions: () => PaletteAction[]): () => void {
  sources.set(source, actions);
  return () => { if (sources.get(source) === actions) sources.delete(source); };
}

/** Registers actions for as long as the calling component is mounted (always the latest closures). */
export function usePaletteActions(source: string, actions: PaletteAction[]): void {
  const latest = useRef(actions);
  latest.current = actions;
  useEffect(() => registerPaletteActions(source, () => latest.current), [source]);
}

/** Actions matching a query, screen actions first. Empty query: everything, in registration order. */
export function findActions(query: string, limit = 8): PaletteAction[] {
  const all: PaletteAction[] = [];
  for (const [, get] of [...sources].reverse()) for (const a of get()) if (!all.some((x) => x.id === a.id)) all.push(a);
  if (!query.trim()) return all.slice(0, limit);
  return all
    .map((a) => ({ a, s: matchScore(query, a.label) * 2 + matchScore(query, `${a.label} ${a.keywords ?? ''}`) }))
    .filter((x) => x.s > 0)
    .sort((x, y) => y.s - x.s)
    .slice(0, limit)
    .map((x) => x.a);
}

export type PaletteMode = 'search' | 'ask';

interface PaletteState {
  open: boolean;
  mode: PaletteMode;
  query: string;
}

export const usePalette = create<PaletteState>(() => ({ open: false, mode: 'search', query: '' }));

export function openPalette(opts: { mode?: PaletteMode; query?: string } = {}) {
  usePalette.setState({ open: true, mode: opts.mode ?? 'search', query: opts.query ?? usePalette.getState().query });
}

export function closePalette() {
  usePalette.setState({ open: false });
}
