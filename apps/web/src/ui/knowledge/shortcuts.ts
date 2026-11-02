import { useEffect } from 'react';
import { isMac } from '../../platform/env.ts';
import { useApp } from '../../state/app.ts';

/** Key labels for the knowledge shortcuts, for menus and tooltips. */
export const TODAY_KEYS = isMac ? '⌥D' : 'Alt+D';
export const GRAPH_KEYS = isMac ? '⌘G' : 'Ctrl+G';

/**
 * App-wide shortcuts: Alt/⌥+D opens today's daily note, Ctrl/⌘+G the graph. Uses `code` so
 * ⌥D works on Mac keyboards (where the key types "∂").
 */
export function useKnowledgeShortcuts(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (e.altKey && !mod && !e.shiftKey && e.code === 'KeyD') {
        e.preventDefault();
        void import('../../lib/knowledge.ts').then((m) => m.openToday());
      } else if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyG') {
        e.preventDefault();
        if (useApp.getState().route.name !== 'graph') useApp.getState().navigate({ name: 'graph' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
