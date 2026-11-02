/**
 * The choke point. Every model call Inkwright makes — the assistant panel, routines, Ask, smart
 * ink, notes that listen, the MCP server's tasks, the A2A agent and the runner — goes through a
 * provider made by `createGuardedProvider`. Callers keep using the plain `Provider` interface;
 * on each `chat()` the guard, in order:
 *
 * 1. **routes** the call by the AI policy (`decideRoute`: the task's route, local-only notes the
 *    run has read, the provider's monthly budget) and refuses calls the policy forbids;
 * 2. **scans** new tool results for prompt-injection signs (taint for the tool-call guard);
 * 3. **shortens** large tool results and passages (`ContextBudgeter`), keeping originals on the
 *    device and answering the model's `retrieve_original` calls itself;
 * 4. **spotlights** untrusted content (delimited, with a system rule);
 * 5. **redacts** personal data and secrets before a cloud call and **rehydrates** the answer,
 *    streamed text and tool-call arguments;
 * 6. **meters** tokens, cost and savings, and writes an **audit** event saying which notes the
 *    call carried, where it went and why.
 *
 * Calls that stay on the device skip redaction (nothing leaves) but are still routed, metered
 * (as free) and audited.
 */
import { isPolicyBlocked, PolicyBlockedError, decideRoute, inferTask, toolAllowed, type AIPolicy, type RouteDecision, type TaskKind } from './policy.ts';
import { ContextBudgeter, RETRIEVE_TOOL_DEF, RETRIEVE_TOOL_NAME, estimateMessagesTokens, type BudgetOptions, type ContentStore } from './compress.ts';
import { Redactor, type NameDetector } from './pii.ts';
import { newSpotlightMarker, spotlightInstructions, spotlightMessages } from './injection.ts';
import { TrustRun } from './access.ts';
import { costUsd, priceFor, type UsageStore } from './meter.ts';
import type { AuditActor, AuditLog } from './audit.ts';
import type { AgentTool } from '../agent.ts';
import { hasImages, textOf, type ChatMessage, type ChatRequest, type ChatResult, type ContentPart, type Provider, type StreamHandler, type ToolCall } from '../types.ts';

/** A concrete place a call can go. */
export interface Route {
  provider: Provider;
  model: string;
  label: string;
  /** Runs on this device (nothing leaves it). */
  local: boolean;
  /** The key budgets and usage rows use (provider config id in the app, provider id on the server). */
  budgetKey: string;
  vision: boolean;
}

/** Long-lived services the guard reports to (one set per app / server process). */
export interface TrustServices {
  policy: () => AIPolicy;
  /** Where originals of shortened blocks are kept (on this device only). */
  originals: ContentStore;
  usage?: UsageStore | null;
  audit?: AuditLog | null;
  /** Optional extra name recognizer (an on-device model). */
  names?: NameDetector;
  /** Optional summarizer on the device for prose (policy `compression.deviceSummaries`). */
  summarize?: BudgetOptions['summarize'];
}

export interface GuardOptions {
  services: TrustServices;
  /** What kind of work this is; inferred per request (images → vision) when omitted. */
  task?: TaskKind;
  actor: AuditActor;
  /** Shared with the access-controlled note host for agent runs; one is made otherwise. */
  run?: TrustRun;
  /** Turns a decision into a concrete route; null when the target isn't available here. */
  resolve: (target: RouteDecision['target']) => Promise<Route | null>;
}

export type GuardedProvider = Provider & {
  readonly trust: TrustRun;
  /** The route the last call took (for "answered by …" labels). */
  readonly lastRoute: Route | null;
};

const lastUserText = (messages: readonly ChatMessage[]) => {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === 'user') return textOf(messages[i]!.content).slice(0, 2000);
  return '';
};

async function redactMessages(messages: ChatMessage[], r: Redactor): Promise<ChatMessage[]> {
  const out: ChatMessage[] = [];
  for (const m of messages) {
    let content: string | ContentPart[];
    if (typeof m.content === 'string') content = await r.redact(m.content);
    else {
      content = [];
      for (const p of m.content) content.push(p.type === 'text' ? { type: 'text', text: await r.redact(p.text) } : p);
    }
    const next: ChatMessage = { ...m, content };
    if (m.toolCalls?.length) {
      next.toolCalls = [];
      for (const c of m.toolCalls) next.toolCalls.push({ ...c, arguments: JSON.parse(await r.redact(JSON.stringify(c.arguments))) as Record<string, unknown> });
    }
    out.push(next);
  }
  return out;
}

