import { McpServer, MissingRequiredClientCapabilityError, ProtocolError, ResourceTemplate, type AuthInfo, type CallToolResult, type McpRequestContext } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type { ServerContext } from './context.ts';
import { dailyReviewArgs, dailyReviewPrompt, summarizeNoteArgs, summarizeNotePrompt, todosFromNotesArgs, todosFromNotesPrompt } from './prompts.ts';
import { NOTE_TEMPLATE, PACK_TEMPLATE, PAGE_SVG_TEMPLATE, listNoteResources, listPackResources, readNoteResource, readPackResource, readPageSvgResource } from './resources.ts';
import { TOOLS, type ToolDef } from './tools.ts';
import { DEV_TOOLS } from './dev/tools.ts';
import { CONTEXT_TOOLS } from './proxy/tools.ts';
import { TEAM_TOOLS } from './federation/tools.ts';
import { ActivitySessions } from './activity.ts';
import { registerAgentTools, ownerOf } from './agent-tools.ts';
import { ApprovalStore } from './approvals.ts';
import type { AgentAI } from './agent/ai.ts';
import { TASKS_EXTENSION, TaskRegistry } from './tasks.ts';
import { SEARCH_UI, UI_MIME, UI_RESOURCES, UI_RESOURCE_META, uiToolMeta } from './ui.ts';
import { VERSION } from './version.ts';
import { notesTouched, proposalFor, type ServerTrust } from './trust.ts';

const INSTRUCTIONS = `Inkwright is the user's handwriting notebook app. This server reads and writes their notes vault (plain files synced across their devices).
- Find notes with search_notes (searches recognized handwriting too) or list_notes; read one with read_note; show a page as the user wrote it with show_note_page.
- Handwriting that has not been recognized yet can be seen with get_page_image (PNG) or converted with transcribe_pages.
- "What did I write today?" -> get_recent_handwriting.
- Writes (create_note, append_to_note, update_note, create_notebook, trash_note) appear in the app on all devices and can be undone there (Settings › AI › Activity). Never trash notes without the user's go-ahead; trash is reversible with restore_note.
- Long jobs (summarize_notebook, transcribe_pages, run_routine) may run as background tasks.
- Background routines sometimes wait for the user's OK: list_pending_approvals shows them. Only approve (decide_approval) when the user says so.
- Code: code_search / code_symbol read repositories scanned into the vault; notes link code as [[code:path#Symbol]]; drift_report lists notes whose linked code changed; validate_diagram checks a diagram IR; get_runbook reads a runbook note's runnable blocks.`;

/** OAuth scopes the server understands (OAuth mode). */
export interface Scopes {
  read: string;
  write: string;
}

/**
 * Process-wide state shared by every MCP server instance (one per HTTP request in stateless mode,
 * one per stdio connection): tasks, the activity log sessions, pending approvals and the AI.
 */
export interface ServerServices {
  ctx: ServerContext;
  tasks: TaskRegistry;
  activity: ActivitySessions;
  approvals: ApprovalStore;
  ai: AgentAI | null;
  transport: 'stdio' | 'http';
  /**
   * Over stateless HTTP a 2025-era client names itself only in `initialize`, which a different
   * server instance answers than its later calls; remember the latest name per principal so its
   * writes are still labelled (2026 clients send their name with every request).
   */
  legacyClients: Map<string, { name: string; title?: string }>;
  /** Set in OAuth mode: write tools then require the write scope (step-up challenge). */
  scopes?: Scopes | null;
  /** Audit trail, usage meter and proposals (docs/TRUST.md). */
  trust: ServerTrust;
}

export function createServices(ctx: ServerContext, o: { ai?: AgentAI | null; transport: 'stdio' | 'http'; scopes?: Scopes | null; tasks?: TaskRegistry }): ServerServices {
  const trust = ctx.trust;
  return { ctx, tasks: o.tasks ?? new TaskRegistry({ clock: ctx.clock }), activity: new ActivitySessions(ctx), legacyClients: new Map(), approvals: new ApprovalStore(ctx.fs, ctx.clock), ai: o.ai ?? null, transport: o.transport, scopes: o.scopes ?? null, trust };
}

/** Write tools available for this context (none in read-only mode). */
export function activeTools(ctx: ServerContext): ToolDef[] {
  // Optional features: context tools unless switched off (--no-context-tools), team search with --team.
  const optional = [...(ctx.features?.contextTools === false ? [] : CONTEXT_TOOLS), ...(ctx.features?.team ? TEAM_TOOLS : [])];
  return [...TOOLS, ...DEV_TOOLS, ...optional].filter((t) => !t.write || !ctx.readOnly);
}

function errorResult(e: unknown): CallToolResult {
  const err = e as { issues?: Array<{ path: PropertyKey[]; message: string }>; message?: string };
  const msg = Array.isArray(err?.issues)
    ? 'Invalid arguments: ' + err.issues.map((i) => `${i.path.map(String).join('.') || 'input'}: ${i.message}`).join('; ')
    : String(err?.message ?? e);
  return { isError: true, content: [{ type: 'text', text: msg }] };
}

