import { AIError, abortError } from './errors.ts';
import { validateArgs } from './schema.ts';
import type { ChatMessage, ChatRequest, ChatResult, ContentPart, Provider, StopReason, ToolCall, ToolDef, Usage } from './types.ts';

export interface ToolContext {
  signal?: AbortSignal;
  toolCallId: string;
  /** Messages so far (read-only snapshot). */
  messages: readonly ChatMessage[];
}

/** A tool the agent can run. `execute` returns plain data (JSON-serialized), a string, or a RichToolResult. */
export interface AgentTool<A = any> extends ToolDef {
  execute(args: A, ctx: ToolContext): Promise<unknown>;
  /** Changes or deletes user data irreversibly: the UI must confirm before it runs. */
  destructive?: boolean;
  /** Only reads data (UI may auto-approve, show it quieter). */
  readOnly?: boolean;
}

/** A tool result with images (e.g. a page rendering for vision models). */
export interface RichToolResult {
  kind: 'inkstone.rich-result';
  parts: ContentPart[];
}

export function richResult(parts: ContentPart[]): RichToolResult {
  return { kind: 'inkstone.rich-result', parts };
}

export function isRichResult(v: unknown): v is RichToolResult {
  return !!v && typeof v === 'object' && (v as RichToolResult).kind === 'inkstone.rich-result' && Array.isArray((v as RichToolResult).parts);
}

export type AgentEvent =
  | { type: 'step_start'; step: number }
  | { type: 'text'; delta: string; step: number }
  | { type: 'tool_start'; call: ToolCall; step: number; destructive: boolean }
  | { type: 'tool_result'; call: ToolCall; result: unknown; step: number; durationMs: number }
  | { type: 'tool_error'; call: ToolCall; error: string; step: number; denied?: boolean }
  | { type: 'step_end'; step: number; result: ChatResult }
  | { type: 'done'; result: AgentResult };

export interface ToolRun {
  call: ToolCall;
  step: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  denied?: boolean;
}

export interface AgentResult {
  /** Final assistant text (the last step's text). */
  text: string;
  /** Full transcript: the input messages plus everything the agent added. */
  messages: ChatMessage[];
  /** Only the messages added by this run. */
  newMessages: ChatMessage[];
  steps: number;
  toolRuns: ToolRun[];
  usage: Usage;
  stopReason: 'done' | 'max_steps' | StopReason;
}

export interface RunAgentOptions {
  provider: Provider;
  model: string;
  system?: string;
  messages: ChatMessage[];
  tools?: AgentTool[];
  /** Model calls before giving up (default 8). */
  maxSteps?: number;
  signal?: AbortSignal;
  onEvent?: (e: AgentEvent) => void;
  temperature?: number;
  maxTokens?: number;
  /**
   * Asked before a `destructive` tool runs. Without it destructive tools are refused (the model is
   * told to ask the user to do it themselves) — never silently executed.
   */
  confirm?: (call: ToolCall, tool: AgentTool) => Promise<boolean> | boolean;
  /** Run several tool calls of one step concurrently (default true). */
  parallelTools?: boolean;
  /** Tool results longer than this are truncated before going back to the model (default 24k chars). */
  maxToolResultChars?: number;
  /** Stream model output (default true). */
  stream?: boolean;
}

