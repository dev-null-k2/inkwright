import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Role, TaskState, type Message, type Task } from '@a2a-js/sdk';
import { ClientFactory, type Client } from '@a2a-js/sdk/client';
import { ActivityStore, createScriptedProvider, type ScriptStep } from '@inkwright/ai';
import { approvalFromMessage, citationsFrom } from '../src/a2a.ts';
import type { AgentAI } from '../src/agent/ai.ts';
import { parseCli } from '../src/cli.ts';
import type { ServerContext } from '../src/context.ts';
import type { RunningHttpServer } from '../src/http.ts';
import { serveHttp } from '../src/serve.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

let fx: Fixture;
let ctx: ServerContext;
let http: RunningHttpServer;
let base: string;

async function start(script: ScriptStep[] | null, extra: string[] = []) {
  const ai: AgentAI | null = script ? { provider: createScriptedProvider(script), model: 'scripted', label: 'Scripted', vision: true } : null;
  ({ http } = await serveHttp(ctx, parseCli(['--vault', fx.dir, '--http', '0', '--a2a', ...extra], {}), ai, () => {}));
  base = http.baseUrl;
}

const text = (t: string, extra: Partial<Message> = {}) => ({ messageId: crypto.randomUUID(), role: Role.ROLE_USER, parts: [{ content: { $case: 'text', value: t } }], ...extra }) as unknown as Message;
const data = (v: unknown, extra: Partial<Message> = {}) => ({ messageId: crypto.randomUUID(), role: Role.ROLE_USER, parts: [{ content: { $case: 'data', value: v } }], ...extra }) as unknown as Message;
const partsOf = (t: Task) => t.artifacts.flatMap((a) => a.parts.map((p) => p.content));
const statusText = (t: Task) => (t.status?.message?.parts ?? []).map((p) => (p.content?.$case === 'text' ? p.content.value : '')).join('');

async function a2aClient(): Promise<Client> {
  return new ClientFactory().createFromUrl(base);
}

beforeEach(async () => {
  fx = await makeFixture();
  ctx = await fx.ctx();
});
afterEach(async () => {
  await http?.close();
  await fx.cleanup();
});