function withSystem(messages: ChatMessage[], extra: string): ChatMessage[] {
  const i = messages.findIndex((m) => m.role === 'system');
  if (i < 0) return [{ role: 'system', content: extra }, ...messages];
  const m = messages[i]!;
  return messages.map((x, k) => (k === i ? { ...m, content: `${textOf(m.content)}\n\n${extra}` } : x));
}

/** Drops images when a call was moved to a route that can't see them (the model is told). */
function withoutImages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => (typeof m.content === 'string' || !m.content.some((p) => p.type === 'image') ? m : { ...m, content: [...m.content.filter((p) => p.type === 'text'), { type: 'text', text: '[An image was left out: this request has to stay on this device, and the model here cannot see images.]' }] }));
}

/**
 * Wraps the routing, firewall, budgeter, meter and audit around a model call. See the module
 * comment for the order of operations.
 */
export function createGuardedProvider(o: GuardOptions): GuardedProvider {
  const run = o.run ?? new TrustRun();
  const svc = o.services;
  let redactor: Redactor | null = null;
  let budgeter: ContextBudgeter | null = null;
  const marker = newSpotlightMarker();
  let lastRoute: Route | null = null;

  const audit = (e: Parameters<AuditLog['record']>[0]) => svc.audit?.record({ actor: o.actor, ...e });
  const notesRef = () => [...run.notes.values()].slice(0, 200).map((n) => ({ id: n.id, ...(n.title ? { title: n.title } : {}) }));

  const block = (message: string, reason: PolicyBlockedError['reason'], task: TaskKind, route?: Route | null): never => {
    audit({ kind: 'blocked', summary: message, task, notes: notesRef(), outcome: 'blocked', ...(route ? { provider: route.budgetKey, model: route.model } : {}) });
    if (route) svc.usage?.record({ at: Date.now(), provider: route.budgetKey, label: route.label, model: route.model, local: route.local, inputTokens: 0, outputTokens: 0, uncompressedInputTokens: 0, redactions: 0, blocked: true });
    throw new PolicyBlockedError(message, reason);
  };

  async function pickRoute(policy: AIPolicy, task: TaskKind): Promise<{ route: Route; decision: RouteDecision }> {
    let decision = decideRoute(policy, task, run.notes.values());
    if (decision.target === 'off') block(decision.why, 'route', task);
    let route = await o.resolve(decision.target);
    if (!route) {
      block(decision.target === 'device'
        ? `${decision.why} No model is available on this device — install one in Settings › AI › On this device, or change the rule in Settings › Privacy & trust › Routing & privacy.`
        : `${decision.why} That AI isn’t available right now.`, 'unavailable', task);
    }
    // Budgets: the month's spend on this provider (every device) against its limit.
    const budget = !route!.local ? (policy.budgets[route!.budgetKey] ?? policy.budgets[route!.provider.id]) : undefined;
    if (budget && svc.usage) {
      const spent = await svc.usage.spent(policy.budgets[route!.budgetKey] ? route!.budgetKey : route!.provider.id).catch(() => 0);
      if (spent >= budget.monthlyUsd) {
        const over = `${route!.label} has reached its monthly budget ($${budget.monthlyUsd.toFixed(2)}; $${spent.toFixed(2)} used).`;
        if (budget.onExceed === 'device') {
          const local = await o.resolve('device');
          if (!local) block(`${over} The policy moves work to this device, but no model is installed here.`, 'budget', task, route);
          decision = { ...decision, target: 'device', why: `${over} Moved to this device.` };
          route = local;
        } else block(`${over} Raise it in Settings › Privacy & trust › Routing & privacy, or wait for next month.`, 'budget', task, route);
      }
    }
    return { route: route!, decision };
  }

  async function chat(req: ChatRequest, onEvent?: StreamHandler): Promise<ChatResult> {
    const policy = svc.policy();
    const task = o.task ?? inferTask({ hasImages: hasImages(req.messages), tools: !!req.tools?.length });
    const { route, decision } = await pickRoute(policy, task);
    lastRoute = route;

    // 2. Injection taint, on the raw tool results.
    const fresh = run.taint.scan(req.messages);
    if (fresh.length) audit({ kind: 'blocked', summary: `Content that looks like a prompt injection entered this run (${[...new Set(fresh.map((s) => s.rule))].join(', ')}); writes now need your OK.`, outcome: 'ok', data: { signals: fresh.map((s) => s.rule) } });

    // 3. Budgeter.
    const original = route.vision || !hasImages(req.messages) ? req.messages : withoutImages(req.messages);
    let messages = original;
    const tools = req.tools ? req.tools.filter((t) => toolAllowed(policy, t.name)) : undefined;
    const canRetrieve = !!tools?.length;
    let shortened = 0;
    if (policy.compression.enabled) {
      budgeter ??= new ContextBudgeter(svc.originals, { minTokens: policy.compression.minTokens, ...(policy.compression.deviceSummaries && svc.summarize ? { summarize: svc.summarize } : {}) });
      const r = await budgeter.apply(messages, { canRetrieve, query: lastUserText(messages) });
      messages = r.messages;
      shortened = r.items.filter((i) => i.ref).length;
    }
    // 4. Spotlighting.
    if (policy.injection.spotlight && messages.some((m) => m.role === 'tool')) {
      messages = withSystem(spotlightMessages(messages, marker), spotlightInstructions(marker));
    }
    // 5. Privacy firewall (cloud only).
    const redacting = !route.local && policy.privacy.mode === 'redact';
    const before = { ...(redactor?.report.counts ?? {}) } as Record<string, number>;
    if (redacting) {
      redactor ??= new Redactor(policy.privacy, svc.names);
      try {
        messages = await redactMessages(messages, redactor);
      } catch (e) {
        if (isPolicyBlocked(e)) block((e as Error).message, 'privacy', task, route);
        throw e;
      }
    }
    const outTools = shortened && canRetrieve && !tools!.some((t) => t.name === RETRIEVE_TOOL_NAME) ? [...tools!, RETRIEVE_TOOL_DEF] : tools;

    // The call, with retrieve_original answered here (up to three rounds).
    const stream = onEvent && redactor && redacting ? redactor.streamRehydrator() : null;
    const emit: StreamHandler | undefined = onEvent
      ? (e) => {
          if (e.type === 'text') {
            const d = stream ? stream.push(e.delta) : e.delta;
            if (d) onEvent({ type: 'text', delta: d });
          } else if (e.type === 'tool_call') {
            if (e.call.name !== RETRIEVE_TOOL_NAME) onEvent({ type: 'tool_call', call: redacting && redactor ? { ...e.call, arguments: redactor.rehydrateValue(e.call.arguments) } : e.call });
          }
        }
      : undefined;
    let convo = messages;
    let result: ChatResult;
    let inputTokens = 0;
    let outputTokens = 0;
    let reportedUsage = true;
    for (let round = 0; ; round++) {
      const r: ChatRequest = { ...req, model: route.model, messages: convo };
      if (outTools) r.tools = outTools;
      else delete r.tools;
      try {
        result = await route.provider.chat(r, emit);
      } catch (e) {
        audit({ kind: 'ai_call', provider: route.budgetKey, model: route.model, local: route.local, task, route: decision.why, notes: notesRef(), outcome: 'error', error: (e as Error).message?.slice(0, 300) });
        throw e;
      }
      if (result.usage) {
        inputTokens += result.usage.inputTokens;
        outputTokens += result.usage.outputTokens;
      } else {
        reportedUsage = false;
        inputTokens += estimateMessagesTokens(convo);
        outputTokens += Math.ceil(result.text.length / 4);
      }
      const retrieves = result.toolCalls.filter((c) => c.name === RETRIEVE_TOOL_NAME);
      if (!retrieves.length || !budgeter || round >= 3) break;
      const replies: ChatMessage[] = [];
      for (const c of retrieves) {
        const got = await budgeter.retrieve(c.arguments);
        let text = got.text;
        if (policy.injection.spotlight) text = spotlightMessages([{ role: 'tool', content: text, name: RETRIEVE_TOOL_NAME }], marker)[0]!.content as string;
        if (redacting && redactor) text = await redactor.redact(text);
        replies.push({ role: 'tool', toolCallId: c.id, name: RETRIEVE_TOOL_NAME, content: text, ...(got.ok ? {} : { isError: true }) });
      }
      convo = [...convo, { role: 'assistant', content: result.text, toolCalls: retrieves }, ...replies];
    }
    if (stream && onEvent) {
      const tail = stream.flush();
      if (tail) onEvent({ type: 'text', delta: tail });
    }
    const toolCalls: ToolCall[] = result!.toolCalls.filter((c) => c.name !== RETRIEVE_TOOL_NAME).map((c) => (redacting && redactor ? { ...c, arguments: redactor.rehydrateValue(c.arguments) } : c));
    const final: ChatResult = { ...result!, text: redacting && redactor ? redactor.rehydrate(result!.text) : result!.text, toolCalls, usage: { inputTokens, outputTokens } };
    if (final.stopReason === 'tool_calls' && !toolCalls.length) final.stopReason = 'stop';

    // 6. Meter and audit.
    const saved = Math.max(0, estimateMessagesTokens(original) - estimateMessagesTokens(messages));
    const delta: Record<string, number> = {};
    for (const [k, n] of Object.entries(redactor?.report.counts ?? {})) if ((n ?? 0) > (before[k] ?? 0)) delta[k] = (n ?? 0) - (before[k] ?? 0);
    const redactions = Object.values(delta).reduce((a, b) => a + b, 0);
    svc.usage?.record({ at: Date.now(), provider: route.budgetKey, label: route.label, model: route.model, local: route.local, inputTokens, outputTokens, uncompressedInputTokens: inputTokens + saved, redactions });
    const cost = route.local ? 0 : costUsd(priceFor(policy, route.model), inputTokens, outputTokens);
    audit({
      kind: 'ai_call',
      provider: route.budgetKey,
      model: route.model,
      local: route.local,
      task,
      route: decision.why,
      notes: notesRef(),
      ...(redactions > 0 ? { redactions: delta } : {}),
      tokens: { input: inputTokens, output: outputTokens, ...(saved ? { uncompressed: inputTokens + saved } : {}) },
      costUsd: cost,
      outcome: 'ok',
      ...(reportedUsage ? {} : { data: { estimatedTokens: true } }),
    });
    return final;
  }

  const first = { label: 'AI', id: 'guarded' };
  return {
    get id() { return lastRoute?.provider.id ?? first.id; },
    get label() { return lastRoute?.label ?? first.label; },
    capabilities: { vision: true, tools: true, streaming: true, listModels: false, json: true },
    chat,
    trust: run,
    get lastRoute() { return lastRoute; },
  } as GuardedProvider;
}

/**
 * The agent's tools as the policy allows them: denied tools are removed, and — once content that
 * looks like an injection has entered the run — every tool that is not read-only asks the user
 * first (`needsConfirmation`, checked by `runAgent` before each call).
 */
export function guardAgentTools(tools: readonly AgentTool[], policy: AIPolicy, run: TrustRun): AgentTool[] {
  if (policy.injection.confirmWritesAfterAnyRead) run.taint.strict = true;
  return tools.filter((t) => toolAllowed(policy, t.name)).map((t) => {
    if ((!policy.injection.confirmWritesAfterSuspicious && !policy.injection.confirmWritesAfterAnyRead) || t.readOnly) return t;
    const inner = t.needsConfirmation;
    return {
      ...t,
      execute: t.execute.bind(t),
      needsConfirmation: (args: unknown) => run.taint.needsConfirmation(t) || !!inner?.(args),
      get confirmReason() {
        if (run.taint.suspicious) return 'Something the assistant read looks like instructions planted for it, so it asks before changing anything.';
        if (run.taint.strict && run.taint.sawUntrusted) return 'Your AI policy asks before any change once the assistant has read notes, pages or app results.';
        return t.confirmReason;
      },
    } as AgentTool;
  });
}
