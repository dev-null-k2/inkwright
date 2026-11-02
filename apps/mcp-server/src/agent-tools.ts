/**
 * The server's own agent tools for MCP clients:
 *
 * - Long-running work as Tasks: `summarize_notebook`, `transcribe_pages`, `run_routine` (plus
 *   `list_routines`). With a Tasks-capable client they return a task at once and report progress
 *   in `statusMessage`; approvals become `input_required`. Other clients get the same work run
 *   inline (and approvals are asked through 2025 elicitation over stdio, or deferred).
 * - `show_note_page` (MCP Apps page view), `list_pending_approvals` / `decide_approval` (the
 *   approval card).
 *
 * These need an AI configured for the server where noted; without one they explain how to set
 * it up instead of failing obscurely.
 */
import { z } from 'zod';
import type { AuthInfo, CallToolResult, McpServer, ServerContext as McpContext } from '@modelcontextprotocol/server';
import { RoutineStore, runSkill, summarizeNote, transcribeHandwriting, type Routine } from '@inkstone/ai';
import { exportMarkdown, pageText, type NoteMeta } from '@inkstone/core';
import { notebookPath, readNoteFresh, type ServerContext } from './context.ts';
import type { ActivityLog } from './activity.ts';
import { approvalElicitation, approvalFromElicitResult, deferringApprover, type ApprovalStore, type Approver } from './approvals.ts';
import type { AgentAI } from './agent/ai.ts';
import { executeApproval, findRoutine, runRoutineOnServer } from './agent/run.ts';
import { pageSvg } from './render.ts';
import { TaskFailure, clientSupportsTasks, createTaskResult, type TaskControl, type TaskRegistry } from './tasks.ts';
import { IdSchema, jsonResult, resolveNotebook, setRecognizedText, textResult, updateNote } from './tools.ts';
import { APPROVALS_UI, NOTE_PAGE_UI, SVG_META_KEY, uiToolMeta } from './ui.ts';

/** What the agent tools need from the hosting server. */
export interface AgentToolDeps {
  ctx: ServerContext;
  tasks: TaskRegistry;
  approvals: ApprovalStore;
  ai: AgentAI | null;
  transport: 'stdio' | 'http';
  /** The connected agent's activity log (writes join its run). */
  activity: () => ActivityLog;
  /** "Claude Desktop (via MCP)" */
  clientLabel: () => string;
  /** Write tools get this OAuth scope challenge (OAuth mode only). */
  writeChallenge?: (c: { authInfo?: AuthInfo }) => { scopes: [string, ...string[]]; errorDescription?: string } | undefined;
}

/** Tasks belong to the principal that created them. */
export function ownerOf(authInfo: AuthInfo | undefined): string {
  if (!authInfo) return 'local';
  const sub = (authInfo.extra as { sub?: string } | undefined)?.sub;
  return `${authInfo.clientId}:${sub ?? ''}`;
}

const NO_AI = 'This needs an AI configured for the Inkstone server (it is separate from the app’s). Start the server with --ai-provider and --ai-model — see docs/AGENTS.md.';

function requireAI(ai: AgentAI | null, vision = false): AgentAI {
  if (!ai) throw new TaskFailure(NO_AI, -32603);
  if (vision && !ai.vision) throw new TaskFailure(`${ai.label} can’t read images. Configure a vision model (for example claude-sonnet, gpt-5, gemini-2.5) to transcribe handwriting.`);
  return ai;
}

type Work = (t: TaskControl, approver: Approver) => Promise<CallToolResult>;

/**
 * Runs long work as a task for Tasks-capable clients, inline otherwise. Inline approvals use 2025
 * elicitation when the client can answer it on this connection (stdio), and are deferred to the
 * pending approvals otherwise.
 */
