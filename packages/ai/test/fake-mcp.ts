/**
 * An in-process MCP server for tests: the official SDK server (`createMcpHandler`, 2026-07-28 with
 * 2025 fallback) behind a `fetch` function, plus the bits the SDK doesn't serve itself — the Tasks
 * extension, bearer-token checks, an OAuth 2.1 authorization server (discovery, dynamic client
 * registration, PKCE S256, refresh) and a "legacy only" mode. No network is involved.
 */
import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';

export interface FakeTask {
  taskId: string;
  status: 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';
  polls: number;
  /** Polls before it completes. */
  doneAfter: number;
  args: Record<string, unknown>;
  answers?: Record<string, unknown>;
}

export interface FakeMcpOptions {
  url?: string;
  /** Require `Authorization: Bearer <token>`. */
  bearer?: string;
  /** Act as an OAuth-protected server with its own authorization server. */
  oauth?: boolean;
  /** Answer `server/discover` like a 2025 server (method not found). */
  legacyOnly?: boolean;
  /** `export_notes` returns a task that completes after this many polls (default 2). */
  taskPolls?: number;
  /** `export_notes` task asks for input first. */
  taskNeedsInput?: boolean;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

async function sha256b64url(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return Buffer.from(d).toString('base64url');
}

export function createFakeMcp(opts: FakeMcpOptions = {}) {
  const base = opts.url ?? 'https://fake-mcp.test/mcp';
  const origin = new URL(base).origin;
  const state = {
    tasksAdded: [] as string[],
    deleted: [] as string[],
    tasks: new Map<string, FakeTask>(),
    requests: [] as Array<{ method: string; rpc?: string; headers: Record<string, string> }>,
    clients: new Map<string, { redirect_uris: string[] }>(),
    codes: new Map<string, { challenge: string; clientId: string; redirectUri: string; resource?: string }>(),
    accessTokens: new Set<string>(),
    refreshTokens: new Set<string>(),
    issued: 0,
  };
  const handler = createMcpHandler(() => {
    const s = new McpServer({ name: 'fake-tasks', version: '1.0.0' });
    s.registerTool('list_tasks', { description: 'List the to-do tasks', annotations: { readOnlyHint: true } }, async () => ({ content: [{ type: 'text', text: state.tasksAdded.length ? state.tasksAdded.join('\n') : 'No tasks.' }] }));
    s.registerTool('add_task', { title: 'Add task', description: 'Add a to-do task', inputSchema: z.object({ title: z.string() }) }, async ({ title }) => {
      state.tasksAdded.push(title);
      return { content: [{ type: 'text', text: `Added “${title}”.` }] };
    });
    s.registerTool('delete_everything', { description: 'Delete all tasks', annotations: { destructiveHint: true } }, async () => {
      state.deleted.push(...state.tasksAdded.splice(0));
      return { content: [{ type: 'text', text: 'Deleted.' }] };
    });
    s.registerTool('broken', { description: 'Always fails', annotations: { readOnlyHint: true } }, async () => ({ isError: true, content: [{ type: 'text', text: 'Quota exceeded for broken.' }] }));
    s.registerTool('export_notes', { description: 'Export a big archive (long-running)', inputSchema: z.object({ format: z.string() }) }, async () => ({ content: [{ type: 'text', text: 'should have been a task' }] }));
    s.registerPrompt('plan_week', { title: 'Plan my week', description: 'Turn open tasks into a weekly plan', argsSchema: z.object({ focus: z.string() }) }, async ({ focus }) => ({
      messages: [{ role: 'user', content: { type: 'text', text: `Plan my week around ${focus}, using my open tasks.` } }],
    }));
    s.registerResource('readme', 'fake://readme', { mimeType: 'text/plain', description: 'Read me' }, async () => ({ contents: [{ uri: 'fake://readme', text: 'Hello from the fake server' }] }));
    return s;
  });

  const taskView = (t: FakeTask, resultType: 'task' | 'complete') => {
    const o: Record<string, unknown> = { resultType, taskId: t.taskId, status: t.status, createdAt: '2026-11-01T09:00:00Z', lastUpdatedAt: '2026-11-01T09:00:00Z', ttlMs: 3_600_000, pollIntervalMs: 10 };
    if (t.status === 'input_required') o.inputRequests = { confirm: { method: 'elicitation/create', params: { mode: 'form', message: 'Include attachments?', requestedSchema: { type: 'object', properties: { attachments: { type: 'boolean' } }, required: ['attachments'] } } } };
    if (t.status === 'completed') o.result = { content: [{ type: 'text', text: `Exported as ${String(t.args.format)}${t.answers ? ` (attachments: ${JSON.stringify((t.answers.confirm as { content?: unknown })?.content)})` : ''}` }], isError: false };
    return o;
  };

  const authorized = (req: Request) => {
    const h = req.headers.get('authorization') ?? '';
    if (opts.bearer) return h === `Bearer ${opts.bearer}`;
    if (opts.oauth) return state.accessTokens.has(h.replace(/^Bearer /, ''));
    return true;
  };

  async function oauthEndpoint(req: Request, url: URL): Promise<Response | null> {
    if (url.pathname === '/.well-known/oauth-protected-resource/mcp' || url.pathname === '/.well-known/oauth-protected-resource') {
      return json({ resource: base, authorization_servers: [origin], scopes_supported: ['tasks:read', 'tasks:write'], bearer_methods_supported: ['header'] });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server' || url.pathname === '/.well-known/openid-configuration') {
      return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'], code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['none'], scopes_supported: ['tasks:read', 'tasks:write'] });
    }
    if (url.pathname === '/register' && req.method === 'POST') {
      const body = (await req.json()) as { redirect_uris: string[]; application_type?: string };
      const id = `client-${state.clients.size + 1}`;
      state.clients.set(id, { redirect_uris: body.redirect_uris });
      return json({ ...body, client_id: id, client_id_issued_at: 1 }, 201);
    }
    if (url.pathname === '/token' && req.method === 'POST') {
      const p = new URLSearchParams(await req.text());
      const issue = () => {
        const n = ++state.issued;
        state.accessTokens.add(`at-${n}`);
        state.refreshTokens.add(`rt-${n}`);
        return json({ access_token: `at-${n}`, token_type: 'Bearer', expires_in: 3600, refresh_token: `rt-${n}`, scope: 'tasks:read tasks:write' });
      };
      if (p.get('grant_type') === 'authorization_code') {
        const c = state.codes.get(p.get('code') ?? '');
        if (!c) return json({ error: 'invalid_grant' }, 400);
        if (c.clientId !== p.get('client_id') || c.redirectUri !== p.get('redirect_uri')) return json({ error: 'invalid_grant', error_description: 'client/redirect mismatch' }, 400);
        if ((await sha256b64url(p.get('code_verifier') ?? '')) !== c.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE verification failed' }, 400);
        state.codes.delete(p.get('code')!);
        return issue();
      }
      if (p.get('grant_type') === 'refresh_token') {
        if (!state.refreshTokens.delete(p.get('refresh_token') ?? '')) return json({ error: 'invalid_grant' }, 400);
        return issue();
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    return null;
  }

  /** What the user's browser does at the authorization endpoint: consent and redirect back. */
  function approve(authorizeUrl: URL): URL {
    const q = authorizeUrl.searchParams;
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) throw new Error('PKCE missing');
    const clientId = q.get('client_id')!;
    const redirectUri = q.get('redirect_uri')!;
    if (!state.clients.get(clientId)?.redirect_uris.includes(redirectUri)) throw new Error('unregistered redirect_uri');
    const code = `code-${state.codes.size + 1}-${Math.random().toString(36).slice(2)}`;
    state.codes.set(code, { challenge: q.get('code_challenge')!, clientId, redirectUri, resource: q.get('resource') ?? undefined });
    const back = new URL(redirectUri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.get('state') ?? '');
    back.searchParams.set('iss', origin);
    return back;
  }

  async function fetchFn(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const req = input instanceof Request ? input : new Request(input, init);
    const url = new URL(req.url);
    if (init?.mode === 'no-cors') return new Response(null, { status: 200 });
    if (opts.oauth) {
      const r = await oauthEndpoint(req, url);
      if (r) return r;
    }
    if (url.origin + url.pathname !== base.replace(/\/$/, '') && url.href !== base) return new Response('not found', { status: 404 });
    const headers = Object.fromEntries(req.headers);
    const text = req.method === 'POST' ? await req.clone().text() : '';
    let rpc: { id?: number | string; method?: string; params?: Record<string, any> } = {};
    try { rpc = text ? JSON.parse(text) : {}; } catch { /* not json */ }
    state.requests.push({ method: req.method, rpc: rpc.method, headers });
    if (!authorized(req)) {
      const md = `${origin}/.well-known/oauth-protected-resource/mcp`;
      return new Response('unauthorized', { status: 401, headers: { 'www-authenticate': opts.oauth ? `Bearer resource_metadata="${md}", scope="tasks:read tasks:write"` : 'Bearer' } });
    }
    if (opts.legacyOnly && rpc.method === 'server/discover') return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32601, message: 'Method not found' } }, 200);
    const modern = !!rpc.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
    const supportsTasks = !!rpc.params?._meta?.['io.modelcontextprotocol/clientCapabilities']?.extensions?.['io.modelcontextprotocol/tasks'];
    if (rpc.method === 'server/discover') {
      const res = await handler.fetch(req);
      const body = await res.json() as { result?: { capabilities?: Record<string, any> } };
      if (body.result?.capabilities) body.result.capabilities.extensions = { ...body.result.capabilities.extensions, 'io.modelcontextprotocol/tasks': {} };
      return json(body, res.status);
    }
    if (rpc.method === 'tools/call' && rpc.params?.name === 'export_notes' && modern && supportsTasks) {
      const t: FakeTask = { taskId: `task-${state.tasks.size + 1}`, status: opts.taskNeedsInput ? 'input_required' : 'working', polls: 0, doneAfter: opts.taskPolls ?? 2, args: rpc.params.arguments ?? {} };
      state.tasks.set(t.taskId, t);
      // Stream it as SSE, like servers that upgrade the response.
      const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: taskView(t, 'task') })}\n\n`;
      return new Response(event, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    if (rpc.method === 'tasks/get' || rpc.method === 'tasks/cancel' || rpc.method === 'tasks/update') {
      const t = state.tasks.get(rpc.params?.taskId);
      if (!t) return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message: 'Unknown task' } });
      if (headers['mcp-name'] !== t.taskId) return json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32020, message: 'Mcp-Name header must be the task id' } });
      if (rpc.method === 'tasks/cancel') {
        if (t.status === 'working' || t.status === 'input_required') t.status = 'cancelled';
        return json({ jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete' } });
      }
      if (rpc.method === 'tasks/update') {
        t.answers = rpc.params?.inputResponses;
        if (t.status === 'input_required') t.status = 'working';
        return json({ jsonrpc: '2.0', id: rpc.id, result: { resultType: 'complete' } });
      }
      if (t.status === 'working' && ++t.polls >= t.doneAfter) t.status = 'completed';
      return json({ jsonrpc: '2.0', id: rpc.id, result: taskView(t, 'complete') });
    }
    return handler.fetch(req);
  }

  return { url: base, fetch: fetchFn, state, approve };
}