/** search_notes results as structured content for the search picker view. */
function withSearchStructure(r: CallToolResult): CallToolResult {
  if (r.isError) return r;
  try {
    const j = JSON.parse((r.content?.[0] as { text?: string })?.text ?? '');
    return { ...r, structuredContent: { query: j.query, hits: (j.hits ?? []).map((h: Record<string, unknown>) => ({ id: h.id, title: h.title, page: h.page, snippet: h.snippet, notebook: h.notebook ?? null, updated: h.updated ?? null })) } };
  } catch {
    return r;
  }
}

/**
 * An MCP server exposing the vault. Built per serving unit by the SDK's entries (`serveStdio`:
 * one per connection; `createMcpHandler`: one per HTTP request, for both the 2026-07-28 and the
 * 2025 protocol eras), so all long-lived state lives in `services`.
 */
export function createMcpServer(services: ServerServices, rc?: McpRequestContext): McpServer {
  const { ctx } = services;
  const server = new McpServer(
    { name: 'inkwright', title: 'Inkwright notes', version: VERSION, websiteUrl: 'https://inkwright.app' },
    {
      instructions: INSTRUCTIONS + (ctx.readOnly ? '\nThis vault is mounted read-only: write tools are disabled.' : ''),
      capabilities: { extensions: { [TASKS_EXTENSION]: {} } } as never,
    },
  );

  // Writes by the connected agent join one activity run per agent (and principal), undoable in the app.
  const authInfo: AuthInfo | undefined = rc?.authInfo;
  if (rc?.era === 'legacy' && rc.requestInfo) {
    try {
      void rc.requestInfo.clone().json().then((b: { method?: string; params?: { clientInfo?: { name?: string; title?: string } } }) => {
        const ci = b?.method === 'initialize' ? b.params?.clientInfo : undefined;
        if (ci?.name) services.legacyClients.set(ownerOf(authInfo), { name: ci.name, ...(ci.title ? { title: ci.title } : {}) });
      }, () => {});
    } catch {
      /* body already read: nothing to learn */
    }
  }
  const clientLabel = () => {
    const v = (server.server.getClientVersion() as { name: string; title?: string } | undefined) ?? services.legacyClients.get(ownerOf(authInfo));
    return `${v?.title ?? v?.name ?? 'An agent'} (via MCP)`;
  };
  const activity = () => services.activity.get(`${clientLabel()}|${ownerOf(authInfo)}`, clientLabel());
  const scopes = services.scopes;
  const writeChallenge = scopes
    ? (c: { authInfo?: AuthInfo }) => (c.authInfo && !c.authInfo.scopes.includes(scopes.write) ? { scopes: [scopes.read, scopes.write] as [string, ...string[]], errorDescription: 'Writing to notes needs the write scope.' } : undefined)
    : undefined;

  for (const tool of activeTools(ctx)) {
    const isSearch = tool.name === 'search_notes';
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: z.object(tool.inputSchema),
        annotations: tool.annotations,
        ...(isSearch ? { _meta: uiToolMeta(SEARCH_UI) } : {}),
        ...(tool.write && writeChallenge ? { scopeChallenge: writeChallenge } : {}),
      },
      async (args: unknown) => {
        const a = (args ?? {}) as Record<string, any>;
        const actor = { source: 'external', label: clientLabel() };
        try {
          if (tool.write) {
            await ctx.refresh();
            // Dry run for outside agents: the change becomes a proposal the user approves in the app.
            if (ctx.policy.current.agentWrites.external === 'propose') {
              const p = await proposalFor(ctx.vault, tool.name, a);
              if (p) {
                const made = await services.trust.proposals.create({ ...p, source: 'external', label: clientLabel() });
                services.trust.audit.record({ kind: 'proposal', actor, tool: tool.name, summary: `Proposed: ${p.summary}`, ...(p.noteId ? { notes: [{ id: p.noteId, ...(p.noteTitle ? { title: p.noteTitle } : {}) }] } : {}) });
                return { content: [{ type: 'text', text: JSON.stringify({ proposed: true, proposalId: made.id, summary: p.summary, message: 'The user reviews changes from agents before they apply: this one is waiting for their approval in Inkwright (Settings › AI › Activity). Tell them it is proposed, not done.' }) }] };
              }
            }
            const r = await activity().record(tool.name, a, () => tool.handler(ctx, a));
            if (!r.isError) services.trust.audit.record({ kind: 'write', actor, tool: tool.name, notes: notesTouched(a, (r.content?.[0] as { text?: string })?.text) });
            return r;
          }
          const r = await tool.handler(ctx, a);
          if (!r.isError) services.trust.audit.record({ kind: 'read', actor, tool: tool.name, notes: notesTouched(a, (r.content?.[0] as { text?: string })?.text) });
          return isSearch ? withSearchStructure(r) : r;
        } catch (e) {
          if ((e as { code?: string })?.code === 'policy_blocked') services.trust.audit.record({ kind: 'blocked', actor, tool: tool.name, summary: (e as Error).message, outcome: 'blocked' });
          return errorResult(e);
        }
      },
    );
  }

  registerAgentTools(server, { ctx, tasks: services.tasks, approvals: services.approvals, ai: services.ai, transport: services.transport, activity, clientLabel, ...(writeChallenge ? { writeChallenge } : {}) });
  registerTaskMethods(server, services);

  server.registerResource(
    'note',
    new ResourceTemplate(NOTE_TEMPLATE, { list: () => listNoteResources(ctx) }),
    { title: 'Inkwright note', description: 'A note as Markdown: front matter, typed text and recognized handwriting per page.', mimeType: 'text/markdown' },
    (_uri, vars) => readNoteResource(ctx, vars.id),
  );
  server.registerResource(
    'page-svg',
    new ResourceTemplate(PAGE_SVG_TEMPLATE, { list: undefined }),
    { title: 'Inkwright page (SVG)', description: 'One page of a note rendered as SVG (n is 1-based).', mimeType: 'image/svg+xml' },
    (_uri, vars) => readPageSvgResource(ctx, vars.id, vars.n),
  );
  server.registerResource(
    'context-pack',
    new ResourceTemplate(PACK_TEMPLATE, { list: () => listPackResources(ctx) }),
    { title: 'Inkwright context pack', description: 'A compressed, cited bundle the user made from their notes for agents: compiled facts tagged EXTRACTED/INFERRED/AMBIGUOUS with sources, the notes and key handwriting.', mimeType: 'text/markdown' },
    (_uri, vars) => readPackResource(ctx, vars.id),
  );
  for (const ui of UI_RESOURCES) {
    server.registerResource(ui.name, ui.uri, { title: ui.title, description: ui.description, mimeType: UI_MIME, _meta: UI_RESOURCE_META }, async () => ({
      contents: [{ uri: ui.uri, mimeType: UI_MIME, text: ui.html, _meta: UI_RESOURCE_META }],
    }));
  }

  server.registerPrompt(
    'summarize_note',
    { title: 'Summarize a note', description: 'Summarize one handwritten note and pull out action items.', argsSchema: z.object(summarizeNoteArgs) },
    (args) => summarizeNotePrompt(ctx, args),
  );
  server.registerPrompt(
    'daily_review',
    { title: 'Daily review', description: 'Review everything written on a day (default today): key points, to-dos, open questions.', argsSchema: z.object(dailyReviewArgs) },
    (args) => dailyReviewPrompt(ctx, args),
  );
  server.registerPrompt(
    'todos_from_notes',
    { title: 'To-dos from notes', description: 'Extract a to-do checklist from recent notes (default last 7 days), optionally one notebook.', argsSchema: z.object(todosFromNotesArgs) },
    (args) => todosFromNotesPrompt(ctx, args),
  );

  return server;
}

