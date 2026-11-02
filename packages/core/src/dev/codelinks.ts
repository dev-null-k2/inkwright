/**
 * Code links: `[[code:path/to/file.ts#Symbol]]` in typed text or recognized handwriting, and ink
 * links whose target is `code:…`. They are ordinary wiki links (links.ts parses them; they just
 * never resolve to a note), so rename, backlinks, Obsidian export and sync already handle them.
 * This file only knows the target syntax; drift.ts compares them with the code graph.
 *
 * Syntax: `code:` + a repository-relative path, optionally `#` + the symbol's qualified name
 * (`SessionStore.put`, `GET /health`). A short name works when it is unique in the file.
 */
export const CODE_LINK_PREFIX = 'code:';

export interface CodeTarget {
  path: string;
  /** Qualified symbol name; absent for a link to a whole file. */
  symbol?: string;
}

export function isCodeTarget(target: string): boolean {
  return target.trim().toLowerCase().startsWith(CODE_LINK_PREFIX);
}

/** `code:src/a.ts#Foo.bar` → `{ path: 'src/a.ts', symbol: 'Foo.bar' }`; null for other targets. */
export function parseCodeTarget(target: string): CodeTarget | null {
  const t = target.trim();
  if (!isCodeTarget(t)) return null;
  const body = t.slice(CODE_LINK_PREFIX.length).trim();
  const bar = body.indexOf('|');
  const inner = bar >= 0 ? body.slice(0, bar) : body;
  const hash = inner.indexOf('#');
  const path = (hash >= 0 ? inner.slice(0, hash) : inner).trim().replace(/^\.?\//, '');
  const symbol = hash >= 0 ? inner.slice(hash + 1).trim() : '';
  if (!path || path.split('/').includes('..')) return null;
  return symbol ? { path, symbol } : { path };
}

/** The key a link's baseline is stored under in `NoteMeta.codeRefs`. */
export function codeRefKey(t: CodeTarget): string {
  return t.symbol ? `${t.path}#${t.symbol}` : t.path;
}

export function formatCodeTarget(t: CodeTarget): string {
  return `${CODE_LINK_PREFIX}${codeRefKey(t)}`;
}

/** Link markup, e.g. `[[code:src/auth.ts#createSession]]`. */
export function formatCodeLink(t: CodeTarget, alias?: string): string {
  const clean = (s: string) => s.replace(/[[\]|\n]+/g, ' ').trim();
  return `[[${CODE_LINK_PREFIX}${clean(t.path)}${t.symbol ? `#${clean(t.symbol)}` : ''}${alias ? `|${clean(alias)}` : ''}]]`;
}

/** What a code link shows on the page: its alias, else the symbol, else the file name. */
export function codeLinkLabel(t: CodeTarget, alias?: string): string {
  if (alias) return alias;
  if (t.symbol) return t.symbol;
  const slash = t.path.lastIndexOf('/');
  return slash >= 0 ? t.path.slice(slash + 1) : t.path;
}
