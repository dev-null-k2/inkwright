/**
 * The context-saving proxy over real HTTP, in front of a fake OpenAI/Anthropic API whose model
 * reads only what it is sent: shortening of tool output in both formats, the three ways an
 * original comes back (the proxy answers retrieve_original; the client's own MCP tool; none,
 * lossless only), streaming in and out, usage metered into the vault, the local-only guards, and
 * the MCP tools over the shared store of originals.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { estimateTokens, monthOf } from '@inkwright/ai';
import { ContextProxy } from '../src/proxy/server.ts';
import { DiskContentStore } from '../src/proxy/originals.ts';
import { createServices } from '../src/server.ts';
import { modernClient, resultJson, resultText } from './clients.ts';
import { makeFixture, type Fixture } from './fixtures.ts';
import { startFakeUpstream, type FakeUpstream } from './proxy-upstream.ts';

const testLog = Array.from({ length: 1200 }, (_, i) => (i === 811 ? 'FAIL src/cart.test.ts > applies the coupon: expected 90 to be 81 (AssertionError)' : `PASS src/module${i % 97}.test.ts > case ${i} (${(i * 7) % 40} ms)`)).join('\n');
const TOOLS_OPENAI = [{ type: 'function', function: { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }];
const TOOLS_ANTHROPIC = [{ name: 'bash', description: 'Run a command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }];

let fx: Fixture;
let up: FakeUpstream;
let proxy: ContextProxy;
let originalsDir: string;

beforeAll(async () => {
  fx = await makeFixture();
  up = await startFakeUpstream();
  originalsDir = await mkdtemp(path.join(tmpdir(), 'iw-originals-'));
  proxy = new ContextProxy({ vaultRoot: fx.dir, originals: new DiskContentStore(originalsDir), port: 0, upstreams: { openai: { baseUrl: `${up.url}/v1`, auth: { kind: 'client' } }, anthropic: { baseUrl: up.url, auth: { kind: 'client' } } } });
  await proxy.listen();
  up.tasks.set('Why do the tests fail?', { question: 'Why do the tests fail?', facts: ['expected 90 to be 81'] });
  up.tasks.set('Which test took 39 ms?', { question: 'Which test took 39 ms?', facts: ['case 377 (39 ms)'] });
});

afterAll(async () => {
  await proxy.close();
  await up.close();
  await fx.cleanup();
  await rm(originalsDir, { recursive: true, force: true });
});

const post = (p: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${proxy.url}${p}`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer client-key', ...headers }, body: JSON.stringify(body) });

const openaiAgentTurn = (question: string, extra: Record<string, unknown> = {}) => ({
  model: 'gpt-4.1',
  messages: [
    { role: 'system', content: 'You are a coding agent.' },
    { role: 'user', content: question },
    { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"cmd":"npm test"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: testLog },
  ],
  tools: TOOLS_OPENAI,
  ...extra,
});

const anthropicAgentTurn = (question: string, extra: Record<string, unknown> = {}) => ({
  model: 'claude-sonnet-4-5',
  max_tokens: 1000,
  messages: [
    { role: 'user', content: question },
    { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'bash', input: { cmd: 'npm test' } }] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: testLog }] },
  ],
  tools: TOOLS_ANTHROPIC,
  ...extra,
});

describe('shortening tool output', () => {
  it('OpenAI: sends a shortened log upstream, answers retrieve_original itself when needed, client sees only the answer', async () => {
    const n = up.requests.length;
    const r = await post('/v1/chat/completions', openaiAgentTurn('Why do the tests fail?'));
    const j = await r.json();
    expect(j.choices[0].message.content).toBe('Answer: expected 90 to be 81');
    const sent = up.requests[n]!;
    const tool = sent.body.messages.find((m: any) => m.role === 'tool').content as string;
    expect(estimateTokens(tool)).toBeLessThan(estimateTokens(testLog) / 4);
    expect(tool).toContain('expected 90 to be 81'); // errors are kept by the log rule
    expect(tool).toMatch(/retrieve_original with ref "[0-9a-f]{16}"/);
    expect(sent.headers.authorization).toBe('Bearer client-key'); // the client's own key, passed through
    expect(up.requests.length).toBe(n + 1); // the error was visible: no retrieval round
  });

  it('OpenAI: a fact the rules dropped is fetched with retrieve_original in a second round', async () => {
    const n = up.requests.length;
    const j = await (await post('/v1/chat/completions', openaiAgentTurn('Which test took 39 ms?'))).json();
    expect(j.choices[0].message.content).toBe('Answer: case 377 (39 ms)');
    expect(up.requests.length).toBe(n + 2);
    expect(up.requests[n]!.body.tools.map((t: any) => t.function.name)).toEqual(['bash', 'retrieve_original']);
    const second = up.requests[n + 1]!.body.messages.at(-1);
    expect(second.role).toBe('tool');
    expect(second.content).toContain('case 377 (39 ms)');
    expect(j.choices[0].message.tool_calls).toBeUndefined();
  });

  it('Anthropic, streamed: the upstream call is made unstreamed and replayed to the client as a stream', async () => {
    const n = up.requests.length;
    const r = await post('/v1/messages', anthropicAgentTurn('Which test took 39 ms?', { stream: true }), { 'x-api-key': 'client-anthropic', 'anthropic-version': '2023-06-01' });
    expect(r.headers.get('content-type')).toMatch(/event-stream/);
    const text = await r.text();
    expect(text).toContain('event: message_start');
    expect(text).toContain('"text_delta","text":"Answer: case 377 (39 ms)"');
    expect(text).toContain('event: message_stop');
    expect(up.requests[n]!.body.stream).toBeUndefined();
    expect(up.requests[n]!.headers['x-api-key']).toBe('client-anthropic');
    const tr = up.requests[n]!.body.messages[2].content[0];
    expect(tr.type).toBe('tool_result');
    expect(estimateTokens(tr.content)).toBeLessThan(estimateTokens(testLog) / 4);
  });

  it('a client offering retrieve_original itself (Inkwright MCP) keeps its stream untouched, and the MCP tool returns the original', async () => {
    const n = up.requests.length;
    const body = openaiAgentTurn('Why do the tests fail?', { stream: true, stream_options: { include_usage: true } });
    (body.tools as any[]).push({ type: 'function', function: { name: 'inkwright__retrieve_original', description: 'x', parameters: { type: 'object' } } });
    const r = await post('/v1/chat/completions', body);
    const text = await r.text();
    expect(text).toContain('"content":"Answer: expected 90 to be 81"');
    expect(text.trim().endsWith('data: [DONE]')).toBe(true);
    const sent = up.requests[n]!.body;
    expect(sent.stream).toBe(true);
    expect(sent.tools.map((t: any) => t.function.name)).toEqual(['bash', 'inkwright__retrieve_original']); // nothing added
    const ref = /ref "([0-9a-f]{16})"/.exec(sent.messages.find((m: any) => m.role === 'tool').content)![1]!;
    // The same store backs the MCP server's retrieve_original.
    const ctx = await fx.ctx({ features: { originalsDir } });
    const client = await modernClient(createServices(ctx, { transport: 'http' }));
    expect(resultText(await client.callTool({ name: 'retrieve_original', arguments: { ref } }))).toBe(testLog);
    expect(resultText(await client.callTool({ name: 'retrieve_original', arguments: { ref, query: 'case 377' } }))).toContain('case 377 (39 ms)');
    await client.close();
  });

  it('without tools only lossless shortening happens (the model could not ask for the original)', async () => {
    const n = up.requests.length;
    const repeated = Array.from({ length: 400 }, () => 'WARN retrying connection to db-1').join('\n');
    await post('/v1/chat/completions', { model: 'gpt-4.1', messages: [{ role: 'user', content: repeated }, { role: 'user', content: 'Summarize.' }] });
    const sent = up.requests[n]!.body.messages[0].content as string;
    expect(sent).toBe('WARN retrying connection to db-1  [repeated 400×]');
    expect(sent).not.toContain('retrieve_original');
  });

  it('small results and the question are left alone', async () => {
    const n = up.requests.length;
    const body = { model: 'gpt-4.1', messages: [{ role: 'user', content: 'ls?' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'bash', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 'c', content: 'README.md\nsrc' }], tools: TOOLS_OPENAI };
    await post('/v1/chat/completions', body);
    expect(up.requests[n]!.body.messages).toEqual(body.messages);
  });
});

describe('metering and safety', () => {
  it('records tokens sent and what shortening saved in the vault’s usage files', async () => {
    await proxy.usage.flush();
    const rows = (await proxy.usage.month(monthOf(Date.now()))).filter((r) => r.label.startsWith('Context proxy'));
    const openai = rows.find((r) => r.provider === 'openai')!;
    expect(openai.calls).toBeGreaterThanOrEqual(4);
    expect(openai.uncompressedInputTokens).toBeGreaterThan(openai.inputTokens * 2);
    expect(rows.find((r) => r.provider === 'anthropic')!.uncompressedInputTokens).toBeGreaterThan(0);
    expect(proxy.stats.retrieveRounds).toBeGreaterThanOrEqual(2);
  });

  it('answers only this computer’s programs, and only JSON', async () => {
    expect((await post('/v1/chat/completions', {}, { origin: 'https://evil.example' })).status).toBe(403);
    const text = await fetch(`${proxy.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"model":"x","messages":[]}' });
    expect(text.status).toBe(415);
    // A DNS-rebinding page reaches 127.0.0.1 under its own host name.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve) => {
      const req = request(`${proxy.url}/v1/models`, { headers: { host: 'attacker.example:8787' } }, (res) => resolve(res.statusCode ?? 0));
      req.end();
    });
    expect(status).toBe(403);
  });

  it('passes other endpoints through unchanged', async () => {
    const r = await fetch(`${proxy.url}/v1/models`, { headers: { authorization: 'Bearer client-key' } });
    expect((await r.json()).data[0].id).toBe('reader-1');
  });

  it('can use its own key instead of the client’s', async () => {
    const p2 = new ContextProxy({ vaultRoot: fx.dir, originals: new DiskContentStore(originalsDir), port: 0, upstreams: { openai: { baseUrl: `${up.url}/v1`, auth: { kind: 'key', key: 'env-key' } }, anthropic: { baseUrl: up.url, auth: { kind: 'client' } } } });
    await p2.listen();
    const n = up.requests.length;
    await fetch(`${p2.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer client-key' }, body: JSON.stringify({ model: 'gpt-4.1', messages: [{ role: 'user', content: 'hi' }] }) });
    expect(up.requests[n]!.headers.authorization).toBe('Bearer env-key');
    await p2.close();
  });
});

describe('compress_and_store over MCP', () => {
  it('shortens and stores, and retrieve_original brings it back', async () => {
    const ctx = await fx.ctx({ features: { originalsDir } });
    const client = await modernClient(createServices(ctx, { transport: 'http' }));
    const r = resultJson(await client.callTool({ name: 'compress_and_store', arguments: { text: testLog, query: 'coupon' } }));
    expect(r.shortened).toBe(true);
    expect(r.tokens).toBeLessThan(r.original_tokens / 4);
    expect(r.text).toContain('applies the coupon');
    expect(resultText(await client.callTool({ name: 'retrieve_original', arguments: { ref: r.ref } }))).toBe(testLog);
    const small = resultJson(await client.callTool({ name: 'compress_and_store', arguments: { text: 'short' } }));
    expect(small.shortened).toBe(false);
    expect(resultText(await client.callTool({ name: 'retrieve_original', arguments: { ref: small.ref } }))).toBe('short');
    const missing = await client.callTool({ name: 'retrieve_original', arguments: { ref: '0000000000000000' } });
    expect(missing.isError).toBe(true);
    await client.close();
  });

  it('is switched off with --no-context-tools', async () => {
    const ctx = await fx.ctx({ features: { contextTools: false } });
    const client = await modernClient(createServices(ctx, { transport: 'http' }));
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('compress_and_store');
    await client.close();
  });
});
