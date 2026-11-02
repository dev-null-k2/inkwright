import { topoOrder, type DagGraph, type DagNode } from './extract.ts';
import type { DagValue } from './ops.ts';

/**
 * Executable canvas, step three: running the graph. Steps run in dependency order with limited
 * parallelism; each gets its upstream outputs (in edge order). A failed step skips everything
 * downstream of it; cancelling stops what is queued and aborts what is running. Re-running one
 * step reuses the cached outputs of its inputs, so only that step does any work.
 */

export type NodeStatus = 'queued' | 'running' | 'done' | 'error' | 'skipped' | 'cancelled';

export interface NodeRun {
  status: NodeStatus;
  output?: DagValue;
  error?: string;
  ms?: number;
}

export interface StepInput {
  from: string;
  label: string;
  value: DagValue;
}

export interface RunOptions {
  exec: (node: DagNode, inputs: StepInput[], signal: AbortSignal) => Promise<DagValue>;
  /** Run only this node (and nothing downstream), using `cached` for its inputs. */
  only?: string;
  cached?: Readonly<Record<string, DagValue | undefined>>;
  signal?: AbortSignal;
  concurrency?: number;
  onUpdate?: (id: string, run: NodeRun) => void;
  clock?: () => number;
}

/** Runs the graph; resolves with the final state of every node that took part. */
export async function runDag(g: DagGraph, o: RunOptions): Promise<Record<string, NodeRun>> {
  if (g.cycles.length) throw new Error('The diagram has a cycle; break it before running');
  const clock = o.clock ?? (() => Date.now());
  const byId = new Map(g.nodes.map((n) => [n.id, n]));
  const order = g.order ?? topoOrder(g.nodes, g.edges);
  const ids = o.only ? [o.only] : order;
  const state: Record<string, NodeRun> = {};
  const set = (id: string, r: NodeRun) => { state[id] = r; o.onUpdate?.(id, r); };
  const inputsOf = (id: string) => g.edges.filter((e) => e.to === id).map((e) => e.from);
  const outputOf = (id: string): DagValue | undefined => state[id]?.output ?? o.cached?.[id];

  if (o.only) {
    const missing = inputsOf(o.only).filter((u) => !outputOf(u));
    if (missing.length) {
      const names = missing.map((m) => byId.get(m)?.label || m).join(', ');
      set(o.only, { status: 'error', error: `Run the steps before it first (${names})` });
      return state;
    }
  }
  for (const id of ids) set(id, { status: 'queued' });

  const inner = new AbortController();
  const onAbort = () => inner.abort();
  o.signal?.addEventListener('abort', onAbort);
  const limit = Math.max(1, o.concurrency ?? 2);
  const pending = new Set(ids);
  const running = new Map<string, Promise<void>>();

  const ready = (id: string) => inputsOf(id).every((u) => (o.only ? true : state[u]?.status === 'done' || (!ids.includes(u) && !!o.cached?.[u])));
  const blocked = (id: string) => inputsOf(id).some((u) => ['error', 'skipped', 'cancelled'].includes(state[u]?.status ?? ''));

  try {
    while (pending.size || running.size) {
      if (inner.signal.aborted) {
        for (const id of pending) set(id, { status: 'cancelled' });
        pending.clear();
        await Promise.allSettled([...running.values()]);
        break;
      }
      for (const id of [...pending]) {
        if (blocked(id)) { pending.delete(id); set(id, { status: 'skipped', error: 'A step before it did not finish' }); }
      }
      for (const id of [...pending]) {
        if (running.size >= limit) break;
        if (!ready(id)) continue;
        pending.delete(id);
        const node = byId.get(id)!;
        const inputs: StepInput[] = inputsOf(id).map((u) => ({ from: u, label: byId.get(u)?.label ?? u, value: outputOf(u)! }));
        const t0 = clock();
        set(id, { status: 'running' });
        const p = o.exec(node, inputs, inner.signal).then(
          (output) => set(id, inner.signal.aborted ? { status: 'cancelled' } : { status: 'done', output, ms: clock() - t0 }),
          (e: Error) => set(id, inner.signal.aborted || e?.name === 'AbortError' ? { status: 'cancelled' } : { status: 'error', error: e?.message ?? String(e), ms: clock() - t0 }),
        ).finally(() => running.delete(id));
        running.set(id, p);
      }
      if (!running.size) {
        // Nothing can start: whatever is left waits on something that will never finish.
        for (const id of pending) set(id, { status: 'skipped', error: 'A step before it did not finish' });
        pending.clear();
        break;
      }
      await Promise.race([...running.values(), new Promise<void>((r) => inner.signal.addEventListener('abort', () => r(), { once: true }))]);
    }
  } finally {
    o.signal?.removeEventListener('abort', onAbort);
  }
  return state;
}
