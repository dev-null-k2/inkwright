/**
 * Agent runs on the server, assembled like the app's `prepareAgentRun`: the note tools (recorded
 * in the vault's AI activity so every change can be undone in the app), the user's Agent Skills
 * and memory from the vault, and the approval gate for destructive actions. Used by A2A, the
 * `run_routine` task and the always-on runner, so all three behave the same way.
 */
import {
  AccessControlledNoteToolHost,
  ActivityStore,
  MemoryStore,
  PROPOSAL_NOTICE,
  ProposingNoteToolHost,
  TrustRun,
  guardAgentTools,
  notebookChain,
  type AuditEntry,
  READ_ONLY_NOTE_TOOLS,
  RunRecorder,
  SkillStore,
  builtinSkills,
  createNoteTools,
  createSkillTools,
  memoryPromptSection,
  notesAgentSystemPrompt,
  routineRunContext,
  runAgent,
  skillsPromptSection,
  type ActivityRun,
  type ActivitySource,
  type AgentEvent,
  type AgentResult,
  type AgentTool,
  type ChatMessage,
  type Routine,
  type TriggerEvent,
} from '@inkwright/ai';
import { readNoteFresh, type ServerContext } from '../context.ts';
import { gateDestructive, type Approver, type PendingApproval } from '../approvals.ts';
import type { AgentAI } from './ai.ts';
import { RecordingVaultHost, VaultNoteToolHost } from './host.ts';
import { gateSuspicious } from '../trust.ts';

export interface ServerAgentOptions {
  source: ActivitySource;
  /** Activity label: the routine's name, or "Claude (via A2A)". */
  label: string;
  prompt: string;
  routineId?: string;
  notes: 'read' | 'write';
  skills?: boolean;
  approver: Approver;
  /** Extra system prompt context. */
  context?: string;
  /** More tools (a routine's connected apps through the credential executor). */
  extraTools?: AgentTool[];
}

export interface PreparedServerAgent {
  tools: AgentTool[];
  system: string;
  recorder: RunRecorder;
  host: VaultNoteToolHost;
}

/** Plain-language description of a destructive call, for approval prompts. */
export async function describeCall(ctx: ServerContext, tool: string, args: Record<string, unknown>): Promise<{ title: string; detail?: string }> {
  const id = typeof args.note_id === 'string' ? args.note_id : typeof args.id === 'string' ? args.id : null;
  const note = id ? (await readNoteFresh(ctx, id).catch(() => null))?.note : null;
  const name = note ? `“${note.title || 'Untitled'}”` : id ? `note ${id}` : 'a note';
  if (tool === 'trash_note') return { title: `Move ${name} to Trash`, detail: 'It can be restored from Trash for 30 days.' };
  return { title: `Run ${tool} on ${name}`, detail: JSON.stringify(args).slice(0, 300) };
}

