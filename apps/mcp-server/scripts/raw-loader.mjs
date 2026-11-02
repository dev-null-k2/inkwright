// Node module hooks for `?raw` imports (Vite syntax for "this file's text"), used by
// @inkwright/ai for its built-in SKILL.md files. Registered by raw-hooks.mjs when the server runs
// from source with tsx; the published bundle inlines the files at build time instead.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

export async function resolve(specifier, context, next) {
  if (specifier.endsWith('?raw') && context.parentURL) {
    return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith('file:') && url.endsWith('?raw')) {
    const text = await readFile(fileURLToPath(url.slice(0, -'?raw'.length)), 'utf8');
    return { format: 'module', source: `export default ${JSON.stringify(text)};`, shortCircuit: true };
  }
  return next(url, context);
}
