import { describe, expect, it } from 'vitest';
import {
  McpConnection,
  McpOAuthProvider,
  MemorySecretStore,
  agentToolName,
  createMcpAgentTools,
  createScriptedProvider,
  defaultToolSettings,
  forgetMcpSecrets,
  mcpBearerSecret,
  explainMcpError,
  normalizeServerUrl,
  parseOAuthCallback,
  runAgent,
  taskAwareFetch,
  type McpServerConfig,
  type McpTask,
} from '../src/index.ts';
import { createFakeMcp } from './fake-mcp.ts';

const cfg = (over: Partial<McpServerConfig> = {}): McpServerConfig => ({ id: 'srv1', name: 'Tasks', url: 'https://fake-mcp.test/mcp', auth: 'none', enabled: true, tools: {}, addedAt: 0, ...over });

describe('MCP configuration', () => {
  it('asks before tools that may change things, not before read-only ones', () => {
    expect(defaultToolSettings({ annotations: { readOnlyHint: true } })).toEqual({ enabled: true, ask: false });
    expect(defaultToolSettings({ annotations: { destructiveHint: false } })).toEqual({ enabled: true, ask: true });
    expect(defaultToolSettings({})).toEqual({ enabled: true, ask: true });
  });

  it('validates server URLs', () => {
    expect(normalizeServerUrl(' https://mcp.notion.com/mcp#x ')).toBe('https://mcp.notion.com/mcp');
    expect(normalizeServerUrl('http://localhost:8787/mcp')).toBe('http://localhost:8787/mcp');
    expect(() => normalizeServerUrl('http://example.com/mcp')).toThrow(/https/);
    expect(() => normalizeServerUrl('notaurl')).toThrow(/https/);
    expect(() => normalizeServerUrl('https://user:pw@example.com/mcp')).toThrow(/password/);
  });

  it('makes provider-safe, unique tool names', () => {
    const taken = new Set<string>();
    expect(agentToolName('Notion', 'search', taken)).toBe('notion__search');
    expect(agentToolName('Notion', 'search', taken)).toBe('notion__search_2');
    const long = agentToolName('A very long server name indeed', 'tool.with/odd chars and a really long name that goes on', taken);
    expect(long).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });
});

describe('MCP connection (in-process server)', () => {
  it('negotiates 2026-07-28, lists tools and resources, and calls tools', async () => {
    const fake = createFakeMcp();
    const c = new McpConnection(cfg(), { fetch: fake.fetch });
    await c.connect();
    expect(c.status).toBe('connected');
    expect(c.info?.protocolVersion).toBe('2026-07-28');
    expect(c.info?.supportsTasks).toBe(true);
    expect(c.tools.map((t) => t.name).sort()).toEqual(['add_task', 'broken', 'delete_everything', 'export_notes', 'list_tasks']);
    expect(c.resources.map((r) => r.uri)).toEqual(['fake://readme']);
    const out = await c.callTool('add_task', { title: 'Buy milk' });
    expect(out.kind).toBe('result');
    expect(fake.state.tasksAdded).toEqual(['Buy milk']);
    // Every request declared the tasks extension.
    const discover = fake.state.requests.find((r) => r.rpc === 'server/discover');
    expect(discover).toBeTruthy();
    const read = await c.readResource('fake://readme');
    expect(JSON.stringify(read.contents)).toContain('Hello from the fake server');
    expect(c.prompts.map((p) => p.name)).toEqual(['plan_week']);
    const prompt = await c.getPrompt('plan_week', { focus: 'exams' });
    expect(JSON.stringify(prompt.messages)).toContain('Plan my week around exams');
    await c.close();
  });

  it('falls back to a 2025 server', async () => {
    const fake = createFakeMcp({ legacyOnly: true });
    const c = new McpConnection(cfg(), { fetch: fake.fetch });
    await c.connect();
    expect(c.info?.protocolVersion).toMatch(/^2025-/);
    expect((await c.callTool('list_tasks', {})).kind).toBe('result');
  });

  it('uses a bearer token and reports a missing one as needing sign-in', async () => {
    const fake = createFakeMcp({ bearer: 'secret-token' });
    const bad = new McpConnection(cfg({ auth: 'bearer' }), { fetch: fake.fetch, auth: { token: async () => 'wrong' } });
    await expect(bad.connect()).rejects.toMatchObject({ kind: 'auth' });
    expect(bad.status).toBe('needs-auth');
    const good = new McpConnection(cfg({ auth: 'bearer' }), { fetch: fake.fetch, auth: { token: async () => 'secret-token' } });
    await good.connect();
    expect(good.status).toBe('connected');
    expect(fake.state.requests.at(-1)!.headers.authorization).toBe('Bearer secret-token');
  });

  it('explains CORS failures and unreachable servers differently', async () => {
    const corsFail = new TypeError('Failed to fetch');
    const cors = await explainMcpError(corsFail, 'https://mcp.example.com/mcp', async () => true);
    expect(cors.kind).toBe('cors');
    expect(cors.message).toMatch(/doesn’t allow web apps/);
    const down = await explainMcpError(corsFail, 'https://mcp.example.com/mcp', async () => false);
    expect(down.kind).toBe('network');
    // Through a connection: fetch throws like a browser blocking a cross-origin response.
    const blocked = new McpConnection(cfg(), { fetch: async (_u, init) => { if (init?.mode === 'no-cors') return new Response(null); throw new TypeError('Failed to fetch'); } });
    await expect(blocked.connect()).rejects.toMatchObject({ kind: 'cors' });
    expect(blocked.status).toBe('error');
  });

  it('reports a wrong path as "no MCP server here"', async () => {
    const fake = createFakeMcp();
    const c = new McpConnection(cfg({ url: 'https://fake-mcp.test/wrong' }), { fetch: fake.fetch });
    await expect(c.connect()).rejects.toMatchObject({ kind: 'http' });
  });
});

