import { create } from 'zustand';
import type { Rect } from '@inkwright/core';
import type { FoundEvent, FoundLink } from './detect.ts';

/**
 * Shared state of the smart-ink layer: the one card on screen (what circled or lassoed writing
 * can do), shared between the selection bar's buttons and the layer that draws the card.
 */
export interface ReadCard {
  kind: 'read';
  pageIndex: number;
  /** Page-space area the card sits next to. */
  anchor: Rect;
  text: string;
  event: FoundEvent | null;
  links: FoundLink[];
  tasks: { text: string; done: boolean }[] | null;
}

export interface SmartState {
  card: ReadCard | null;
  /** A short "Reading…" / "Solving…" status while something runs. */
  busy: string | null;
  setCard: (c: ReadCard | null) => void;
  setBusy: (b: string | null) => void;
}

export const useSmart = create<SmartState>((set) => ({
  card: null,
  busy: null,
  setCard: (card) => set({ card }),
  setBusy: (busy) => set({ busy }),
}));
