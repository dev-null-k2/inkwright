/**
 * Inkwright's agent as an A2A (Agent2Agent) agent, so other agents can delegate note work to it:
 * the Agent Card at `/.well-known/agent-card.json` and JSON-RPC at `/a2a` (A2A v1.0 —
 * `SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, … — plus the v0.3 names
 * `message/send`, `message/stream`, `tasks/get`, `tasks/cancel` for older clients, chosen by the
 * `A2A-Version` header). Built on the official SDK (`@a2a-js/sdk`): it owns the wire format, task
 * store, streaming (SSE) and v0.3 translation; this module supplies the card and the executor.
 *
 * The executor runs the same agent as everything else on the server (agent/run.ts): the note
 * tools, the user's skills and memory, changes logged in Activity and undoable, and the same
 * approval rule — moving a note to Trash pauses the task in `INPUT_REQUIRED` until the client
 * replies on that task with yes/no (a text "approve"/"deny" or a data part `{ "approve": true }`).
 *
 * Structured calls skip the model where it isn't needed: a data part
 * `{ "skill": "search_notes", "query": "…" }` searches directly, and
 * `{ "skill": "run_routine", "routine": "<name or id>" }` runs a routine.
 */
import express from 'express';
import type { Request as ExpressRequest } from 'express';
import { AgentCard as AgentCardJson, Role, TaskState, type AgentCard, type AgentSkill, type Message, type Part, type SecurityScheme, type SecurityRequirement, type Task } from '@a2a-js/sdk';
import { AgentEvent, DefaultRequestHandler, InMemoryTaskStore, type AgentExecutor, type ExecutionEventBus, type RequestContext, type User } from '@a2a-js/sdk/server';
import { agentCardHandler, jsonRpcHandler } from '@a2a-js/sdk/server/express';
import type { AuthInfo } from '@modelcontextprotocol/server';
import { RoutineStore, type ChatMessage, type ToolRun } from '@inkwright/ai';
import { notebookPath, type ServerContext } from './context.ts';
import type { ApprovalRequest, Approver } from './approvals.ts';
import type { AgentAI } from './agent/ai.ts';
import { findRoutine, runRoutineOnServer, runServerAgent } from './agent/run.ts';
import { VaultNoteToolHost } from './agent/host.ts';
import type { Scopes } from './server.ts';
import { VERSION } from './version.ts';

export interface A2AConfig {
  ctx: ServerContext;
  ai: AgentAI | null;
  /** Public base URL (scheme://host[:port]); the JSON-RPC endpoint is `<publicUrl>/a2a`. */
  publicUrl: string;
  auth: { kind: 'none' } | { kind: 'token' } | { kind: 'oauth'; issuer: string; scopes: Scopes; discoveryUrl?: string };
}

/** The signed-in caller, as the A2A SDK sees it. */
export class InkwrightUser implements User {
  constructor(readonly name: string, readonly canWrite: boolean) {}
  get isAuthenticated() { return this.name !== 'local'; }
  get userName() { return this.name; }
}

/** Builds the user from what the HTTP gate verified (attached to the request as `inkwrightAuth`). */
export function userFromAuth(auth: AuthInfo | undefined, scopes: Scopes | null, readOnly: boolean): InkwrightUser {
  if (!auth) return new InkwrightUser('local', !readOnly);
  const sub = (auth.extra as { sub?: string } | undefined)?.sub;
  const canWrite = !readOnly && (!scopes || auth.scopes.includes(scopes.write));
  return new InkwrightUser(`${auth.clientId}:${sub ?? ''}`, canWrite);
}

// ---- Agent Card ---------------------------------------------------------------------------------

const TEXT = 'text/plain';
const JSON_MIME = 'application/json';

function skill(id: string, name: string, description: string, tags: string[], examples: string[], security: SecurityRequirement[] = []): AgentSkill {
  return { id, name, description, tags, examples, inputModes: [TEXT, JSON_MIME], outputModes: [TEXT, JSON_MIME], securityRequirements: security };
}