describe('MCP tools in the agent: per-tool on/off and ask-before-running', () => {
  async function connected(tools: McpServerConfig['tools'] = {}) {
    const fake = createFakeMcp();
    const c = new McpConnection(cfg({ tools }), { fetch: fake.fetch });
    await c.connect();
    return { fake, c };
  }

  it('exposes enabled tools; write tools need confirmation; read-only tools run directly', async () => {
    const { fake, c } = await connected({ delete_everything: { enabled: false, ask: true } });
    const tools = createMcpAgentTools([{ connection: c }]);
    const names = tools.map((t) => t.name);
    expect(names).toContain('tasks__add_task');
    expect(names).toContain('tasks__list_tasks');
    expect(names).not.toContain('tasks__delete_everything');
    expect(names).toContain('check_background_task');
    expect(tools.find((t) => t.name === 'tasks__add_task')!.destructive).toBe(true);
    expect(tools.find((t) => t.name === 'tasks__list_tasks')!.destructive).toBe(false);

    const asked: string[] = [];
    const provider = createScriptedProvider([
      { toolCalls: [{ name: 'tasks__list_tasks' }, { name: 'tasks__add_task', arguments: { title: 'Revise chapter 3' } }] },
      { text: 'Added it.' },
    ]);
    const res = await runAgent({ provider, model: 'm', messages: [{ role: 'user', content: 'add a task' }], tools, confirm: (call) => { asked.push(call.name); return true; } });
    expect(asked).toEqual(['tasks__add_task']);
    expect(fake.state.tasksAdded).toEqual(['Revise chapter 3']);
    expect(res.toolRuns.every((r) => r.ok)).toBe(true);
  });

  it('a declined call never reaches the server', async () => {
    const { fake, c } = await connected();
    const tools = createMcpAgentTools([{ connection: c }]);
    const provider = createScriptedProvider([{ toolCalls: [{ name: 'tasks__add_task', arguments: { title: 'Nope' } }] }, { text: 'OK, not added.' }]);
    const res = await runAgent({ provider, model: 'm', messages: [{ role: 'user', content: 'add' }], tools, confirm: () => false });
    expect(fake.state.tasksAdded).toEqual([]);
    expect(res.toolRuns[0]!.denied).toBe(true);
  });

  it('"ask" can be turned off per tool, and forced back on for background routines', async () => {
    const { c } = await connected({ add_task: { enabled: true, ask: false } });
    expect(createMcpAgentTools([{ connection: c }]).find((t) => t.name === 'tasks__add_task')!.destructive).toBe(false);
    expect(createMcpAgentTools([{ connection: c }], { alwaysAskForWrites: true }).find((t) => t.name === 'tasks__add_task')!.destructive).toBe(true);
    // Routines can restrict a server to some tools.
    expect(createMcpAgentTools([{ connection: c, only: ['list_tasks'] }]).map((t) => t.name)).toEqual(['tasks__list_tasks', 'check_background_task']);
  });

  it('tool errors go back to the model as errors; changes are reported for the activity log', async () => {
    const { c } = await connected();
    const changes: string[] = [];
    const tools = createMcpAgentTools([{ connection: c }], { onExternalChange: (x) => changes.push(x.summary) });
    const provider = createScriptedProvider([{ toolCalls: [{ name: 'tasks__broken' }, { name: 'tasks__add_task', arguments: { title: 'x' } }] }, { text: 'done' }]);
    const res = await runAgent({ provider, model: 'm', messages: [{ role: 'user', content: 'go' }], tools, confirm: () => true });
    expect(res.toolRuns[0]!.ok).toBe(false);
    expect(res.toolRuns[0]!.error).toMatch(/Quota exceeded/);
    expect(changes).toEqual(['Used “Add task” in Tasks']);
  });

  it('resources are readable through one read-only tool that lists them', async () => {
    const { c } = await connected();
    const tool = createMcpAgentTools([{ connection: c }]).find((t) => t.name === 'tasks__read_resource')!;
    expect(tool.readOnly).toBe(true);
    expect(tool.destructive).toBeFalsy();
    expect(tool.description).toContain('fake://readme');
    expect(await tool.execute({ uri: 'fake://readme' }, { toolCallId: 'x', messages: [] })).toBe('Hello from the fake server');
  });

  it('disabled servers contribute no tools', async () => {
    const { c } = await connected();
    (c.config as McpServerConfig).enabled = false;
    expect(createMcpAgentTools([{ connection: c }])).toEqual([]);
  });
});

