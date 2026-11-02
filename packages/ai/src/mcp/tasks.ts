/**
 * Client side of the MCP Tasks extension (`io.modelcontextprotocol/tasks`, SEP-2663, part of the
 * 2026-07-28 protocol): a server may answer `tools/call` with a task handle (`resultType: "task"`)
 * instead of a result; the client polls `tasks/get`, answers `input_required` with `tasks/update`
 * and can `tasks/cancel`.
 *
 * The MCP TypeScript SDK (v2) negotiates the protocol but has no runtime for this extension yet:
 * its 2026 codec rejects `resultType: "task"`. `taskAwareFetch` closes that gap at the HTTP layer:
 * it rewrites a task handle in a `tools/call` response (JSON or SSE) into an ordinary complete tool
 * result carrying the task under `_meta["dev.inkstone/task"]`, which the SDK accepts and validates
 * as usual. Everything else passes through untouched.
 */
import type { FetchLike } from '../types.ts';

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
/** Where a rewritten tool result carries its task. */
export const TASK_META_KEY = 'dev.inkstone/task';

export type McpTaskStatus = 'working' | 'input_required' | 'completed' | 'failed' | 'cancelled';

export interface McpTask {
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
  ttlMs?: number | null;
  pollIntervalMs?: number;
  /** `input_required`: the server's requests, keyed by an id the response must echo. */
  inputRequests?: Record<string, { method: string; params?: Record<string, unknown> }>;
  /** `completed`: what the original request would have returned (a CallToolResult). */
  result?: Record<string, unknown>;
  /** `failed`: the JSON-RPC error. */
  error?: { code?: number; message?: string; data?: unknown };
}

export const isTerminal = (s: McpTaskStatus) => s === 'completed' || s === 'failed' || s === 'cancelled';

const TASK_FIELDS = ['taskId', 'status', 'statusMessage', 'createdAt', 'lastUpdatedAt', 'ttlMs', 'pollIntervalMs', 'inputRequests', 'result', 'error'] as const;

/** Picks the Task fields from a result object (CreateTaskResult or tasks/get result). */
export function taskFromResult(r: Record<string, unknown>): McpTask | null {
  if (typeof r.taskId !== 'string' || typeof r.status !== 'string') return null;
  const t: Record<string, unknown> = {};
  for (const k of TASK_FIELDS) if (r[k] !== undefined) t[k] = r[k];
  return t as unknown as McpTask;
}

function rewriteMessage(msg: unknown, ids: Set<string | number>): { msg: unknown; changed: boolean } {
  if (!msg || typeof msg !== 'object') return { msg, changed: false };
  const m = msg as { id?: string | number; result?: Record<string, unknown> };
  if (m.id === undefined || !ids.has(m.id) || !m.result || m.result.resultType !== 'task') return { msg, changed: false };
  const task = taskFromResult(m.result);
  if (!task) return { msg, changed: false };
  const text = `The server started a background task (${task.taskId}, ${task.status})${task.statusMessage ? `: ${task.statusMessage}` : ''}.`;
  return {
    msg: { ...m, result: { resultType: 'complete', content: [{ type: 'text', text }], _meta: { [TASK_META_KEY]: task } } },
    changed: true,
  };
}

/** JSON-RPC ids of the `tools/call` requests in a POST body. */
function toolCallIds(body: unknown): Set<string | number> {
  const ids = new Set<string | number>();
  if (typeof body !== 'string') return ids;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return ids;
  }
  for (const r of Array.isArray(parsed) ? parsed : [parsed]) {
    const o = r as { method?: string; id?: string | number };
    if (o && o.method === 'tools/call' && o.id !== undefined) ids.add(o.id);
  }
  return ids;
}

/** Rewrites `data:` lines of SSE events whose JSON is a task result for one of `ids`. */
function sseTransform(ids: Set<string | number>): TransformStream<Uint8Array, Uint8Array> {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = '';
  const flushEvent = (event: string) => {
    const lines = event.split('\n');
    const dataIdx = lines.map((l, i) => (l.startsWith('data:') ? i : -1)).filter((i) => i >= 0);
    if (!dataIdx.length) return event;
    const data = dataIdx.map((i) => lines[i]!.slice(5).replace(/^ /, '')).join('\n');
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return event;
    }
    const r = rewriteMessage(json, ids);
    if (!r.changed) return event;
    const kept = lines.filter((l) => !l.startsWith('data:'));
    return [...kept, `data: ${JSON.stringify(r.msg)}`].join('\n');
  };
  return new TransformStream({
    transform(chunk, controller) {
      buf += dec.decode(chunk, { stream: true }).replace(/\r\n?/g, '\n');
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        controller.enqueue(enc.encode(flushEvent(buf.slice(0, i)) + '\n\n'));
        buf = buf.slice(i + 2);
      }
    },
    flush(controller) {
      buf += dec.decode();
      if (buf) controller.enqueue(enc.encode(flushEvent(buf)));
    },
  });
}

/**
 * Wraps fetch so task handles in `tools/call` responses reach the SDK as complete results with
 * the task in `_meta` (see the module comment). Responses to other requests are not touched.
 */
export function taskAwareFetch(inner: FetchLike): FetchLike {
  return async (input, init) => {
    const res = await inner(input, init);
    if (!init || (init.method ?? 'GET').toUpperCase() !== 'POST') return res;
    const ids = toolCallIds(init.body);
    if (!ids.size || !res.ok || !res.body) return res;
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/event-stream')) {
      return new Response(res.body.pipeThrough(sseTransform(ids)), { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    if (type.includes('application/json')) {
      const text = await res.text();
      let json: unknown;
      try {
        json = JSON.parse(text);
      } catch {
        return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
      }
      let changed = false;
      const out = Array.isArray(json)
        ? json.map((m) => {
            const r = rewriteMessage(m, ids);
            changed ||= r.changed;
            return r.msg;
          })
        : (() => {
            const r = rewriteMessage(json, ids);
            changed = r.changed;
            return r.msg;
          })();
      return new Response(changed ? JSON.stringify(out) : text, { status: res.status, statusText: res.statusText, headers: res.headers });
    }
    return res;
  };
}

/** A tool result's task, when the server answered with a task handle. */
export function taskOfToolResult(result: { _meta?: Record<string, unknown> } | undefined): McpTask | null {
  const t = result?._meta?.[TASK_META_KEY];
  return t && typeof t === 'object' ? taskFromResult(t as Record<string, unknown>) : null;
}
