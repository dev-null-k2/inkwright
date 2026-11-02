/**
 * Wire format of the peer link (docs/COLLABORATION.md, "Wire format").
 *
 * A **message** is a JSON header plus optional binary body (file contents travel as bytes, not
 * base64). Each message is sealed as a whole (crypto.ts) and the ciphertext is cut into
 * **frames** no larger than a data channel reliably carries (16 KiB: the lowest common
 * denominator across browsers' SCTP implementations). Every frame has a fixed 12-byte header:
 *
 *   offset 0  u8   version (1)
 *   offset 1  u8   flags (reserved, 0)
 *   offset 2  u16  reserved (0)
 *   offset 4  u32  sequence number of the sealed message (also its GCM nonce)
 *   offset 8  u16  chunk index
 *   offset 10 u16  chunk count
 *
 * The transport is reliable and ordered (an SCTP data channel), so frames of one message arrive
 * together and in order; the reassembler still checks everything, because frames come from the
 * network and are not trusted until the message they form opens.
 */
import { utf8Decode, utf8Encode } from '../util.ts';

export const FRAME_VERSION = 1;
export const FRAME_HEADER_BYTES = 12;
/** Largest frame payload: keeps every frame under 16 KiB including the header. */
export const MAX_CHUNK_BYTES = 16 * 1024 - FRAME_HEADER_BYTES;
/** Largest sealed message accepted (a big PDF or recording fits; a hostile peer can't exhaust memory). */
export const MAX_MESSAGE_BYTES = 128 * 1024 * 1024;

export interface PeerMessage {
  /** What the message is: `req`, `res`, `evt`, `hello`, `bye`. */
  type: string;
  /** JSON-serialisable content. */
  body?: unknown;
  /** Binary payload (file bytes). */
  bin?: Uint8Array;
}

/** `[u32 header length][header JSON][binary body]`. */
export function encodeMessage(m: PeerMessage): Uint8Array {
  const header = utf8Encode(JSON.stringify({ type: m.type, body: m.body ?? null }));
  const bin = m.bin ?? new Uint8Array(0);
  const out = new Uint8Array(4 + header.length + bin.length);
  new DataView(out.buffer).setUint32(0, header.length);
  out.set(header, 4);
  out.set(bin, 4 + header.length);
  return out;
}

export function decodeMessage(bytes: Uint8Array): PeerMessage {
  if (bytes.length < 4) throw new FramingError('Message too short');
  const len = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (4 + len > bytes.length) throw new FramingError('Message header overruns the message');
  let header: { type?: unknown; body?: unknown };
  try {
    header = JSON.parse(utf8Decode(bytes.subarray(4, 4 + len)));
  } catch {
    throw new FramingError('Message header is not JSON');
  }
  if (!header || typeof header.type !== 'string') throw new FramingError('Message has no type');
  const m: PeerMessage = { type: header.type, body: header.body ?? undefined };
  if (bytes.length > 4 + len) m.bin = bytes.slice(4 + len);
  return m;
}

export class FramingError extends Error {
  override name = 'FramingError';
}

/** Cuts one sealed message into frames. */
export function toFrames(seq: number, sealed: Uint8Array, chunk = MAX_CHUNK_BYTES): Uint8Array[] {
  if (sealed.length > MAX_MESSAGE_BYTES) throw new FramingError(`Message too large (${sealed.length} bytes)`);
  const count = Math.max(1, Math.ceil(sealed.length / chunk));
  if (count > 0xffff) throw new FramingError('Message needs too many frames');
  const frames: Uint8Array[] = [];
  for (let i = 0; i < count; i++) {
    const part = sealed.subarray(i * chunk, Math.min(sealed.length, (i + 1) * chunk));
    const f = new Uint8Array(FRAME_HEADER_BYTES + part.length);
    const v = new DataView(f.buffer);
    v.setUint8(0, FRAME_VERSION);
    v.setUint32(4, seq);
    v.setUint16(8, i);
    v.setUint16(10, count);
    f.set(part, FRAME_HEADER_BYTES);
    frames.push(f);
  }
  return frames;
}

/**
 * Collects frames into whole sealed messages. Frames must arrive in order (the transport
 * guarantees it); anything else — a gap, a foreign version, a message that grows past the
 * limit — is a protocol error and the link is closed.
 */
export class Reassembler {
  private seq = -1;
  private count = 0;
  private parts: Uint8Array[] = [];
  private size = 0;

  constructor(private readonly maxBytes = MAX_MESSAGE_BYTES) {}

  /** Returns the completed `{ seq, sealed }` when this frame finishes a message, else null. */
  push(frame: Uint8Array): { seq: number; sealed: Uint8Array } | null {
    if (frame.length < FRAME_HEADER_BYTES) throw new FramingError('Frame too short');
    const v = new DataView(frame.buffer, frame.byteOffset, frame.byteLength);
    if (v.getUint8(0) !== FRAME_VERSION) throw new FramingError(`Unsupported frame version ${v.getUint8(0)}`);
    const seq = v.getUint32(4);
    const idx = v.getUint16(8);
    const count = v.getUint16(10);
    if (count === 0) throw new FramingError('Frame count is zero');
    if (idx === 0) {
      if (this.parts.length) throw new FramingError('A message started before the previous one finished');
      this.seq = seq;
      this.count = count;
      this.size = 0;
    } else if (seq !== this.seq || count !== this.count || idx !== this.parts.length) {
      throw new FramingError('Frames arrived out of order');
    }
    const body = frame.subarray(FRAME_HEADER_BYTES);
    this.size += body.length;
    if (this.size > this.maxBytes) throw new FramingError('Message too large');
    this.parts.push(body.slice());
    if (this.parts.length < this.count) return null;
    const sealed = new Uint8Array(this.size);
    let o = 0;
    for (const p of this.parts) {
      sealed.set(p, o);
      o += p.length;
    }
    this.parts = [];
    return { seq: this.seq, sealed };
  }
}
