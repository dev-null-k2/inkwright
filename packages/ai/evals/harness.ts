/**
 * A small eval harness for the notes agent. Each case seeds a fresh in-memory vault, gives the
 * agent a user request, and scores the run with weighted checks over the tool calls, the final
 * vault state and the reply. Cases carry a script so they run deterministically offline; the same
 * prompts and checks run against a real model in live mode.
 */
import {
  MemoryNoteToolHost,
  createNoteTools,
  createProvider,
  createScriptedProvider,
  notesAgentSystemPrompt,
  runAgent,
  type AgentEvent,
  type AgentResult,
  type Provider,
  type ScriptStep,
  type ToolRun,
} from '../src/index.ts';

export interface EvalRun {
  result?: AgentResult;
  error?: unknown;
  host: MemoryNoteToolHost;
  /** Ids returned by `setup`, by name. */
  ids: Record<string, string>;
  /** Every tool call the model made (including denied/failed ones). */
  calls: ToolRun[];
  /** Destructive tools the user was asked to confirm. */
  confirmAsked: string[];
  events: AgentEvent[];
  text: string;
}

export interface Check {
  name: string;
  weight?: number;
  test: (run: EvalRun) => boolean | Promise<boolean>;
}

export interface EvalCase {
  id: string;
  description: string;
  prompt: string;
  setup?: (host: MemoryNoteToolHost) => Promise<Record<string, string>>;
  /** Offline model behaviour. Turns may read previous tool results (ctx.toolResults). */
  script: ScriptStep[] | ((ids: Record<string, string>) => ScriptStep[]);
  /** How the simulated user answers a confirmation prompt (default: declines). */
  confirm?: boolean;
  checks: Check[];
  maxSteps?: number;
}

export interface CheckResult {
  name: string;
  pass: boolean;
  weight: number;
}

export interface CaseResult {
  id: string;
  mode: string;
  score: number;
  checks: CheckResult[];
  steps: number;
  tools: string[];
  ms: number;
  error?: string;
}

export const NOW = Date.UTC(2026, 10, 1, 9, 0, 0);

export async function runCase(c: EvalCase, mode: { name: string; provider?: Provider; model: string }): Promise<CaseResult> {
  let t = NOW - 86_400_000;
  const host = await MemoryNoteToolHost.create({ clock: () => (t += 1000) });
  const ids = (await c.setup?.(host)) ?? {};
  const script = typeof c.script === 'function' ? c.script(ids) : c.script;
  const provider = mode.provider ?? createScriptedProvider(script, { fallbackText: 'Done.' });
  const confirmAsked: string[] = [];
  const events: AgentEvent[] = [];
  const run: EvalRun = { host, ids, calls: [], confirmAsked, events, text: '' };
  const started = Date.now();
  try {
    run.result = await runAgent({
      provider,
      model: mode.model,
      system: notesAgentSystemPrompt({ now: new Date(NOW) }),
      messages: [{ role: 'user', content: c.prompt }],
      tools: createNoteTools(host),
      maxSteps: c.maxSteps ?? 8,
      temperature: 0,
      confirm: (call) => {
        confirmAsked.push(call.name);
        return c.confirm ?? false;
      },
      onEvent: (e) => events.push(e),
    });
    run.calls = run.result.toolRuns;
    run.text = run.result.text;
  } catch (e) {
    run.error = e;
  }
  const ms = Date.now() - started;
  const checks: CheckResult[] = [];
  for (const ch of c.checks) {
    let pass = false;
    if (!run.error) {
      try {
        pass = !!(await ch.test(run));
      } catch {
        pass = false;
      }
    }
    checks.push({ name: ch.name, pass, weight: ch.weight ?? 1 });
  }
  const total = checks.reduce((s, x) => s + x.weight, 0);
  const got = checks.reduce((s, x) => s + (x.pass ? x.weight : 0), 0);
  return {
    id: c.id,
    mode: mode.name,
    score: total ? got / total : 0,
    checks,
    steps: run.result?.steps ?? 0,
    tools: run.calls.map((x) => (x.ok ? x.call.name : `${x.call.name}${x.denied ? '(denied)' : '(err)'}`)),
    ms,
    ...(run.error ? { error: (run.error as Error).message ?? String(run.error) } : {}),
  };
}

// ---- Check helpers ----------------------------------------------------------------------------

type Args = Record<string, any>;

