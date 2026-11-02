/**
 * "Connect your apps": remote MCP servers over Streamable HTTP, used by the assistant alongside
 * the note tools. Built on the official MCP TypeScript SDK v2 (`@modelcontextprotocol/client`,
 * protocol 2026-07-28 with automatic fallback to 2025-era servers).
 *
 * - `McpServerConfig` is what the user configures (URL, sign-in method, per-tool on/off and
 *   "ask before running"); it holds no secrets.
 * - `McpConnection` is a live connection: discovery, tools/resources/prompts, tool calls,
 *   Tasks (poll / answer / cancel) and sign-in completion.
 * - `createMcpAgentTools` turns enabled tools into `AgentTool`s; tools that change things ask
 *   first unless the user turned that off.
 */
import {
  Client,
  InsufficientScopeError,
  OAuthError,
  ProtocolError,
  SdkError,
  SdkErrorCode,
  StreamableHTTPClientTransport,
  UnauthorizedError,
  type AuthProvider,
  type CallToolResult,
  type ElicitRequestFormParams,
  type ElicitResult,
  type GetPromptResult,
  type OAuthClientProvider,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type Tool,
} from '@modelcontextprotocol/client';
import { richResult, type AgentTool } from '../agent.ts';
import type { ContentPart, FetchLike, JsonSchema } from '../types.ts';
import { TASKS_EXTENSION, isTerminal, taskAwareFetch, taskFromResult, taskOfToolResult, type McpTask } from './tasks.ts';

// ---- Configuration ---------------------------------------------------------------------------

export interface McpToolSettings {
  enabled: boolean;
  /** Ask the user before each call. */
  ask: boolean;
}

export type McpAuthMethod = 'none' | 'oauth' | 'bearer';

export interface McpServerConfig {
  /** Local id (namespaces secrets). */
  id: string;
  name: string;
  url: string;
  auth: McpAuthMethod;
  enabled: boolean;
  /** Per-tool choices; tools not listed use `defaultToolSettings`. */
  tools: Record<string, McpToolSettings>;
  addedAt: number;
}

/**
 * Defaults per the MCP tool annotations: every tool is on; a tool asks first unless the server
 * declares it read-only (`readOnlyHint`), since unannotated tools may change things.
 */
export function defaultToolSettings(tool: Pick<Tool, 'annotations'>): McpToolSettings {
  return { enabled: true, ask: tool.annotations?.readOnlyHint !== true };
}

export function toolSettings(cfg: Pick<McpServerConfig, 'tools'>, tool: Pick<Tool, 'name' | 'annotations'>): McpToolSettings {
  return cfg.tools[tool.name] ?? defaultToolSettings(tool);
}

/** Validates and normalizes a server URL: https, or http only for this computer / the LAN. */
export function normalizeServerUrl(input: string): string {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    throw new Error('Enter the server’s full address, starting with https://');
  }
  const local = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|[^.]+\.local)$/.test(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('MCP servers must use https:// (http:// only works for servers on this computer or network).');
  if (u.username || u.password) throw new Error('Don’t put passwords in the address; use a token instead.');
  u.hash = '';
  return u.toString();
}

/** A short readable name from a URL ("mcp.notion.com/mcp" → "Notion"). */
export function nameFromUrl(url: string): string {
  try {
    const host = new URL(url).hostname.replace(/^(mcp|api|www|ai)\./, '');
    const base = host.split('.').slice(-2, -1)[0] ?? host;
    return base.charAt(0).toUpperCase() + base.slice(1);
  } catch {
    return 'MCP server';
  }
}

/** Agent-visible tool name: `<server>__<tool>`, within `^[a-zA-Z0-9_-]{1,64}$`, unique in `taken`. */
export function agentToolName(serverName: string, toolName: string, taken: Set<string>): string {
  const slug = serverName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16) || 'app';
  const tool = toolName.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'tool';
  let name = `${slug}__${tool}`.slice(0, 64);
  for (let i = 2; taken.has(name); i++) name = `${`${slug}__${tool}`.slice(0, 60)}_${i}`;
  taken.add(name);
  return name;
}