export function buildAgentCard(c: A2AConfig): AgentCard {
  const url = `${c.publicUrl.replace(/\/+$/, '')}/a2a`;
  const securitySchemes: Record<string, SecurityScheme> = {};
  let read: SecurityRequirement[] = [];
  let write: SecurityRequirement[] = [];
  if (c.auth.kind === 'token') {
    securitySchemes.bearer = { scheme: { $case: 'httpAuthSecurityScheme', value: { description: 'The token the Inkwright server was started with (--token / INKWRIGHT_MCP_TOKEN).', scheme: 'Bearer', bearerFormat: '' } } };
    read = write = [{ schemes: { bearer: { list: [] } } }];
  } else if (c.auth.kind === 'oauth') {
    const issuer = c.auth.issuer.replace(/\/+$/, '');
    securitySchemes.oauth = c.auth.discoveryUrl?.includes('openid-configuration') || !c.auth.discoveryUrl
      ? { scheme: { $case: 'openIdConnectSecurityScheme', value: { description: 'Sign in with your identity provider.', openIdConnectUrl: c.auth.discoveryUrl ?? `${issuer}/.well-known/openid-configuration` } } }
      : { scheme: { $case: 'oauth2SecurityScheme', value: { description: 'Sign in with your identity provider.', flows: undefined, oauth2MetadataUrl: c.auth.discoveryUrl } } };
    read = [{ schemes: { oauth: { list: [c.auth.scopes.read] } } }];
    write = [{ schemes: { oauth: { list: [c.auth.scopes.read, c.auth.scopes.write] } } }];
  }
  const writable = !c.ctx.readOnly;
  return {
    name: 'Inkwright notes',
    description: 'The agent of the user’s Inkwright handwriting notes: searches notes (including recognized handwriting), answers questions from them with citations, creates and appends notes, and runs the user’s routines. Changes are logged in Inkwright and can be undone; moving notes to Trash asks first.',
    supportedInterfaces: [
      { url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '1.0' },
      { url, protocolBinding: 'JSONRPC', tenant: '', protocolVersion: '0.3' },
    ],
    provider: { organization: 'Inkwright', url: 'https://inkwright.app' },
    version: VERSION,
    capabilities: { streaming: true, pushNotifications: false, extensions: [], extendedAgentCard: false },
    securitySchemes,
    securityRequirements: read,
    defaultInputModes: [TEXT, JSON_MIME],
    defaultOutputModes: [TEXT, JSON_MIME],
    skills: [
      skill('search_notes', 'Search notes', 'Finds notes by words, including handwriting that has been recognized. Send text, or a data part {"skill":"search_notes","query":"…"} for a direct search without the model.', ['notes', 'search', 'handwriting'], ['Find my notes about the beta launch', 'Where did I write Maria’s phone number?'], read),
      skill('answer_from_notes', 'Answer from notes', 'Answers a question using only what the user wrote, citing the notes it used (data part "citations" with note ids, titles and inkwright:// links).', ['notes', 'question answering', 'citations'], ['What did we decide about pricing?', 'Summarize what I wrote this week'], read),
      ...(writable ? [
        skill('write_notes', 'Create or append notes', 'Creates a note or adds text to an existing one. The change shows up in Inkwright on all devices and can be undone there.', ['notes', 'write'], ['Save these meeting minutes as a note in Work', 'Add “call the printer” to my Tasks note'], write),
        skill('run_routine', 'Run a routine', 'Runs one of the user’s Inkwright routines now (by name). Send text, or a data part {"skill":"run_routine","routine":"File my notes"}.', ['routines', 'automation'], ['Run my “File my notes” routine'], write),
      ] : []),
    ],
    signatures: [],
  };
}

/** The v1.0 card as A2A JSON (proto3 JSON mapping), as `/.well-known/agent-card.json` serves it. */
export function agentCardJson(card: AgentCard): unknown {
  return AgentCardJson.toJSON(card);
}

// ---- Message helpers -----------------------------------------------------------------------------

const textPart = (text: string): Part => ({ content: { $case: 'text', value: text }, metadata: undefined, filename: '', mediaType: TEXT });
const dataPart = (value: unknown): Part => ({ content: { $case: 'data', value }, metadata: undefined, filename: '', mediaType: JSON_MIME });

function agentMessage(rc: Pick<RequestContext, 'taskId' | 'contextId'>, parts: Part[]): Message {
  return { messageId: crypto.randomUUID(), contextId: rc.contextId, taskId: rc.taskId, role: Role.ROLE_AGENT, parts, metadata: undefined, extensions: [], referenceTaskIds: [] };
}

function textOfMessage(m: Message | undefined): string {
  return (m?.parts ?? []).map((p) => (p.content?.$case === 'text' ? p.content.value : '')).filter(Boolean).join('\n').trim();
}

function dataOfMessage(m: Message | undefined): Record<string, unknown> | null {
  for (const p of m?.parts ?? []) if (p.content?.$case === 'data' && p.content.value && typeof p.content.value === 'object') return p.content.value as Record<string, unknown>;
  return null;
}