export const called = (tool: string, pred?: (args: Args, run: EvalRun) => boolean, name?: string, weight?: number): Check => ({
  name: name ?? `calls ${tool}`,
  weight,
  test: (r) => r.calls.some((c) => c.call.name === tool && (!pred || pred(c.call.arguments as Args, r))),
});

export const notCalled = (tools: string[], name?: string, weight?: number): Check => ({
  name: name ?? `does not call ${tools.join('/')}`,
  weight,
  test: (r) => !r.calls.some((c) => tools.includes(c.call.name)),
});

export const calledOnce = (tool: string, weight?: number): Check => ({
  name: `calls ${tool} once`,
  weight,
  test: (r) => r.calls.filter((c) => c.call.name === tool && c.ok).length === 1,
});

export const replyMatches = (re: RegExp, name?: string, weight?: number): Check => ({ name: name ?? `reply matches ${re}`, weight, test: (r) => re.test(r.text) });

export const state = (name: string, test: (r: EvalRun) => Promise<boolean> | boolean, weight?: number): Check => ({ name, weight, test });

export const WRITE_TOOLS = ['create_note', 'append_to_note', 'update_note', 'create_notebook', 'trash_note'];

/** All non-trashed note text, by title (for state checks). */
export async function noteTexts(host: MemoryNoteToolHost): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const n of await host.listNotes()) {
    const c = await host.readNote(n.id);
    out.set(n.title, c ? c.pages.map((p) => p.text).join('\n') : '');
  }
  return out;
}

// ---- Live mode & reporting ----------------------------------------------------------------------

export interface LiveConfig {
  provider: Provider;
  model: string;
  label: string;
  minScore: number;
}

/** Live mode when INKSTONE_EVAL_PROVIDER / _KEY / _MODEL are set (BASE_URL optional). */
export function liveConfig(env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {}): LiveConfig | null {
  const providerId = env.INKSTONE_EVAL_PROVIDER;
  const model = env.INKSTONE_EVAL_MODEL;
  if (!providerId || !model) return null;
  const provider = createProvider({ providerId, apiKey: env.INKSTONE_EVAL_KEY, baseUrl: env.INKSTONE_EVAL_BASE_URL });
  return { provider, model, label: `${providerId}/${model}`, minScore: Number(env.INKSTONE_EVAL_MIN_SCORE ?? 0) };
}

/** Prints past Vitest's console capture (which hides logs of passing tests by default). */
export function printReport(text: string): void {
  const out = (globalThis as { process?: { stdout?: { write(s: string): unknown } } }).process?.stdout;
  if (out) out.write(text + '\n');
  else console.log(text);
}

export function formatTable(title: string, results: CaseResult[]): string {
  const rows = results.map((r) => {
    const passed = r.checks.filter((c) => c.pass).length;
    return [r.id, r.score.toFixed(2), `${passed}/${r.checks.length}`, String(r.steps), r.tools.join(' → ') || '—', `${r.ms}`];
  });
  const totalChecks = results.reduce((s, r) => s + r.checks.length, 0);
  const passedChecks = results.reduce((s, r) => s + r.checks.filter((c) => c.pass).length, 0);
  const mean = results.length ? results.reduce((s, r) => s + r.score, 0) / results.length : 0;
  rows.push(['TOTAL', mean.toFixed(2), `${passedChecks}/${totalChecks}`, '', `${results.filter((r) => r.score === 1).length}/${results.length} cases perfect`, '']);
  const head = ['case', 'score', 'checks', 'steps', 'tool calls', 'ms'];
  const widths = head.map((h, i) => Math.min(60, Math.max(h.length, ...rows.map((r) => r[i]!.length))));
  const line = (cells: string[]) => cells.map((c, i) => (c.length > widths[i]! ? c.slice(0, widths[i]! - 1) + '…' : c.padEnd(widths[i]!))).join('  ');
  const failures = results.flatMap((r) => (r.error ? [`  ! ${r.id}: ${r.error}`] : r.checks.filter((c) => !c.pass).map((c) => `  ✗ ${r.id}: ${c.name}`)));
  return [`\n${title}`, line(head), widths.map((w) => '─'.repeat(w)).join('  '), ...rows.slice(0, -1).map(line), widths.map((w) => '─'.repeat(w)).join('  '), line(rows.at(-1)!), ...failures, ''].join('\n');
}
