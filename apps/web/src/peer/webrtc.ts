/**
 * WebRTC data channels as a PeerTransport (packages/sync/src/peer/channel.ts).
 *
 * Signalling is non-trickle: each side waits for ICE gathering to finish (or a short timeout)
 * and puts every candidate into its one session description, so a single offer and a single
 * answer — a QR code each way, or two pasted codes — are all two devices need to exchange.
 */
import type { PeerTransport } from '@inkwright/sync';

/** How long to wait for ICE candidates before sending what we have. */
const GATHER_MS = 3000;
/** Pause sending above this much buffered data (back-pressure on big files). */
const HIGH_WATER = 1 << 20;

function waitForGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pc.removeEventListener('icegatheringstatechange', check);
      resolve();
    };
    const check = () => {
      if (pc.iceGatheringState === 'complete') done();
    };
    const timer = setTimeout(done, GATHER_MS);
    pc.addEventListener('icegatheringstatechange', check);
  });
}

function opened(dc: RTCDataChannel, pc: RTCPeerConnection, timeoutMs = 30_000): Promise<RTCDataChannel> {
  if (dc.readyState === 'open') return Promise.resolve(dc);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(connectionHelp(pc))), timeoutMs);
    dc.addEventListener('open', () => {
      clearTimeout(timer);
      resolve(dc);
    }, { once: true });
    pc.addEventListener('connectionstatechange', () => {
      if (pc.connectionState === 'failed') {
        clearTimeout(timer);
        reject(new Error(connectionHelp(pc)));
      }
    });
  });
}

/** Plain words for a connection that never opened. */
function connectionHelp(pc: RTCPeerConnection): string {
  return pc.connectionState === 'failed' || pc.iceConnectionState === 'failed'
    ? 'The devices could not reach each other. On some networks a TURN relay is needed (Settings › Devices & sharing › Network).'
    : 'The other device did not connect in time.';
}

export interface RtcSide {
  pc: RTCPeerConnection;
  /** The local session description, with candidates. */
  sdp: string;
}

/** The starting side: a data channel and a complete offer. */
export async function rtcOffer(iceServers: RTCIceServer[]): Promise<RtcSide & { channel: RTCDataChannel; transport: PeerTransport }> {
  const pc = new RTCPeerConnection({ iceServers });
  const channel = pc.createDataChannel('inkwright', { ordered: true });
  const transport = channelTransport(channel, pc);
  await pc.setLocalDescription(await pc.createOffer());
  await waitForGathering(pc);
  return { pc, channel, transport, sdp: pc.localDescription!.sdp };
}

/** The starting side, once the answer is back: resolves with the transport once the channel is open. */
export async function rtcFinish(side: RtcSide & { channel: RTCDataChannel; transport: PeerTransport }, answerSdp: string): Promise<PeerTransport> {
  await side.pc.setRemoteDescription({ type: 'answer', sdp: answerSdp });
  await opened(side.channel, side.pc);
  return side.transport;
}

/** The answering side: a complete answer, and the transport once the channel opens. */
export async function rtcAnswer(offerSdp: string, iceServers: RTCIceServer[]): Promise<RtcSide & { channel: Promise<PeerTransport> }> {
  const pc = new RTCPeerConnection({ iceServers });
  const channel = new Promise<PeerTransport>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(connectionHelp(pc))), 45_000);
    pc.addEventListener('datachannel', (e) => {
      clearTimeout(timer);
      const transport = channelTransport(e.channel, pc);
      opened(e.channel, pc).then(() => resolve(transport), reject);
    }, { once: true });
  });
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp });
  await pc.setLocalDescription(await pc.createAnswer());
  await waitForGathering(pc);
  return { pc, sdp: pc.localDescription!.sdp, channel };
}

/**
 * A data channel as a PeerTransport (closing it also closes the connection). Made the moment the
 * channel exists — before it opens — because the other side may send its first message as soon
 * as *its* end opens, and a message event with no listener yet is lost for good. Messages that
 * arrive before the link above sets `onmessage` are queued and delivered in order.
 */
export function channelTransport(dc: RTCDataChannel, pc: RTCPeerConnection): PeerTransport {
  dc.binaryType = 'arraybuffer';
  dc.bufferedAmountLowThreshold = HIGH_WATER / 4;
  const early: Uint8Array[] = [];
  let receiver: ((data: Uint8Array) => void) | null = null;
  const t: PeerTransport = {
    get onmessage() {
      return receiver;
    },
    set onmessage(fn) {
      receiver = fn;
      while (fn && early.length) fn(early.shift()!);
    },
    onclose: null,
    async send(data: Uint8Array) {
      if (dc.readyState !== 'open') throw new Error('The connection closed.');
      if (dc.bufferedAmount > HIGH_WATER) {
        await new Promise<void>((resolve) => dc.addEventListener('bufferedamountlow', () => resolve(), { once: true }));
      }
      dc.send(data as Uint8Array<ArrayBuffer>);
    },
    close() {
      try {
        dc.close();
      } finally {
        pc.close();
      }
    },
  };
  dc.addEventListener('message', (e) => {
    if (!(e.data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(e.data);
    if (receiver) receiver(bytes);
    else early.push(bytes);
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    t.onclose?.('The other device disconnected.');
  };
  dc.addEventListener('close', close);
  pc.addEventListener('connectionstatechange', () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') close();
  });
  return t;
}
