/**
 * The developer module from outside: the `inkwright` CLI (spawned for real) scans a repository into
 * a vault and reports drift; the MCP tools are exercised through the official SDK client.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CodeIndex, CodeStore, codeRefStates, newPage, withCodeBaselines, type NoteMeta } from '@inkwright/core';
import { parseSkillMd, validateSkillFrontmatter } from '@inkwright/ai';
import { REPO } from '../../../packages/core/test/dev/fixture-repo.ts';
import { scanFolderIntoVault } from '../src/dev/repo.ts';
import { createServices } from '../src/server.ts';
import { modernClient, resultJson, resultText } from './clients.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

async function writeRepo(dir: string, over: Record<string, string> = {}) {
  for (const [p, text] of Object.entries({ ...REPO, ...over })) {
    await mkdir(path.dirname(path.join(dir, p)), { recursive: true });
    await writeFile(path.join(dir, p), text);
  }
}

/** Runs the real CLI entry from source, as `inkwright …`. */
async function inkwright(...args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const r = await run('npx', ['tsx', '--import', './apps/mcp-server/scripts/raw-hooks.mjs', 'apps/mcp-server/src/inkwright-cli.ts', ...args], { cwd: repoRoot, timeout: 90_000 });
    return { code: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    return { code: x.code, stdout: x.stdout, stderr: x.stderr };
  }
}

const CHANGED = REPO['src/auth/session.ts']!.replace('ttlMs: number): Session', 'ttlMs: number, scope: string[]): Session');

let fx: Fixture;
let repo: string;

/** Adds a note linking createSession (typed) and hashToken (ink), with baselines from the current scan. */
async function addLinkedNote(): Promise<NoteMeta> {
  const page = {
    ...newPage('AUTHP1'),
    strokes: [{ id: 'w1', pen: 'fountain' as const, color: '#FF1B1F24', size: 2, createdAt: 1, points: [{ x: 10, y: 10, t: 0, p: 0.5, tilt: -1, orient: -1 }, { x: 60, y: 12, t: 9, p: 0.5, tilt: -1, orient: -1 }] }],
    texts: [{ id: 'AT1', x: 100, y: 100, width: 400, text: 'Login calls [[code:src/auth/session.ts#createSession]].\n\n```http\nGET https://status.example.test/health\n```', fontSize: 16, color: '#FF1B1F24', font: 'sans' as const, createdAt: 1 }],
    links: [{ id: 'L1', strokeIds: ['w1'], target: 'code:src/auth/crypto.ts#hashToken', createdAt: 1 }],
  };
  const graphs = await new CodeStore(fx.external.fs).readAllGraphs();
  const meta0: NoteMeta = { id: 'AUTHDOC', title: 'Auth design', kind: 'paged', paper: { style: 'blank', tint: 'white', texture: 'smooth', spacing: 0 }, pageSize: { name: 'A4', width: 793.7, height: 1122.5 }, pageIds: ['AUTHP1'], tags: [], createdAt: 1, updatedAt: 2, pinned: false, formatVersion: 2 };
  const meta = withCodeBaselines(meta0, codeRefStates(meta0, [page], graphs.map((g) => new CodeIndex(g))), 3);
  await fx.external.saveNote(meta, [page]);
  return meta;
}

beforeAll(async () => {
  repo = await mkdtemp(path.join(tmpdir(), 'inkwright-repo-'));
  await writeRepo(repo);
});
afterAll(async () => { await rm(repo, { recursive: true, force: true }); });
beforeEach(async () => { fx = await makeFixture(); });
afterEach(async () => { await fx.cleanup(); });