function serialize(result: unknown, max: number): ContentPart[] {
  if (isRichResult(result)) {
    return result.parts.map((p) => (p.type === 'text' ? { type: 'text' as const, text: truncate(p.text, max) } : p));
  }
  let s: string;
  if (typeof result === 'string') s = result;
  else if (result === undefined) s = 'Done.';
  else {
    try {
      s = JSON.stringify(result);
    } catch {
      s = String(result);
    }
  }
  return [{ type: 'text', text: truncate(s, max) }];
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}\n…[truncated ${s.length - max} characters]`;
}

function errorMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}

/**
 * The agent loop: model turn → run requested tools (validated, confirmed when destructive, in
 * parallel) → feed results back → repeat until the model answers without tools or `maxSteps`.
 * Tool failures are returned to the model as error results; only provider errors and aborts throw.
 */
export async function runAgent(opts: RunAgentOptions): Promise<AgentResult> {
  const maxSteps = Math.max(1, opts.maxSteps ?? 8);
  const tools = opts.tools ?? [];
  const byName = new Map(tools.map((t) => [t.name, t]));
  const maxChars = opts.maxToolResultChars ?? 24_000;
  const emit = (e: AgentEvent) => {
    try {
      opts.onEvent?.(e);
    } catch {
      /* a UI handler must not break the loop */
    }
  };
  const base: ChatMessage[] = opts.system ? [{ role: 'system', content: opts.system }, ...opts.messages.filter((m) => m.role !== 'system')] : [...opts.messages];
  const transcript: ChatMessage[] = [...base];
  const added: ChatMessage[] = [];
  const toolRuns: ToolRun[] = [];
  const usage: Usage = { inputTokens: 0, outputTokens: 0 };
  const toolDefs: ToolDef[] = tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  let text = '';
  let stopReason: AgentResult['stopReason'] = 'done';
  let step = 0;

  const push = (m: ChatMessage) => {
    transcript.push(m);
    added.push(m);
  };

  const runTool = async (call: ToolCall): Promise<{ message: ChatMessage; run: ToolRun }> => {
    const tool = byName.get(call.name);
    const fail = (error: string, denied = false) => {
      emit({ type: 'tool_error', call, error, step, ...(denied ? { denied } : {}) });
      const run: ToolRun = { call, step, ok: false, error, ...(denied ? { denied } : {}) };
      const message: ChatMessage = { role: 'tool', toolCallId: call.id, name: call.name, content: `Error: ${error}`, isError: true };
      return { message, run };
    };
    emit({ type: 'tool_start', call, step, destructive: !!tool?.destructive });
    if (!tool) return fail(`Unknown tool "${call.name}". Available tools: ${tools.map((t) => t.name).join(', ') || 'none'}.`);
    if (call.invalidArguments !== undefined) return fail(`The arguments were not valid JSON: ${call.invalidArguments.slice(0, 200)}. Call the tool again with a JSON object.`);
    const v = validateArgs(tool.parameters, call.arguments);
    if (!v.ok) return fail(`Invalid arguments for ${tool.name}: ${v.errors.join('; ')}. Fix them and call the tool again.`);
    if (tool.destructive) {
      let ok = false;
      if (opts.confirm) {
        try {
          ok = await opts.confirm(call, tool);
        } catch {
          ok = false;
        }
      }
      if (opts.signal?.aborted) throw abortError(opts.provider.id, opts.signal.reason);
      if (!ok) {
        return fail(
          opts.confirm
            ? 'The user declined this action. Do not retry it; tell the user it was not done.'
            : 'This action needs the user’s confirmation, which is not available here. Do not retry; tell the user what you would do so they can do it themselves.',
          true,
        );
      }
    }
    const started = Date.now();
    try {
      const result = await tool.execute(v.value, { signal: opts.signal, toolCallId: call.id, messages: transcript.slice() });
      if (opts.signal?.aborted) throw abortError(opts.provider.id, opts.signal.reason);
      emit({ type: 'tool_result', call, result, step, durationMs: Date.now() - started });
      return { message: { role: 'tool', toolCallId: call.id, name: call.name, content: serialize(result, maxChars) }, run: { call, step, ok: true, result } };
    } catch (e) {
      if (opts.signal?.aborted || (e instanceof AIError && e.code === 'aborted')) throw abortError(opts.provider.id, e);
      return fail(errorMessage(e));
    }
  };

  while (step < maxSteps) {
    if (opts.signal?.aborted) throw abortError(opts.provider.id, opts.signal.reason);
    step++;
    emit({ type: 'step_start', step });
    const req: ChatRequest = { model: opts.model, messages: transcript.slice(), signal: opts.signal };
    if (toolDefs.length) req.tools = toolDefs;
    if (opts.temperature !== undefined) req.temperature = opts.temperature;
    if (opts.maxTokens !== undefined) req.maxTokens = opts.maxTokens;
    const stream = opts.stream !== false;
    const s = step;
    const result = await opts.provider.chat(req, stream ? (e) => (e.type === 'text' ? emit({ type: 'text', delta: e.delta, step: s }) : undefined) : undefined);
    if (!stream && result.text) emit({ type: 'text', delta: result.text, step });
    if (result.usage) {
      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
    }
    text = result.text;
    const assistant: ChatMessage = { role: 'assistant', content: result.text };
    if (result.toolCalls.length) assistant.toolCalls = result.toolCalls;
    push(assistant);
    emit({ type: 'step_end', step, result });
    if (!result.toolCalls.length) {
      stopReason = result.stopReason === 'stop' || result.stopReason === 'tool_calls' ? 'done' : result.stopReason;
      break;
    }
    const replies =
      opts.parallelTools === false
        ? await result.toolCalls.reduce<Promise<Array<{ message: ChatMessage; run: ToolRun }>>>(async (acc, c) => [...(await acc), await runTool(c)], Promise.resolve([]))
        : await Promise.all(result.toolCalls.map(runTool));
    // Results go back (and are recorded) in call order, whatever order they finished in.
    for (const r of replies) {
      toolRuns.push(r.run);
      push(r.message);
    }
    if (step >= maxSteps) stopReason = 'max_steps';
  }

  const out: AgentResult = { text, messages: transcript, newMessages: added, steps: step, toolRuns, usage, stopReason };
  emit({ type: 'done', result: out });
  return out;
}

export interface AskOptions {
  system?: string;
  images?: Array<{ mediaType: string; data: string }>;
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  json?: boolean;
  /** Streams text as it arrives. */
  onText?: (delta: string, soFar: string) => void;
}

/** One question, one answer: the simplest way to use any provider. */
export async function askOnce(provider: Provider, model: string, prompt: string | ContentPart[], opts: AskOptions = {}): Promise<string> {
  const parts: ContentPart[] = typeof prompt === 'string' ? [{ type: 'text', text: prompt }] : [...prompt];
  for (const im of opts.images ?? []) parts.push({ type: 'image', mediaType: im.mediaType, data: im.data });
  const messages: ChatMessage[] = [];
  if (opts.system) messages.push({ role: 'system', content: opts.system });
  messages.push({ role: 'user', content: parts.length === 1 && parts[0]!.type === 'text' ? parts[0]!.text : parts });
  const req: ChatRequest = { model, messages, signal: opts.signal };
  if (opts.temperature !== undefined) req.temperature = opts.temperature;
  if (opts.maxTokens !== undefined) req.maxTokens = opts.maxTokens;
  if (opts.json) req.json = true;
  let soFar = '';
  const onText = opts.onText;
  const r = await provider.chat(
    req,
    onText
      ? (e) => {
          if (e.type === 'text') {
            soFar += e.delta;
            onText(e.delta, soFar);
          }
        }
      : undefined,
  );
  return r.text;
}
