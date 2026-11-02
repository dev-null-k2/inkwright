/**
 * The SDK is generated from the OpenAPI document and works against the real server:
 * - the committed src/generated.ts matches what the generator makes from today's routes;
 * - typed calls, ETags, idempotent retries, errors and pagination over HTTP;
 * - webhook verification with Web Crypto agrees with the server's signer.
 */
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { describeApi } from '../../../apps/mcp-server/src/api/index.ts';
import { signWebhook } from '../../../apps/mcp-server/src/api/webhooks.ts';
import { parseCli } from '../../../apps/mcp-server/src/cli.ts';
import { createContext, type ServerContext } from '../../../apps/mcp-server/src/context.ts';
import { serveHttp } from '../../../apps/mcp-server/src/serve.ts';
import type { RunningHttpServer } from '../../../apps/mcp-server/src/http.ts';
import { generateSdk, tsType } from '../scripts/codegen.ts';
import { InkwrightApiError, InkwrightClient, paginate, verifyWebhook } from '../src/index.ts';

describe('code generation', () => {
  it('src/generated.ts is up to date with the API (run npm run generate -w @inkwright/sdk)', () => {
    const committed = readFileSync(new URL('../src/generated.ts', import.meta.url), 'utf8');
    expect(committed).toBe(generateSdk(describeApi()));
  });

  it('maps JSON Schema to TypeScript', () => {
    expect(tsType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null');
    expect(tsType({ type: 'array', items: { enum: ['a', 'b'] } })).toBe('Array<"a" | "b">');
    expect(tsType({ type: 'object', properties: { 'x-y': { type: 'integer' } }, required: ['x-y'] })).toBe('{\n  "x-y": number;\n}');
    expect(tsType({ type: 'object', additionalProperties: { type: 'boolean' } })).toBe('Record<string, boolean>');
    expect(tsType({ $ref: '#/components/schemas/Note' })).toBe('Note');
    expect(tsType({})).toBe('unknown');
  });
});

describe('InkwrightClient against the server', () => {
  let dir: string;
  let state: string;
  let ctx: ServerContext;
  let http: RunningHttpServer;
  let client: InkwrightClient;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'inkwright-sdk-'));
    state = await mkdtemp(path.join(tmpdir(), 'inkwright-sdk-state-'));
    ctx = await createContext({ root: dir, watch: false, renderPng: null });
    ({ http } = await serveHttp(ctx, parseCli(['--vault', dir, '--http', '0', '--token', 'tok', '--state-dir', state], {}), null, () => {}));
    client = new InkwrightClient({ baseUrl: `${http.baseUrl}/api/v1`, apiKey: 'tok' });
  });

  afterAll(async () => {
    await http?.close();
    ctx?.close();
    await rm(dir, { recursive: true, force: true });
    await rm(state, { recursive: true, force: true });
  });

  it('creates, reads, updates with ETags and paginates', async () => {
    const created = await client.createNote({ body: { title: 'SDK note', text: 'Hello from the SDK', tags: ['sdk'] } });
    expect(created).toMatchObject({ title: 'SDK note', tags: ['sdk'], pages: 1 });
    expect(client.lastResponse?.location).toContain(`/notes/${created.id}`);
    const read = await client.getNote({ id: created.id });
    const etag = client.lastResponse!.etag!;
    expect(read!.markdown).toContain('Hello from the SDK');
    expect(await client.getNote({ id: created.id }, { ifNoneMatch: etag })).toBeNull();
    await client.updateNote({ id: created.id, body: { title: 'Renamed' } }, { ifMatch: etag });
    const stale = await client.updateNote({ id: created.id, body: { title: 'Lost' } }, { ifMatch: etag }).catch((e) => e);
    expect(stale).toBeInstanceOf(InkwrightApiError);
    expect(stale).toMatchObject({ status: 412, code: 'precondition_failed' });
    for (let i = 0; i < 4; i++) await client.createNote({ body: { title: `Page ${i}`, tags: ['sdk'] } });
    const titles: string[] = [];
    for await (const n of paginate((cursor) => client.listNotes({ tag: 'sdk', limit: 2, cursor }))) titles.push(n.title);
    expect(titles).toHaveLength(5);
    expect(await client.getPageText({ id: created.id, n: 1 })).toContain('Hello from the SDK');
  });

  it('makes POST retries safe with automatic idempotency keys', async () => {
    let calls = 0;
    const flaky = new InkwrightClient({
      baseUrl: `${http.baseUrl}/api/v1`,
      apiKey: 'tok',
      fetch: async (url, init) => {
        calls++;
        const res = await fetch(url, init);
        // The first answer is "lost": the server did the work, the client sees a 503 and retries.
        return calls === 1 ? new Response(null, { status: 503 }) : res;
      },
    });
    const before = (await client.listNotes({ limit: 200 })).data.length;
    await flaky.createNote({ body: { title: 'Exactly once' } });
    expect(calls).toBe(2);
    expect((await client.listNotes({ limit: 200 })).data.length).toBe(before + 1);
  });

  it('turns problem documents into typed errors', async () => {
    const e = await client.getNote({ id: 'missing' }).catch((x) => x);
    expect(e).toMatchObject({ name: 'InkwrightApiError', status: 404, code: 'not_found' });
    const v = await client.createNote({ body: { title: '' } }).catch((x) => x);
    expect(v.problem.errors[0].path).toBe('body.title');
  });
});

describe('verifyWebhook (Web Crypto)', () => {
  it('accepts what the server signs and rejects tampering and stale messages', async () => {
    const secret = 'whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw';
    const body = '{"type":"note.created","timestamp":"2026-11-02T00:00:00.000Z","data":{"id":"N"}}';
    const ts = 1_800_000_000;
    const headers = { 'webhook-id': 'msg_1', 'webhook-timestamp': String(ts), 'webhook-signature': signWebhook(secret, 'msg_1', ts, body) };
    expect(await verifyWebhook(secret, headers, body, { now: ts * 1000 })).toBe(true);
    expect(await verifyWebhook(secret, new Headers(headers), body, { now: ts * 1000 + 60_000 })).toBe(true);
    expect(await verifyWebhook(secret, headers, body.replace('"N"', '"M"'), { now: ts * 1000 })).toBe(false);
    expect(await verifyWebhook(secret, headers, body, { now: (ts + 600) * 1000 })).toBe(false);
  });
});