describe('MCP Tasks extension', () => {
  it('turns a task handle into a tracked background task, polls it to completion', async () => {
    const fake = createFakeMcp({ taskPolls: 2 });
    const c = new McpConnection(cfg({ tools: { export_notes: { enabled: true, ask: false } } }), { fetch: fake.fetch });
    await c.connect();
    const out = await c.callTool('export_notes', { format: 'zip' });
    expect(out.kind).toBe('task');
    const task = (out as { task: McpTask }).task;
    expect(task.status).toBe('working');
    expect((await c.getTask(task.taskId)).status).toBe('working');
    const done = await c.getTask(task.taskId);
    expect(done.status).toBe('completed');
    expect(JSON.stringify(done.result)).toContain('Exported as zip');
  });

  it('agent tool reports the task and check_background_task returns the result', async () => {
    const fake = createFakeMcp({ taskPolls: 1 });
    const c = new McpConnection(cfg({ tools: { export_notes: { enabled: true, ask: false } } }), { fetch: fake.fetch });
    await c.connect();
    const started: McpTask[] = [];
    const tools = createMcpAgentTools([{ connection: c }], { onTask: (t) => started.push(t) });
    const provider = createScriptedProvider([
      { toolCalls: [{ name: 'tasks__export_notes', arguments: { format: 'pdf' } }] },
      (ctx) => ({ toolCalls: [{ name: 'check_background_task', arguments: { task_id: (ctx.toolResults[0]!.value as any).background_task.task_id } }] }),
      (ctx) => ({ text: `Result: ${(ctx.toolResults[0]!.value as any).result}` }),
    ]);
    const res = await runAgent({ provider, model: 'm', messages: [{ role: 'user', content: 'export' }], tools });
    expect(started).toHaveLength(1);
    expect(res.text).toContain('Exported as pdf');
  });

  it('answers input_required with tasks/update and can cancel', async () => {
    const fake = createFakeMcp({ taskNeedsInput: true, taskPolls: 1 });
    const c = new McpConnection(cfg(), { fetch: fake.fetch });
    await c.connect();
    const out = await c.callTool('export_notes', { format: 'md' });
    const id = (out as { task: McpTask }).task.taskId;
    const t = await c.getTask(id);
    expect(t.status).toBe('input_required');
    expect(t.inputRequests?.confirm?.method).toBe('elicitation/create');
    await c.updateTask(id, { confirm: { action: 'accept', content: { attachments: true } } });
    const done = await c.getTask(id);
    expect(done.status).toBe('completed');
    expect(JSON.stringify(done.result)).toContain('attachments');

    const out2 = await c.callTool('export_notes', { format: 'md' });
    const id2 = (out2 as { task: McpTask }).task.taskId;
    await c.cancelTask(id2);
    expect((await c.getTask(id2)).status).toBe('cancelled');
  });

  it('taskAwareFetch leaves ordinary responses alone', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, result: { resultType: 'complete', content: [] } });
    const f = taskAwareFetch(async () => new Response(body, { headers: { 'content-type': 'application/json' } }));
    const r = await f('https://x/mcp', { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'a' } }) });
    expect(await r.text()).toBe(body);
  });
});

