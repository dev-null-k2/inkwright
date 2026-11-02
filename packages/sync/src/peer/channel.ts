/**
 * The encrypted message channel two devices talk over, independent of how bytes travel: a WebRTC
 * data channel in the app, an in-memory pipe in tests (`memoryTransportPair`). Everything above
 * it (sync RPC, live collaboration) sees only whole, authenticated messages.
 */
import { Opener, PeerCryptoError, Sealer, type SessionKeys } from './crypto.ts';
import { Reassembler, decodeMessage, encodeMessage, toFrames, type PeerMessage } from './framing.ts';

/** A reliable, ordered byte-message pipe (an RTCDataChannel, a test pipe). */
export interface PeerTransport {
  /** May return a promise to apply back-pressure (the data channel's buffer is full). */
  send(data: Uint8Array): void | Promise<void>;
  close(): void;
  onmessage: ((data: Uint8Array) => void) | null;
  onclose: ((reason?: string) => void) | null;
}

export interface SecureChannelOptions {
  /** Called once per protocol violation before the channel closes (for logs and the UI). */
  onError?: (e: Error) => void;
}

/**
 * Seals, frames and sends messages; reassembles, opens and delivers them. Sends and receives
 * are each serialised, so messages keep their order end to end even though WebCrypto is async.
 * Any frame that is malformed or fails authentication closes the channel: there is no way to
 * skip a message under AES-GCM's counter discipline, and a peer that sends one is not trusted.
 */
export class SecureChannel {
  private readonly sealer: Sealer;
  private readonly opener: Opener;
  private readonly reassembler = new Reassembler();
  private sendQueue: Promise<void> = Promise.resolve();
  private recvQueue: Promise<void> = Promise.resolve();
  private listeners = new Set<(m: PeerMessage) => void>();
  private closeListeners = new Set<(reason?: string) => void>();
  private closedReason: string | undefined;
  private isClosed = false;

  constructor(
    private readonly transport: PeerTransport,
    readonly keys: SessionKeys,
    private readonly opts: SecureChannelOptions = {},
  ) {
    this.sealer = new Sealer(keys.send);
    this.opener = new Opener(keys.recv);
    transport.onmessage = (data) => this.receive(data);
    // In order with the messages: everything that arrived before the close is still delivered
    // (opening a message is async, so a close right behind it must wait its turn).
    transport.onclose = (reason) => {
      this.recvQueue = this.recvQueue.then(() => this.finish(reason ?? 'The other device disconnected.'));
    };
  }

  get closed(): boolean {
    return this.isClosed;
  }

  get closeReason(): string | undefined {
    return this.closedReason;
  }

  /** Short authentication string: equal on both screens when nobody is in the middle. */
  get sas(): string {
    return this.keys.sas;
  }

  /** Subscribes to every incoming message; returns the unsubscribe function. */
  onMessage(l: (m: PeerMessage) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  onClose(l: (reason?: string) => void): () => void {
    if (this.isClosed) queueMicrotask(() => l(this.closedReason));
    else this.closeListeners.add(l);
    return () => this.closeListeners.delete(l);
  }

  /** Sends one message. Resolves when its frames are handed to the transport. */
  send(m: PeerMessage): Promise<void> {
    if (this.isClosed) return Promise.reject(new Error(this.closedReason ?? 'The peer link is closed.'));
    const job = this.sendQueue.then(async () => {
      if (this.isClosed) throw new Error(this.closedReason ?? 'The peer link is closed.');
      const { seq, data } = await this.sealer.seal(encodeMessage(m));
      for (const f of toFrames(seq, data)) await this.transport.send(f);
    });
    // A failed send must not wedge the queue for the next one.
    this.sendQueue = job.catch(() => {});
    return job;
  }

  /** Closes the link (after telling the other side, best effort). */
  close(reason = 'Closed on this device.'): void {
    if (this.isClosed) return;
    void this.send({ type: 'bye', body: { reason } }).catch(() => {}).finally(() => {
      try {
        this.transport.close();
      } catch {
        /* already closed */
      }
    });
    this.finish(reason);
  }

  private receive(data: Uint8Array): void {
    if (this.isClosed) return;
    this.recvQueue = this.recvQueue.then(async () => {
      if (this.isClosed) return;
      try {
        const done = this.reassembler.push(data);
        if (!done) return;
        const plain = await this.opener.open(done.seq, done.sealed);
        const m = decodeMessage(plain);
        if (m.type === 'bye') {
          const r = (m.body as { reason?: unknown } | undefined)?.reason;
          this.finish(typeof r === 'string' ? `The other device closed the link: ${r}` : 'The other device closed the link.');
          return;
        }
        for (const l of [...this.listeners]) {
          try {
            l(m);
          } catch (e) {
            console.warn('peer message handler failed', e);
          }
        }
      } catch (e) {
        const err = e instanceof Error ? e : new Error(String(e));
        this.opts.onError?.(err);
        this.finish(err instanceof PeerCryptoError ? err.message : `Protocol error: ${err.message}`);
        try {
          this.transport.close();
        } catch {
          /* already closed */
        }
      }
    });
  }

  private finish(reason: string): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.closedReason = reason;
    for (const l of [...this.closeListeners]) {
      try {
        l(reason);
      } catch {
        /* ignore */
      }
    }
    this.closeListeners.clear();
  }
}

/**
 * Two connected in-memory transports (tests, and a same-process loopback). Delivery is
 * asynchronous like a real network; `tap` sees (and may replace or drop) every frame in flight.
 */
export function memoryTransportPair(opts: { tap?: (from: 'a' | 'b', frame: Uint8Array) => Uint8Array | null } = {}): [PeerTransport, PeerTransport] {
  const make = (side: 'a' | 'b'): PeerTransport & { peer?: PeerTransport; open: boolean } => ({
    open: true,
    onmessage: null,
    onclose: null,
    send(data: Uint8Array) {
      if (!this.open) throw new Error('Transport closed');
      const target = this.peer as (PeerTransport & { open: boolean }) | undefined;
      const frame = opts.tap ? opts.tap(side, data.slice()) : data.slice();
      if (!frame) return;
      setTimeout(() => {
        if (target?.open) target.onmessage?.(frame);
      }, 0);
    },
    close() {
      if (!this.open) return;
      this.open = false;
      const target = this.peer as (PeerTransport & { open: boolean }) | undefined;
      setTimeout(() => {
        if (target?.open) {
          target.open = false;
          target.onclose?.('The other device disconnected.');
        }
      }, 0);
    },
  });
  const a = make('a');
  const b = make('b');
  a.peer = b;
  b.peer = a;
  return [a, b];
}
