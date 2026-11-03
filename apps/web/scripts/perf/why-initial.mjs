#!/usr/bin/env node
/**
 * Explains why modules end up in the startup bundle: builds the app and prints, for each module
 * matching a pattern, the chain of *static* imports that leads to it from src/main.tsx.
 *
 *   node scripts/perf/why-initial.mjs pdf-lib @modelcontextprotocol/client src/canvas/engine.ts
 *   node scripts/perf/why-initial.mjs --from src/screens/Editor.tsx pdf-lib   # what a lazy screen pulls in
 *
 * Tree-shaking can still drop unused exports, so a chain is the reason a module is *reachable* at
 * startup; bundle-report.mjs --why shows how many bytes it actually contributed.
 */
import { build } from 'vite';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const argv = process.argv.slice(2);
const fromAt = argv.indexOf('--from');
const from = fromAt >= 0 ? argv.splice(fromAt, 2)[1] : 'src/main.tsx';
const patterns = argv;
if (!patterns.length) {
  console.error('Usage: why-initial.mjs <module substring>...');
  process.exit(2);
}
const root = fileURLToPath(new URL('../..', import.meta.url));
const out = mkdtempSync(join(tmpdir(), 'inkwright-why-'));

/** @type {import('vite').Plugin} */
const tracer = {
  name: 'inkwright-why-initial',
  apply: 'build',
  buildEnd() {
    const ids = [...this.getModuleIds()];
    const entry = ids.find((id) => id.endsWith('/' + from));
    if (!entry) throw new Error(`${from} is not part of the build`);
    // Breadth-first over static imports only: the first path found is a shortest chain.
    const prev = new Map([[entry, null]]);
    const queue = [entry];
    while (queue.length) {
      const id = queue.shift();
      for (const dep of this.getModuleInfo(id)?.importedIds ?? []) {
        if (prev.has(dep)) continue;
        prev.set(dep, id);
        queue.push(dep);
      }
    }
    const short = (id) => (id.includes('node_modules/') ? id.slice(id.lastIndexOf('node_modules/') + 13) : relative(root, id));
    for (const p of patterns) {
      const hit = [...prev.keys()].find((id) => id.includes(p));
      if (!hit) {
        console.log(`\n${p}: not statically reachable from ${from}`);
        continue;
      }
      const chain = [];
      for (let id = hit; id; id = prev.get(id)) chain.unshift(short(id));
      console.log(`\n${p}:\n  ${chain.join('\n  → ')}`);
    }
  },
};

try {
  await build({ root, logLevel: 'error', plugins: [tracer], build: { outDir: out, emptyOutDir: true, sourcemap: false, write: false } });
} finally {
  rmSync(out, { recursive: true, force: true });
}
