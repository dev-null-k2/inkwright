import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityStore, RoutineStore, VaultUndoTarget, createScriptedProvider, newRoutine, undoRun, type McpConnection, type McpTask, type ScriptStep } from '@inkwright/ai';
import type { ServerContext } from '../src/context.ts';
import { createServices, type ServerServices } from '../src/server.ts';
import type { AgentAI } from '../src/agent/ai.ts';
import { MCP_URL, appConnection, mcpFetch, modernClient, resultText, waitFor } from './clients.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

let fx: Fixture;
let ctx: ServerContext;
let services: ServerServices;
let conn: McpConnection;

function scriptedAI(script: ScriptStep[] | ((c: Parameters<Extract<ScriptStep, Function>>[0]) => ReturnType<Extract<ScriptStep, Function>>)): AgentAI {
  return { provider: createScriptedProvider(script as never), model: 'scripted', label: 'Scripted · test', vision: true };
}

async function setup(ai: AgentAI | null) {
  services = createServices(ctx, { transport: 'http', ai });
  conn = await appConnection(services);
}

async function startTask(name: string, args: Record<string, unknown>): Promise<McpTask> {
  const out = await conn.callTool(name, args);
  if (out.kind !== 'task') throw new Error(`expected a task, got ${JSON.stringify(out)}`);
  return out.task;
}

const until = (id: string, status: McpTask['status']) => waitFor(async () => { const t = await conn.getTask(id); return t.status === status ? t : null; });

beforeEach(async () => {
  fx = await makeFixture();
  ctx = await fx.ctx({ renderPng: async () => new Uint8Array([137, 80, 78, 71]) });
});
afterEach(async () => {
  await conn?.close();
  services?.tasks.close();
  await fx.cleanup();
});

