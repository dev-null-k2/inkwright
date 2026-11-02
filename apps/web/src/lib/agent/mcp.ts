/**
 * Connected apps (remote MCP servers) on this device. Server settings are kept in local storage
 * (they are per device: sign-ins don't sync); tokens and client registrations live in the
 * encrypted secret store. Background tasks started by connected apps are tracked here and polled
 * while the app is open; their ids are persisted so polling resumes after a reload.
 */
import { create } from 'zustand';
import {
  McpConnection,
  McpOAuthProvider,
  createMcpAgentTools,
  forgetMcpSecrets,
  isTerminal,
  mcpBearerSecret,
  mcpResultParts,
  nameFromUrl,
  normalizeServerUrl,
  parseOAuthCallback,
  type AgentTool,
  type ElicitHandler,
  type McpAgentToolsOptions,
  type McpAuthMethod,
  type McpServerConfig,
  type McpServerInfo,
  type McpStatus,
  type McpTask,
  type McpToolSettings,
} from '@inkstone/ai';
import { newId } from '@inkstone/core';
import { APP_VERSION, safeStorage } from '../../platform/env.ts';
import { getSecret, secrets, setSecret } from '../secrets.ts';
import { requestElicitation } from './hub.ts';

const KEY = 'inkstone.mcp.v1';
const TASKS_KEY = 'inkstone.mcp.tasks.v1';
export const OAUTH_CHANNEL = 'inkstone-mcp-oauth';
export const OAUTH_CALLBACK_KEY = 'inkstone.mcp.oauth-callback';

export interface McpRuntime {
  status: McpStatus;
  error?: string;
  errorKind?: string;
  info?: McpServerInfo;
  tools: Array<{ name: string; title?: string; description?: string; readOnly: boolean; destructive: boolean }>;
  /** A sign-in that needs a click to open (popups need a user gesture). */
  pendingAuthUrl?: string;
}

export interface TrackedTask {
  serverId: string;
  serverName: string;
  tool: string;
  task: McpTask;
  startedAt: number;
  /** Plain text of the final result, once completed. */
  resultText?: string;
  /** Last poll failed with this error. */
  pollError?: string;
}

interface McpState {
  servers: McpServerConfig[];
  runtime: Record<string, McpRuntime>;
  tasks: TrackedTask[];
}

function load(): { servers: McpServerConfig[]; tasks: TrackedTask[] } {
  try {
    const s = JSON.parse(safeStorage.get(KEY) ?? '[]');
    const t = JSON.parse(safeStorage.get(TASKS_KEY) ?? '[]');
    return { servers: Array.isArray(s) ? s : [], tasks: Array.isArray(t) ? t : [] };
  } catch {
    return { servers: [], tasks: [] };
  }
}

export const useMcp = create<McpState>(() => ({ ...load(), runtime: {} }));

const persist = () => {
  const s = useMcp.getState();
  safeStorage.set(KEY, JSON.stringify(s.servers));
  // Keep running tasks and the last finished ones.
  const keep = [...s.tasks.filter((t) => !isTerminal(t.task.status)), ...s.tasks.filter((t) => isTerminal(t.task.status)).slice(-20)];
  safeStorage.set(TASKS_KEY, JSON.stringify(keep));
};

const connections = new Map<string, McpConnection>();
let popup: Window | null = null;

/** Where the authorization server sends the browser back: this app's own address. */
export function oauthRedirectUrl(): string {
  return `${location.origin}${location.pathname}`;
}

function setRuntime(id: string, patch: Partial<McpRuntime>) {
  useMcp.setState((s) => ({ runtime: { ...s.runtime, [id]: { ...{ status: 'idle' as McpStatus, tools: [] }, ...s.runtime[id], ...patch } } }));
}

function runtimeFrom(c: McpConnection): Partial<McpRuntime> {
  return {
    status: c.status,
    error: c.error?.message,
    errorKind: c.error?.kind,
    info: c.info ?? undefined,
    tools: c.tools.map((t) => ({ name: t.name, title: t.title ?? t.annotations?.title, description: t.description, readOnly: t.annotations?.readOnlyHint === true, destructive: t.annotations?.destructiveHint !== false && t.annotations?.readOnlyHint !== true })),
  };
}

function config(id: string): McpServerConfig | undefined {
  return useMcp.getState().servers.find((s) => s.id === id);
}

