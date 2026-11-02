/**
 * Tree-sitter in the browser: web-tree-sitter plus the grammar wasm files, loaded only when a
 * code source is scanned (and each grammar only when its language appears). The same runtime and
 * grammars as the CLI (apps/mcp-server/src/dev/treesitter.ts), so both produce identical graphs.
 */
import type { CodeLanguage, CodeParser, SyntaxNodeLike } from '@inkstone/core';
import { GRAMMARS, TREE_SITTER_RUNTIME } from './wasm-assets.ts';

type TS = typeof import('web-tree-sitter');
let runtime: Promise<TS> | null = null;
const parsers = new Map<CodeLanguage, Promise<InstanceType<TS['Parser']> | null>>();

export function browserCodeParser(): CodeParser {
  return {
    async parse(language, text) {
      if (!TREE_SITTER_RUNTIME || !GRAMMARS) return null;
      runtime ??= import('web-tree-sitter').then(async (m) => {
        await m.Parser.init({ locateFile: () => TREE_SITTER_RUNTIME! });
        return m;
      });
      let p = parsers.get(language);
      if (!p) {
        p = runtime.then(async (ts) => {
          const parser = new ts.Parser();
          parser.setLanguage(await ts.Language.load(GRAMMARS![language]));
          return parser;
        }).catch((e) => { console.warn(`tree-sitter: ${language} grammar failed to load`, e); return null; });
        parsers.set(language, p);
      }
      const parser = await p;
      const tree = parser?.parse(text);
      return (tree?.rootNode ?? null) as unknown as SyntaxNodeLike | null;
    },
  };
}