/** "yes" / "approve" / {approve:true} → approved; anything else declines. */
export function approvalFromMessage(m: Message | undefined): 'approved' | 'denied' {
  const d = dataOfMessage(m);
  if (d && typeof d.approve === 'boolean') return d.approve ? 'approved' : 'denied';
  return /^\s*(y|yes|ok|okay|approve|approved|allow|go ahead|sure)\b/i.test(textOfMessage(m)) ? 'approved' : 'denied';
}

export interface Citation {
  noteId: string;
  title: string;
  uri: string;
  page?: number;
}

/** Notes the agent read or found, kept when the answer mentions them (or they were read in full). */
export function citationsFrom(runs: readonly ToolRun[], answer: string): Citation[] {
  const out = new Map<string, Citation>();
  const lower = answer.toLowerCase();
  for (const r of runs) {
    if (!r.ok || !r.result || typeof r.result !== 'object') continue;
    const res = r.result as Record<string, any>;
    if (r.call.name === 'read_note' && typeof res.id === 'string') {
      out.set(res.id, { noteId: res.id, title: res.title ?? '', uri: `inkwright://notes/${res.id}` });
    } else if (r.call.name === 'search_notes' && Array.isArray(res.results)) {
      for (const h of res.results) {
        const title = String(h.title ?? '');
        if (!out.has(h.note_id) && title && lower.includes(title.toLowerCase())) out.set(h.note_id, { noteId: h.note_id, title, uri: `inkwright://notes/${h.note_id}`, page: (h.page_index ?? 0) + 1 });
      }
    }
  }
  return [...out.values()];
}

// ---- Executor --------------------------------------------------------------------------------------

interface Session {
  contextId: string;
  abort: AbortController;
  /** Set while the task waits for an approval. */
  awaiting: { resolve: (d: 'approved' | 'denied') => void } | null;
  done: Promise<void>;
}

const CONTEXT_TURNS = 20;

/** Runs Inkwright's agent for A2A tasks. */
export class InkwrightExecutor implements AgentExecutor {
  private sessions = new Map<string, Session>();
  /** Conversation per A2A context, so follow-up questions have the earlier turns. */
  private transcripts = new Map<string, ChatMessage[]>();

  constructor(private c: A2AConfig) {}

  private status(bus: ExecutionEventBus, rc: Pick<RequestContext, 'taskId' | 'contextId'>, state: TaskState, text?: string, extra: Part[] = []) {
    bus.publish(AgentEvent.statusUpdate({ taskId: rc.taskId, contextId: rc.contextId, status: { state, message: text || extra.length ? agentMessage(rc, [...(text ? [textPart(text)] : []), ...extra]) : undefined, timestamp: new Date(this.c.ctx.clock()).toISOString() }, metadata: undefined }));
  }

  async execute(rc: RequestContext, bus: ExecutionEventBus): Promise<void> {
    const existing = this.sessions.get(rc.taskId);
    if (existing?.awaiting && rc.task) {
      // A reply to "may I?": the SDK requires a task event first on every call.
      bus.publish(AgentEvent.task(rc.task));
      const waiting = existing.awaiting;
      existing.awaiting = null;
      waiting.resolve(approvalFromMessage(rc.userMessage));
      await existing.done;
      return;
    }
    if (rc.task && rc.task.status && [TaskState.TASK_STATE_COMPLETED, TaskState.TASK_STATE_FAILED, TaskState.TASK_STATE_CANCELED, TaskState.TASK_STATE_REJECTED].includes(rc.task.status.state)) {
      bus.publish(AgentEvent.task(rc.task));
      this.status(bus, rc, rc.task.status.state, 'This task has already finished; start a new one.');
      bus.finished();
      return;
    }
    let finish!: () => void;
    const session: Session = { contextId: rc.contextId, abort: new AbortController(), awaiting: null, done: new Promise((r) => (finish = r)) };
    this.sessions.set(rc.taskId, session);
    const task: Task = { id: rc.taskId, contextId: rc.contextId, status: { state: TaskState.TASK_STATE_SUBMITTED, message: undefined, timestamp: new Date(this.c.ctx.clock()).toISOString() }, artifacts: [], history: [rc.userMessage], metadata: undefined };
    bus.publish(AgentEvent.task(task));
    try {
      await this.run(rc, bus, session);
    } catch (e) {
      if (!session.abort.signal.aborted) this.status(bus, rc, TaskState.TASK_STATE_FAILED, `Something went wrong: ${(e as Error)?.message ?? e}`);
    } finally {
      this.sessions.delete(rc.taskId);
      finish();
      bus.finished();
    }
  }

