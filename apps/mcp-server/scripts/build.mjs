// Bundles the two command-line tools into self-contained files:
//   dist/index.js  → inkstone-mcp   (MCP server: stdio or HTTP, optional A2A)
//   dist/agent.js  → inkstone-agent (always-on runner, service install helpers, approvals)
//   dist/inkstone.js → inkstone     (mcp / scan / drift for developers and coding agents)
// `?raw` imports (the built-in SKILL.md files in @inkstone/ai) are inlined as strings.
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const raw = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (args) => ({ path: path.resolve(args.resolveDir, args.path.slice(0, -'?raw'.length)), namespace: 'raw' }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (args) => ({ contents: `export default ${JSON.stringify(await readFile(args.path, 'utf8'))};`, loader: 'js' }));
  },
};

await build({
  entryPoints: { index: path.join(root, 'src/index.ts'), agent: path.join(root, 'src/agent-cli.ts'), inkstone: path.join(root, 'src/inkstone-cli.ts') },
  outdir: path.join(root, 'dist'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  // Tree-sitter loads its runtime and grammar .wasm files from its packages at run time.
  external: ['@resvg/resvg-js', 'web-tree-sitter', '@vscode/tree-sitter-wasm'],
  plugins: [raw],
  banner: { js: "import { createRequire as __inkCreateRequire } from 'node:module'; const require = __inkCreateRequire(import.meta.url);" },
  logLevel: 'info',
});
