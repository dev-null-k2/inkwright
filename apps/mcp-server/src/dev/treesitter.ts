/**
 * Tree-sitter for Node: the same runtime (web-tree-sitter) and grammar files
 * (@vscode/tree-sitter-wasm) the app loads in the browser, so `inkstone scan` on a computer and
 * "Add code source" in the app produce identical graphs. Both packages stay external in the
 * bundle (scripts/build.mjs): web-tree-sitter finds its runtime .wasm next to its own file.
 */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import type { CodeLanguage, CodeParser, SyntaxNodeLike } from '@inkstone/core';

const require = createRequire(import.meta.url);

type TS = typeof import('web-tree-sitter');
type Parser = InstanceType<TS['Parser']>;
let runtime: Promise<TS> | null = null;
const parsers = new Map<CodeLanguage, Promise<Parser>>();

function grammarDir(): string {
  return path.join(path.dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
}

/** A `CodeParser` backed by web-tree-sitter; each grammar loads on first use of its language. */
export function nodeCodeParser(): CodeParser {
  return {
    async parse(language, text) {
      runtime ??= import('web-tree-sitter').then(async (m) => { await m.Parser.init(); return m; });
      let p = parsers.get(language);
      if (!p) {
        p = runtime.then(async (ts) => {
          const parser = new ts.Parser();
          parser.setLanguage(await ts.Language.load(path.join(grammarDir(), `tree-sitter-${language}.wasm`)));
          return parser;
        });
        parsers.set(language, p);
      }
      const tree = (await p).parse(text);
      return (tree?.rootNode ?? null) as unknown as SyntaxNodeLike | null;
    },
  };
}