describe('Tasks extension', () => {
  it('summarize_notebook runs as a task with progress and saves only empty summaries', async () => {
    await setup(scriptedAI((c) => ({ text: `About ${/Title: (.*)/.exec(c.userText)?.[1] ?? '?'}.` })));
    expect(conn.info?.supportsTasks).toBe(true);
    const t = await startTask('summarize_notebook', { notebook: 'Work' });
    expect(t.status).toBe('working');
    expect(t.pollIntervalMs).toBeGreaterThan(0);
    const done = await until(t.taskId, 'completed');
    const text = (done.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toContain('**Launch plan** (LAUNCH): About Launch plan.');
    expect(text).toMatch(/Saved 1 summary; kept 1 existing one/);
    ctx.vault.invalidate();
    expect((await ctx.vault.readNote('LAUNCH'))!.summary).toBe('About Launch plan.');
    expect((await ctx.vault.readNote('OLDNOTE'))!.summary).toBe('Thoughts on Deep Work');
    await services.activity.flush();
    const runs = await new ActivityStore(ctx.fs).list();
    expect(runs[0]).toMatchObject({ source: 'external', label: 'Inkwright (via MCP)' });
    expect(runs[0]!.ops.map((o) => o.kind)).toEqual(['meta_changed']);
  });

  it('replacing existing summaries asks first (input_required → tasks/update)', async () => {
    await setup(scriptedAI((c) => ({ text: `New summary of ${/Title: (.*)/.exec(c.userText)?.[1]}.` })));
    const t = await startTask('summarize_notebook', { notebook: 'Work', save: 'all' });
    const waiting = await until(t.taskId, 'input_required');
    const [key, req] = Object.entries(waiting.inputRequests!)[0]!;
    expect(req.method).toBe('elicitation/create');
    expect(String(req.params?.message)).toMatch(/Replace the summaries of 1 note in “Work”/);
    await conn.updateTask(t.taskId, { [key]: { action: 'accept', content: { approve: true } } });
    await until(t.taskId, 'completed');
    ctx.vault.invalidate();
    expect((await ctx.vault.readNote('OLDNOTE'))!.summary).toBe('New summary of Reading notes.');
  });

  it('transcribe_pages fills unrecognized pages, logs undoable ops', async () => {
    const ai = scriptedAI([{ text: '# Whiteboard\n- arrows everywhere' }]);
    await setup(ai);
    const t = await startTask('transcribe_pages', { id: 'SKETCH' });
    const done = await until(t.taskId, 'completed');
    expect((done.result as { structuredContent: { pages: unknown[] } }).structuredContent.pages).toEqual([{ id: 'SKETCH', title: 'Whiteboard sketch', page: 1, text: '# Whiteboard\n- arrows everywhere', saved: true }]);
    const sent = (ai.provider as unknown as { requests: Array<{ messages: Array<{ content: unknown }> }> }).requests[0]!;
    expect(JSON.stringify(sent.messages)).toContain('"type":"image"');
    ctx.vault.invalidate();
    const page = await ctx.vault.readPage('SKETCH', 'SKETCHP1');
    expect(page.recognizedText).toBe('# Whiteboard\n- arrows everywhere');
    expect(page.recognizedBy).toBe('inkwright-agent:scripted');
    await services.activity.flush();
    const [run] = await new ActivityStore(ctx.fs).list();
    expect(run!.ops[0]).toMatchObject({ kind: 'handwriting_recognized', noteId: 'SKETCH', pageId: 'SKETCHP1' });
    await undoRun(run!, new VaultUndoTarget(ctx.vault));
    ctx.vault.invalidate();
    expect((await ctx.vault.readPage('SKETCH', 'SKETCHP1')).recognizedText).toBeUndefined();
  });

  it('cancel stops the work', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const ai: AgentAI = { provider: { ...createScriptedProvider([]), chat: async (req: { signal?: AbortSignal }) => { await Promise.race([gate, new Promise((_, rej) => req.signal?.addEventListener('abort', () => rej(new Error('aborted'))))]); return { text: 'late', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 }, stopReason: 'stop' }; } } as never, model: 'slow', label: 'slow', vision: true };
    await setup(ai);
    const t = await startTask('transcribe_pages', {});
    await waitFor(async () => /Reading page/.test((await conn.getTask(t.taskId)).statusMessage ?? ''));
    await conn.cancelTask(t.taskId);
    const after = await conn.getTask(t.taskId);
    expect(after.status).toBe('cancelled');
    release();
    await new Promise((r) => setTimeout(r, 30));
    expect((await conn.getTask(t.taskId)).status).toBe('cancelled'); // terminal: never changes again
    ctx.vault.invalidate();
    expect((await ctx.vault.readPage('SKETCH', 'SKETCHP1')).recognizedText).toBeUndefined();
  });

  it('run_routine: trashing waits for approval; declining keeps the note', async () => {
    await new RoutineStore(ctx.fs).save(newRoutine({ name: 'Tidy up', prompt: 'Trash my old reading notes please.' }));
    await setup(scriptedAI([
      { toolCalls: [{ name: 'trash_note', arguments: { note_id: 'OLDNOTE' } }] },
      (c) => ({ text: c.toolResults[0]!.ok ? 'Trashed it.' : 'You declined, so I left it.' }),
    ]));
    const t = await startTask('run_routine', { routine: 'tidy up' });
    const waiting = await until(t.taskId, 'input_required');
    const [key, req] = Object.entries(waiting.inputRequests!)[0]!;
    expect(String(req.params?.message)).toContain('Tidy up wants to: Move “Reading notes” to Trash');
    await conn.updateTask(t.taskId, { [key]: { action: 'decline' } });
    const done = await until(t.taskId, 'completed');
    expect(resultText(done.result as never)).toContain('You declined, so I left it.');
    ctx.vault.invalidate();
    expect((await ctx.vault.readNote('OLDNOTE'))!.trashedAt).toBeUndefined();
    const r = await new RoutineStore(ctx.fs).list();
    expect(r[0]!.state).toMatchObject({ lastStatus: 'done' });
    const runs = await new ActivityStore(ctx.fs).list();
    expect(runs.find((x) => x.source === 'routine')).toMatchObject({ label: 'Tidy up', status: 'done', reply: 'You declined, so I left it.' });
  });

  it('without Tasks support, a routine’s trash is deferred to the approval card and runs when allowed', async () => {
    await new RoutineStore(ctx.fs).save(newRoutine({ name: 'Tidy up', prompt: 'Trash my old reading notes please.' }));
    services = createServices(ctx, { transport: 'http', ai: scriptedAI([{ toolCalls: [{ name: 'trash_note', arguments: { note_id: 'OLDNOTE' } }] }, { text: 'Asked you about trashing Reading notes.' }]) });
    const c = await modernClient(services, { name: 'claude-ai', title: 'Claude', version: '1' });
    const r = await c.callTool({ name: 'run_routine', arguments: { routine: 'Tidy up' } });
    expect(resultText(r)).toContain('Asked you about trashing Reading notes.');
    ctx.vault.invalidate();
    expect((await ctx.vault.readNote('OLDNOTE'))!.trashedAt).toBeUndefined();
    const card = await c.callTool({ name: 'list_pending_approvals', arguments: {} });
    const approvals = (card.structuredContent as { approvals: Array<{ id: string; title: string; source: string }> }).approvals;
    expect(approvals).toEqual([expect.objectContaining({ title: 'Move “Reading notes” to Trash', source: 'Tidy up' })]);
    const decided = await c.callTool({ name: 'decide_approval', arguments: { id: approvals[0]!.id, approve: true } });
    expect(decided.structuredContent).toMatchObject({ approval: { status: 'approved' } });
    ctx.vault.invalidate();
    expect((await ctx.vault.readNote('OLDNOTE'))!.trashedAt).toBeTypeOf('number');
    const again = await c.callTool({ name: 'decide_approval', arguments: { id: approvals[0]!.id, approve: true } });
    expect(again.isError).toBe(true);
    const runs = await new ActivityStore(ctx.fs).list();
    expect(runs.find((x) => x.prompt?.startsWith('Approved:'))).toMatchObject({ source: 'routine', label: 'Tidy up', ops: [expect.objectContaining({ kind: 'note_trashed' })] });
    await c.close();
  });

  it('task methods: unknown ids are -32602; clients without the extension get -32021', async () => {
    await setup(null);
    await expect(conn.getTask('nope')).rejects.toThrow(/Unknown or expired task/);
    const f = mcpFetch(services);
    const res = await f(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tasks/get', 'mcp-name': 'x' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tasks/get', params: { taskId: 'x', _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'c', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} } } }) });
    const body = await res.json() as { error?: { code: number } };
    expect(body.error?.code).toBe(-32021);
  });

  it('tasks belong to the principal that started them', () => {
    services = createServices(ctx, { transport: 'http' });
    const v = services.tasks.start('alice', async () => ({ content: [] }));
    expect(services.tasks.get(v.taskId, 'alice')).not.toBeNull();
    expect(services.tasks.get(v.taskId, 'mallory')).toBeNull();
    expect(services.tasks.cancel(v.taskId, 'mallory')).toBe(false);
  });
});