// ---- Errors -----------------------------------------------------------------------------------

export type McpErrorKind = 'cors' | 'network' | 'auth' | 'scope' | 'http' | 'protocol' | 'other';

export class McpConnectionError extends Error {
  constructor(readonly kind: McpErrorKind, message: string, readonly status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'McpConnectionError';
  }
}

const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };

function statusOf(e: unknown): number | undefined {
  const d = (e as { data?: { status?: number }; status?: number })?.data?.status ?? (e as { status?: number })?.status;
  if (typeof d === 'number') return d;
  const m = /\b(4\d\d|5\d\d)\b/.exec(String((e as Error)?.message ?? ''));
  return m ? Number(m[1]) : undefined;
}

/**
 * Turns SDK and fetch failures into plain-language errors. A `TypeError` from fetch means the
 * browser blocked or couldn't make the request; `probe` distinguishes "server unreachable" from
 * "server refuses web apps (CORS)" with an opaque no-cors request, which succeeds in the latter case.
 */
export async function explainMcpError(e: unknown, url: string, probe?: (url: string) => Promise<boolean>): Promise<McpConnectionError> {
  if (e instanceof McpConnectionError) return e;
  if (UnauthorizedError.isInstance(e)) return new McpConnectionError('auth', `Sign in to ${host(url)} to use it.`, 401, { cause: e });
  if (e instanceof InsufficientScopeError) return new McpConnectionError('scope', `${host(url)} needs more permissions${e.requiredScope ? ` (${e.requiredScope})` : ''}. Sign in again to grant them.`, 403, { cause: e });
  if (e instanceof OAuthError) return new McpConnectionError('auth', `Sign-in with ${host(url)} failed: ${e.message}`, undefined, { cause: e });
  if (isFetchFailure(e)) {
    const reachable = probe ? await probe(url).catch(() => false) : false;
    return reachable
      ? new McpConnectionError('cors', `${host(url)} answered, but it doesn’t allow web apps to connect to it (the browser blocked the response: CORS). This is a setting on that server — ask its provider to allow browser clients, or use a server that does.`, undefined, { cause: e })
      : new McpConnectionError('network', `Couldn’t reach ${host(url)}. Check the address and your connection. If they’re right, the server may not allow web apps to connect (CORS).`, undefined, { cause: e });
  }
  const status = statusOf(e);
  if (status === 401) return new McpConnectionError('auth', `${host(url)} needs you to sign in.`, 401, { cause: e });
  if (status === 403) return new McpConnectionError('auth', `${host(url)} refused access (403). Check the token’s permissions.`, 403, { cause: e });
  if (status === 404 || status === 405) return new McpConnectionError('http', `There’s no MCP server at this address (${status}). Check the URL — it often ends in /mcp.`, status, { cause: e });
  if (status && status >= 500) return new McpConnectionError('http', `${host(url)} had a problem (${status}). Try again later.`, status, { cause: e });
  if (e instanceof ProtocolError) return new McpConnectionError('protocol', `${host(url)} reported an error: ${e.message}`, undefined, { cause: e });
  if (e instanceof SdkError) {
    // Negotiation and validation failures carry schema dumps; say what they mean instead.
    const garbled = e.code === SdkErrorCode.EraNegotiationFailed || e.code === SdkErrorCode.InvalidResult || e.message.length > 200;
    return new McpConnectionError('protocol', garbled ? `${host(url)} didn’t answer like an MCP server. Check the address — it often ends in /mcp.` : `Couldn’t talk to ${host(url)}: ${e.message}`, status, { cause: e });
  }
  return new McpConnectionError('other', (e as Error)?.message ?? String(e), status, { cause: e });
}

const FETCH_FAILED = /failed to fetch|networkerror|load failed|fetch failed|network request failed/i;

/**
 * Whether the browser's fetch itself failed (blocked by CORS, offline, DNS). The SDK wraps such
 * failures (negotiation probe, transport) in its own errors, so the cause chain is searched.
 */
