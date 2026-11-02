/**
 * An established, authenticated link to another device: the encrypted channel, RPC on top of it,
 * and what the other device said about itself in its first message.
 *
 * Opening a link is also **key confirmation**: each side's first message is a `hello` sealed
 * with the session keys. If either device derived different keys (a wrong pairing secret, a
 * substituted key, a tampered handshake), the hello fails to open and the link closes before
 * anything else is exchanged.
 */
import { SecureChannel, type PeerTransport } from './channel.ts';
import type { SessionKeys } from './crypto.ts';
import type { DeviceInfo } from './pairing.ts';
import { PeerRpc } from './rpc.ts';
import type { PeerMessage } from './framing.ts';

export interface PeerHello {
  device: DeviceInfo;
  /** What this side is offering on the link: vault sync, a live note, or both. */
  features: string[];
  /** Free-form details for a feature (the collaborator's colour, a note id). */
  [k: string]: unknown;
}

export class PeerLink {
  readonly rpc: PeerRpc;
  private constructor(readonly channel: SecureChannel, readonly peer: PeerHello, early: PeerMessage[], setup?: (link: PeerLink) => void) {
    this.rpc = new PeerRpc(channel);
    setup?.(this);
    // Anything that arrived between their hello and now goes through in order.
    for (const m of early) this.rpc.deliver(m);
  }

  get sas(): string {
    return this.channel.sas;
  }

  get closed(): boolean {
    return this.channel.closed;
  }

  onClose(l: (reason?: string) => void): () => void {
    return this.channel.onClose(l);
  }

  close(reason?: string): void {
    this.rpc.dispose();
    this.channel.close(reason);
  }

  /**
   * Opens the link: sends our hello and waits for theirs (or fails). Messages that arrive right
   * after the hello are held until `setup` has registered the handlers, so a fast peer's first
   * request is never answered with "not offered".
   */
  static async open(transport: PeerTransport, keys: SessionKeys, hello: PeerHello, opts: { timeoutMs?: number; setup?: (link: PeerLink) => void } = {}): Promise<PeerLink> {
    const channel = new SecureChannel(transport, keys);
    const early: PeerMessage[] = [];
    let greeted = false;
    let stop: () => void = () => {};
    const theirs = await new Promise<PeerHello>((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        offClose();
        channel.close('No answer from the other device.');
        reject(new Error('The other device did not confirm the connection in time.'));
      }, opts.timeoutMs ?? 20_000);
      const off = channel.onMessage((m) => {
        if (greeted) {
          early.push(m);
          return;
        }
        if (m.type !== 'hello') return;
        greeted = true;
        clearTimeout(timer);
        offClose();
        const h = m.body as PeerHello;
        if (!h || typeof h !== 'object' || !h.device || !Array.isArray(h.features)) {
          channel.close('Invalid hello.');
          reject(new Error('The other device sent an invalid greeting.'));
          return;
        }
        resolve(h);
        // Keep collecting until the RPC layer is attached (below).
        stop = off;
      });
      const offClose = channel.onClose((reason) => {
        clearTimeout(timer);
        off();
        reject(new Error(reason ?? 'The connection closed.'));
      });
      channel.send({ type: 'hello', body: hello }).catch(reject);
    });
    stop();
    return new PeerLink(channel, theirs, early, opts.setup);
  }
}
