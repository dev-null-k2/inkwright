// Builds the MCP server (apps/mcp-server, `inkwright-mcp`) as one self-contained executable for
// the desktop app to run as a sidecar, with Node's single executable applications (SEA):
//
//   1. esbuild bundles the server into one CommonJS file (SEA runs a single CommonJS script);
//   2. `node --experimental-sea-config` turns it into a blob;
//   3. postject injects the blob into a copy of the Node binary; on macOS the copy is re-signed
//      (ad hoc here; `tauri build` signs it again with the Developer ID when secrets are set).
//
// The result goes where Tauri expects external binaries: src-tauri/binaries/inkwright-mcp-<target>
// (with .exe on Windows). Usage:
//   node scripts/build-sidecar.mjs                       # this machine's target
//   node scripts/build-sidecar.mjs --target universal-apple-darwin   # macOS: arm64 + x64 via lipo
//
// Why SEA and not pkg/nexe/Bun: SEA is part of Node itself (no third-party runtime patching), runs
// the exact Node the server is tested on, and builds on every CI runner. The cost is size (the
// Node binary, ~100 MB uncompressed, ~35 MB in the installer). docs/DESKTOP.md has the trade-off.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const here = path.dirname(fileURLToPath(import.meta.url));
const desktop = path.resolve(here, '..');
const repo = path.resolve(desktop, '../..');
const server = path.join(repo, 'apps/mcp-server');
const out = path.join(desktop, 'build/sidecar');
const binDir = path.join(desktop, 'src-tauri/binaries');
const FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const hostTarget = execFileSync('rustc', ['-vV'], { encoding: 'utf8' }).match(/^host: (.+)$/m)?.[1]?.trim();
// `tauri build` runs this as its beforeBuildCommand with TAURI_ENV_TARGET_TRIPLE set (e.g. universal-apple-darwin).
const target = flag('--target') ?? process.env.TAURI_ENV_TARGET_TRIPLE ?? hostTarget;
if (!target) throw new Error('Could not work out the target triple (is Rust installed?). Pass --target.');

// `?raw` imports (built-in SKILL.md files) are inlined as strings, as in the server's own build.
const raw = {
  name: 'raw',
  setup(b) {
    b.onResolve({ filter: /\?raw$/ }, (a) => ({ path: path.resolve(a.resolveDir, a.path.slice(0, -'?raw'.length)), namespace: 'raw' }));
    b.onLoad({ filter: /.*/, namespace: 'raw' }, async (a) => ({ contents: `module.exports = ${JSON.stringify(await readFile(a.path, 'utf8'))};`, loader: 'js' }));
  },
};

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
mkdirSync(binDir, { recursive: true });
const script = path.join(out, 'inkwright-mcp.cjs');
await build({
  entryPoints: [path.join(server, 'src/index.ts')],
  outfile: script,
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  // Optional native/wasm add-ons stay out: PNG page rendering (resvg) and the code graph's
  // grammars are not part of the desktop sidecar; the server reports them as unavailable.
  external: ['@resvg/resvg-js', 'web-tree-sitter', '@vscode/tree-sitter-wasm'],
  define: { 'import.meta.url': '__inkMetaUrl' },
  banner: { js: "const __inkMetaUrl = require('node:url').pathToFileURL(__filename).href;" },
  plugins: [raw],
  logLevel: 'warning',
});

const blob = path.join(out, 'sea-prep.blob');
writeFileSync(path.join(out, 'sea-config.json'), JSON.stringify({ main: script, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false, useCodeCache: false }, null, 2));
execFileSync(process.execPath, ['--experimental-sea-config', path.join(out, 'sea-config.json')], { stdio: 'inherit' });

const postject = path.join(repo, 'node_modules/postject/dist/cli.js');
const isMac = target.includes('apple-darwin');
const exe = target.includes('windows') ? '.exe' : '';

/** Copies a Node binary, injects the blob, and signs it on macOS. */
function inject(nodeBinary, dest) {
  copyFileSync(nodeBinary, dest);
  chmodSync(dest, 0o755);
  if (isMac) execFileSync('codesign', ['--remove-signature', dest], { stdio: 'inherit' });
  execFileSync(process.execPath, [postject, dest, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', FUSE, ...(isMac ? ['--macho-segment-name', 'NODE_SEA'] : [])], { stdio: 'inherit' });
  if (isMac) execFileSync('codesign', ['--sign', '-', dest], { stdio: 'inherit' });
}

/** The official Node binary for another macOS architecture (checksummed against SHASUMS256.txt). */
async function nodeFor(arch) {
  const v = process.version;
  const name = `node-${v}-darwin-${arch}`;
  const dir = path.join(out, name);
  if (!existsSync(path.join(dir, 'bin/node'))) {
    const base = `https://nodejs.org/dist/${v}`;
    const tgz = Buffer.from(await (await fetch(`${base}/${name}.tar.gz`)).arrayBuffer());
    const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
    const want = sums.split('\n').find((l) => l.endsWith(`  ${name}.tar.gz`))?.split(/\s+/)[0];
    const got = createHash('sha256').update(tgz).digest('hex');
    if (!want || want !== got) throw new Error(`Checksum mismatch for ${name}.tar.gz`);
    writeFileSync(path.join(out, `${name}.tar.gz`), tgz);
    execFileSync('tar', ['-xzf', path.join(out, `${name}.tar.gz`), '-C', out]);
  }
  return path.join(dir, 'bin/node');
}

const dest = path.join(binDir, `inkwright-mcp-${target}${exe}`);
if (target === 'universal-apple-darwin') {
  const parts = [];
  for (const [arch, triple] of [['arm64', 'aarch64-apple-darwin'], ['x64', 'x86_64-apple-darwin']]) {
    const node = process.arch === arch ? process.execPath : await nodeFor(arch);
    const part = path.join(out, `inkwright-mcp-${triple}`);
    inject(node, part);
    // Tauri also looks for the per-architecture names when building a single-arch bundle.
    copyFileSync(part, path.join(binDir, `inkwright-mcp-${triple}`));
    parts.push(part);
  }
  execFileSync('lipo', ['-create', '-output', dest, ...parts], { stdio: 'inherit' });
  execFileSync('codesign', ['--force', '--sign', '-', dest], { stdio: 'inherit' });
} else {
  inject(process.execPath, dest);
}
const mb = (readFileSync(dest).length / 1e6).toFixed(1);
console.log(`Sidecar: ${path.relative(repo, dest)} (${mb} MB)`);
