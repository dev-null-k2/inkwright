/**
 * The proxy's benchmark (docs/PROXY.md): coding-agent turns with large tool output, sent through
 * the real proxy to a fake API whose model reads only what it receives and fetches originals when
 * facts are missing. Compares the same turn with shortening off and on: input tokens over every
 * round trip (estimated, ~4 characters per token, as reported by the fake API), round trips,
 * answer quality, and the time the proxy itself adds. Prints the table the docs quote.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ContextProxy } from '../src/proxy/server.ts';
import { DiskContentStore } from '../src/proxy/originals.ts';
import { makeFixture, type Fixture } from './fixtures.ts';
import { startFakeUpstream, type FakeUpstream } from './proxy-upstream.ts';

interface Task {
  id: string;
  shows: string;
  question: string;
  cmd: string;
  output: string;
  facts: string[];
  retrieveQuery?: string;
}

const testLog = Array.from({ length: 1200 }, (_, i) => (i === 811 ? 'FAIL src/cart.test.ts > applies the coupon: expected 90 to be 81 (AssertionError)' : `PASS src/module${i % 97}.test.ts > case ${i} (${(i * 7) % 40} ms)`)).join('\n');
const grep = Array.from({ length: 1500 }, (_, i) => `src/${['api', 'ui', 'db', 'jobs'][i % 4]}/file${i % 211}.ts:${(i * 13) % 400 + 1}:  ${i === 1033 ? 'const retryBudget = loadRetryBudget(env.RETRY_BUDGET_MS);' : `logger.debug('step ${i}', { id, attempt });`}`).join('\n');
const issues = JSON.stringify(Array.from({ length: 300 }, (_, i) => ({ number: 4000 + i, title: i === 217 ? 'Checkout hangs when the coupon field is empty' : `Refactor module ${i % 50}`, state: i % 3 ? 'open' : 'closed', labels: [['bug'], ['chore'], ['docs']][i % 3], user: { login: `dev${i % 17}` }, comments: i % 9, created_at: `2026-10-${String((i % 28) + 1).padStart(2, '0')}T09:00:00Z` })));
const source = Array.from({ length: 140 }, (_, i) => (i === 93 ? 'export function applyCoupon(total: number, coupon?: string): number {\n  if (!coupon) return total; // an empty coupon must not reach the pricing service\n  return pricing.apply(total, coupon);\n}' : `export function helper${i}(input: string): string {\n  // normalises input for step ${i}\n  return input.trim().toLowerCase();\n}`)).join('\n\n');
const needle = Array.from({ length: 400 }, (_, i) => (i === 287 ? 'build: artifact uploaded to s3://releases/inkwright-2.4.1.tgz' : `build: compiled chunk ${i} (${100 + (i % 50)} kB)`)).join('\n');
const scattered = Array.from({ length: 140 }, (_, i) => ([12, 47, 83, 119].includes(i) ? `So we will ${['ship the beta on Friday', 'price at 9 dollars', 'hire two designers', 'drop the Windows build'][[12, 47, 83, 119].indexOf(i)]}, Ana noted.` : `Point ${i}: the team talked through options and wants more data first.`)).join('\n\n');

const TASKS: Task[] = [
  { id: 'test-log', shows: '1,200-line test run, find the failure', question: 'Why do the tests fail?', cmd: 'npm test', output: testLog, facts: ['expected 90 to be 81'] },
  { id: 'grep', shows: '1,500 grep matches, question names the symbol', question: 'Where is loadRetryBudget called?', cmd: 'rg -n "" src', output: grep, facts: ['loadRetryBudget(env.RETRY_BUDGET_MS)'] },
  { id: 'json-api', shows: '300-issue JSON from an API, question names the issue', question: 'What is the number of the issue about the checkout coupon hang?', cmd: 'gh issue list --json', output: issues, facts: ['4217'] },
  { id: 'source', shows: 'a 560-line source file, question names the function', question: 'What does applyCoupon do with an empty coupon?', cmd: 'cat src/pricing.ts', output: source, facts: ['an empty coupon must not reach the pricing service'] },
  { id: 'needle', shows: 'build log, the answer shares no words with the question (one retrieval round trip)', question: 'Where did the release end up?', cmd: 'npm run release', output: needle, facts: ['s3://releases/inkwright-2.4.1.tgz'], retrieveQuery: 'uploaded' },
  { id: 'summary-all', shows: 'meeting notes, summarise everything, no shared words (needs the whole original back)', question: 'What did the meeting decide?', cmd: 'cat notes/meeting.md', output: scattered, facts: ['ship the beta on Friday', 'price at 9 dollars', 'hire two designers', 'drop the Windows build'] },
  { id: 'short', shows: 'short output under the threshold (left alone)', question: 'Which files are in the folder?', cmd: 'ls', output: 'README.md\npackage.json\nsrc\ntest', facts: ['package.json'] },
];

let fx: Fixture;
let up: FakeUpstream;
let originals: string;
const proxies: ContextProxy[] = [];

async function proxyWith(compress: boolean): Promise<ContextProxy> {
  const p = new ContextProxy({ vaultRoot: fx.dir, originals: new DiskContentStore(originals), port: 0, compress, upstreams: { openai: { baseUrl: `${up.url}/v1`, auth: { kind: 'client' } }, anthropic: { baseUrl: up.url, auth: { kind: 'client' } } } });
  await p.listen();
  proxies.push(p);
  return p;
}

async function run(p: ContextProxy, t: Task, nonce: string) {
  const body = {
    model: 'gpt-4.1',
    messages: [
      { role: 'system', content: `You are a coding agent. (${nonce})` },
      { role: 'user', content: t.question },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ cmd: t.cmd }) } }] },
      { role: 'tool', tool_call_id: 'c1', content: t.output },
    ],
    tools: [{ type: 'function', function: { name: 'bash', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } } }],
  };
  const before = up.requests.length;
  const t0 = performance.now();
  const r = await fetch(`${p.url}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  const ms = performance.now() - t0;
  const reqs = up.requests.slice(before);
  const { estimateTokens } = await import('@inkwright/ai');
  const tokens = reqs.reduce((a, q) => a + estimateTokens(JSON.stringify(q.body.messages)), 0);
  const text = String(j.choices?.[0]?.message?.content ?? '');
  return { tokens, calls: reqs.length, quality: t.facts.filter((f) => text.includes(f)).length / t.facts.length, ms };
}

beforeAll(async () => {
  fx = await makeFixture();
  up = await startFakeUpstream();
  originals = await mkdtemp(path.join(tmpdir(), 'iw-bench-'));
  for (const t of TASKS) up.tasks.set(t.question, { question: t.question, facts: t.facts, ...(t.retrieveQuery ? { retrieveQuery: t.retrieveQuery } : {}) });
});

afterAll(async () => {
  for (const p of proxies) await p.close();
  await up.close();
  await fx.cleanup();
  await rm(originals, { recursive: true, force: true });
});

const pct = (x: number) => `${(x * 100).toFixed(1)}%`;

describe('proxy benchmark', () => {
  it('cuts input tokens on list/log/table-shaped output without losing answers, and shows where it costs more', async () => {
    const off = await proxyWith(false);
    const on = await proxyWith(true);
    const rows = [];
    for (const [i, t] of TASKS.entries()) {
      const a = await run(off, t, `off-${i}`);
      const b = await run(on, t, `on-${i}`);
      // Overhead: the same turn again through each proxy (new conversations), median of 5.
      const times = async (p: ContextProxy, tag: string) => {
        const ms = [];
        for (let k = 0; k < 5; k++) ms.push((await run(p, t, `${tag}-${i}-${k}`)).ms);
        return ms.sort((x, y) => x - y)[2]!;
      };
      rows.push({ t, a, b, saving: 1 - b.tokens / a.tokens, msOff: await times(off, 'toff'), msOn: await times(on, 'ton') });
    }
    console.log('\nContext proxy: input tokens over all round trips (estimated), round trips and answer quality, shortening off → on');
    console.log(`${'task'.padEnd(12)} ${'tokens off'.padStart(10)} ${'tokens on'.padStart(10)} ${'saved'.padStart(7)} ${'calls'.padStart(6)} ${'quality'.padStart(10)} ${'ms off→on'.padStart(12)}  what it shows`);
    for (const r of rows) console.log(`${r.t.id.padEnd(12)} ${String(r.a.tokens).padStart(10)} ${String(r.b.tokens).padStart(10)} ${pct(r.saving).padStart(7)} ${`${r.a.calls}→${r.b.calls}`.padStart(6)} ${`${pct(r.a.quality)}→${pct(r.b.quality)}`.padStart(10)} ${`${r.msOff.toFixed(1)}→${r.msOn.toFixed(1)}`.padStart(12)}  ${r.t.shows}`);
    const tot = rows.reduce((x, r) => ({ a: x.a + r.a.tokens, b: x.b + r.b.tokens }), { a: 0, b: 0 });
    console.log(`${'all tasks'.padEnd(12)} ${String(tot.a).padStart(10)} ${String(tot.b).padStart(10)} ${pct(1 - tot.b / tot.a).padStart(7)}`);
    const by = Object.fromEntries(rows.map((r) => [r.t.id, r]));
    for (const r of rows) expect(r.b.quality, r.t.id).toBe(r.a.quality);
    for (const r of rows) expect(r.a.quality, r.t.id).toBe(1);
    expect(by['test-log']!.saving).toBeGreaterThan(0.8);
    expect(by.grep!.saving).toBeGreaterThan(0.6);
    expect(by['json-api']!.saving).toBeGreaterThan(0.6);
    expect(by.short!.saving).toBe(0);
    expect(by.needle!.b.calls).toBe(2);
    expect(by['summary-all']!.b.calls).toBe(2);
    expect(by['summary-all']!.saving).toBeLessThan(0);
  }, 120_000);
});