async function runLong(deps: AgentToolDeps, server: McpServer, mcp: McpContext, startMessage: string, work: Work): Promise<CallToolResult> {
  const envelope = (mcp.mcpReq as { envelope?: Record<string, unknown> }).envelope;
  const owner = ownerOf(mcp.http?.authInfo);
  if (clientSupportsTasks(envelope)) {
    let asked = 0;
    const view = deps.tasks.start(owner, (t) => work(t, async (req) => approvalFromElicitResult(await t.ask(`approval-${++asked}`, approvalElicitation(req)))), startMessage);
    return createTaskResult(view);
  }
  const abort = new AbortController();
  mcp.mcpReq.signal?.addEventListener('abort', () => abort.abort());
  const inline: TaskControl = { signal: abort.signal, progress: () => {}, ask: () => Promise.reject(new Error('This client can’t answer questions during a call.')) };
  const canElicit = deps.transport === 'stdio' && !envelope && !!server.server.getClientCapabilities()?.elicitation;
  const approver: Approver = canElicit
    ? async (req) => approvalFromElicitResult(await mcp.mcpReq.elicitInput(approvalElicitation(req).params as never))
    : deferringApprover(deps.approvals);
  try {
    return await work(inline, approver);
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: (e as Error)?.message ?? String(e) }] };
  }
}

const WRITE = { readOnlyHint: false, destructiveHint: false, openWorldHint: false } as const;
const READ = { readOnlyHint: true, openWorldHint: false } as const;

async function notesInNotebook(ctx: ServerContext, ref: string): Promise<{ notes: NoteMeta[]; path: string }> {
  await ctx.refresh();
  const notebooks = await ctx.vault.listNotebooks();
  const nb = resolveNotebook(notebooks, ref);
  const ids = new Set([nb.id]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const n of notebooks) if (n.parentId && ids.has(n.parentId) && !ids.has(n.id)) { ids.add(n.id); grew = true; }
  }
  const notes = (await ctx.vault.listNotes()).filter((n) => n.notebookId && ids.has(n.notebookId));
  return { notes, path: notebookPath(notebooks, nb.id) ?? nb.name };
}

