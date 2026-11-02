/**
 * Request/response calls and one-way events over a SecureChannel. Small on purpose: the peer
 * link carries a handful of file operations (sync) and a stream of collaboration events.
 *
 *   req  { id, m: method, p: params }   (+ binary body)
 *   res  { id, ok: true, r: result }    (+ binary body)
 *   res  { id, ok: false, e: { message, status? } }
 *   evt  { n: name, p: payload }        (+ binary body)
 */
import type { SecureChannel } from './channel.ts';
import type { PeerMessage } from './framing.ts';

export interface RpcResult {
  result?: unknown;
  bin?: Uint8Array;
}

export type RpcHandler = (params: unknown, bin: Uint8Array | undefined) => Promise<RpcResult | void> | RpcResult | void;
export type EventHandler = (payload: unknown, bin: Uint8Array | undefined) => void;

/** An error from the other device, with its HTTP-like status when it has one (412: precondition). */
export class PeerRpcError extends Error {
  override name = 'PeerRpcError';
  constructor(message: string, readonly status?: number) {
    super(message);
  }
}

export class PeerRpc {
  private nextId = 1;
  private pending = new Map<number, { resolve: (r: RpcResult) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private handlers = new Map<string, RpcHandler>();
  private events = new Map<string, Set<EventHandler>>();
  private unsub: () => void;

  constructor(readonly channel: SecureChannel, private readonly timeoutMs = 120_000) {
    this.unsub = channel.onMessage((m) => this.deliver(m));
    channel.onClose((reason) => {
      for (const [, p] of this.pending) {
        clearTimeout(p.timer);
        p.reject(new PeerRpcError(reason ?? 'The peer link closed.'));
      }
      this.pending.clear();
    });
  }

  /** Serves a method. Handlers may throw; the caller gets the message (and `status` if set). */
  handle(method: string, h: RpcHandler): () => void {
    this.handlers.set(method, h);
    return () => {
      if (this.handlers.get(method) === h) this.handlers.delete(method);
    };
  }

  on(name: string, h: EventHandler): () => void {
    let set = this.events.get(name);
    if (!set) this.events.set(name, (set = new Set()));
    set.add(h);
    return () => set!.delete(h);
  }

  /** Calls a method on the other device. */
  call(method: string, params?: unknown, bin?: Uint8Array, opts: { signal?: AbortSignal } = {}): Promise<RpcResult> {
    if (opts.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
    const id = this.nextId++;
    return new Promise<RpcResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new PeerRpcError(`The other device did not answer ${method} in time.`));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      opts.signal?.addEventListener('abort', () => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      }, { once: true });
      this.channel.send({ type: 'req', body: { id, m: method, p: params ?? null }, ...(bin ? { bin } : {}) }).catch((e) => {
        if (!this.pending.delete(id)) return;
        clearTimeout(timer);
        reject(e);
      });
    });
  }

  /** Sends a one-way event. */
  emit(name: string, payload?: unknown, bin?: Uint8Array): Promise<void> {
    return this.channel.send({ type: 'evt', body: { n: name, p: payload ?? null }, ...(bin ? { bin } : {}) });
  }

  dispose(): void {
    this.unsub();
  }

  /** Handles one incoming message (called for every message on the channel). */
  deliver(m: PeerMessage): void {
    const b = m.body as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object') return;
    if (m.type === 'res' && typeof b.id === 'number') {
      const p = this.pending.get(b.id);
      if (!p) return;
      this.pending.delete(b.id);
      clearTimeout(p.timer);
      if (b.ok) p.resolve({ result: b.r, ...(m.bin ? { bin: m.bin } : {}) });
      else {
        const e = (b.e ?? {}) as { message?: unknown; status?: unknown };
        p.reject(new PeerRpcError(typeof e.message === 'string' ? e.message : 'The other device reported an error.', typeof e.status === 'number' ? e.status : undefined));
      }
    } else if (m.type === 'req' && typeof b.id === 'number' && typeof b.m === 'string') {
      void this.serve(b.id, b.m, b.p, m.bin);
    } else if (m.type === 'evt' && typeof b.n === 'string') {
      for (const h of [...(this.events.get(b.n) ?? [])]) {
        try {
          h(b.p, m.bin);
        } catch (e) {
          console.warn(`peer event ${b.n} failed`, e);
        }
      }
    }
  }

  private async serve(id: number, method: string, params: unknown, bin: Uint8Array | undefined): Promise<void> {
    const h = this.handlers.get(method);
    try {
      if (!h) throw new PeerRpcError(`The other device does not offer ${method}.`, 404);
      const r = (await h(params, bin)) ?? {};
      await this.channel.send({ type: 'res', body: { id, ok: true, r: r.result ?? null }, ...(r.bin ? { bin: r.bin } : {}) });
    } catch (e) {
      const err = e as Error & { status?: number };
      await this.channel.send({ type: 'res', body: { id, ok: false, e: { message: err?.message ?? String(e), ...(typeof err?.status === 'number' ? { status: err.status } : {}) } } }).catch(() => {});
    }
  }
}
