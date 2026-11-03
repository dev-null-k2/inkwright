import { createElement, useEffect } from 'react';
import { openPalette, usePalette } from '../lib/palette.ts';
import { isIOS, isMac } from '../platform/env.ts';
import { Palette } from './screens.ts';
import { releaseBackground } from './background.ts';

/**
 * The search palette is a lazily loaded overlay (./screens.ts), and it owns Ctrl/⌘-K once it is on
 * screen (ui/Palette.tsx). Until then — its chunk still loading, or React not yet having revealed
 * it — this opens it through the palette store, which the palette reads when it renders, so the
 * keystroke is never lost on a slow connection. Opening it any other way (the library's search
 * field on touch screens) also mounts it at once.
 */

let mounted = false;

/** Renders the palette and records when it is committed, i.e. when its own shortcut is live. */
export function PaletteHost() {
  // Effects run child-first: by the time this one runs, the palette's key listener is installed.
  useEffect(() => {
    mounted = true;
    return () => { mounted = false; };
  }, []);
  return createElement(Palette);
}

export function usePaletteShortcutUntilLoaded(enabled: boolean): void {
  useEffect(() => usePalette.subscribe((s) => { if (s.open) releaseBackground(); }), []);
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (mounted) return;
      const mod = isMac || isIOS ? e.metaKey : e.ctrlKey;
      if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette({ query: '' });
        releaseBackground(); // mounts the app-wide overlays, the palette among them
        void Palette.preload();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [enabled]);
}