export function registerAgentTools(server: McpServer, deps: AgentToolDeps): void {
  const { ctx } = deps;
  const writable = !ctx.readOnly;
  const scopeChallenge = deps.writeChallenge;

  // ---- summarize_notebook ----------------------------------------------------------------------
  server.registerTool(
    'summarize_notebook',
    {
      title: 'Summarize a notebook',
      description:
        'Summarizes every note in a notebook (and its sections) with the server’s AI: one or two sentences per note. Long-running: Tasks-capable clients get a task with progress. save="empty" (default) stores summaries only on notes without one; "all" also replaces existing summaries after asking the user; "none" only returns them.',
      inputSchema: z.object({
        notebook: z.string().min(1).describe('Notebook id, name or "Parent / Child" path.'),
        save: z.enum(['none', 'empty', 'all']).default('empty').describe('Which notes get the summary saved (see description).'),
      }),
      annotations: { ...WRITE, title: 'Summarize a notebook', idempotentHint: true },
      ...(scopeChallenge ? { scopeChallenge } : {}),
    },
    async ({ notebook, save }, mcp) => {
      if (save !== 'none' && !writable) return textResult('The vault is read-only; use save="none".');
      return runLong(deps, server, mcp, 'Finding the notes…', async (t, approver) => {
        const ai = requireAI(deps.ai);
        const { notes, path } = await notesInNotebook(ctx, notebook);
        const out: Array<{ note: NoteMeta; summary: string }> = [];
        for (const [i, n] of notes.entries()) {
          if (t.signal.aborted) throw new Error('Cancelled');
          t.progress(`Summarizing ${i + 1} of ${notes.length}: “${n.title || 'Untitled'}”`);
          const text = exportMarkdown(n, await ctx.vault.readPages(n)).replace(/^---[\s\S]*?---\n/, '');
          if (!text.trim()) continue;
          out.push({ note: n, summary: await runSkill(summarizeNote, ai.provider, ai.model, { title: n.title, text, style: 'short' }, { signal: t.signal }) });
        }
        let saved = 0;
        let kept = 0;
        if (save !== 'none' && out.length) {
          let replace = false;
          const existing = out.filter((x) => x.note.summary?.trim());
          if (save === 'all' && existing.length) {
            replace = (await approver({ tool: 'update_note', args: { notebook }, title: `Replace the summaries of ${existing.length} ${existing.length === 1 ? 'note' : 'notes'} in “${path}”`, detail: 'Each can be undone from Activity in Inkstone.', source: deps.clientLabel() })) === 'approved';
          }
          t.progress('Saving summaries…');
          const log = deps.activity();
          for (const x of out) {
            if (x.note.summary?.trim() && !replace) { kept++; continue; }
            const r = await log.record('update_note', { id: x.note.id, summary: x.summary }, () => updateNote(ctx, { id: x.note.id, summary: x.summary }));
            if (!r.isError) saved++;
          }
        }
        const lines = out.map((x) => `- **${x.note.title || 'Untitled'}** (${x.note.id}): ${x.summary}`);
        const tail = save === 'none' ? '' : `\n\nSaved ${saved} ${saved === 1 ? 'summary' : 'summaries'}${kept ? `; kept ${kept} existing ${kept === 1 ? 'one' : 'ones'}` : ''}. Changes can be undone in Inkstone (Settings › AI › Activity).`;
        return { content: [{ type: 'text', text: `# ${path}\n\n${notes.length} ${notes.length === 1 ? 'note' : 'notes'}.\n\n${lines.join('\n') || '_No notes with text to summarize._'}${tail}` }], structuredContent: { notebook: path, summaries: out.map((x) => ({ id: x.note.id, title: x.note.title, summary: x.summary })), saved } };
      });
    },
  );

  // ---- transcribe_pages --------------------------------------------------------------------------
  server.registerTool(
    'transcribe_pages',
    {
      title: 'Transcribe handwriting',
      description:
        'Reads handwriting that has not been converted to text yet (one note, a notebook, or every note) with the server’s vision AI and stores the text so search and agents can use it. The ink is untouched; pages that already have text are skipped; each page can be undone in Inkstone’s Activity. Long-running (a task with per-page progress).',
      inputSchema: z.object({
        id: IdSchema.optional().describe('Only this note.'),
        notebook: z.string().min(1).optional().describe('Only notes in this notebook (id, name or path).'),
        save: z.boolean().default(true).describe('Store the text on the pages (default true); false only returns it.'),
        limit: z.number().int().min(1).max(500).default(50).describe('At most this many pages (default 50).'),
      }),
      annotations: { ...WRITE, title: 'Transcribe handwriting', idempotentHint: true },
      ...(scopeChallenge ? { scopeChallenge } : {}),
    },
    async (a, mcp) => {
      if (a.save && !writable) return textResult('The vault is read-only; use save=false.');
      return runLong(deps, server, mcp, 'Finding pages with handwriting…', async (t) => {
        const ai = requireAI(deps.ai, true);
        await ctx.refresh();
        let notes: NoteMeta[];
        if (a.id) {
          const f = await readNoteFresh(ctx, a.id);
          if (!f) throw new TaskFailure(`Note not found: ${a.id}`, -32602);
          notes = [f.note];
        } else notes = a.notebook ? (await notesInNotebook(ctx, a.notebook)).notes : await ctx.vault.listNotes();
        const todo: Array<{ note: NoteMeta; pageId: string; index: number }> = [];
        for (const n of notes) {
          for (const [index, p] of (await ctx.vault.readPages(n)).entries()) {
            if (p.strokes.length && !p.recognizedText?.trim()) todo.push({ note: n, pageId: p.id, index });
          }
        }
        const pages = todo.slice(0, a.limit);
        const done: Array<{ id: string; title: string; page: number; text: string; saved: boolean }> = [];
        for (const [i, x] of pages.entries()) {
          if (t.signal.aborted) throw new Error('Cancelled');
          t.progress(`Reading page ${i + 1} of ${pages.length}: “${x.note.title || 'Untitled'}” p. ${x.index + 1}`);
          const page = await ctx.vault.readPage(x.note.id, x.pageId);
          const png = await ctx.renderPng(await pageSvg(ctx, x.note, page, { embedAssets: true }), 1400);
          if (!png) throw new TaskFailure('Transcribing needs the optional PNG renderer (@resvg/resvg-js). Reinstall the server with optional dependencies.');
          const text = (await runSkill(transcribeHandwriting, ai.provider, ai.model, { image: { mediaType: 'image/png', data: Buffer.from(png).toString('base64') }, mode: 'markdown', context: x.note.title }, { signal: t.signal })).trim();
          let saved = false;
          if (a.save && text) {
            saved = await setRecognizedText(ctx, x.note.id, x.pageId, text, `inkstone-agent:${ai.model}`);
            if (saved) deps.activity().push({ kind: 'handwriting_recognized', tool: 'transcribe_pages', noteId: x.note.id, title: x.note.title, pageId: x.pageId, text, summary: `Recognized handwriting on page ${x.index + 1} of “${x.note.title || 'Untitled'}”` });
          }
          done.push({ id: x.note.id, title: x.note.title, page: x.index + 1, text, saved });
        }
        const more = todo.length > pages.length ? `\n\n${todo.length - pages.length} more page(s) left; run again or raise limit.` : '';
        const body = done.map((d) => `## ${d.title || 'Untitled'} — page ${d.page}${d.saved ? '' : a.save ? ' (not saved: the page has text now)' : ''}\n\n${d.text || '_No handwriting found._'}`).join('\n\n');
        return { content: [{ type: 'text', text: `${done.length ? `Transcribed ${done.length} ${done.length === 1 ? 'page' : 'pages'}.` : 'No pages with unrecognized handwriting.'}\n\n${body}${more}` }], structuredContent: { pages: done, remaining: todo.length - pages.length } };
      });
    },
  );

  // ---- routines ------------------------------------------------------------------------------------
  const routines = new RoutineStore(ctx.fs);
  server.registerTool(
    'list_routines',
    { title: 'List routines', description: 'The user’s routines (background agent tasks set up in Inkstone): name, what triggers them, when they last ran.', inputSchema: z.object({}), annotations: { ...READ, title: 'List routines' } },
    async () => {
      const list = await routines.list();
      return jsonResult({ routines: list.map((r: Routine) => ({ id: r.id, name: r.name, enabled: r.enabled, triggers: r.triggers.map((x) => x.kind), lastRunAt: r.state.lastRunAt ? new Date(r.state.lastRunAt).toISOString() : null, lastStatus: r.state.lastStatus ?? null })) });
    },
  );

  if (writable) {
    server.registerTool(
      'run_routine',
      {
        title: 'Run a routine',
        description:
          'Runs one of the user’s routines now with the server’s AI, exactly as Inkstone would (its prompt, its tools; changes are logged and undoable in Activity). Moving notes to Trash waits for the user’s OK. Long-running: a task with progress for Tasks-capable clients.',
        inputSchema: z.object({ routine: z.string().min(1).describe('Routine id or name (see list_routines).') }),
        annotations: { ...WRITE, title: 'Run a routine', openWorldHint: false },
        ...(scopeChallenge ? { scopeChallenge } : {}),
      },
      async ({ routine }, mcp) => {
        const r = findRoutine(await routines.list(), routine);
        if (!r) return { isError: true, content: [{ type: 'text', text: `No routine called “${routine}”. Use list_routines.` }] };
        return runLong(deps, server, mcp, `Starting “${r.name}”…`, async (t, approver) => {
          requireAI(deps.ai);
          const res = await runRoutineOnServer(ctx, deps.ai, r, { kind: 'manual', reason: `Run by ${deps.clientLabel()}` }, approver, {
            signal: t.signal,
            onEvent: (e) => {
              if (e.type === 'tool_start') t.progress(`“${r.name}”: ${e.call.name.replace(/_/g, ' ')}…`);
            },
          });
          await routines.updateState(r.id, (s) => ({ ...s, lastRunAt: ctx.clock(), lastStatus: res.status, ...(res.error ? { lastError: res.error } : {}) }));
          if (res.status === 'error') throw new TaskFailure(res.error ?? 'The routine failed.');
          const changes = res.run.ops.map((o) => `- ${o.summary}`).join('\n');
          return { content: [{ type: 'text', text: `${res.reply || `“${r.name}” finished.`}${changes ? `\n\nChanges (undo them in Inkstone › Activity):\n${changes}` : ''}` }], structuredContent: { routine: r.name, status: res.status, runId: res.run.id, changes: res.run.ops.map((o) => o.summary) } };
        });
      },
    );
  }

  // ---- show_note_page (MCP Apps page view) -----------------------------------------------------------
  server.registerTool(
    'show_note_page',
    {
      title: 'Show a note page',
      description: 'Shows one page of a note as the user wrote it (handwriting, drawings, typed text). Hosts with MCP Apps render the page; others get its text.',
      inputSchema: z.object({ id: IdSchema.describe('Note id.'), page: z.number().int().min(1).default(1).describe('1-based page number (default 1).') }),
      annotations: { ...READ, title: 'Show a note page' },
      _meta: uiToolMeta(NOTE_PAGE_UI),
    },
    async ({ id, page }) => {
      await ctx.refresh();
      const found = await readNoteFresh(ctx, id);
      if (!found) return { isError: true, content: [{ type: 'text', text: `Note not found: ${id}` }] };
      const n = found.note;
      const pageCount = n.pageIds.length;
      const num = Math.min(Math.max(1, page), Math.max(1, pageCount));
      const pageId = n.pageIds[num - 1];
      if (!pageId) return { isError: true, content: [{ type: 'text', text: `“${n.title}” has no pages.` }] };
      const p = await ctx.vault.readPage(id, pageId);
      const text = pageText(p);
      const note = p.strokes.length && !p.recognizedText?.trim() ? '\n\n_(This page has handwriting that has not been converted to text; transcribe_pages or get_page_image can read it.)_' : '';
      return {
        content: [{ type: 'text', text: `“${n.title || 'Untitled'}” — page ${num} of ${pageCount}\n\n${text || '_(no text on this page)_'}${note}` }],
        structuredContent: { noteId: id, title: n.title, page: num, pageCount, text },
        _meta: { [SVG_META_KEY]: await pageSvg(ctx, n, p, { embedAssets: true }) },
      };
    },
  );

  // ---- Approvals (MCP Apps approval card) ---------------------------------------------------------
  server.registerTool(
    'list_pending_approvals',
    {
      title: 'Actions waiting for approval',
      description: 'Actions Inkstone’s background agents (routines, the always-on runner) want to take but are waiting for the user’s OK, such as moving a note to Trash. Hosts with MCP Apps show an approval card with Allow / Don’t allow buttons.',
      inputSchema: z.object({}),
      annotations: { ...READ, title: 'Actions waiting for approval' },
      _meta: uiToolMeta(APPROVALS_UI),
    },
    async () => {
      const list = await deps.approvals.list();
      const lines = list.map((a) => `- ${a.title} (asked by ${a.source}, ${new Date(a.createdAt).toISOString().slice(0, 16).replace('T', ' ')} UTC) — id ${a.id}`);
      return {
        content: [{ type: 'text', text: list.length ? `${list.length} ${list.length === 1 ? 'action is' : 'actions are'} waiting for the user’s OK:\n${lines.join('\n')}\n\nAsk the user before approving any of them.` : 'Nothing is waiting for approval.' }],
        structuredContent: { approvals: list.map((a) => ({ id: a.id, title: a.title, detail: a.detail ?? null, source: a.source, createdAt: a.createdAt })) },
      };
    },
  );

  if (writable) {
    server.registerTool(
      'decide_approval',
      {
        title: 'Approve or decline a pending action',
        description: 'Approves (runs) or declines one pending action from list_pending_approvals. Only call this when the user has explicitly said so for that action.',
        inputSchema: z.object({ id: IdSchema.describe('Approval id.'), approve: z.boolean().describe('true runs the action; false declines it.') }),
        annotations: { title: 'Approve or decline a pending action', readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
        _meta: uiToolMeta(APPROVALS_UI, ['app', 'model']),
        ...(scopeChallenge ? { scopeChallenge } : {}),
      },
      async ({ id, approve }) => {
        const a = await deps.approvals.decide(id, approve, deps.clientLabel(), (x) => executeApproval(ctx, x));
        const text = a.status === 'approved' ? `Done: ${a.title}. It can be undone in Inkstone › Activity.` : a.status === 'denied' ? `Declined: ${a.title}. Nothing was changed.` : `Could not do it: ${a.outcome}`;
        return { content: [{ type: 'text', text }], structuredContent: { approval: { id: a.id, status: a.status, outcome: a.outcome ?? null, title: a.title } }, ...(a.status === 'failed' ? { isError: true } : {}) };
      },
    );
  }
}
