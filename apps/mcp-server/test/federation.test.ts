/**
 * Team (federated) search with two real servers in this process, each over its own vault, over
 * real HTTP: what a peer may see (shared notebooks and tags only, minus what the AI policy hides),
 * the fan-out with timeouts and refusals, merged results with provenance, the MCP tool, and
 * nothing cached.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readdir, rm, writeFile, mkdir, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parsePolicy, serializePolicy } from '@inkwright/ai';
import { parseCli } from '../src/cli.ts';
import { serveHttp } from '../src/serve.ts';
import type { ServerContext } from '../src/context.ts';
import type { ServerServices } from '../src/server.ts';
import type { RunningHttpServer } from '../src/http.ts';
import { KeyStore } from '../src/api/keys.ts';
import { loadTeamConfig, mergeResults, parseTeamConfig, sharedWithTeam, type TeamConfig } from '../src/federation/team.ts';
import { modernClient, resultJson } from './clients.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

interface Person {
  fx: Fixture;
  ctx: ServerContext;
  http: RunningHttpServer;
  services: ServerServices;
  team: TeamConfig;
}

let ana: Person;
let ben: Person;
let slow: Server;
let slowUrl = '';
let tmp: string;

async function start(fx: Fixture, team: TeamConfig): Promise<Person> {
  const ctx = await fx.ctx({ features: { team, contextTools: true } });
  const { http, services } = await serveHttp(ctx, parseCli(['--vault', fx.dir, '--http', '0', '--token', `token-${team.self}`], {}), null, () => {});
  return { fx, ctx, http, services, team };
}

beforeAll(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), 'inkwright-team-'));
  // A peer that accepts the connection and never answers.
  slow = createServer(() => {});
  await new Promise<void>((r) => slow.listen(0, '127.0.0.1', () => r()));
  slowUrl = `http://127.0.0.1:${(slow.address() as AddressInfo).port}`;

  const fxA = await makeFixture();
  const fxB = await makeFixture();
  // Ben hides his #books notes from agents: they must not reach Ana either.
  await mkdir(path.join(fxB.dir, 'ai'), { recursive: true });
  await writeFile(path.join(fxB.dir, 'ai', 'policy.json'), serializePolicy(parsePolicy({ tags: { books: { access: 'none' } } }).policy));

  // Each starts with a team file naming the other (keys filled in below, once both run).
  ana = await start(fxA, parseTeamConfig({ self: 'Ana', share: { tags: ['launch'] }, peers: [] }));
  ben = await start(fxB, parseTeamConfig({ self: 'Ben', share: { notebooks: ['Work'] }, peers: [] }));
  const keyFromBenForAna = (await new KeyStore(ben.ctx).create({ name: 'Ana’s server', scopes: ['federation:search'], createdBy: 'test' })).key;
  const keyFromAnaForBen = (await new KeyStore(ana.ctx).create({ name: 'Ben’s server', scopes: ['federation:search'], createdBy: 'test' })).key;
  process.env.TEAM_TEST_BEN_KEY = keyFromBenForAna;
  Object.assign(ana.team, parseTeamConfig({
    self: 'Ana', share: { tags: ['launch'] }, timeoutMs: 400,
    peers: [
      { name: 'Ben', url: ben.http.baseUrl, keyEnv: 'TEAM_TEST_BEN_KEY' },
      { name: 'Sleepy', url: slowUrl, key: 'ink_whatever' },
      { name: 'Wrongkey', url: ben.http.baseUrl, key: 'ink_AAAAAAAAAAAA_wrong' },
    ],
  }));
  Object.assign(ben.team, parseTeamConfig({ self: 'Ben', share: { notebooks: ['Work'] }, peers: [{ name: 'Ana', url: ana.http.baseUrl, key: keyFromAnaForBen }] }));
});

afterAll(async () => {
  delete process.env.TEAM_TEST_BEN_KEY;
  for (const p of [ana, ben]) {
    p.services.tasks.close();
    await p.http.close();
    await p.fx.cleanup();
  }
  slow.closeAllConnections?.();
  await new Promise<void>((r) => slow.close(() => r()));
  await rm(tmp, { recursive: true, force: true });
});

const get = async (p: Person, route: string, key: string) => {
  const r = await fetch(`${p.http.baseUrl}/api/v1${route}`, { headers: { authorization: `Bearer ${key}` } });
  return { status: r.status, body: (await r.json()) as any };
};

describe('team file', () => {
  it('lists every problem at once and refuses keys others can read', async () => {
    expect(() => parseTeamConfig({ peers: [{ name: 'X', url: 'http://example.com' }, { url: 'nope' }] })).toThrow(/self .*missing.*peers\[0\]\.url must be https.*exactly one of key.*peers\[1\]\.name is missing/);
    const f = path.join(tmp, 'team.json');
    await writeFile(f, JSON.stringify({ self: 'Ana', peers: [{ name: 'B', url: 'https://b.example.com', key: 'ink_x' }] }));
    await chmod(f, 0o644);
    if (process.platform !== 'win32') expect(() => loadTeamConfig(f)).toThrow(/chmod 600/);
    await chmod(f, 0o600);
    expect(loadTeamConfig(f).peers[0]!.url).toBe('https://b.example.com');
  });

  it('shares a notebook with its sub-notebooks, and tags', () => {
    const nbs = [{ id: 'W', name: 'Work', createdAt: 0, formatVersion: 2 }, { id: 'P', name: 'Projects', parentId: 'W', createdAt: 0, formatVersion: 2 }] as never;
    expect(sharedWithTeam({ notebooks: ['work'], tags: [] }, { notebookId: 'P', tags: [] }, nbs)).toBe(true);
    expect(sharedWithTeam({ notebooks: ['Work/Projects'], tags: [] }, { notebookId: 'P', tags: [] }, nbs)).toBe(true);
    expect(sharedWithTeam({ notebooks: ['Projects'], tags: [] }, { notebookId: 'W', tags: [] }, nbs)).toBe(false);
    expect(sharedWithTeam({ notebooks: [], tags: ['launch'] }, { notebookId: undefined, tags: ['Launch'] }, nbs)).toBe(true);
  });

  it('merges by relevance within each source, mine first on ties', () => {
    const r = (id: string, score: number) => ({ noteId: id, title: id, snippet: '', notebook: null, tags: [], updatedAt: '', score });
    const m = mergeResults([{ person: 'me', server: 'local', results: [r('a', 10), r('b', 5)] }, { person: 'B', server: 'x', results: [r('c', 2), r('d', 1)] }], 10);
    expect(m.map((x) => `${x.person}:${x.noteId}:${x.relevance}`)).toEqual(['me:a:1', 'B:c:1', 'me:b:0.5', 'B:d:0.5']);
  });
});

describe('serving peers', () => {
  it('a federation key sees only shared notes, as snippets, and nothing else of the API', async () => {
    const key = process.env.TEAM_TEST_BEN_KEY!;
    const beta = await get(ben, '/federated/search?q=beta', key);
    expect(beta.status).toBe(200);
    expect(beta.body.server).toBe('Ben');
    expect(beta.body.data.map((d: any) => d.title)).toEqual(['Launch plan']);
    expect(beta.body.data[0].snippet.length).toBeLessThanOrEqual(300);
    expect(beta.body.data[0]).not.toHaveProperty('markdown');
    // Personal notebook: not shared. #books: hidden from agents by Ben's AI policy.
    expect((await get(ben, '/federated/search?q=milk', key)).body.data).toEqual([]);
    expect((await get(ben, '/federated/search?q=uninterrupted', key)).body.data).toEqual([]);
    // The key opens nothing else.
    expect((await get(ben, '/notes', key)).status).toBe(403);
    expect((await get(ben, '/federated/team-search?q=beta', key)).status).toBe(403);
  });
});

describe('searching the team', () => {
  it('fans out, merges with provenance, and reports slow and refused peers without failing', async () => {
    const t0 = Date.now();
    const r = await get(ana, '/federated/team-search?q=beta', 'token-Ana');
    expect(r.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(3000);
    const who = r.body.data.map((d: any) => `${d.person}:${d.title}`);
    expect(who).toContain('Ana:Launch plan');
    expect(who).toContain('Ben:Launch plan');
    expect(r.body.data.find((d: any) => d.person === 'Ben').server).toBe(ben.http.baseUrl);
    const status = Object.fromEntries(r.body.peers.map((p: any) => [p.name, p.status]));
    expect(status).toEqual({ Ben: 'ok', Sleepy: 'timeout', Wrongkey: 'unauthorized' });
  });

  it('your own results are not limited to what you share; a peer’s are', async () => {
    // Ana's "Reading notes" isn't shared (no #launch) but it is hers to search.
    const mine = await get(ana, '/federated/team-search?q=uninterrupted', 'token-Ana');
    expect(mine.body.data.map((d: any) => d.person)).toEqual(['Ana']);
    // Ben searching: only Ana's #launch note comes from her.
    const theirs = await get(ben, '/federated/team-search?q=uninterrupted', 'token-Ben');
    expect(theirs.body.data).toEqual([]);
    const beta = await get(ben, '/federated/team-search?q=beta', 'token-Ben');
    expect(beta.body.data.map((d: any) => `${d.person}:${d.title}`).sort()).toEqual(['Ana:Launch plan', 'Ben:Launch plan']);
  });

  it('is live (nothing cached) and stores nothing in the vault', async () => {
    const before = await readdir(ana.fx.dir, { recursive: true });
    await ben.fx.external.updateNote('LAUNCH', (n) => ({ ...n, title: 'Launch plan v2' }));
    ben.ctx.markDirty();
    const r = await get(ana, '/federated/team-search?q=beta', 'token-Ana');
    expect(r.body.data.map((d: any) => `${d.person}:${d.title}`)).toContain('Ben:Launch plan v2');
    const after = await readdir(ana.fx.dir, { recursive: true });
    expect(after.filter((f) => !before.includes(f) && !String(f).startsWith('ai'))).toEqual([]);
  });

  it('team_search over MCP', async () => {
    const client = await modernClient(ana.services);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain('team_search');
    const r = resultJson(await client.callTool({ name: 'team_search', arguments: { query: 'beta' } }));
    expect(r.results.some((x: any) => x.person === 'Ben')).toBe(true);
    expect(r.note).toMatch(/Sleepy \(timeout\)/);
    await client.close();
  });
});