export function isFetchFailure(e: unknown, depth = 0): boolean {
  if (!e || depth > 5) return false;
  if (Array.isArray(e)) return e.some((x) => isFetchFailure(x, depth + 1));
  if (typeof e !== 'object') return false;
  const o = e as { name?: string; message?: string; cause?: unknown; errors?: unknown; data?: { cause?: unknown } };
  if (e instanceof TypeError || o.name === 'TypeError') return true;
  if (UnauthorizedError.isInstance(e) || e instanceof OAuthError || statusOf(e)) return false;
  if (typeof o.message === 'string' && FETCH_FAILED.test(o.message)) return true;
  return isFetchFailure(o.cause, depth + 1) || isFetchFailure(o.errors, depth + 1) || isFetchFailure(o.data?.cause, depth + 1);
}

/** A no-cors request: resolves true when the server answered at all (opaque response). */
export function corsProbe(fetchFn: FetchLike = (i, init) => globalThis.fetch(i, init)): (url: string) => Promise<boolean> {
  return async (url) => {
    try {
      await fetchFn(url, { method: 'GET', mode: 'no-cors', cache: 'no-store', credentials: 'omit' });
      return true;
    } catch {
      return false;
    }
  };
}

// ---- Connection -------------------------------------------------------------------------------

export type McpStatus = 'idle' | 'connecting' | 'connected' | 'needs-auth' | 'error';

/** Answer to an elicitation (a server asking the user for input or approval mid-call). */
export type ElicitHandler = (req: { server: string; message: string; schema?: ElicitRequestFormParams['requestedSchema'] }) => Promise<ElicitResult>;

export interface McpConnectionOptions {
  auth?: OAuthClientProvider | AuthProvider;
  fetch?: FetchLike;
  clientInfo?: { name: string; version: string; title?: string };
  /** Server asks for input/approval during a call (form elicitation). Default: decline. */
  onElicit?: ElicitHandler;
  /** Request timeout (ms). */
  timeoutMs?: number;
}

export interface McpServerInfo {
  name?: string;
  version?: string;
  title?: string;
  protocolVersion?: string;
  instructions?: string;
  supportsTasks: boolean;
}

export type McpCallOutcome = { kind: 'result'; result: CallToolResult } | { kind: 'task'; task: McpTask };

/** Accepts any value: task results are validated by `taskFromResult`. */
const passthrough = { '~standard': { version: 1 as const, vendor: 'inkwright', validate: (value: unknown) => ({ value }) } };

export class McpConnection {
  status: McpStatus = 'idle';
  error: McpConnectionError | null = null;
  tools: Tool[] = [];
  resources: Resource[] = [];
  prompts: Prompt[] = [];
  info: McpServerInfo | null = null;
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private fetchFn: FetchLike;

  constructor(readonly config: McpServerConfig, private opts: McpConnectionOptions = {}) {
    const base = opts.fetch ?? ((i: string, init?: RequestInit) => globalThis.fetch(i, init));
    this.fetchFn = taskAwareFetch(base);
  }

  private newTransport(): StreamableHTTPClientTransport {
    return new StreamableHTTPClientTransport(new URL(this.config.url), {
      ...(this.opts.auth ? { authProvider: this.opts.auth } : {}),
      fetch: this.fetchFn as never,
    });
  }

  /** Connects (negotiating 2026-07-28 or falling back) and loads tools, resources and prompts. */
  async connect(): Promise<void> {
    await this.close();
    this.status = 'connecting';
    this.error = null;
    const client = new Client(
      { name: this.opts.clientInfo?.name ?? 'inkwright', version: this.opts.clientInfo?.version ?? '1.0.0', ...(this.opts.clientInfo?.title ? { title: this.opts.clientInfo.title } : {}) },
      {
        versionNegotiation: { mode: 'auto' },
        capabilities: { elicitation: { form: {} }, extensions: { [TASKS_EXTENSION]: {} } } as never,
      },
    );
    client.setRequestHandler('elicitation/create', async (req) => {
      const p = req.params as ElicitRequestFormParams & { mode?: string };
      if (p.mode && p.mode !== 'form') return { action: 'decline' };
      return this.opts.onElicit ? this.opts.onElicit({ server: this.config.name, message: p.message, schema: p.requestedSchema }) : { action: 'decline' };
    });
    const transport = this.newTransport();
    try {
      await client.connect(transport, { timeout: this.opts.timeoutMs ?? 30_000 });
      this.client = client;
      this.transport = transport;
      const caps = client.getServerCapabilities() ?? {};
      const v = client.getServerVersion();
      this.info = {
        name: v?.name,
        version: v?.version,
        title: (v as { title?: string } | undefined)?.title,
        protocolVersion: client.getNegotiatedProtocolVersion(),
        instructions: client.getInstructions(),
        supportsTasks: !!(caps as { extensions?: Record<string, unknown> }).extensions?.[TASKS_EXTENSION],
      };
      await this.refresh();
      this.status = 'connected';
    } catch (e) {
      await transport.close().catch(() => {});
      this.error = await explainMcpError(e, this.config.url, corsProbe(this.opts.fetch));
      this.status = this.error.kind === 'auth' || this.error.kind === 'scope' ? 'needs-auth' : 'error';
      throw this.error;
    }
  }

