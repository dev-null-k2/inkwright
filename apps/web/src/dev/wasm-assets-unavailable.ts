/**
 * Stand-in for `wasm-assets.ts` in the single-file preview build (vite.config.ts aliases it): no
 * grammars or SQLite are bundled there, so scanning and ```sql blocks say they need the full app.
 * Importing graphs, code links, drift, diagrams, ```http and ```js blocks still work.
 */
import type { CodeLanguage } from '@inkwright/core';

export const WASM_AVAILABLE = false;
export const SQLITE_WASM: string | null = null;

export async function treeSitterRuntime(): Promise<string> {
  throw new Error('Scanning code needs the full app.');
}

export async function grammar(_language: CodeLanguage): Promise<string> {
  throw new Error('Scanning code needs the full app.');
}