/**
 * `tasks/get`, `tasks/update` and `tasks/cancel` (Tasks extension). Only clients that declare the
 * extension on the request may use them (-32021 otherwise); unknown, expired or foreign task ids
 * are -32602, as the extension requires.
 */
function registerTaskMethods(server: McpServer, services: ServerServices): void {
  const low = server.server as unknown as {
    setRequestHandler(method: string, schemas: { params: z.ZodType }, handler: (params: Record<string, any>, ctx: { mcpReq: { envelope?: Record<string, unknown> }; http?: { authInfo?: AuthInfo } }) => unknown): void;
  };
  const params = z.object({ taskId: z.string().min(1) }).passthrough();
  const guard = (ctx: { mcpReq: { envelope?: Record<string, unknown> } }) => {
    const caps = ctx.mcpReq.envelope?.['io.modelcontextprotocol/clientCapabilities'] as { extensions?: Record<string, unknown> } | undefined;
    if (!caps?.extensions?.[TASKS_EXTENSION]) {
      throw new MissingRequiredClientCapabilityError({ requiredCapabilities: { extensions: { [TASKS_EXTENSION]: {} } } } as never, 'This method needs the io.modelcontextprotocol/tasks extension.');
    }
  };
  const unknown = (id: string) => new ProtocolError(-32602, `Unknown or expired task: ${id}`);
  low.setRequestHandler('tasks/get', { params }, (p, ctx) => {
    guard(ctx);
    const v = services.tasks.get(p.taskId, ownerOf(ctx.http?.authInfo));
    if (!v) throw unknown(p.taskId);
    return v;
  });
  // The SDK lifts `inputResponses` out of the params into the request context (as for MRTR).
  low.setRequestHandler('tasks/update', { params }, (p, ctx) => {
    guard(ctx);
    const responses = (p.inputResponses ?? (ctx.mcpReq as { inputResponses?: Record<string, unknown> }).inputResponses ?? {}) as Record<string, unknown>;
    if (!services.tasks.update(p.taskId, ownerOf(ctx.http?.authInfo), responses)) throw unknown(p.taskId);
    return {};
  });
  low.setRequestHandler('tasks/cancel', { params }, (p, ctx) => {
    guard(ctx);
    if (!services.tasks.cancel(p.taskId, ownerOf(ctx.http?.authInfo))) throw unknown(p.taskId);
    return {};
  });
}