function updateConfig(id: string, fn: (c: McpServerConfig) => McpServerConfig) {
  useMcp.setState((s) => ({ servers: s.servers.map((c) => (c.id === id ? fn(c) : c)) }));
  persist();
  const conn = connections.get(id);
  const next = config(id);
  if (conn && next) Object.assign(conn.config, next);
}

function oauthProvider(cfg: McpServerConfig): McpOAuthProvider {
  return new McpOAuthProvider({
    serverId: cfg.id,
    secrets: secrets(),
    redirectUrl: oauthRedirectUrl(),
    clientName: 'Inkstone',
    clientUri: 'https://inkstone.app',
    clientMetadataUrl: (import.meta.env?.VITE_MCP_CLIENT_METADATA_URL as string | undefined) || undefined,
    onRedirect: (url) => {
      if (popup && !popup.closed) {
        popup.location.href = url.toString();
      } else {
        // No window to show it in (sign-in was needed in the background): wait for a click.
        setRuntime(cfg.id, { status: 'needs-auth', pendingAuthUrl: url.toString() });
      }
    },
  });
}

function newConnection(cfg: McpServerConfig): McpConnection {
  const auth = cfg.auth === 'oauth' ? oauthProvider(cfg) : cfg.auth === 'bearer' ? { token: async () => (await getSecret(mcpBearerSecret(cfg.id))) ?? undefined } : undefined;
  const c = new McpConnection({ ...cfg }, {
    auth,
    clientInfo: { name: 'inkstone', title: 'Inkstone', version: APP_VERSION },
    onElicit: async (req) => (await requestElicitation({ server: req.server, message: req.message, schema: req.schema as never })) as Awaited<ReturnType<ElicitHandler>>,
  });
  connections.set(cfg.id, c);
  return c;
}

/** Connects (or reconnects) one server and updates its runtime state. Never throws. */
export async function connectServer(id: string): Promise<McpConnection | null> {
  const cfg = config(id);
  if (!cfg) return null;
  const old = connections.get(id);
  if (old) await old.close();
  const c = newConnection(cfg);
  setRuntime(id, { status: 'connecting', error: undefined, errorKind: undefined });
  try {
    await c.connect();
    setRuntime(id, { ...runtimeFrom(c), pendingAuthUrl: undefined });
  } catch {
    setRuntime(id, runtimeFrom(c));
  }
  return c;
}

/** Adds a server and connects to it. Returns its id. */
export async function addServer(input: { url: string; name?: string; auth: McpAuthMethod; token?: string }): Promise<string> {
  const url = normalizeServerUrl(input.url);
  if (useMcp.getState().servers.some((s) => s.url === url)) throw new Error('That server is already connected.');
  const cfg: McpServerConfig = { id: newId(), name: (input.name?.trim() || nameFromUrl(url)).slice(0, 40), url, auth: input.auth, enabled: true, tools: {}, addedAt: Date.now() };
  if (input.auth === 'bearer') {
    if (!input.token?.trim()) throw new Error('Paste the token or API key for this server.');
    await setSecret(mcpBearerSecret(cfg.id), input.token.trim());
  }
  useMcp.setState((s) => ({ servers: [...s.servers, cfg] }));
  persist();
  if (input.auth === 'oauth') await signIn(cfg.id);
  else await connectServer(cfg.id);
  return cfg.id;
}

/**
 * Starts (or continues) an OAuth sign-in in a popup. Must be called from a click: the popup is
 * opened first, synchronously, then pointed at the authorization server once discovery is done.
 */
export async function signIn(id: string): Promise<void> {
  const rt = useMcp.getState().runtime[id];
  try {
    popup = window.open(rt?.pendingAuthUrl ?? 'about:blank', 'inkstone-mcp-signin', 'popup,width=520,height=720');
  } catch {
    popup = null;
  }
  if (rt?.pendingAuthUrl && popup) {
    setRuntime(id, { pendingAuthUrl: undefined });
    return;
  }
  const c = await connectServer(id);
  const after = useMcp.getState().runtime[id];
  if (c?.status === 'connected') { popup?.close(); popup = null; return; }
  if (after?.status === 'needs-auth' && after.pendingAuthUrl && !popup) {
    // Popups are blocked: sign in in this tab and come back.
    safeStorage.set('inkstone.mcp.return', location.hash);
    location.assign(after.pendingAuthUrl);
  } else if (after?.status !== 'needs-auth') {
    popup?.close();
    popup = null;
  }
}

/** Completes a sign-in from the redirect's query string (popup message or full-page return). */
const handledStates = new Set<string>();