export async function prepareServerAgent(ctx: ServerContext, ai: AgentAI, o: ServerAgentOptions): Promise<PreparedServerAgent> {
  const recorder = new RunRecorder(new ActivityStore(ctx.fs), { source: o.source, label: o.label, prompt: o.prompt, ...(o.routineId ? { routineId: o.routineId } : {}) }, ctx.clock);
  const host = new VaultNoteToolHost(ctx);
  // The policy vault already hides and protects notes; this wrapper tells the run (and the audit
  // trail) which notes the agent read, and dry run turns writes into proposals.
  const policy = ctx.policy.current;
  const run = ai.trust ?? new TrustRun();
  const audit = ctx.trust.audit;
  const proposing = policy.agentWrites[o.source] === 'propose' ? new ProposingNoteToolHost(host, ctx.trust.proposals, { source: o.source, label: o.label }) : null;
  const guarded = new AccessControlledNoteToolHost(proposing ?? host, {
    policy: () => ctx.policy.current,
    labelOf: async (id) => { const n = await ctx.vault.readNote(id); return n ? { id: n.id, title: n.title, notebookIds: notebookChain(n.notebookId, (b) => nbParents.get(b)), tags: n.tags } : null; },
    notebookParent: (id) => nbParents.get(id),
    run,
    audit: (e: AuditEntry) => audit.record(e),
    actor: { source: o.source, label: o.label },
    proposing: !!proposing,
  });
  const nbParents = new Map((await ctx.vault.listNotebooks()).map((b) => [b.id, b.parentId] as const));
  // In dry run nothing is written, so no undoable "Created …" entries; the proposals are listed.
  const recording = new RecordingVaultHost(host, proposing ? () => {} : recorder.record, ctx.clock, guarded);
  const writable = o.notes === 'write' && !ctx.readOnly;
  const noteTools = createNoteTools(recording, writable ? (ai.vision ? {} : { exclude: ['get_page_image'] }) : { include: READ_ONLY_NOTE_TOOLS.filter((t) => ai.vision || t !== 'get_page_image') });
  // Tell the recorder which tool is running so ops name it.
  const named = noteTools.map((t) => ({ ...t, execute: (a: unknown, c: Parameters<AgentTool['execute']>[1]) => { recording.currentTool = t.name; return t.execute(a, c); } }));
  const tools: AgentTool[] = gateDestructive(named, o.approver, (t, a) => describeCall(ctx, t.name, a), { source: o.label, ...(o.routineId ? { routineId: o.routineId } : {}) });
  const sections: string[] = [];
  const memory = await new MemoryStore(ctx.fs, ctx.clock).load().catch(() => []);
  const mem = memoryPromptSection(memory);
  if (mem) sections.push(mem);
  if (o.skills !== false) {
    const store = new SkillStore(ctx.fs, builtinSkills());
    const enabled = await store.enabled().catch(() => []);
    if (enabled.length) {
      tools.push(...createSkillTools(store));
      sections.push(skillsPromptSection(enabled));
    }
  }
  if (o.extraTools?.length) tools.push(...o.extraTools);
  if (proposing) sections.push(PROPOSAL_NOTICE);
  if (o.context) sections.push(o.context);
  // Policy tool rules, and the injection guard: after suspicious content, writes go to the approver.
  const safe = gateSuspicious(guardAgentTools(tools, policy, run), (req) => o.approver({ ...req, source: o.label, ...(o.routineId ? { routineId: o.routineId } : {}) }));
  return { tools: safe, system: notesAgentSystemPrompt({ appName: 'Inkwright', now: new Date(ctx.clock()), extra: sections.join('\n\n') }), recorder, host };
}

export interface ServerAgentRun {
  status: 'done' | 'error' | 'cancelled';
  reply: string;
  error?: string;
  run: ActivityRun;
  result?: AgentResult;
}

/** Runs the agent once and finishes its activity run (always logged, so the user sees it ran). */
export async function runServerAgent(ctx: ServerContext, base: AgentAI, o: ServerAgentOptions & { messages: ChatMessage[]; signal?: AbortSignal; onEvent?: (e: AgentEvent) => void; maxSteps?: number; alwaysLog?: boolean }): Promise<ServerAgentRun> {
  // A fresh trust run per agent run: the notes it reads and any injection taint are its own.
  const ai = base.forRun?.({ source: o.source, label: o.label }) ?? base;
  const prep = await prepareServerAgent(ctx, ai, o);
  try {
    const result = await runAgent({ provider: ai.provider, model: ai.model, system: prep.system, messages: o.messages, tools: prep.tools, maxSteps: o.maxSteps ?? 16, signal: o.signal, onEvent: o.onEvent, stream: false });
    const run = await prep.recorder.finish('done', { reply: result.text, alwaysLog: o.alwaysLog });
    return { status: 'done', reply: result.text, run, result };
  } catch (e) {
    const cancelled = !!o.signal?.aborted;
    const error = cancelled ? undefined : (e as Error)?.message ?? String(e);
    const run = await prep.recorder.finish(cancelled ? 'cancelled' : 'error', { error, alwaysLog: o.alwaysLog });
    return { status: cancelled ? 'cancelled' : 'error', reply: '', error, run };
  }
}

