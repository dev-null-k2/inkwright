/**
 * Stand-in for `wasm-assets.ts` in the single-file preview build (vite.config.ts aliases it): no
 * grammars or SQLite are bundled there, so scanning and ```sql blocks say they need the full app.
 * Importing graphs, code links, drift, diagrams, ```http and ```js blocks still work.
 */
import type { CodeLanguage } from '@inkstone/core';

export const WASM_AVAILABLE = false;
export const TREE_SITTER_RUNTIME: string | null = null;
export const GRAMMARS: Record<CodeLanguage, string> | null = null;
export const SQLITE_WASM: string | null = null;
