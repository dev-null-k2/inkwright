import { useEffect } from 'react';
import { create } from 'zustand';
import type { InkEngine } from '../canvas/engine.ts';
import { useApp } from '../state/app.ts';

/**
 * "Take me to that place": a search result or an AI citation names a note, a page and a region.
 * The request is parked here, the app navigates to the note, and the editor's engine picks it up
 * as soon as it exists (or immediately, when that note is already open), scrolling to the region
 * and flashing it.
 */
export interface FocusRequest {
  noteId: string;
  pageIndex: number;
  /** Page-space region (page units). Without it the page itself is shown. */
  rect?: { x: number; y: number; width: number; height: number };
  /** Distinguishes repeated requests for the same place. */
  seq: number;
}

const useFocus = create<{ request: FocusRequest | null }>(() => ({ request: null }));
let seq = 0;

/** Opens a note at a page and highlights a region. */
export function openAnchor(a: Omit<FocusRequest, 'seq'>): void {
  useFocus.setState({ request: { ...a, seq: ++seq } });
  const app = useApp.getState();
  const r = app.route;
  if (r.name !== 'editor' || r.noteId !== a.noteId) app.navigate({ name: 'editor', noteId: a.noteId, page: a.pageIndex });
}

/** Applies a parked request to this editor's engine once the engine shows that note. */
export function applyFocus(engine: InkEngine, noteId: string, req: FocusRequest): boolean {
  if (req.noteId !== noteId) return false;
  if (req.rect) engine.flashRegion(req.pageIndex, { minX: req.rect.x, minY: req.rect.y, maxX: req.rect.x + req.rect.width, maxY: req.rect.y + req.rect.height });
  else engine.scrollToPage(req.pageIndex);
  useFocus.setState({ request: null });
  return true;
}

/** Editor hook: honours focus requests for the open note. */
export function useFocusRequests(engine: InkEngine | null, noteId: string): void {
  const request = useFocus((s) => s.request);
  useEffect(() => {
    if (!engine || !request) return;
    // Let the first layout and fit-to-width settle before scrolling.
    const id = requestAnimationFrame(() => requestAnimationFrame(() => applyFocus(engine, noteId, request)));
    return () => cancelAnimationFrame(id);
  }, [engine, noteId, request]);
}