/**
 * One routine run, like the app's `runRoutine`: the routine's prompt and tools, the run context
 * (why it started, when it last ran), logged as a routine run in Activity.
 */
export async function runRoutineOnServer(ctx: ServerContext, ai: AgentAI | null, r: Routine, ev: TriggerEvent, approver: Approver, opts: { signal?: AbortSignal; onEvent?: (e: AgentEvent) => void } = {}): Promise<ServerAgentRun> {
  if (!ai) {
    const rec = new RunRecorder(new ActivityStore(ctx.fs), { source: 'routine', label: r.name, routineId: r.id, prompt: ev.reason }, ctx.clock);
    const error = 'No AI is set up for the Inkwright agent. Start it with --ai-provider (see docs/AGENTS.md).';
    return { status: 'error', reply: '', error, run: await rec.finish('error', { error, alwaysLog: true }) };
  }
  // Connected apps: their read-only tools through the credential executor when it holds a token
  // for them (creds/agent.ts); otherwise the routine is told to skip those steps.
  const apps = r.tools.mcpServers.length && ai.connectorTools ? await ai.connectorTools(r.tools.mcpServers, { source: 'routine', label: r.name }).catch(() => ({ tools: [], missing: r.tools.mcpServers })) : { tools: [], missing: r.tools.mcpServers };
  const extra = apps.missing.length
    ? `\n${apps.tools.length ? 'Some connected apps are' : 'Connected apps are'} not available when the routine runs outside the Inkwright app; skip steps that need them and say so.${apps.tools.length ? ' The apps that are available offer only tools that read.' : ''}`
    : apps.tools.length ? '\nConnected apps are available here only with tools that read; skip steps that would change something in them and say so.' : '';
  return runServerAgent(ctx, ai, {
    source: 'routine',
    label: r.name,
    routineId: r.id,
    prompt: ev.reason,
    notes: r.tools.notes,
    skills: r.tools.skills,
    approver,
    context: routineRunContext(r, ev, ctx.clock()) + extra,
    ...(apps.tools.length ? { extraTools: apps.tools } : {}),
    messages: [{ role: 'user', content: r.prompt }],
    signal: opts.signal,
    onEvent: opts.onEvent,
    alwaysLog: true,
  });
}

/** Finds a routine by id or (case-insensitive) name. */
export function findRoutine(list: Routine[], ref: string): Routine | null {
  const want = ref.trim().toLowerCase();
  return list.find((r) => r.id === ref) ?? list.find((r) => r.name.trim().toLowerCase() === want) ?? null;
}

/**
 * Runs a deferred call once its approval is given, logged as its own Activity run (labelled with
 * the routine or agent that asked) so it can be undone like any other change.
 */
export async function executeApproval(ctx: ServerContext, a: PendingApproval): Promise<string> {
  const recorder = new RunRecorder(new ActivityStore(ctx.fs), { source: a.routineId ? 'routine' : 'external', label: a.source, prompt: `Approved: ${a.title}`, ...(a.routineId ? { routineId: a.routineId } : {}) }, ctx.clock);
  const host = new RecordingVaultHost(new VaultNoteToolHost(ctx), recorder.record, ctx.clock);
  host.currentTool = a.tool;
  const tool = createNoteTools(host).find((t) => t.name === a.tool);
  if (!tool) throw new Error(`The approved action (${a.tool}) is not something the agent can do.`);
  try {
    const out = await tool.execute(a.args, { toolCallId: `approval_${a.id}`, messages: [] });
    await recorder.finish('done', { reply: `Done: ${a.title}`, alwaysLog: true });
    return typeof out === 'string' ? out : `Done: ${a.title}.`;
  } catch (e) {
    await recorder.finish('error', { error: (e as Error).message, alwaysLog: true });
    throw e;
  }
}
