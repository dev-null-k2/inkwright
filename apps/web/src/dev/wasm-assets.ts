/**
 * WebAssembly the developer module loads on demand: the tree-sitter runtime and the grammars of
 * the six supported languages (from @vscode/tree-sitter-wasm, MIT), and SQLite (sql.js) for
 * ```sql runbook blocks. Vite emits each as a separate file fetched only when first needed, and
 * the service worker caches it then (wasm is left out of the install-time precache).
 *
 * The single-file preview build swaps this module for `wasm-assets-unavailable.ts` (vite.config.ts):
 * inlining megabytes of grammars into one HTML file is not worth it there.
 */
import type { CodeLanguage } from '@inkstone/core';
import treeSitterRuntime from 'web-tree-sitter/tree-sitter.wasm?url';
import typescript from '@vscode/tree-sitter-wasm/wasm/tree-sitter-typescript.wasm?url';
import tsx from '@vscode/tree-sitter-wasm/wasm/tree-sitter-tsx.wasm?url';
import javascript from '@vscode/tree-sitter-wasm/wasm/tree-sitter-javascript.wasm?url';
import python from '@vscode/tree-sitter-wasm/wasm/tree-sitter-python.wasm?url';
import go from '@vscode/tree-sitter-wasm/wasm/tree-sitter-go.wasm?url';
import rust from '@vscode/tree-sitter-wasm/wasm/tree-sitter-rust.wasm?url';
import java from '@vscode/tree-sitter-wasm/wasm/tree-sitter-java.wasm?url';
import sqlite from 'sql.js/dist/sql-wasm-browser.wasm?url';

export const WASM_AVAILABLE = true;
export const TREE_SITTER_RUNTIME: string | null = treeSitterRuntime;
export const GRAMMARS: Record<CodeLanguage, string> | null = { typescript, tsx, javascript, python, go, rust, java };
export const SQLITE_WASM: string | null = sqlite;