  /** Re-reads the tool, resource and prompt lists. */
  async refresh(): Promise<void> {
    const c = this.requireClient();
    const caps = c.getServerCapabilities() ?? {};
    this.tools = caps.tools ? (await c.listTools()).tools : [];
    this.resources = caps.resources ? await c.listResources().then((r) => r.resources, () => []) : [];
    this.prompts = caps.prompts ? await c.listPrompts().then((r) => r.prompts, () => []) : [];
  }

  private requireClient(): Client {
    if (!this.client) throw new McpConnectionError('other', `${this.config.name} is not connected.`);
    return this.client;
  }

  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      const err = await explainMcpError(e, this.config.url, corsProbe(this.opts.fetch));
      if (err.kind === 'auth' || err.kind === 'scope') {
        this.status = 'needs-auth';
        this.error = err;
      }
      throw err;
    }
  }

  /** Calls a tool; the server may answer with a background task instead of a result. */
  async callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpCallOutcome> {
    const c = this.requireClient();
    const tool = this.tools.find((t) => t.name === name);
    const result = await this.guard(() => c.callTool({ name, arguments: args }, { signal, timeout: this.opts.timeoutMs ?? 120_000, ...(tool ? { toolDefinition: tool } : {}) }));
    const task = taskOfToolResult(result as { _meta?: Record<string, unknown> });
    return task ? { kind: 'task', task } : { kind: 'result', result };
  }

  /** `tasks/get`: the task's current state (with its result once completed). */
  async getTask(taskId: string, signal?: AbortSignal): Promise<McpTask> {
    const c = this.requireClient();
    const r = await this.guard(() => c.request({ method: 'tasks/get', params: { taskId } } as never, passthrough as never, { signal, headers: { 'Mcp-Name': taskId } } as never));
    const t = taskFromResult(r as Record<string, unknown>);
    if (!t) throw new McpConnectionError('protocol', `${this.config.name} returned an unreadable task.`);
    return t;
  }

  /** `tasks/update`: answers a task's input requests (keyed like `inputRequests`). */
  async updateTask(taskId: string, inputResponses: Record<string, unknown>): Promise<void> {
    const c = this.requireClient();
    await this.guard(() => c.request({ method: 'tasks/update', params: { taskId, inputResponses } } as never, passthrough as never, { headers: { 'Mcp-Name': taskId } } as never));
  }

  /** `tasks/cancel`: asks the server to stop (cooperative; it may still finish). */
  async cancelTask(taskId: string): Promise<void> {
    const c = this.requireClient();
    await this.guard(() => c.request({ method: 'tasks/cancel', params: { taskId } } as never, passthrough as never, { headers: { 'Mcp-Name': taskId } } as never));
  }

  async readResource(uri: string): Promise<ReadResourceResult> {
    const c = this.requireClient();
    return this.guard(() => c.readResource({ uri }));
  }

  async getPrompt(name: string, args: Record<string, string> = {}): Promise<GetPromptResult> {
    const c = this.requireClient();
    return this.guard(() => c.getPrompt({ name, arguments: args }));
  }

  /** Completes an OAuth sign-in with the redirect's query parameters (`code`, `state`, `iss`). */
  async finishAuth(params: URLSearchParams): Promise<void> {
    if (!this.opts.auth || !('redirectToAuthorization' in this.opts.auth)) throw new McpConnectionError('auth', 'This connection does not use OAuth.');
    const t = this.newTransport();
    try {
      await t.finishAuth(params);
    } catch (e) {
      throw await explainMcpError(e, this.config.url);
    } finally {
      await t.close().catch(() => {});
    }
  }

  async close(): Promise<void> {
    const c = this.client;
    this.client = null;
    this.transport = null;
    if (c) await c.close().catch(() => {});
    if (this.status === 'connected') this.status = 'idle';
  }
}

