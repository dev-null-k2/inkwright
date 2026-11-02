/**
 * The REST API end to end over real HTTP, plus contract tests: every response is validated
 * against the OpenAPI document the server serves (with an independent JSON Schema 2020-12
 * validator), and every documented operation must be exercised here.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { API_KEYS_FILE, decodeApiKeys } from '@inkwright/core';
import { parseCli } from '../src/cli.ts';
import { serveHttp } from '../src/serve.ts';
import type { RunningHttpServer } from '../src/http.ts';
import type { ServerContext } from '../src/context.ts';
import { KeyStore } from '../src/api/keys.ts';
import { verifyWebhook } from '../src/api/webhooks.ts';
import { keysCli } from '../src/api/keys-cli.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

let fx: Fixture;
let ctx: ServerContext;
let http: RunningHttpServer;
let base: string;
let stateDir: string;
let spec: any;
let ajv: InstanceType<typeof Ajv2020>;
const keys: Record<string, string> = {};
/** operationId → statuses seen (for the coverage check). */
const exercised = new Map<string, Set<number>>();

// A webhook receiver on loopback.
let receiver: Server;
let receiverUrl = '';
const received: { headers: Record<string, string>; body: string }[] = [];
let receiverStatus = 200;

beforeAll(async () => {
  fx = await makeFixture();
  ctx = await fx.ctx({ renderPng: undefined });
  stateDir = await mkdtemp(path.join(tmpdir(), 'inkwright-api-state-'));
  ({ http } = await serveHttp(ctx, parseCli(['--vault', fx.dir, '--http', '0', '--token', 'server-token', '--state-dir', stateDir, '--cors-origin', 'https://app.example.com'], {}), null, () => {}, { eventIntervalMs: 200 }));
  base = `${http.baseUrl}/api/v1`;
  const store = new KeyStore(ctx);
  for (const [name, scopes] of [['reader', ['notes:read']], ['writer', ['notes:read', 'notes:write']], ['hooks', ['webhooks', 'notes:read']], ['admin', ['admin']]] as const) {
    keys[name] = (await store.create({ name, scopes: [...scopes], createdBy: 'test' })).key;
  }
  spec = await (await fetch(`${base}/openapi.json`)).json();
  ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
  ajv.addSchema(spec, 'openapi');
  receiver = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ headers: req.headers as Record<string, string>, body });
      res.writeHead(receiverStatus).end();
    });
  });
  await new Promise<void>((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${(receiver.address() as AddressInfo).port}/hook`;
});

afterAll(async () => {
  await http?.close();
  receiver?.close();
  await fx?.cleanup();
  await rm(stateDir, { recursive: true, force: true });
});

/** Finds the OpenAPI operation for a concrete path. */
function operationFor(method: string, url: string): { template: string; op: any } {
  const p = new URL(url).pathname.slice('/api/v1'.length);
  for (const [template, ops] of Object.entries<any>(spec.paths)) {
    const re = new RegExp(`^${template.replace(/\{\w+\}/g, '[^/]+')}$`);
    if (re.test(p) && ops[method.toLowerCase()]) return { template, op: ops[method.toLowerCase()] };
  }
  throw new Error(`No documented operation for ${method} ${p}`);
}

/** Calls the API and checks the response against the OpenAPI document. */
async function call(method: string, p: string, o: { key?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean } = {}): Promise<{ status: number; headers: Headers; body: any }> {
  const url = `${base}${p}`;
  const headers: Record<string, string> = { ...(o.key ? { authorization: `Bearer ${o.key}` } : {}), ...(o.body !== undefined ? { 'content-type': 'application/json' } : {}), ...o.headers };
  const res = await fetch(url, { method, headers, ...(o.body !== undefined ? { body: typeof o.body === 'string' ? o.body : JSON.stringify(o.body) } : {}) });
  const type = res.headers.get('content-type') ?? '';
  const body = type.includes('json') ? await res.json() : type.startsWith('text/') || type.includes('svg') ? await res.text() : new Uint8Array(await res.arrayBuffer());
  const { op } = operationFor(method, url);
  const seen = exercised.get(op.operationId) ?? new Set();
  seen.add(res.status);
  exercised.set(op.operationId, seen);
  // Contract: the status is documented, and a JSON body matches its schema.
  let doc = op.responses[String(res.status)];
  if (doc?.$ref) doc = spec.components.responses[doc.$ref.split('/').pop()];
  expect(doc, `${method} ${p} answered ${res.status}, which the OpenAPI document does not list`).toBeTruthy();
  if (res.status !== 204 && res.status !== 304) {
    const mediaTypes = Object.keys(doc.content ?? {});
    const base = type.split(';')[0]!.trim();
    expect(mediaTypes.some((m) => m === base || (m === 'application/octet-stream')), `${method} ${p}: ${base} not in ${mediaTypes.join(', ')}`).toBe(true);
    const schema = doc.content?.[base]?.schema;
    if (schema?.$ref && type.includes('json')) {
      const validate = ajv.getSchema(`openapi${schema.$ref}`)!;
      const ok = validate(body);
      expect(ok, `${method} ${p} → ${res.status} does not match ${schema.$ref}: ${JSON.stringify(validate.errors?.slice(0, 3))}`).toBe(true);
    }
  }
  return { status: res.status, headers: res.headers, body };
}

describe('documents', () => {
  it('serves an OpenAPI 3.1 document and a docs page without a key', async () => {
    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers[0].url).toBe(`${http.baseUrl}/api/v1`);
    expect(Object.keys(spec.components.schemas)).toEqual(expect.arrayContaining(['Note', 'NoteSummary', 'Problem', 'Webhook', 'ApiKey', 'SearchResult']));
    const docs = await fetch(`${base}/docs`);
    expect(docs.headers.get('content-type')).toMatch(/text\/html/);
    expect(await docs.text()).toContain('id="problem-precondition-failed"');
  });
});

describe('authentication and scopes', () => {
  it('refuses calls without a key with a problem document', async () => {
    const r = await call('GET', '/notes');
    expect(r.status).toBe(401);
    expect(r.headers.get('content-type')).toBe('application/problem+json');
    expect(r.body).toMatchObject({ status: 401, code: 'unauthorized', type: '/api/v1/docs#problem-unauthorized', instance: '/api/v1/notes' });
    expect(r.headers.get('www-authenticate')).toMatch(/^Bearer/);
  });

  it('accepts the server token and scoped keys, and enforces scopes', async () => {
    expect((await call('GET', '/notes', { key: 'server-token' })).status).toBe(200);
    expect((await call('GET', '/notes', { key: keys.reader })).status).toBe(200);
    const denied = await call('POST', '/notes', { key: keys.reader, body: { title: 'Nope' } });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('insufficient_scope');
    expect(denied.headers.get('www-authenticate')).toContain('scope="notes:write"');
    expect((await call('GET', '/notes', { key: keys.admin })).status).toBe(403);
  });

  it('rejects unknown and revoked keys', async () => {
    expect((await call('GET', '/notes', { key: `${keys.reader!.slice(0, 15)}_${'x'.repeat(43)}` })).status).toBe(401);
    const store = new KeyStore(ctx);
    const temp = await store.create({ name: 'temp', scopes: ['notes:read'], createdBy: 'test' });
    expect((await call('GET', '/tags', { key: temp.key })).status).toBe(200);
    const r = await call('DELETE', `/keys/${temp.record.id}`, { key: keys.admin });
    expect(r.status).toBe(200);
    expect(r.body.revokedAt).toBeTruthy();
    await new Promise((res) => setTimeout(res, 1100)); // key file re-check interval
    const after = await call('GET', '/tags', { key: temp.key });
    expect(after.status).toBe(401);
    expect(after.body.detail).toMatch(/revoked/);
  });

  it('manages keys through the API (admin) and stores only hashes', async () => {
    const made = await call('POST', '/keys', { key: keys.admin, body: { name: 'Shortcuts', scopes: ['notes:read'], expiresInDays: 30 } });
    expect(made.status).toBe(201);
    expect(made.body.key).toMatch(/^ink_/);
    const list = await call('GET', '/keys', { key: keys.admin });
    expect(list.body.data.some((k: any) => k.name === 'Shortcuts' && !('key' in k) && !('hash' in k))).toBe(true);
    const file = decodeApiKeys((await ctx.fs.readText(API_KEYS_FILE))!);
    expect(JSON.stringify(file)).not.toContain(made.body.key.slice(15));
    expect((await call('DELETE', '/keys/nope', { key: keys.admin })).status).toBe(404);
  });
});

describe('notes', () => {
  it('lists with keyset pagination and filters', async () => {
    const first = await call('GET', '/notes?limit=2', { key: keys.reader });
    expect(first.body.data.map((n: any) => n.id)).toEqual(['SKETCH', 'LAUNCH']);
    const second = await call('GET', `/notes?limit=2&cursor=${first.body.nextCursor}`, { key: keys.reader });
    expect(second.body.data.map((n: any) => n.id)).toEqual(['GROCERIES', 'OLDNOTE']);
    expect(second.body.nextCursor).toBeNull();
    expect((await call('GET', '/notes?tag=%23launch', { key: keys.reader })).body.data.map((n: any) => n.id)).toEqual(['LAUNCH']);
    expect((await call('GET', '/notes?notebook=Work', { key: keys.reader })).body.data.map((n: any) => n.id).sort()).toEqual(['LAUNCH', 'OLDNOTE']);
    expect((await call('GET', '/notes?status=trashed', { key: keys.reader })).body.data.map((n: any) => n.id)).toEqual(['TRASHED']);
    const bad = await call('GET', '/notes?limit=0&cursor=zzz', { key: keys.reader });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: any) => e.path)).toContain('query.limit');
    expect((await call('GET', '/notes?cursor=bm9wZQ', { key: keys.reader })).status).toBe(400);
  });

  it('reads a note with an ETag and answers If-None-Match with 304', async () => {
    const r = await call('GET', '/notes/LAUNCH', { key: keys.reader });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: 'LAUNCH', title: 'Launch plan', notebook: 'Work / Projects', pages: 2 });
    expect(r.body.markdown).toContain('Launch the beta on Friday');
    const etag = r.headers.get('etag')!;
    expect(etag).toMatch(/^".+"$/);
    expect((await call('GET', '/notes/LAUNCH', { key: keys.reader, headers: { 'if-none-match': etag } })).status).toBe(304);
    expect((await call('GET', '/notes/NOPE', { key: keys.reader })).status).toBe(404);
  });

  it('updates safely with If-Match and logs the change under the key’s name', async () => {
    const r = await call('GET', '/notes/GROCERIES', { key: keys.writer });
    const etag = r.headers.get('etag')!;
    const ok = await call('PATCH', '/notes/GROCERIES', { key: keys.writer, headers: { 'if-match': etag }, body: { title: 'Shopping', tags: ['home', 'errands'] } });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ title: 'Shopping', tags: ['home', 'errands'] });
    expect(ok.headers.get('etag')).not.toBe(etag);
    const stale = await call('PATCH', '/notes/GROCERIES', { key: keys.writer, headers: { 'if-match': etag }, body: { title: 'Lost update' } });
    expect(stale.status).toBe(412);
    expect(stale.body.code).toBe('precondition_failed');
    expect((await call('PATCH', '/notes/GROCERIES', { key: keys.writer, body: {} })).status).toBe(400);
    await new Promise((res) => setTimeout(res, 50));
    const activity = await call('GET', '/activity?limit=5', { key: keys.reader });
    expect(activity.body.data.some((a: any) => a.label === 'writer (API)' && a.changes.some((c: any) => /Shopping|renamed/.test(c.summary)))).toBe(true);
  });

  it('creates once per Idempotency-Key', async () => {
    const before = (await call('GET', '/notes?limit=200', { key: keys.reader })).body.data.length;
    const h = { 'idempotency-key': 'create-meeting-1' };
    const a = await call('POST', '/notes', { key: keys.writer, headers: h, body: { title: 'Meeting', text: 'Agenda\n- budget', tags: ['work'] } });
    expect(a.status).toBe(201);
    expect(a.headers.get('location')).toBe(`${base}/notes/${a.body.id}`);
    const b = await call('POST', '/notes', { key: keys.writer, headers: h, body: { title: 'Meeting', text: 'Agenda\n- budget', tags: ['work'] } });
    expect(b.body.id).toBe(a.body.id);
    expect(b.headers.get('idempotent-replayed')).toBe('true');
    const c = await call('POST', '/notes', { key: keys.writer, headers: h, body: { title: 'Other' } });
    expect(c.status).toBe(422);
    expect((await call('GET', '/notes?limit=200', { key: keys.reader })).body.data.length).toBe(before + 1);
  });

  it('appends, trashes and restores', async () => {
    const created = await call('POST', '/notes', { key: keys.writer, body: { title: 'Journal' } });
    const id = created.body.id;
    const appended = await call('POST', `/notes/${id}/append`, { key: keys.writer, body: { text: 'Walked by the river.' } });
    expect(appended.body.markdown).toContain('Walked by the river.');
    const md = await call('GET', `/notes/${id}/markdown`, { key: keys.reader });
    expect(md.headers.get('content-type')).toMatch(/text\/markdown/);
    expect(md.body).toContain('Walked by the river.');
    expect((await call('DELETE', `/notes/${id}`, { key: keys.writer })).body.trashedAt).toBeTruthy();
    expect((await call('POST', `/notes/${id}/restore`, { key: keys.writer })).body.trashedAt).toBeNull();
  });

  it('rejects non-JSON bodies, unknown paths and wrong methods', async () => {
    const r = await call('POST', '/notes', { key: keys.writer, body: 'title=x', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    expect(r.status).toBe(415);
    const nf = await fetch(`${base}/nowhere`, { headers: { authorization: `Bearer ${keys.reader}` } });
    expect(nf.status).toBe(404);
    const m = await fetch(`${base}/tags`, { method: 'DELETE', headers: { authorization: `Bearer ${keys.reader}` } });
    expect(m.status).toBe(405);
    expect(m.headers.get('allow')).toBe('GET');
  });

  it('exports Markdown, JSON and PDF', async () => {
    expect((await call('GET', '/notes/LAUNCH/export?format=md', { key: keys.reader })).headers.get('content-disposition')).toContain('Launch plan.md');
    const j = await call('GET', '/notes/LAUNCH/export?format=json', { key: keys.reader });
    expect(j.body.pages).toHaveLength(2);
    const pdf = await call('GET', '/notes/LAUNCH/export?format=pdf', { key: keys.reader });
    expect(pdf.status).toBe(200);
    expect(new TextDecoder().decode((pdf.body as Uint8Array).slice(0, 5))).toBe('%PDF-');
  });
});

describe('pages, notebooks, search, links, assets', () => {
  it('renders pages in every format', async () => {
    expect((await call('GET', '/notes/LAUNCH/pages', { key: keys.reader })).body.data.map((p: any) => p.number)).toEqual([1, 2]);
    expect((await call('GET', '/notes/LAUNCH/pages/1', { key: keys.reader })).body).toMatchObject({ number: 1, strokes: 2, handwritingRecognized: true });
    expect((await call('GET', '/notes/LAUNCH/pages/1/ink', { key: keys.reader })).body.strokes).toHaveLength(2);
    expect((await call('GET', '/notes/LAUNCH/pages/1/text', { key: keys.reader })).body).toContain('Call Maria');
    expect((await call('GET', '/notes/LAUNCH/pages/1/svg', { key: keys.reader })).body).toMatch(/^<svg|^<\?xml/);
    const png = await call('GET', '/notes/LAUNCH/pages/1/png?width=300', { key: keys.reader });
    expect([...(png.body as Uint8Array).slice(1, 4)]).toEqual([0x50, 0x4e, 0x47]);
    expect(new TextDecoder().decode((await call('GET', '/notes/LAUNCH/pages/2/pdf', { key: keys.reader })).body.slice(0, 5))).toBe('%PDF-');
    expect((await call('GET', '/notes/LAUNCH/pages/9', { key: keys.reader })).status).toBe(404);
  });

  it('lists and creates notebooks and lists tags', async () => {
    const nbs = await call('GET', '/notebooks', { key: keys.reader });
    expect(nbs.body.data.map((n: any) => n.path)).toEqual(['Personal', 'Work', 'Work / Projects']);
    expect((await call('POST', '/notebooks', { key: keys.writer, body: { name: 'Recipes', parentId: 'NBPERSONAL' } })).status).toBe(201);
    expect((await call('POST', '/notebooks', { key: keys.writer, body: { name: 'recipes', parentId: 'NBPERSONAL' } })).status).toBe(200);
    const tags = await call('GET', '/tags', { key: keys.reader });
    expect(tags.body.data.map((t: any) => t.tag)).toEqual(expect.arrayContaining(['work', 'launch', 'books']));
  });

  it('searches by keyword and explains that semantic search needs a model', async () => {
    const r = await call('GET', '/search?q=maria%20pricing', { key: keys.reader });
    expect(r.body.data[0]).toMatchObject({ noteId: 'LAUNCH', page: 1 });
    const s = await call('GET', '/search?q=planning&mode=semantic', { key: keys.reader });
    expect(s.status).toBe(501);
    expect(s.body.detail).toMatch(/--embeddings-model/);
  });

  it('answers links, backlinks and the graph', async () => {
    await call('POST', '/notes', { key: keys.writer, body: { title: 'Retro', text: 'Follow up on [[Launch plan]] next week.' } });
    const links = await call('GET', '/notes/LAUNCH/links', { key: keys.reader });
    expect(links.body.backlinks.map((b: any) => b.title)).toContain('Retro');
    const graph = await call('GET', '/graph?tags=false', { key: keys.reader });
    expect(graph.body.edges.some((e: any) => e.kind === 'link' && e.target === 'LAUNCH')).toBe(true);
    expect(graph.body.nodes.every((n: any) => n.kind !== 'tag')).toBe(true);
  });

  it('lists assets and transcripts', async () => {
    await ctx.vault.writeAsset('SKETCH', 'photo.png', new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const list = await call('GET', '/notes/SKETCH/assets', { key: keys.reader });
    expect(list.body.data).toEqual([expect.objectContaining({ name: 'photo.png', mimeType: 'image/png' })]);
    const file = await call('GET', '/notes/SKETCH/assets/photo.png', { key: keys.reader });
    expect([...(file.body as Uint8Array)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect((await call('GET', '/notes/SKETCH/assets/missing.png', { key: keys.reader })).status).toBe(404);
    expect((await call('GET', '/notes/SKETCH/transcripts', { key: keys.reader })).body.data).toEqual([]);
  });

  it('lists routines and explains that running one needs an AI', async () => {
    expect((await call('GET', '/routines', { key: keys.reader })).body.data).toEqual([]);
    expect((await call('POST', '/routines/nightly/run', { key: 'server-token' })).status).toBe(404);
  });
});

describe('webhooks', () => {
  it('delivers signed note events and logs deliveries', async () => {
    const made = await call('POST', '/webhooks', { key: keys.hooks, body: { url: receiverUrl, events: ['note.created', 'note.updated'], description: 'test' } });
    expect(made.status).toBe(201);
    expect(made.body.secret).toMatch(/^whsec_/);
    const secret = made.body.secret as string;
    expect((await call('GET', '/webhooks', { key: keys.hooks })).body.data[0]).not.toHaveProperty('secret');
    expect((await call('GET', `/webhooks/${made.body.id}`, { key: keys.hooks })).body.url).toBe(receiverUrl);
    expect((await call('POST', '/webhooks', { key: keys.hooks, body: { url: 'http://example.com/hook', events: ['note.created'] } })).status).toBe(400);

    const test = await call('POST', `/webhooks/${made.body.id}/test`, { key: keys.hooks });
    expect(test.body).toMatchObject({ status: 'succeeded', responseStatus: 200, attempt: 1 });
    const msg = received.at(-1)!;
    expect(verifyWebhook(secret, { id: msg.headers['webhook-id']!, timestamp: msg.headers['webhook-timestamp']!, signature: msg.headers['webhook-signature']! }, msg.body)).toBe(true);
    expect(verifyWebhook(secret, { id: msg.headers['webhook-id']!, timestamp: msg.headers['webhook-timestamp']!, signature: msg.headers['webhook-signature']! }, msg.body.replace('Test', 'Fake'))).toBe(false);

    // A note written by another device (the app, via sync) becomes a note.created event.
    const n = received.length;
    await fx.external.createNote({ title: 'From the phone' });
    const deadline = Date.now() + 5000;
    while (!received.slice(n).some((r) => r.body.includes('From the phone')) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    const bodies = received.slice(n).map((r) => JSON.parse(r.body));
    expect(bodies.some((b) => b.type === 'note.created' && b.data.title === 'From the phone')).toBe(true);
    const log = await call('GET', `/webhooks/${made.body.id}/deliveries`, { key: keys.hooks });
    expect(log.body.data.length).toBeGreaterThanOrEqual(2);
    expect((await call('DELETE', `/webhooks/${made.body.id}`, { key: keys.hooks })).status).toBe(204);
    expect((await call('GET', `/webhooks/${made.body.id}`, { key: keys.hooks })).status).toBe(404);
  });
});

describe('limits and CORS', () => {
  it('answers CORS preflight for allowed origins only', async () => {
    const ok = await fetch(`${base}/notes`, { method: 'OPTIONS', headers: { origin: 'https://app.example.com', 'access-control-request-method': 'POST' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example.com');
    expect(ok.headers.get('access-control-allow-headers')).toContain('idempotency-key');
    const no = await fetch(`${base}/notes`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'GET' } });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
    const get = await fetch(`${base}/tags`, { headers: { origin: 'https://app.example.com', authorization: `Bearer ${keys.reader}` } });
    expect(get.headers.get('access-control-expose-headers')).toContain('etag');
  });

  it('rate-limits per key with RateLimit headers and Retry-After', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'inkwright-api-rl-'));
    const c2 = await fx.ctx();
    const { http: h2 } = await serveHttp(c2, parseCli(['--vault', fx.dir, '--http', '0', '--token', 't', '--rate-limit', '3', '--state-dir', dir], {}), null, () => {});
    try {
      const go = () => fetch(`${h2.baseUrl}/api/v1/tags`, { headers: { authorization: 'Bearer t' } });
      const first = await go();
      expect(first.headers.get('ratelimit-policy')).toBe('"default";q=3;w=60');
      expect(first.headers.get('ratelimit')).toMatch(/^"default";r=2;t=\d+$/);
      await go();
      await go();
      const limited = await go();
      expect(limited.status).toBe(429);
      expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
      expect((await limited.json()).code).toBe('rate_limited');
    } finally {
      await h2.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe('keys CLI', () => {
  it('creates, lists and revokes keys in the vault', async () => {
    let out = '';
    await keysCli(['create', '--vault', fx.dir, '--name', 'Tasker', '--scope', 'notes:read,notes:write'], (s) => (out += s));
    const key = /(ink_\S+)/.exec(out)![1]!;
    expect((await call('GET', '/tags', { key })).status).toBe(200);
    out = '';
    await keysCli(['list', '--vault', fx.dir, '--json'], (s) => (out += s));
    const listed = JSON.parse(out).find((k: any) => k.name === 'Tasker');
    expect(listed.scopes).toEqual(['notes:read', 'notes:write']);
    await keysCli(['revoke', '--vault', fx.dir, listed.id], () => {});
    await expect(keysCli(['create', '--vault', fx.dir, '--name', 'x', '--scope', 'root'], () => {})).rejects.toThrow(/Unknown scope root/);
  });
});

describe('contract coverage', () => {
  it('exercised every documented operation', () => {
    const documented = Object.values<any>(spec.paths).flatMap((ops) => Object.values<any>(ops).map((op) => op.operationId));
    const missing = documented.filter((id) => !exercised.has(id));
    expect(missing).toEqual([]);
  });
});