describe('inkwright CLI', () => {
  it('scans a repository into the vault and reports drift after the code changes', async () => {
    const s = await inkwright('scan', repo, '--vault', fx.dir, '--name', 'shop');
    expect(s.stderr).toBe('');
    expect(s.code).toBe(0);
    expect(s.stdout).toMatch(/Scanned shop into .*code\/sources\/shop/);
    expect(s.stdout).toMatch(/\d+ files, \d+ symbols \(.*\d+ function.*\), \d+ edges/);
    expect((await new CodeStore(fx.external.fs).readSource('shop'))!.kind).toBe('cli');

    await addLinkedNote();
    const clean = await inkwright('drift', fx.dir, '--check');
    expect(clean.code).toBe(0);
    expect(clean.stdout).toContain('No drift');

    await writeFile(path.join(repo, 'src/auth/session.ts'), CHANGED);
    expect((await inkwright('scan', repo, '--vault', fx.dir, '--name', 'shop')).code).toBe(0);
    const d = await inkwright('drift', fx.dir, '--check');
    expect(d.code).toBe(1);
    expect(d.stdout).toContain('1 code link drifted');
    expect(d.stdout).toContain('Auth design  (AUTHDOC)');
    expect(d.stdout).toContain('src/auth/session.ts#createSession: signature changed');
    expect(d.stdout).toContain('now: function createSession(userId: string, ttlMs: number, scope: string[]): Session');
    const j = JSON.parse((await inkwright('drift', fx.dir, '--json')).stdout);
    expect(j).toEqual([expect.objectContaining({ noteId: 'AUTHDOC', link: 'src/auth/session.ts#createSession', status: 'changed' })]);
    await writeFile(path.join(repo, 'src/auth/session.ts'), REPO['src/auth/session.ts']!);
  }, 240_000);

  it('explains usage mistakes with exit code 2', async () => {
    const r = await inkwright('scan', repo);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('scan needs a repository folder and --vault');
    expect((await inkwright('--version')).stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
  }, 120_000);
});

describe('MCP developer tools', () => {
  it('code_search, code_symbol, drift_report, get_runbook and validate_diagram', async () => {
    await scanFolderIntoVault(fx.external.fs, repo, { name: 'shop' });
    await addLinkedNote();
    const services = createServices(await fx.ctx(), { transport: 'http' });
    const c = await modernClient(services);
    try {
      const names = (await c.listTools()).tools.map((t) => t.name);
      expect(names).toEqual(expect.arrayContaining(['code_search', 'code_symbol', 'drift_report', 'get_runbook', 'validate_diagram']));

      const search = resultJson(await c.callTool({ name: 'code_search', arguments: { query: 'createSes' } }));
      expect(search.results[0]).toMatchObject({ id: 'src/auth/session.ts#createSession', kind: 'function', link: '[[code:src/auth/session.ts#createSession]]' });
      const routes = resultJson(await c.callTool({ name: 'code_search', arguments: { query: 'items', kind: 'route' } }));
      expect(routes.results.map((r: { id: string }) => r.id)).toEqual(expect.arrayContaining(['cmd/main.go#POST /items']));

      const sym = resultJson(await c.callTool({ name: 'code_symbol', arguments: { target: 'src/auth/crypto.ts#hashToken' } }));
      expect(sym).toMatchObject({ kind: 'function', callers: ['src/auth/session.ts#createSession'], linkedFrom: [{ id: 'AUTHDOC', title: 'Auth design', status: 'ok' }] });
      expect(sym.source_code).toContain('reverse()');
      const missing = await c.callTool({ name: 'code_symbol', arguments: { target: 'src/nope.ts#x' } });
      expect(missing.isError).toBe(true);

      expect(resultJson(await c.callTool({ name: 'drift_report', arguments: {} })).count).toBe(0);
      await writeFile(path.join(repo, 'src/auth/session.ts'), CHANGED);
      await scanFolderIntoVault(fx.external.fs, repo, { name: 'shop' });
      const drift = resultJson(await c.callTool({ name: 'drift_report', arguments: {} }));
      expect(drift.items).toEqual([expect.objectContaining({ noteId: 'AUTHDOC', status: 'changed', was: expect.stringContaining('ttlMs: number)'), now: expect.stringContaining('scope: string[]') })]);

      const rb = resultJson(await c.callTool({ name: 'get_runbook', arguments: { id: 'AUTHDOC' } }));
      expect(rb.blocks).toEqual([expect.objectContaining({ language: 'http', page: 1, request: { method: 'GET', url: 'https://status.example.test/health', headers: [], hasBody: false } })]);

      const bad = await c.callTool({ name: 'validate_diagram', arguments: { diagram: { nodes: [{ id: 'api', code: 'src/auth/session.ts#nope' }], edges: [{ from: 'api', to: 'db' }] } } });
      expect(bad.structuredContent).toMatchObject({ ok: false });
      expect(resultText(bad)).toContain('[unbound_code_ref] /nodes/0/code');
      expect(resultText(bad)).toContain('[unknown_node_ref] /edges/0/to');
      const good = await c.callTool({ name: 'validate_diagram', arguments: { diagram: JSON.stringify({ nodes: [{ id: 'api', kind: 'service', code: 'src/auth/session.ts#createSession' }, { id: 'db', kind: 'database' }], edges: [{ from: 'api', to: 'db' }] }), svg: true } });
      expect(good.structuredContent).toMatchObject({ ok: true });
      expect(resultText(good)).toContain('<svg xmlns=');
    } finally {
      await c.close();
      await writeFile(path.join(repo, 'src/auth/session.ts'), REPO['src/auth/session.ts']!);
    }
  }, 60_000);

  it('read-only mode still offers the developer tools (they never write)', async () => {
    const services = createServices(await fx.ctx({ readOnly: true }), { transport: 'http' });
    const c = await modernClient(services);
    try {
      expect((await c.listTools()).tools.map((t) => t.name)).toEqual(expect.arrayContaining(['code_search', 'drift_report', 'validate_diagram']));
      expect(resultJson(await c.callTool({ name: 'code_search', arguments: { query: 'x' } })).note).toMatch(/No code source/);
    } finally {
      await c.close();
    }
  });
});

describe('the Agent Skill for coding agents (skills/inkwright-code-notes)', () => {
  it('is a valid Agent Skill whose commands and tools exist', async () => {
    const md = await readFile(path.join(repoRoot, 'skills/inkwright-code-notes/SKILL.md'), 'utf8');
    const { frontmatter, body } = parseSkillMd(md);
    expect(validateSkillFrontmatter(frontmatter, 'inkwright-code-notes')).toMatchObject({ ok: true, errors: [] });
    for (const tool of ['code_search', 'code_symbol', 'validate_diagram', 'get_runbook']) expect(body).toContain(tool);
    for (const cmd of ['scan <repo-folder> --vault', 'drift <vault-folder> --check']) expect(body).toContain(cmd);
  });
});
