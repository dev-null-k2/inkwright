/**
 * Opening a peer link between two devices: the offer/answer handshake (QR codes or pasted
 * codes, or a relay you run), WebRTC underneath, and the E2EE PeerLink on top.
 *
 * Who may connect is decided here, before any data flows:
 * - `pair`: anyone holding the one-time code (they prove it with the pairing secret); both
 *   devices then remember each other's public key;
 * - `sync`: only a device already paired, by its remembered key, on both sides;
 * - `collab`: anyone holding the invite's one-time code, with the invite's permission.
 */
import {
  PairingError,
  PeerLink,
  RelayClient,
  SealedMailbox,
  answerOffer,
  completeOffer,
  createOffer,
  decodeCode,
  encodeCode,
  isOffer,
  keyFingerprint,
  rendezvousSecret,
  type CollabInvite,
  type DeviceInfo,
  type LinkPurpose,
  type PeerAnswer,
  type PeerOffer,
} from '@inkwright/sync';
import { fromBase64Url } from '@inkwright/core';
import { deviceIdentity, getRelayToken, iceServers, pairedByKey, rememberDevice, usePeer, type PairedDevice } from './identity.ts';
import { rtcAnswer, rtcFinish, rtcOffer } from './webrtc.ts';

export interface Connected {
  link: PeerLink;
  purpose: LinkPurpose;
  /** The other device as it introduced itself (key verified by the handshake). */
  peer: DeviceInfo;
  fingerprint: string;
  invite?: CollabInvite;
}

export interface LinkOptions {
  /** Registers handlers before the first message is delivered (see PeerLink.open). */
  setup?: (link: PeerLink) => void;
  /** Extra fields for our hello (a collaborator's colour). */
  hello?: Record<string, unknown>;
}

export interface PendingOffer {
  /** The code to show as a QR code or to copy. */
  code: string;
  offer: PeerOffer;
  /** Completes the connection with the other device's answer code. */
  finish(answer: string | PeerAnswer, opts?: LinkOptions): Promise<Connected>;
  cancel(): void;
}

async function hello(purpose: LinkPurpose, extra: Record<string, unknown> = {}) {
  const id = await deviceIdentity();
  return { device: id.info, features: [purpose], ...extra };
}

/**
 * Starts a connection: an offer to show. For `sync`, `expect` is the paired device it must be.
 * With `pakePsk` (a short code's key, shortcode.ts) the offer carries no secret of its own.
 */
export async function startConnection(purpose: LinkPurpose, opts: { invite?: CollabInvite; expect?: PairedDevice; pakePsk?: Uint8Array } = {}): Promise<PendingOffer> {
  const id = await deviceIdentity();
  const rtc = await rtcOffer(await iceServers());
  const started = await createOffer({ device: id.info, purpose, sdp: rtc.sdp, ...(opts.invite ? { invite: opts.invite } : {}), ...(opts.pakePsk ? { pakePsk: opts.pakePsk } : {}) });
  let used = false;
  let linked = false;
  return {
    code: await encodeCode(started.offer),
    offer: started.offer,
    // Abandoning an offer closes its connection; once it connected, the link owns it.
    cancel: () => {
      if (!linked) rtc.pc.close();
    },
    async finish(answerIn, linkOpts = {}) {
      // The pairing secret is one-time: the first valid answer uses it up.
      if (used) throw new PairingError('This code was already used; start again.');
      const answer = typeof answerIn === 'string' ? await decodeCode(answerIn) : answerIn;
      if (isOffer(answer)) throw new PairingError('That is a connection code, not an answer. Paste the code the other device shows after scanning yours.');
      if (purpose === 'sync' && !pairedByKey(answer.from.key)) throw new PairingError(`“${answer.from.name}” is not paired with this device.`);
      const keys = await completeOffer({ started, answer, identity: id.key, ...(opts.expect ? { expectPeerKey: opts.expect.key } : {}) });
      used = true;
      const transport = await rtcFinish(rtc, answer.sdp);
      const link = await PeerLink.open(transport, keys, await hello(purpose, linkOpts.hello), { ...(linkOpts.setup ? { setup: linkOpts.setup } : {}) });
      linked = true;
      return connected(link, purpose, answer.from, opts.invite);
    },
  };
}

/** Reads a pasted or scanned code. */
export const readCode = decodeCode;

/**
 * The answering side: checks who is asking, answers, and connects. Returns the answer code at
 * once (to show back) and the connection when it opens.
 */
export async function answerConnection(offer: PeerOffer, opts: LinkOptions & { pakePsk?: Uint8Array } = {}): Promise<{ answerCode: string; answer: PeerAnswer; connected: Promise<Connected> }> {
  const id = await deviceIdentity();
  if (offer.purpose === 'sync' && !pairedByKey(offer.from.key)) throw new PairingError(`“${offer.from.name}” is not paired with this device. Pair the devices first.`);
  const rtc = await rtcAnswer(offer.sdp, await iceServers());
  const { answer, keys } = await answerOffer({ offer, identity: id.key, device: id.info, sdp: rtc.sdp, ...(opts.pakePsk ? { pakePsk: opts.pakePsk } : {}) });
  const connectedP = (async () => {
    const transport = await rtc.channel;
    const link = await PeerLink.open(transport, keys, await hello(offer.purpose, opts.hello), { answering: true, ...(opts.setup ? { setup: opts.setup } : {}) });
    return connected(link, offer.purpose, offer.from, offer.invite);
  })();
  connectedP.catch(() => rtc.pc.close());
  return { answerCode: await encodeCode(answer), answer, connected: connectedP };
}

