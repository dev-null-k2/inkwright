import { createElement, useEffect } from 'react';
import { CalendarDays, Download, Upload, Waypoints } from 'lucide-react';
import { isMac } from '../../platform/env.ts';
import { usePaletteActions } from '../../lib/palette.ts';
import { useApp } from '../../state/app.ts';
import { isModuleOn } from '../../modules/registry.ts';

/** Key labels for the knowledge shortcuts, for menus and tooltips. */
export const TODAY_KEYS = isMac ? '⌥D' : 'Alt+D';
export const GRAPH_KEYS = isMac ? '⌘G' : 'Ctrl+G';

/**
 * App-wide shortcuts: Alt/⌥+D opens today's daily note, Ctrl/⌘+G the graph. Uses `code` so
 * ⌥D works on Mac keyboards (where the key types "∂").
 */
export function useKnowledgeShortcuts(): void {
  // The same commands in the search palette, from anywhere.
  usePaletteActions('knowledge', [
    { id: 'kb-today', label: 'Today’s daily note', keywords: 'journal daily date', hint: TODAY_KEYS, icon: createElement(CalendarDays, { size: 16 }), run: () => import('../../lib/knowledge.ts').then((m) => { void m.openToday(); }) },
    { id: 'kb-graph', label: 'Graph of notes', keywords: 'links knowledge map', hint: GRAPH_KEYS, icon: createElement(Waypoints, { size: 16 }), run: () => useApp.getState().navigate({ name: 'graph' }) },
    { id: 'kb-obsidian-export', label: 'Export for Obsidian', keywords: 'markdown vault zip', icon: createElement(Download, { size: 16 }), run: () => import('../../lib/obsidian.ts').then((m) => m.exportObsidianZip()).then(() => undefined, (e) => useApp.getState().fail((e as Error).message)) },
    { id: 'kb-obsidian-import', label: 'Import an Obsidian vault', keywords: 'markdown folder zip', icon: createElement(Upload, { size: 16 }), run: () => useApp.getState().navigate({ name: 'settings', section: 'knowledge' }) },
  ]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (e.altKey && !mod && !e.shiftKey && e.code === 'KeyD' && isModuleOn('knowledge')) {
        e.preventDefault();
        void import('../../lib/knowledge.ts').then((m) => m.openToday());
      } else if (mod && !e.altKey && !e.shiftKey && e.code === 'KeyG' && isModuleOn('graph')) {
        e.preventDefault();
        if (useApp.getState().route.name !== 'graph') useApp.getState().navigate({ name: 'graph' });
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