export async function completeSignIn(search: string): Promise<{ ok: boolean; message?: string }> {
  const cb = parseOAuthCallback(search);
  if (!cb) return { ok: false, message: 'Not a sign-in response.' };
  // The popup reports through two channels (BroadcastChannel and postMessage): redeem once.
  const state = cb.params.get('state') ?? '';
  if (handledStates.has(state)) return { ok: true };
  handledStates.add(state);
  const cfg = config(cb.serverId);
  if (!cfg) return { ok: false, message: 'That connection was removed.' };
  if (cb.error) {
    setRuntime(cfg.id, { status: 'needs-auth', error: `Sign-in was not completed: ${cb.error}` });
    return { ok: false, message: cb.error };
  }
  const provider = oauthProvider(cfg);
  if ((await provider.expectedState()) !== cb.params.get('state')) {
    setRuntime(cfg.id, { status: 'needs-auth', error: 'That sign-in response didn’t match the one we started. Try again.' });
    return { ok: false, message: 'State mismatch.' };
  }
  const c = connections.get(cfg.id) ?? newConnection(cfg);
  try {
    await c.finishAuth(cb.params);
  } catch (e) {
    setRuntime(cfg.id, { status: 'needs-auth', error: (e as Error).message });
    return { ok: false, message: (e as Error).message };
  }
  await connectServer(cfg.id);
  popup = null;
  return { ok: useMcp.getState().runtime[cfg.id]?.status === 'connected' };
}

export async function removeServer(id: string): Promise<void> {
  await connections.get(id)?.close();
  connections.delete(id);
  await forgetMcpSecrets(secrets(), id).catch(() => {});
  useMcp.setState((s) => {
    const runtime = { ...s.runtime };
    delete runtime[id];
    return { servers: s.servers.filter((c) => c.id !== id), runtime, tasks: s.tasks.filter((t) => t.serverId !== id) };
  });
  persist();
}

export async function signOut(id: string): Promise<void> {
  await connections.get(id)?.close();
  await forgetMcpSecrets(secrets(), id).catch(() => {});
  setRuntime(id, { status: 'needs-auth', tools: [], error: undefined });
}

export function setServerEnabled(id: string, enabled: boolean) {
  updateConfig(id, (c) => ({ ...c, enabled }));
  if (enabled && connections.get(id)?.status !== 'connected') void connectServer(id);
}

export function renameServer(id: string, name: string) {
  if (name.trim()) updateConfig(id, (c) => ({ ...c, name: name.trim().slice(0, 40) }));
}

export function setToolSettings(id: string, tool: string, patch: Partial<McpToolSettings>, defaults: McpToolSettings) {
  updateConfig(id, (c) => ({ ...c, tools: { ...c.tools, [tool]: { ...defaults, ...c.tools[tool], ...patch } } }));
}

/** Connects every enabled server (on start) and resumes polling of background tasks. */
let started = false;

export async function startConnectedApps(): Promise<void> {
  if (started) return;
  started = true;
  if (typeof BroadcastChannel !== 'undefined') {
    const ch = new BroadcastChannel(OAUTH_CHANNEL);
    ch.onmessage = (e) => { if (typeof e.data?.search === 'string') void completeSignIn(e.data.search); };
  }
  window.addEventListener('message', (e) => {
    if (e.origin === location.origin && e.data?.type === OAUTH_CHANNEL && typeof e.data.search === 'string') void completeSignIn(e.data.search);
  });
  // Returning from a full-page sign-in (popups were blocked).
  const pending = safeStorage.get(OAUTH_CALLBACK_KEY);
  if (pending) {
    safeStorage.remove(OAUTH_CALLBACK_KEY);
    void completeSignIn(pending);
  }
  await Promise.all(useMcp.getState().servers.filter((s) => s.enabled).map((s) => connectServer(s.id)));
  for (const t of useMcp.getState().tasks) if (!isTerminal(t.task.status)) pollTask(t.serverId, t.task.taskId);
}

