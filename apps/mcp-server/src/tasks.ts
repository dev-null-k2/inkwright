/**
 * Server side of the MCP Tasks extension (`io.modelcontextprotocol/tasks`, protocol 2026-07-28;
 * spec: modelcontextprotocol.github.io/ext-tasks). Long-running tools — summarize a notebook,
 * transcribe pages, run a routine — answer `tools/call` with a task handle instead of blocking:
 *
 *   tools/call → { resultType: "task", taskId, status: "working", … }
 *   tasks/get → status, statusMessage (progress), inputRequests while `input_required`,
 *               `result` once completed, `error` if failed
 *   tasks/update { inputResponses } → answers input requests (approvals)
 *   tasks/cancel → cooperative cancel (the work's AbortSignal fires)
 *
 * The SDK (v2.4) negotiates the protocol and lets these methods through when registered with a
 * schema, but has no task runtime, so this module is that runtime: an in-memory registry shared
 * by every request the process serves (stateless HTTP creates a server per request; tasks outlive
 * them). Tasks live until their TTL (default one hour after creation), which the spec allows:
 * a purged task is reported as unknown. Task ids are random and bound to the principal that made
 * them, so another signed-in client can't read or steer someone else's task.
 *
 * Clients that don't declare the extension never get a task (the spec forbids it); they get the
 * same work run inline, see `runInline`.
 */
import { randomUUID } from 'node:crypto';
import type { CallToolResult } from '@modelcontextprotocol/server';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';

export type TaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

/** A request the server embeds in `inputRequests` (same shape as a standalone request). */
export interface InputRequest {
  method: string;
  params?: Record<string, unknown>;
}

/** What `tasks/get` returns (minus `resultType`, added by the wire layer). */
export interface TaskView {
  taskId: string;
  status: TaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
  inputRequests?: Record<string, InputRequest>;
  result?: CallToolResult;
  error?: { code: number; message: string; data?: unknown };
}

/** Handed to the work function: progress, input requests and cancellation. */
export interface TaskControl {
  readonly signal: AbortSignal;
  /** Progress the client sees as `statusMessage` (Tasks has no progress notifications). */
  progress(message: string): void;
  /**
   * Moves the task to `input_required` with this request under `key` and waits for the client's
   * `tasks/update`. Keys are never reused within a task, as the spec requires.
   */
  ask(key: string, request: InputRequest): Promise<unknown>;
}

interface Entry {
  view: TaskView;
  owner: string;
  createdMs: number;
  abort: AbortController;
  waiting: Map<string, { request: InputRequest; resolve: (v: unknown) => void; reject: (e: unknown) => void }>;
  usedKeys: Set<string>;
}

export interface TaskRegistryOptions {
  clock?: () => number;
  /** Lifetime from creation (default 1 h). */
  ttlMs?: number;
  /** Suggested polling interval (default 1 s). */
  pollIntervalMs?: number;
}

/** An error the work function can throw to fail the task with a JSON-RPC error. */
export class TaskFailure extends Error {
  constructor(message: string, readonly code = -32603) {
    super(message);
  }
}

export class TaskRegistry {
  private tasks = new Map<string, Entry>();
  private clock: () => number;
  readonly ttlMs: number;
  readonly pollIntervalMs: number;

  constructor(opts: TaskRegistryOptions = {}) {
    this.clock = opts.clock ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 3_600_000;
    this.pollIntervalMs = opts.pollIntervalMs ?? 1000;
  }

  private iso() {
    return new Date(this.clock()).toISOString();
  }

  private purge() {
    const now = this.clock();
    for (const [id, e] of this.tasks) {
      if (now - e.createdMs > this.ttlMs) {
        e.abort.abort();
        for (const w of e.waiting.values()) w.reject(new Error('Task expired'));
        this.tasks.delete(id);
      }
    }
  }

  private touch(e: Entry, patch: Partial<TaskView>) {
    if (e.view.status === 'completed' || e.view.status === 'failed' || e.view.status === 'cancelled') return; // terminal states never change
    Object.assign(e.view, patch, { lastUpdatedAt: this.iso() });
  }