  private approver(rc: RequestContext, bus: ExecutionEventBus, session: Session): Approver {
    return (req: ApprovalRequest) =>
      new Promise((resolve) => {
        session.awaiting = { resolve };
        this.status(bus, rc, TaskState.TASK_STATE_INPUT_REQUIRED, `${req.title}? ${req.detail ?? ''} Reply “approve” or “deny” on this task.`.trim(), [dataPart({ approval: { tool: req.tool, arguments: req.args, title: req.title }, reply: { approve: 'boolean' } })]);
      });
  }

  private async run(rc: RequestContext, bus: ExecutionEventBus, session: Session) {
    const { ctx } = this.c;
    const user = rc.context.user instanceof InkwrightUser ? rc.context.user : new InkwrightUser('local', !ctx.readOnly);
    const text = textOfMessage(rc.userMessage);
    const data = dataOfMessage(rc.userMessage) ?? {};
    const skillId = typeof data.skill === 'string' ? data.skill : typeof rc.request.metadata?.skill === 'string' ? rc.request.metadata.skill : null;
    const signal = session.abort.signal;
    const clientName = rc.context.user?.isAuthenticated ? user.name.split(':')[0] : 'An agent';

    if (skillId === 'search_notes') {
      const query = String(data.query ?? text).trim();
      if (!query) return this.status(bus, rc, TaskState.TASK_STATE_REJECTED, 'Send a query to search for.');
      this.status(bus, rc, TaskState.TASK_STATE_WORKING, `Searching for “${query}”…`);
      const host = new VaultNoteToolHost(ctx);
      const hits = await host.searchNotes(query, { limit: Number(data.limit) || 10 });
      const notebooks = await ctx.vault.listNotebooks();
      const rows = [];
      for (const h of hits) {
        const n = await ctx.vault.readNote(h.noteId);
        rows.push({ noteId: h.noteId, title: h.title, page: h.pageIndex + 1, snippet: h.snippet, notebook: notebookPath(notebooks, n?.notebookId), uri: `inkwright://notes/${h.noteId}` });
      }
      const summary = rows.length ? rows.map((r) => `- ${r.title || 'Untitled'} (page ${r.page}): ${r.snippet}`).join('\n') : `No notes match “${query}”.`;
      bus.publish(AgentEvent.artifactUpdate({ taskId: rc.taskId, contextId: rc.contextId, artifact: { artifactId: 'results', name: 'Search results', description: `Notes matching “${query}”`, parts: [textPart(summary), dataPart({ query, results: rows })], metadata: undefined, extensions: [] }, append: false, lastChunk: true, metadata: undefined }));
      return this.status(bus, rc, TaskState.TASK_STATE_COMPLETED, rows.length ? `Found ${rows.length} ${rows.length === 1 ? 'note' : 'notes'}.` : summary);
    }

    if (!this.c.ai) return this.status(bus, rc, TaskState.TASK_STATE_FAILED, 'No AI is set up for the Inkwright agent, so it can only search (data part {"skill":"search_notes"}). Start the server with --ai-provider; see docs/AGENTS.md.');

    if (skillId === 'run_routine') {
      if (!user.canWrite) return this.status(bus, rc, TaskState.TASK_STATE_REJECTED, 'Running routines needs write access.');
      const r = findRoutine(await new RoutineStore(ctx.fs).list(), String(data.routine ?? text));
      if (!r) return this.status(bus, rc, TaskState.TASK_STATE_REJECTED, `No routine called “${String(data.routine ?? text)}”.`);
      this.status(bus, rc, TaskState.TASK_STATE_WORKING, `Running “${r.name}”…`);
      const res = await runRoutineOnServer(ctx, this.c.ai, r, { kind: 'manual', reason: `Run by ${clientName} (via A2A)` }, this.approver(rc, bus, session), { signal, onEvent: (e) => { if (e.type === 'tool_start') this.status(bus, rc, TaskState.TASK_STATE_WORKING, `“${r.name}”: ${e.call.name.replace(/_/g, ' ')}…`); } });
      await new RoutineStore(ctx.fs).updateState(r.id, (s) => ({ ...s, lastRunAt: ctx.clock(), lastStatus: res.status }));
      if (signal.aborted) return;
      if (res.status !== 'done') return this.status(bus, rc, TaskState.TASK_STATE_FAILED, res.error ?? 'The routine failed.');
      bus.publish(AgentEvent.artifactUpdate({ taskId: rc.taskId, contextId: rc.contextId, artifact: { artifactId: 'routine-run', name: `Routine “${r.name}”`, description: 'What the routine did', parts: [textPart(res.reply || 'Done.'), dataPart({ routine: r.name, changes: res.run.ops.map((o) => o.summary), activityRunId: res.run.id })], metadata: undefined, extensions: [] }, append: false, lastChunk: true, metadata: undefined }));
      return this.status(bus, rc, TaskState.TASK_STATE_COMPLETED, res.reply || 'Done.');
    }

    if (!text) return this.status(bus, rc, TaskState.TASK_STATE_REJECTED, 'Send a question or an instruction as text.');
    this.status(bus, rc, TaskState.TASK_STATE_WORKING, 'Reading your notes…');
    const history = this.transcripts.get(rc.contextId) ?? [];
    const messages: ChatMessage[] = [...history, { role: 'user', content: text }];
    const res = await runServerAgent(ctx, this.c.ai, {
      source: 'external',
      label: `${clientName} (via A2A)`,
      prompt: text,
      notes: user.canWrite ? 'write' : 'read',
      approver: this.approver(rc, bus, session),
      context: 'You are answering another agent on the user’s behalf over A2A. When you use notes, cite them by title in square brackets, e.g. [Beta launch plan]. If the notes don’t contain the answer, say so plainly.',
      messages,
      signal,
      onEvent: (e) => {
        if (e.type === 'tool_start') this.status(bus, rc, TaskState.TASK_STATE_WORKING, e.call.name === 'search_notes' ? 'Searching notes…' : e.call.name === 'read_note' ? 'Reading a note…' : `${e.call.name.replace(/_/g, ' ')}…`);
      },
    });
    if (signal.aborted) return;
    if (res.status !== 'done') return this.status(bus, rc, TaskState.TASK_STATE_FAILED, res.error ?? 'The agent failed.');
    this.transcripts.set(rc.contextId, [...messages, { role: 'assistant' as const, content: res.reply }].slice(-CONTEXT_TURNS));
    const citations = citationsFrom(res.result?.toolRuns ?? [], res.reply);
    const changes = res.run.ops.map((o) => o.summary);
    bus.publish(AgentEvent.artifactUpdate({ taskId: rc.taskId, contextId: rc.contextId, artifact: { artifactId: 'answer', name: 'Answer', description: 'The answer, with the notes it is based on', parts: [textPart(res.reply), dataPart({ citations, ...(changes.length ? { changes, activityRunId: res.run.id } : {}) })], metadata: undefined, extensions: [] }, append: false, lastChunk: true, metadata: undefined }));
    this.status(bus, rc, TaskState.TASK_STATE_COMPLETED, res.reply);
  }

