/** web-tree-sitter in Node for the extractor tests: the same runtime and grammars the app ships. */
import { createRequire } from 'node:module';
import * as path from 'node:path';
import { Language, Parser } from 'web-tree-sitter';
import type { CodeLanguage, CodeParser, SyntaxNodeLike } from '../../src/index.ts';

const require = createRequire(import.meta.url);
const wasmDir = path.join(path.dirname(require.resolve('@vscode/tree-sitter-wasm/package.json')), 'wasm');
let ready: Promise<void> | null = null;
const langs = new Map<CodeLanguage, Promise<Language>>();

export function nodeParser(): CodeParser {
  return {
    async parse(language: CodeLanguage, text: string) {
      ready ??= Parser.init();
      await ready;
      let l = langs.get(language);
      if (!l) langs.set(language, (l = Language.load(path.join(wasmDir, `tree-sitter-${language}.wasm`))));
      const p = new Parser();
      p.setLanguage(await l);
      const tree = p.parse(text);
      return (tree?.rootNode ?? null) as unknown as SyntaxNodeLike | null;
    },
  };
}
