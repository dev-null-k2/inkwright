// Lets plain Node (tsx) load Vite-style `?raw` imports — the built-in SKILL.md files the AI package
// bundles — as a string default export, so the evals run outside Vite and Vitest.
import { register } from 'node:module';

register('data:text/javascript,' + encodeURIComponent(`
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
export async function load(url, context, next) {
  if (!url.startsWith('file:') || !url.includes('?raw')) return next(url, context);
  const text = await readFile(fileURLToPath(url.slice(0, url.indexOf('?'))), 'utf8');
  return { format: 'module', source: 'export default ' + JSON.stringify(text) + ';', shortCircuit: true };
}
`));