// ---- Results ---------------------------------------------------------------------------------

/** MCP content → what the model sees: text joined, images kept for vision models. */
export function mcpResultParts(r: CallToolResult, opts: { images?: boolean; maxChars?: number } = {}): { text: string; parts: ContentPart[] } {
  const texts: string[] = [];
  const images: ContentPart[] = [];
  for (const c of r.content ?? []) {
    if (c.type === 'text') texts.push(c.text);
    else if (c.type === 'image' && opts.images !== false) images.push({ type: 'image', mediaType: c.mimeType, data: c.data });
    else if (c.type === 'image') texts.push('[image omitted: this model cannot see images]');
    else if (c.type === 'resource_link') texts.push(`[${c.name}](${c.uri})${c.description ? ` — ${c.description}` : ''}`);
    else if (c.type === 'resource') {
      const res = c.resource as { uri: string; text?: string; mimeType?: string };
      texts.push(res.text != null ? `Resource ${res.uri}:\n${res.text}` : `[binary resource ${res.uri}${res.mimeType ? ` (${res.mimeType})` : ''}]`);
    } else if (c.type === 'audio') texts.push('[audio omitted]');
  }
  if (!texts.length && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent));
  let text = texts.join('\n\n') || (r.isError ? 'The tool failed without a message.' : 'Done.');
  const max = opts.maxChars ?? 24_000;
  if (text.length > max) text = `${text.slice(0, max)}\n…[truncated]`;
  return { text, parts: images.length ? [{ type: 'text', text }, ...images] : [{ type: 'text', text }] };
}

// ---- Agent tools -------------------------------------------------------------------------------

export interface McpToolSource {
  connection: Pick<McpConnection, 'callTool' | 'getTask' | 'config' | 'tools'> & Partial<Pick<McpConnection, 'resources' | 'readResource'>>;
  /** Restrict to these tool names (routines pick tools per server). */
  only?: readonly string[];
}

export interface McpAgentToolsOptions {
  vision?: boolean;
  /** A task was started by a tool call (the app tracks and shows it). */
  onTask?: (task: McpTask, ctx: { serverId: string; serverName: string; tool: string }) => void;
  /** A tool that may change things ran successfully (activity log). */
  onExternalChange?: (info: { serverName: string; tool: string; args: Record<string, unknown>; summary: string }) => void;
  /** Force "ask before running" on for every tool that may change things (background routines). */
  alwaysAskForWrites?: boolean;
}

function cleanSchema(s: unknown): JsonSchema {
  const o = s && typeof s === 'object' ? { ...(s as Record<string, unknown>) } : {};
  delete o.$schema;
  if (o.type !== 'object') return { type: 'object', properties: {}, additionalProperties: true };
  if (!o.properties) o.properties = {};
  return o;
}