describe('A2A agent', () => {
  it('serves an Agent Card (v1.0 JSON, and v0.3 for older clients)', async () => {
    await start(null);
    const v1 = await (await fetch(`${base}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } })).json() as Record<string, any>;
    expect(v1).toMatchObject({ name: 'Inkwright notes', capabilities: { streaming: true }, defaultInputModes: ['text/plain', 'application/json'] });
    expect(v1.supportedInterfaces).toEqual([
      { url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
      { url: `${base}/a2a`, protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
    ]);
    expect(v1.skills.map((s: { id: string }) => s.id)).toEqual(['search_notes', 'answer_from_notes', 'write_notes', 'run_routine']);
    expect(v1.securitySchemes).toBeUndefined(); // loopback mode: no sign-in
    const v03 = await (await fetch(`${base}/.well-known/agent-card.json`)).json() as Record<string, any>;
    expect(v03).toMatchObject({ url: `${base}/a2a`, protocolVersion: '0.3', preferredTransport: 'JSONRPC' });
  });

  it('answers from notes with citations (SendMessage, official v1.0 client)', async () => {
    await start([
      { toolCalls: [{ name: 'search_notes', arguments: { query: 'maria pricing' } }] },
      { toolCalls: [{ name: 'read_note', arguments: { note_id: 'LAUNCH' } }] },
      { text: 'Call Maria about pricing before the Friday beta launch [Launch plan].' },
    ]);
    const client = await a2aClient();
    const res = (await client.sendMessage({ message: text('What did I decide about pricing?') } as never)) as Task;
    expect(res.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    const contents = partsOf(res);
    expect(contents[0]).toEqual({ $case: 'text', value: 'Call Maria about pricing before the Friday beta launch [Launch plan].' });
    expect(contents[1]).toEqual({ $case: 'data', value: { citations: [{ noteId: 'LAUNCH', title: 'Launch plan', uri: 'inkwright://notes/LAUNCH' }] } });
    const again = await client.getTask({ id: res.id } as never);
    expect(again.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
  });

  it('streams progress: task, working updates, the answer artifact, completed', async () => {
    await start([{ toolCalls: [{ name: 'search_notes', arguments: { query: 'groceries' } }] }, { text: 'Milk, eggs and coffee [Grocery list].' }]);
    const client = await a2aClient();
    const kinds: string[] = [];
    let last: unknown;
    for await (const ev of client.sendMessageStream({ message: text('What do I need to buy?') } as never)) {
      const e = ev as { payload?: { $case: string; value: any } } & Record<string, any>;
      const k = e.payload?.$case ?? Object.keys(e).find((x) => ['task', 'statusUpdate', 'artifactUpdate', 'message'].includes(x)) ?? 'unknown';
      kinds.push(k === 'statusUpdate' ? `status:${(e.payload?.value ?? e.statusUpdate).status?.state}` : k);
      last = e;
    }
    expect(kinds[0]).toBe('task');
    expect(kinds).toContain(`status:${TaskState.TASK_STATE_WORKING}`);
    expect(kinds).toContain('artifactUpdate');
    expect(kinds.at(-1)).toBe(`status:${TaskState.TASK_STATE_COMPLETED}`);
    expect(last).toBeTruthy();
  });

  it('moving a note to Trash pauses in INPUT_REQUIRED until the client approves on the same task', async () => {
    await start([{ toolCalls: [{ name: 'trash_note', arguments: { note_id: 'OLDNOTE' } }] }, { text: 'Moved “Reading notes” to Trash.' }]);
    const client = await a2aClient();
    const first = (await client.sendMessage({ message: text('Trash my reading notes') } as never)) as Task;
    expect(first.status?.state).toBe(TaskState.TASK_STATE_INPUT_REQUIRED);
    expect(statusText(first)).toContain('Move “Reading notes” to Trash');
    ctx.vault.invalidate();
    expect((await ctx.vault.readNote('OLDNOTE'))!.trashedAt).toBeUndefined();
    const done = (await client.sendMessage({ message: data({ approve: true }, { taskId: first.id, contextId: first.contextId }) } as never)) as Task;
    expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
    ctx.vault.invalidate();
    expect((await ctx.vault.readNote('OLDNOTE'))!.trashedAt).toBeTypeOf('number');
    const runs = await new ActivityStore(ctx.fs).list();
    expect(runs[0]).toMatchObject({ source: 'external', label: 'An agent (via A2A)', ops: [expect.objectContaining({ kind: 'note_trashed', noteId: 'OLDNOTE' })] });
  });

  it('cancelling a task waiting for approval stops it without doing anything', async () => {
    await start([{ toolCalls: [{ name: 'trash_note', arguments: { note_id: 'OLDNOTE' } }] }, { text: 'done' }]);
    const client = await a2aClient();
    const first = (await client.sendMessage({ message: text('Trash my reading notes') } as never)) as Task;
    const cancelled = await client.cancelTask({ id: first.id } as never);
    expect(cancelled.status?.state).toBe(TaskState.TASK_STATE_CANCELED);
    await new Promise((r) => setTimeout(r, 50));
    ctx.vault.invalidate();
    expect((await ctx.vault.readNote('OLDNOTE'))!.trashedAt).toBeUndefined();
  });

  it('v0.3 clients: message/send and tasks/get by their old names; structured search needs no AI', async () => {
    await start(null);
    const call = (method: string, params: unknown) => fetch(`${base}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.json() as Promise<{ result: any }>);
    const sent = await call('message/send', { message: { kind: 'message', messageId: 'm1', role: 'user', parts: [{ kind: 'data', data: { skill: 'search_notes', query: 'budget beta' } }] } });
    expect(sent.result).toMatchObject({ kind: 'task', status: { state: 'completed' } });
    const results = sent.result.artifacts[0].parts.find((p: { kind: string }) => p.kind === 'data').data.results;
    expect(results[0]).toMatchObject({ noteId: 'LAUNCH', page: 2, notebook: 'Work / Projects' });
    const got = await call('tasks/get', { id: sent.result.id });
    expect(got.result.id).toBe(sent.result.id);
    const noAi = await call('message/send', { message: { kind: 'message', messageId: 'm2', role: 'user', parts: [{ kind: 'text', text: 'What is in my notes?' }] } });
    expect(noAi.result.status).toMatchObject({ state: 'failed' });
    expect(JSON.stringify(noAi.result.status.message)).toContain('No AI is set up');
  });

  it('with a token, the card says so and requests need it', async () => {
    await start(null, ['--token', 's3cret']);
    const card = await (await fetch(`${base}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } })).json() as Record<string, any>;
    expect(card.securitySchemes.bearer.httpAuthSecurityScheme.scheme).toBe('Bearer');
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'SendMessage', params: { message: { messageId: 'x', role: 'ROLE_USER', parts: [{ data: { skill: 'search_notes', query: 'milk' } }] } } });
    expect((await fetch(`${base}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0' }, body })).status).toBe(401);
    const ok = await fetch(`${base}/a2a`, { method: 'POST', headers: { 'content-type': 'application/json', 'A2A-Version': '1.0', authorization: 'Bearer s3cret' }, body });
    expect(((await ok.json()) as { result: { task: { status: { state: string } } } }).result.task.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('helpers: approvals from replies, citations only for notes used', () => {
    expect(approvalFromMessage(text('Yes, go ahead'))).toBe('approved');
    expect(approvalFromMessage(text('no thanks'))).toBe('denied');
    expect(approvalFromMessage(data({ approve: false }))).toBe('denied');
    const runs = [
      { call: { id: '1', name: 'search_notes', arguments: {} }, step: 1, ok: true, result: { results: [{ note_id: 'A', title: 'Alpha', page_index: 0 }, { note_id: 'B', title: 'Beta', page_index: 2 }] } },
    ];
    expect(citationsFrom(runs, 'See [Beta].')).toEqual([{ noteId: 'B', title: 'Beta', uri: 'inkwright://notes/B', page: 3 }]);
  });
});
