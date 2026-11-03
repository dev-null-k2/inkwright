import { create } from 'zustand';

/** Whether the timeline is open, and the moment or question to open it at. */
interface TimelineUI {
  open: boolean;
  /** Epoch ms to scroll to (a `#recall/<ms>` link, a journal source). */
  focusAt: number | null;
  query: string;
}

export const useTimelineUI = create<TimelineUI>(() => ({ open: false, focusAt: null, query: '' }));

export function openTimeline(o: { at?: number; query?: string } = {}): void {
  useTimelineUI.setState({ open: true, focusAt: o.at ?? null, query: o.query ?? '' });
}

export function closeTimeline(): void {
  useTimelineUI.setState({ open: false, focusAt: null });
}

/** `#recall/<epoch ms>` — links to a moment (journal sources, search results, the assistant). */
export function parseRecallHref(href: string): number | null {
  const m = /^#recall\/(\d{10,16})$/.exec(href.trim());
  return m ? Number(m[1]) : null;
}

let installed = false;

/** Handles clicks on `#recall/…` links anywhere in the app. */
export function installRecallLinks(): () => void {
  if (installed || typeof document === 'undefined') return () => {};
  installed = true;
  const onClick = (e: MouseEvent) => {
    const a = (e.target as Element | null)?.closest?.('a[href^="#recall/"]');
    if (!a) return;
    const at = parseRecallHref(a.getAttribute('href') ?? '');
    if (at == null) return;
    e.preventDefault();
    openTimeline({ at });
  };
  document.addEventListener('click', onClick);
  return () => { installed = false; document.removeEventListener('click', onClick); };
}