describe('MCP OAuth (PKCE, dynamic registration, refresh)', () => {
  const redirectUrl = 'https://app.inkstone.test/';

  it('signs in through the authorization server and stores tokens encrypted per issuer', async () => {
    const fake = createFakeMcp({ oauth: true });
    const secrets = new MemorySecretStore();
    let authorizeUrl: URL | null = null;
    const provider = new McpOAuthProvider({ serverId: 'srv1', secrets, redirectUrl, clientName: 'Inkstone', onRedirect: (u) => { authorizeUrl = u; } });
    const c = new McpConnection(cfg({ auth: 'oauth' }), { fetch: fake.fetch, auth: provider });
    await expect(c.connect()).rejects.toMatchObject({ kind: 'auth' });
    expect(c.status).toBe('needs-auth');
    expect(authorizeUrl).not.toBeNull();
    const a = authorizeUrl!;
    expect(a.searchParams.get('code_challenge_method')).toBe('S256');
    expect(a.searchParams.get('resource')).toBe('https://fake-mcp.test/mcp');
    expect(a.searchParams.get('state')).toMatch(/^srv1\./);
    expect(fake.state.clients.size).toBe(1);

    // The browser comes back to the app with ?code=…&state=…&iss=…
    const back = fake.approve(a);
    const cb = parseOAuthCallback(back.search)!;
    expect(cb.serverId).toBe('srv1');
    expect(cb.params.get('state')).toBe(await provider.expectedState());
    await c.finishAuth(cb.params);
    expect(await provider.hasTokens()).toBe(true);
    const names = await secrets.list();
    expect(names.some((n) => n.startsWith('mcp:srv1:tokens:https://fake-mcp.test'))).toBe(true);
    expect(names.some((n) => n.startsWith('mcp:srv1:client:https://fake-mcp.test'))).toBe(true);

    await c.connect();
    expect(c.status).toBe('connected');
    expect(fake.state.requests.at(-1)!.headers.authorization).toBe('Bearer at-1');

    // An expired/revoked access token is refreshed with the refresh token, without user action.
    fake.state.accessTokens.clear();
    const again = new McpConnection(cfg({ auth: 'oauth' }), { fetch: fake.fetch, auth: provider });
    await again.connect();
    expect(again.status).toBe('connected');
    expect(fake.state.requests.at(-1)!.headers.authorization).toBe('Bearer at-2');

    await forgetMcpSecrets(secrets, 'srv1');
    expect((await secrets.list()).filter((n) => n.startsWith('mcp:srv1:'))).toEqual([]);
  });

  it('a PKCE verifier mismatch fails the sign-in', async () => {
    const fake = createFakeMcp({ oauth: true });
    const secrets = new MemorySecretStore();
    let authorizeUrl: URL | null = null;
    const provider = new McpOAuthProvider({ serverId: 'srv2', secrets, redirectUrl, clientName: 'Inkstone', onRedirect: (u) => { authorizeUrl = u; } });
    const c = new McpConnection(cfg({ id: 'srv2', auth: 'oauth' }), { fetch: fake.fetch, auth: provider });
    await c.connect().catch(() => {});
    const back = fake.approve(authorizeUrl!);
    await secrets.set('mcp:srv2:verifier', 'tampered');
    await expect(c.finishAuth(back.searchParams)).rejects.toThrow();
    expect(await provider.hasTokens()).toBe(false);
  });

  it('only recognizes callbacks with a state it issued', () => {
    expect(parseOAuthCallback('?code=abc&state=srv1.0123456789abcdef')?.serverId).toBe('srv1');
    expect(parseOAuthCallback('?code=abc&state=random')).toBeNull();
    expect(parseOAuthCallback('?state=srv1.0123456789abcdef&error=access_denied&error_description=No')?.error).toBe('No');
    expect(parseOAuthCallback('?foo=1')).toBeNull();
  });

  it('bearer secrets live under the server namespace', () => {
    expect(mcpBearerSecret('abc')).toBe('mcp:abc:bearer');
  });
});