async function connected(link: PeerLink, purpose: LinkPurpose, from: DeviceInfo, invite?: CollabInvite): Promise<Connected> {
  // The device's own hello must carry the key the handshake authenticated.
  if (link.peer.device.key !== from.key) {
    link.close('Identity mismatch.');
    throw new PairingError('The other device introduced itself with a different key.');
  }
  const fingerprint = await keyFingerprint(fromBase64Url(from.key));
  if (purpose === 'pair') rememberDevice({ id: from.id, name: from.name, key: from.key, fingerprint });
  return { link, purpose, peer: link.peer.device, fingerprint, ...(invite ? { invite } : {}) };
}

// ---- Through a relay (optional) ------------------------------------------------------------------

async function relay(): Promise<RelayClient | null> {
  const url = usePeer.getState().network.relayUrl.trim();
  if (!url) return null;
  return new RelayClient({ url, getToken: getRelayToken });
}

/** Mailbox for messages *to* `toId`, sealed with the pair's shared secret. */
async function mailbox(client: RelayClient, device: PairedDevice, toId: string): Promise<SealedMailbox> {
  const id = await deviceIdentity();
  return SealedMailbox.open(client, await rendezvousSecret(id.key, fromBase64Url(device.key), 'relay'), `to:${toId}`);
}

async function latestSeq(box: SealedMailbox): Promise<number> {
  const msgs = await box.client.poll(box.room, 0, { waitSec: 0 });
  return msgs.reduce((m, x) => Math.max(m, x.seq), 0);
}

export const relayConfigured = () => !!usePeer.getState().network.relayUrl.trim();

/** Connects to a paired device through the relay (it must be running Inkwright with the relay set too). */
export async function connectViaRelay(device: PairedDevice, opts: LinkOptions & { signal?: AbortSignal } = {}): Promise<Connected> {
  const client = await relay();
  if (!client) throw new Error('No signalling server is set up.');
  const id = await deviceIdentity();
  const outbox = await mailbox(client, device, device.id);
  const inbox = await mailbox(client, device, id.info.id);
  const after = await latestSeq(inbox);
  const pending = await startConnection('sync', { expect: device });
  try {
    await outbox.send(pending.code, opts.signal);
    const timeout = AbortSignal.timeout(60_000);
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout;
    for (let cursor = after; ;) {
      const m = await inbox.receive(cursor, signal).catch((e) => {
        throw signal.aborted && !opts.signal?.aborted ? new Error(`“${device.name}” did not answer. Is Inkwright open there, with the same signalling server?`) : e;
      });
      cursor = m.seq;
      const v = await decodeCode(m.text).catch(() => null);
      if (v && !isOffer(v) && v.from.key === device.key) return pending.finish(v, opts);
    }
  } catch (e) {
    pending.cancel();
    throw e;
  }
}

/**
 * Answers sync requests from paired devices that arrive through the relay, while `signal` is
 * not aborted. Each accepted connection is handed to `onLink` (which serves the vault).
 */
export async function listenViaRelay(opts: { signal: AbortSignal; setup: (link: PeerLink) => void; onLink: (c: Connected) => void }): Promise<void> {
  const client = await relay();
  if (!client) return;
  const id = await deviceIdentity();
  const loops = new Map<string, Promise<void>>();
  const listen = async (device: PairedDevice) => {
    const inbox = await mailbox(client, device, id.info.id);
    const outbox = await mailbox(client, device, device.id);
    let cursor: number | null = null;
    while (!opts.signal.aborted && pairedByKey(device.key)) {
      try {
        // Inside the loop: a relay that is down or refuses at first must not end the listener.
        cursor ??= await latestSeq(inbox);
        const m = await inbox.receive(cursor, opts.signal);
        cursor = m.seq;
        const v = await decodeCode(m.text);
        if (!isOffer(v) || v.purpose !== 'sync' || v.from.key !== device.key) continue;
        const r = await answerConnection(v, { setup: opts.setup });
        await outbox.send(r.answerCode, opts.signal);
        void r.connected.then(opts.onLink, (e) => console.warn('peer: relayed connection failed', e));
      } catch (e) {
        if (opts.signal.aborted) return;
        console.warn('peer: relay listener', e);
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  };
  const sync = () => {
    for (const d of usePeer.getState().paired) if (!loops.has(d.key)) loops.set(d.key, listen(d).finally(() => loops.delete(d.key)));
  };
  sync();
  const unsub = usePeer.subscribe(sync);
  opts.signal.addEventListener('abort', unsub, { once: true });
  await new Promise<void>((resolve) => opts.signal.addEventListener('abort', () => resolve(), { once: true }));
}