/** Agent tools for the given servers (all enabled ones when omitted). Connects on demand. */
export async function mcpAgentTools(opts: { serverIds?: readonly string[]; vision?: boolean; alwaysAskForWrites?: boolean; onExternalChange?: McpAgentToolsOptions['onExternalChange'] } = {}): Promise<AgentTool[]> {
  const servers = useMcp.getState().servers.filter((s) => s.enabled && (!opts.serverIds || opts.serverIds.includes(s.id)));
  const sources = [];
  for (const s of servers) {
    let c = connections.get(s.id);
    if (!c || c.status !== 'connected') c = (await connectServer(s.id)) ?? undefined;
    if (c?.status === 'connected') sources.push({ connection: c });
  }
  return createMcpAgentTools(sources, {
    vision: opts.vision,
    alwaysAskForWrites: opts.alwaysAskForWrites,
    onExternalChange: opts.onExternalChange,
    onTask: (task, ctx) => trackTask({ serverId: ctx.serverId, serverName: ctx.serverName, tool: ctx.tool, task, startedAt: Date.now() }),
  });
}

/** The agent-visible name → server/tool mapping (for friendly approval prompts). */
export function describeMcpToolName(name: string): { server: string; tool: string } | null {
  const i = name.indexOf('__');
  if (i < 0) return null;
  const slug = name.slice(0, i);
  const s = useMcp.getState().servers.find((x) => x.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 16) === slug);
  return s ? { server: s.name, tool: name.slice(i + 2) } : null;
}

// ---- Background tasks --------------------------------------------------------------------------

const polling = new Set<string>();

function updateTask(taskId: string, patch: Partial<TrackedTask>) {
  useMcp.setState((s) => ({ tasks: s.tasks.map((t) => (t.task.taskId === taskId ? { ...t, ...patch } : t)) }));
  persist();
}

export function trackTask(t: TrackedTask) {
  useMcp.setState((s) => ({ tasks: [...s.tasks.filter((x) => x.task.taskId !== t.task.taskId), t] }));
  persist();
  pollTask(t.serverId, t.task.taskId);
}

/** Polls a task at the server's suggested interval until it ends (or the app closes). */
function pollTask(serverId: string, taskId: string) {
  if (polling.has(taskId)) return;
  polling.add(taskId);
  const step = async () => {
    const tracked = useMcp.getState().tasks.find((t) => t.task.taskId === taskId);
    if (!tracked || isTerminal(tracked.task.status)) { polling.delete(taskId); return; }
    let c = connections.get(serverId);
    if (!c || c.status !== 'connected') c = (await connectServer(serverId)) ?? undefined;
    let interval = tracked.task.pollIntervalMs ?? 5000;
    if (c?.status === 'connected') {
      try {
        const task = await c.getTask(taskId);
        const patch: Partial<TrackedTask> = { task, pollError: undefined };
        if (task.status === 'completed' && task.result) patch.resultText = mcpResultParts(task.result as unknown as Parameters<typeof mcpResultParts>[0], { images: false }).text;
        updateTask(taskId, patch);
        interval = task.pollIntervalMs ?? interval;
        if (isTerminal(task.status)) { polling.delete(taskId); return; }
      } catch (e) {
        updateTask(taskId, { pollError: (e as Error).message });
        interval = Math.max(interval, 15_000);
      }
    } else interval = 30_000;
    setTimeout(() => void step(), Math.min(60_000, Math.max(1000, interval)));
  };
  void step();
}

export async function cancelTask(taskId: string): Promise<void> {
  const t = useMcp.getState().tasks.find((x) => x.task.taskId === taskId);
  const c = t && connections.get(t.serverId);
  if (!t || !c) return;
  await c.cancelTask(taskId);
  updateTask(taskId, { task: { ...t.task, status: 'cancelled', statusMessage: 'Cancelled by you' } });
}

/** Answers a task's input requests (each is an elicitation shown to the user). */
export async function answerTask(taskId: string): Promise<void> {
  const t = useMcp.getState().tasks.find((x) => x.task.taskId === taskId);
  const c = t && connections.get(t.serverId);
  if (!t || !c || !t.task.inputRequests) return;
  const responses: Record<string, unknown> = {};
  for (const [key, req] of Object.entries(t.task.inputRequests)) {
    if (req.method !== 'elicitation/create') { responses[key] = { action: 'decline' }; continue; }
    const p = req.params ?? {};
    responses[key] = await requestElicitation({ server: t.serverName, message: String(p.message ?? 'The app needs your input.'), schema: p.requestedSchema as never });
  }
  await c.updateTask(taskId, responses);
  updateTask(taskId, { task: { ...t.task, status: 'working', inputRequests: undefined } });
  polling.delete(taskId);
  pollTask(t.serverId, taskId);
}

export function dismissTask(taskId: string) {
  useMcp.setState((s) => ({ tasks: s.tasks.filter((t) => t.task.taskId !== taskId) }));
  persist();
}
