/**
 * Tree-sitter in the browser: web-tree-sitter plus the grammar wasm files, loaded only when a
 * code source is scanned (and each grammar only when its language appears; both download once,
 * verified, see ./wasm-assets.ts). The same runtime and grammars as the CLI
 * (apps/mcp-server/src/dev/treesitter.ts), so both produce identical graphs.
 */
import type { CodeLanguage, CodeParser, SyntaxNodeLike } from '@inkwright/core';
import { WASM_AVAILABLE, grammar, treeSitterRuntime } from './wasm-assets.ts';

type TS = typeof import('web-tree-sitter');
let runtime: Promise<TS> | null = null;
const parsers = new Map<CodeLanguage, Promise<InstanceType<TS['Parser']> | null>>();

export function browserCodeParser(): CodeParser {
  return {
    async parse(language, text) {
      if (!WASM_AVAILABLE) return null;
      if (!runtime) {
        runtime = Promise.all([import('web-tree-sitter'), treeSitterRuntime()]).then(async ([m, wasm]) => {
          await m.Parser.init({ locateFile: () => wasm });
          return m;
        });
        runtime.catch(() => { runtime = null; }); // e.g. offline on first use: try again next scan
      }
      let p = parsers.get(language);
      if (!p) {
        p = runtime.then(async (ts) => {
          const parser = new ts.Parser();
          parser.setLanguage(await ts.Language.load(await grammar(language)));
          return parser;
        }).catch((e) => {
          console.warn(`tree-sitter: ${language} grammar failed to load`, e);
          parsers.delete(language); // not remembered: the next scan tries again (back online)
          return null;
        });
        parsers.set(language, p);
      }
      const parser = await p;
      const tree = parser?.parse(text);
      return (tree?.rootNode ?? null) as unknown as SyntaxNodeLike | null;
    },
  };
}