  /**
   * Creates a task that runs `work` in the background and returns its initial view (the task is
   * registered before this returns, so an immediate `tasks/get` finds it).
   */
  start(owner: string, work: (t: TaskControl) => Promise<CallToolResult>, initialMessage = 'Starting…'): TaskView {
    this.purge();
    const now = this.iso();
    const e: Entry = {
      view: { taskId: randomUUID(), status: 'working', statusMessage: initialMessage, createdAt: now, lastUpdatedAt: now, ttlMs: this.ttlMs, pollIntervalMs: this.pollIntervalMs },
      owner,
      createdMs: this.clock(),
      abort: new AbortController(),
      waiting: new Map(),
      usedKeys: new Set(),
    };
    this.tasks.set(e.view.taskId, e);
    const control: TaskControl = {
      signal: e.abort.signal,
      progress: (message) => this.touch(e, { statusMessage: message }),
      ask: (key, request) => {
        if (e.usedKeys.has(key)) return Promise.reject(new Error(`Input request key reused: ${key}`));
        if (e.abort.signal.aborted) return Promise.reject(new Error('Task cancelled'));
        e.usedKeys.add(key);
        return new Promise((resolve, reject) => {
          e.waiting.set(key, { request, resolve, reject });
          this.touch(e, { status: 'input_required', inputRequests: this.outstanding(e) });
        });
      },
    };
    void Promise.resolve()
      .then(() => work(control))
      .then(
        (result) => {
          if (e.abort.signal.aborted) return;
          this.touch(e, { status: 'completed', result, inputRequests: undefined, statusMessage: result.isError ? 'Finished with an error' : 'Done' });
        },
        (err: unknown) => {
          if (e.abort.signal.aborted) return;
          const code = err instanceof TaskFailure ? err.code : -32603;
          this.touch(e, { status: 'failed', inputRequests: undefined, error: { code, message: (err as Error)?.message ?? String(err) }, statusMessage: 'Failed' });
        },
      );
    return this.snapshot(e);
  }

  private outstanding(e: Entry): Record<string, InputRequest> | undefined {
    if (!e.waiting.size) return undefined;
    return Object.fromEntries([...e.waiting].map(([k, w]) => [k, w.request]));
  }

  private snapshot(e: Entry): TaskView {
    const v: TaskView = { ...e.view };
    for (const k of Object.keys(v) as (keyof TaskView)[]) if (v[k] === undefined) delete v[k];
    return v;
  }

  private find(taskId: string, owner: string): Entry | null {
    this.purge();
    const e = this.tasks.get(taskId);
    return e && e.owner === owner ? e : null;
  }

  /** The task's current view, or null when unknown, expired or someone else's. */
  get(taskId: string, owner: string): TaskView | null {
    const e = this.find(taskId, owner);
    return e ? this.snapshot(e) : null;
  }

  /**
   * Answers outstanding input requests. Responses for keys that aren't outstanding are ignored
   * (spec); the task leaves `input_required` once every request is answered.
   */
  update(taskId: string, owner: string, inputResponses: Record<string, unknown>): boolean {
    const e = this.find(taskId, owner);
    if (!e) return false;
    for (const [k, v] of Object.entries(inputResponses ?? {})) {
      const w = e.waiting.get(k);
      if (!w) continue;
      e.waiting.delete(k);
      w.resolve(v);
    }
    if (e.view.status === 'input_required') {
      const rest = this.outstanding(e);
      this.touch(e, rest ? { inputRequests: rest } : { status: 'working', inputRequests: undefined, statusMessage: 'Continuing…' });
    }
    return true;
  }

  /** Cooperative cancel: aborts the work and marks the task cancelled (unless already terminal). */
  cancel(taskId: string, owner: string): boolean {
    const e = this.find(taskId, owner);
    if (!e) return false;
    this.touch(e, { status: 'cancelled', inputRequests: undefined, statusMessage: 'Cancelled' });
    e.abort.abort();
    for (const w of e.waiting.values()) w.reject(new Error('Task cancelled'));
    e.waiting.clear();
    return true;
  }

  /** Tasks currently known (tests, diagnostics). */
  get size(): number {
    return this.tasks.size;
  }

  /** Aborts all work (shutdown). */
  close(): void {
    for (const id of [...this.tasks.keys()]) {
      const e = this.tasks.get(id)!;
      e.abort.abort();
      for (const w of e.waiting.values()) w.reject(new Error('Server shutting down'));
    }
    this.tasks.clear();
  }
}

/** CreateTaskResult for `tools/call` (the wire layer keeps a handler-provided `resultType`). */
export function createTaskResult(view: TaskView): CallToolResult {
  return { ...view, resultType: 'task' } as unknown as CallToolResult;
}

/** Whether the request's per-request capabilities (2026 `_meta` envelope) declare Tasks. */
export function clientSupportsTasks(envelope: Record<string, unknown> | undefined): boolean {
  const caps = envelope?.['io.modelcontextprotocol/clientCapabilities'] as { extensions?: Record<string, unknown> } | undefined;
  return !!caps?.extensions?.[TASKS_EXTENSION];
}