  async cancelTask(taskId: string, bus: ExecutionEventBus): Promise<void> {
    const s = this.sessions.get(taskId);
    if (!s) return;
    s.abort.abort();
    s.awaiting?.resolve('denied');
    s.awaiting = null;
    this.status(bus, { taskId, contextId: s.contextId }, TaskState.TASK_STATE_CANCELED, 'Cancelled.');
  }
}

/**
 * Express app with the agent card and the JSON-RPC endpoint. The HTTP server authenticates the
 * request first and attaches the verified `AuthInfo` as `inkwrightAuth`.
 */
export function createA2AApp(c: A2AConfig, scopes: Scopes | null): { app: express.Express; card: AgentCard; executor: InkwrightExecutor } {
  const card = buildAgentCard(c);
  const executor = new InkwrightExecutor(c);
  const handler = new DefaultRequestHandler(card, new InMemoryTaskStore(), executor);
  const app = express();
  app.disable('x-powered-by');
  app.get('/.well-known/agent-card.json', (req, res, next) => {
    // v1.0 clients get the card in A2A JSON; v0.3 (or no version header) the SDK's v0.3 card.
    const v = req.header('A2A-Version');
    if (!v || v.startsWith('0.')) return next();
    res.setHeader('Vary', 'A2A-Version');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(agentCardJson(card));
  });
  app.use('/.well-known/agent-card.json', agentCardHandler({ agentCardProvider: handler, legacyCompat: { enabled: true }, cache: { maxAge: 300 } }));
  app.use('/a2a', jsonRpcHandler({ requestHandler: handler, legacyCompat: { enabled: true }, userBuilder: async (req: ExpressRequest) => userFromAuth((req as ExpressRequest & { inkwrightAuth?: AuthInfo }).inkwrightAuth, scopes, c.ctx.readOnly) }));
  return { app, card, executor };
}