/** Wraps every enabled tool of the given connections as AgentTools (plus a task-status tool). */
export function createMcpAgentTools(sources: readonly McpToolSource[], opts: McpAgentToolsOptions = {}): AgentTool[] {
  const taken = new Set<string>();
  const out: AgentTool[] = [];
  const taskOwners = new Map<string, McpToolSource>();
  for (const src of sources) {
    const cfg = src.connection.config;
    if (!cfg.enabled) continue;
    for (const tool of src.connection.tools) {
      const set = toolSettings(cfg, tool);
      if (!set.enabled || (src.only && !src.only.includes(tool.name))) continue;
      const readOnly = tool.annotations?.readOnlyHint === true;
      const ask = set.ask || (!!opts.alwaysAskForWrites && !readOnly);
      const name = agentToolName(cfg.name, tool.name, taken);
      const title = tool.title ?? tool.annotations?.title ?? tool.name;
      out.push({
        name,
        description: `[${cfg.name}] ${title}${tool.description ? `: ${tool.description}` : ''}`.slice(0, 1024),
        parameters: cleanSchema(tool.inputSchema),
        destructive: ask,
        readOnly,
        async execute(args: Record<string, unknown>, ctx) {
          const outcome = await src.connection.callTool(tool.name, args, ctx.signal);
          if (outcome.kind === 'task') {
            taskOwners.set(outcome.task.taskId, src);
            opts.onTask?.(outcome.task, { serverId: cfg.id, serverName: cfg.name, tool: tool.name });
            if (!readOnly) opts.onExternalChange?.({ serverName: cfg.name, tool: tool.name, args, summary: `Started “${title}” in ${cfg.name} (background task)` });
            return { background_task: { task_id: outcome.task.taskId, status: outcome.task.status, message: outcome.task.statusMessage }, note: 'This runs in the background. The user sees its progress in the app; call check_background_task later for the result.' };
          }
          const r = outcome.result;
          const { text, parts } = mcpResultParts(r, { images: opts.vision });
          if (r.isError) throw new Error(text);
          if (!readOnly) opts.onExternalChange?.({ serverName: cfg.name, tool: tool.name, args, summary: `Used “${title}” in ${cfg.name}` });
          return parts.length > 1 ? richResult(parts) : text;
        },
      });
    }
    // Resources (files, documents the server exposes): one read-only tool listing what exists.
    const resources = src.connection.resources ?? [];
    const read = src.connection.readResource;
    if (resources.length && read && !src.only) {
      const listed = resources.slice(0, 25).map((r) => `- ${r.uri}${r.name && r.name !== r.uri ? ` (${r.name})` : ''}${r.description ? `: ${r.description.slice(0, 100)}` : ''}`);
      out.push({
        name: agentToolName(cfg.name, 'read_resource', taken),
        description: `[${cfg.name}] Read a resource (document or data) this app shares, by URI.${resources.length > 25 ? ` ${resources.length} resources; some are:` : ' Available:'}\n${listed.join('\n')}`.slice(0, 2000),
        parameters: { type: 'object', properties: { uri: { type: 'string', description: 'The resource URI.' } }, required: ['uri'], additionalProperties: false },
        readOnly: true,
        async execute(a: { uri: string }) {
          const r = await read.call(src.connection, a.uri);
          const parts = (r.contents ?? []).map((c) => ('text' in c && typeof c.text === 'string' ? c.text : `[binary ${c.uri}${c.mimeType ? ` (${c.mimeType})` : ''} not shown]`));
          const text = parts.join('\n\n') || '(empty)';
          return text.length > 24_000 ? `${text.slice(0, 24_000)}\n…[truncated]` : text;
        },
      });
    }
  }
  if (out.length) {
    out.push({
      name: 'check_background_task',
      description: 'Check a background task a connected app started (from a tool result with background_task). Returns its status, and its result once completed.',
      parameters: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'], additionalProperties: false },
      readOnly: true,
      async execute(a: { task_id: string }) {
        const src = taskOwners.get(a.task_id) ?? sources.find((s) => s.connection.config.enabled);
        if (!src) throw new Error('No connected app owns that task.');
        const t = await src.connection.getTask(a.task_id);
        const o: Record<string, unknown> = { task_id: t.taskId, status: t.status };
        if (t.statusMessage) o.message = t.statusMessage;
        if (t.status === 'completed' && t.result) o.result = mcpResultParts(t.result as CallToolResult, { images: false }).text;
        if (t.status === 'failed') o.error = t.error?.message ?? 'failed';
        if (t.status === 'input_required') o.note = 'Waiting for the user to answer in the app.';
        if (!isTerminal(t.status)) o.hint = 'Still running; tell the user it continues in the background.';
        return o;
      },
    });
  }
  return out;
}

export { taskFromResult };
