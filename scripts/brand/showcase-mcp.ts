/**
 * The terminal half of the README hero: a real MCP session against a real vault.
 *
 *   npx tsx scripts/brand/showcase-mcp.ts <out-dir>
 *
 * Writes the hero's notes (apps/web/e2e/showcase/content.ts — the same handwriting, seeds and
 * recognized text the app shows) into a temporary vault folder with the core Vault, starts the MCP
 * server exactly as Claude Code would (`node … apps/mcp-server/src/index.ts --vault <dir>
 * --read-only`, over stdio), lists its tools, calls `search_notes` and `read_note`, and saves the
 * exchange as <out-dir>/mcp.json. scripts/brand/showcase.mjs typesets that file into the terminal
 * panel, so every line the image shows is what the server returned.
 */
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Vault } from '../../packages/core/src/vault.ts';
import { NodeFS } from '../../apps/mcp-server/src/nodefs.ts';
import { NOTEBOOK_COLORS, launchSync, lecture, studyNotes, thesisNotes, type SeedNote } from '../../apps/web/e2e/showcase/content.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = process.argv[2];
if (!out) throw new Error('usage: tsx scripts/brand/showcase-mcp.ts <out-dir>');

async function seedVault(dir: string, notes: SeedNote[], now: number) {
  const v = new Vault(new NodeFS(dir), () => now);
  await v.init();
  const books = new Map<string, string>();
  for (const n of notes) {
    if (!books.has(n.notebook)) books.set(n.notebook, (await v.createNotebook(n.notebook, NOTEBOOK_COLORS[n.notebook])).id);
    const { note, pages } = await v.createNote({ title: n.title, notebookId: books.get(n.notebook), tags: n.tags, paper: n.paper });
    const at = now - n.agoMin * 60_000;
    const p = n.pages[0]!;
    await v.saveNote({ ...note, createdAt: at - 40 * 60_000, updatedAt: at }, [{ ...pages[0]!, strokes: p.strokes, texts: p.texts ?? [], recognizedText: p.recognizedText, recognizedLines: p.recognizedLines, recognizedAt: at, recognizedBy: 'mlkit' }]);
  }
}

const text = (r: any): string => (r.content ?? []).filter((c: any) => c.type === 'text').map((c: any) => c.text).join('\n');

const dir = await mkdtemp(join(tmpdir(), 'inkwright-showcase-'));
try {
  const now = Date.now();
  await seedVault(dir, [lecture(now), studyNotes(now), ...thesisNotes(now), launchSync(now)], now);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', '--import', './scripts/raw-hooks.mjs', 'src/index.ts', '--vault', dir, '--read-only'],
    cwd: join(root, 'apps', 'mcp-server'),
    stderr: 'ignore',
  });
  const client = new Client({ name: 'claude-code', version: '2.0.0' });
  await client.connect(transport);
  const tools = (await client.listTools()).tools.map((t) => t.name);
  const searchArgs = { query: 'beta soak tests', limit: 3 };
  const search = await client.callTool({ name: 'search_notes', arguments: searchArgs });
  const hits = JSON.parse(text(search));
  const readArgs = { id: hits.hits[0].id as string };
  const read = await client.callTool({ name: 'read_note', arguments: readArgs });
  await client.close();
  await mkdir(out, { recursive: true });
  await writeFile(join(out, 'mcp.json'), JSON.stringify({
    server: (client.getServerVersion() ?? {}) as object,
    tools,
    calls: [
      { tool: 'search_notes', args: searchArgs, result: text(search) },
      { tool: 'read_note', args: readArgs, result: text(read) },
    ],
  }, null, 2));
  console.log(`MCP session saved to ${join(out, 'mcp.json')} (${tools.length} tools)`);
} finally {
  await rm(dir, { recursive: true, force: true });
}
