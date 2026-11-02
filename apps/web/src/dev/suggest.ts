import { searchSymbols, type CodeSymbol } from '@inkstone/core';
import { devToolsOn } from './settings.ts';
import { useDev } from './store.ts';

/**
 * `[[code:` autocomplete for the text box suggestions (ui/knowledge/LinkSuggest.tsx): symbols of
 * the mounted code sources, best first. Empty when the developer module is off.
 */
export function suggestCode(query: string, limit = 8): CodeSymbol[] {
  if (!devToolsOn()) return [];
  const { graphs } = useDev.getState();
  return searchSymbols(graphs, query, { limit }).map((h) => h.symbol);
}
