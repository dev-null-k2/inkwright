/**
 * WebAssembly the developer module loads on demand:
 *
 * - the tree-sitter runtime and the grammars of the seven supported languages (web-tree-sitter and
 *   @vscode/tree-sitter-wasm, MIT) download on first use (src/engines): ~5 MB that only people
 *   who scan repositories need, so they are not part of the install. Each grammar is fetched when
 *   its language first appears.
 * - SQLite (sql.js) for ```sql runbook blocks ships with the app (the data sandbox uses it too).
 *
 * The single-file preview build swaps this module for `wasm-assets-unavailable.ts` (vite.config.ts).
 */
import type { CodeLanguage } from '@inkwright/core';
import sqlite from 'sql.js/dist/sql-wasm-browser.wasm?url';
import { engine } from '../engines/catalog.ts';
import { downloadEngine } from '../engines/progress.ts';

export const WASM_AVAILABLE = !!engine('tree-sitter');
export const SQLITE_WASM: string | null = sqlite;

/** The tree-sitter runtime (`tree-sitter.wasm`) as a verified local URL. */
export async function treeSitterRuntime(): Promise<string> {
  return (await downloadEngine('tree-sitter', { files: ['tree-sitter.wasm'] }))['tree-sitter.wasm']!;
}

/** One language's grammar as a verified local URL. */
export async function grammar(language: CodeLanguage): Promise<string> {
  const file = `tree-sitter-${language}.wasm`;
  return (await downloadEngine('tree-sitter', { files: [file] }))[file]!;
}
