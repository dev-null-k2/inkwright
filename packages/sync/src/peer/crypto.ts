/**
 * End-to-end encryption for the peer link (docs/COLLABORATION.md, "Threat model").
 *
 * WebRTC data channels are already encrypted with DTLS, but DTLS only protects the hop between
 * two endpoints: if a TURN relay or a signalling server ever sits in the middle, the keys it
 * negotiates are only as trustworthy as the SDP it carried. So every message on the peer link is
 * encrypted again, with keys only the two devices can derive:
 *
 * - Each device has a long-term **identity** key pair (X25519, private key non-extractable), the
 *   public half of which its peers remember when they pair.
 * - Each connection adds a fresh **ephemeral** X25519 key pair on both sides (forward secrecy:
 *   recorded traffic stays sealed even if an identity key leaks later).
 * - The four Diffie-Hellman results (ee, es, se, ss — the Noise "KK" pattern) and, on first
 *   pairing, the **one-time pairing secret** from the QR code go into HKDF-SHA-256. The salt is
 *   the hash of the whole handshake transcript (both offers, including the WebRTC SDP with its
 *   DTLS fingerprints), so tampering with anything in the handshake yields different keys.
 * - Messages are sealed with AES-256-GCM, one key per direction, the IV being a strictly
 *   increasing message counter: a replayed, dropped or reordered message fails to open.
 *
 * Everything here is WebCrypto only, so it runs unchanged in browsers, Android WebViews and
 * Node 20+ (tests).
 */
import { concatBytes, toBufferView, utf8Encode } from '../util.ts';

const subtle = (): SubtleCrypto => {
  const s = globalThis.crypto?.subtle;
  if (!s) throw new Error('This device has no WebCrypto (a secure context is required for the peer link).');
  return s;
};

const X25519 = { name: 'X25519' } as const;

/** Bytes of the per-message authentication tag (AES-GCM). */
export const TAG_BYTES = 16;

export function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

/** True when this runtime can do X25519 in WebCrypto (Chrome 133+, Firefox 130+, Safari 17+, Node 20+). */
export async function x25519Supported(): Promise<boolean> {
  try {
    await subtle().generateKey(X25519, false, ['deriveBits']);
    return true;
  } catch {
    return false;
  }
}

export interface KeyPair {
  /** Non-extractable private key: scripts (ours included) can use it but never read it out. */
  privateKey: CryptoKey;
  /** The raw 32-byte public key. */
  publicRaw: Uint8Array;
}

/** A new X25519 key pair (identity or ephemeral). */
export async function generateKeyPair(): Promise<KeyPair> {
  const kp = (await subtle().generateKey(X25519, false, ['deriveBits'])) as CryptoKeyPair;
  const publicRaw = new Uint8Array(await subtle().exportKey('raw', kp.publicKey));
  return { privateKey: kp.privateKey, publicRaw };
}

async function importPublic(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error('A peer key must be 32 bytes.');
  return subtle().importKey('raw', toBufferView(raw), X25519, true, []);
}

async function dh(priv: CryptoKey, peerPublic: Uint8Array): Promise<Uint8Array> {
  const out = new Uint8Array(await subtle().deriveBits({ name: 'X25519', public: await importPublic(peerPublic) }, priv, 256));
  // RFC 7748 §6.1: an all-zero result means a low-order point; refuse rather than derive from it.
  if (out.every((b) => b === 0)) throw new Error('Invalid peer key.');
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', toBufferView(bytes)));
}

export async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', toBufferView(key), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle().sign('HMAC', k, toBufferView(data)));
}

/** Constant-time comparison (for MACs). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i]! ^ b[i]!;
  return d === 0;
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string, bytes: number): Promise<Uint8Array> {
  const k = await subtle().importKey('raw', toBufferView(ikm), 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: toBufferView(salt), info: toBufferView(utf8Encode(info)) }, k, bytes * 8));
}

async function aesKey(raw: Uint8Array, usage: 'encrypt' | 'decrypt'): Promise<CryptoKey> {
  return subtle().importKey('raw', toBufferView(raw), { name: 'AES-GCM' }, false, [usage]);
}

export type PeerRole = 'initiator' | 'responder';

export interface HandshakeInput {
  role: PeerRole;
  /** This device's identity key. */
  identity: KeyPair;
  /** This connection's ephemeral key. */
  ephemeral: KeyPair;
  peerIdentity: Uint8Array;
  peerEphemeral: Uint8Array;
  /** The one-time pairing secret (first pairing and invites); absent for already-paired devices. */
  psk?: Uint8Array;
  /** Canonical bytes of the handshake (`transcriptBytes`): both sides must pass the same. */
  transcript: Uint8Array;
}

export interface SessionKeys {
  /** Seals what this device sends. */
  send: CryptoKey;
  /** Opens what the peer sends. */
  recv: CryptoKey;
  /**
   * Six digits both screens can show: equal on both devices exactly when they derived the same
   * keys (a short authentication string, for people who want to compare).
   */
  sas: string;
  /** Hex hash of the transcript; identifies this session in logs without revealing anything. */
  sessionId: string;
}

const INFO = 'inkwright.peer.v1';

/**
 * Derives both directions' keys from a handshake. Both devices get the same pair (with send and
 * receive swapped) only if each holds the identity private key the other expects, both saw the
 * same transcript, and — on first pairing — both know the pairing secret.
 */
export async function deriveSessionKeys(h: HandshakeInput): Promise<SessionKeys> {
  const ee = await dh(h.ephemeral.privateKey, h.peerEphemeral);
  const ss = await dh(h.identity.privateKey, h.peerIdentity);
  // es = initiator's ephemeral × responder's identity; se = initiator's identity × responder's ephemeral.
  const es = h.role === 'initiator' ? await dh(h.ephemeral.privateKey, h.peerIdentity) : await dh(h.identity.privateKey, h.peerEphemeral);
  const se = h.role === 'initiator' ? await dh(h.identity.privateKey, h.peerEphemeral) : await dh(h.ephemeral.privateKey, h.peerIdentity);
  const ikm = concatBytes([ee, es, se, ss, h.psk ?? new Uint8Array(0)]);
  const salt = await sha256(h.transcript);
  const i2r = await hkdf(ikm, salt, `${INFO} initiator->responder`, 32);
  const r2i = await hkdf(ikm, salt, `${INFO} responder->initiator`, 32);
  const sasBytes = await hkdf(ikm, salt, `${INFO} sas`, 4);
  const sas = String(new DataView(sasBytes.buffer).getUint32(0) % 1_000_000).padStart(6, '0');
  const [send, recv] = h.role === 'initiator' ? [i2r, r2i] : [r2i, i2r];
  return { send: await aesKey(send, 'encrypt'), recv: await aesKey(recv, 'decrypt'), sas, sessionId: [...salt.subarray(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('') };
}

/** The AAD every sealed message is bound to: protocol, version and its sequence number. */
function aad(seq: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(INFO.length + 8);
  b.set(utf8Encode(INFO));
  new DataView(b.buffer).setBigUint64(INFO.length, BigInt(seq));
  return b;
}

function iv(seq: number): Uint8Array<ArrayBuffer> {
  const b = new Uint8Array(12);
  new DataView(b.buffer).setBigUint64(4, BigInt(seq));
  return b;
}

/**
 * Seals outgoing messages with a strictly increasing counter as the GCM nonce (unique per key,
 * since each direction has its own key). Not reusable across sessions: keys are per session.
 */
export class Sealer {
  private seq = 0;
  constructor(private readonly key: CryptoKey) {}
  /** Returns the sequence number used and the ciphertext (with tag). */
  async seal(plain: Uint8Array): Promise<{ seq: number; data: Uint8Array }> {
    const seq = ++this.seq;
    if (seq > Number.MAX_SAFE_INTEGER - 1) throw new Error('Peer session exhausted; reconnect.');
    const data = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: iv(seq), additionalData: aad(seq) }, this.key, toBufferView(plain)));
    return { seq, data };
  }
}

/** Raised for any message that does not open: forged, altered, replayed or out of order. */
export class PeerCryptoError extends Error {
  override name = 'PeerCryptoError';
}

/** Opens incoming messages, accepting each sequence number exactly once and in order. */
export class Opener {
  private expected = 1;
  constructor(private readonly key: CryptoKey) {}
  async open(seq: number, data: Uint8Array): Promise<Uint8Array> {
    if (seq !== this.expected) throw new PeerCryptoError(`Unexpected message ${seq} (wanted ${this.expected}): replayed, dropped or reordered.`);
    let plain: ArrayBuffer;
    try {
      plain = await subtle().decrypt({ name: 'AES-GCM', iv: iv(seq), additionalData: aad(seq) }, this.key, toBufferView(data));
    } catch {
      throw new PeerCryptoError('A message failed authentication: it was altered, or the other device holds different keys.');
    }
    this.expected++;
    return new Uint8Array(plain);
  }
}

/**
 * MAC over a transcript with the pairing secret, sent in the answer: the inviting device can tell
 * an answer from someone who saw the QR code's secret apart from a forged one before connecting.
 */
export async function pairingMac(psk: Uint8Array, transcript: Uint8Array): Promise<Uint8Array> {
  return hmacSha256(await hkdf(psk, new Uint8Array(32), `${INFO} pairing-mac`, 32), transcript);
}

/** Fingerprint of an identity key for people to compare: SHA-256, first 10 bytes as five hex groups. */
export async function keyFingerprint(publicRaw: Uint8Array): Promise<string> {
  const h = await sha256(publicRaw);
  const hex = [...h.subarray(0, 10)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join('');
  return hex.match(/.{4}/g)!.join(' ');
}

/** A key both paired devices can derive for a rendezvous (relay room id and its message key). */
export async function rendezvousSecret(identity: KeyPair, peerIdentity: Uint8Array, label: string): Promise<Uint8Array> {
  const ss = await dh(identity.privateKey, peerIdentity);
  // Order-independent salt: both devices sort the two public keys the same way.
  const [a, b] = [identity.publicRaw, peerIdentity].sort((x, y) => compareBytes(x, y));
  return hkdf(ss, concatBytes([a!, b!]), `${INFO} ${label}`, 32);
}

export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return a.length - b.length;
}

/** Seals a small blob with a symmetric key derived from `secret` (relay mailboxes). */
export async function sealWithSecret(secret: Uint8Array, label: string, plain: Uint8Array): Promise<Uint8Array> {
  const key = await aesKey(await hkdf(secret, new Uint8Array(32), `${INFO} box ${label}`, 32), 'encrypt');
  const nonce = randomBytes(12);
  const ct = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: toBufferView(nonce), additionalData: toBufferView(utf8Encode(label)) }, key, toBufferView(plain)));
  return concatBytes([nonce, ct]);
}

export async function openWithSecret(secret: Uint8Array, label: string, sealed: Uint8Array): Promise<Uint8Array> {
  if (sealed.length < 12 + TAG_BYTES) throw new PeerCryptoError('Sealed message too short.');
  const key = await aesKey(await hkdf(secret, new Uint8Array(32), `${INFO} box ${label}`, 32), 'decrypt');
  try {
    return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: toBufferView(sealed.slice(0, 12)), additionalData: toBufferView(utf8Encode(label)) }, key, toBufferView(sealed.slice(12))));
  } catch {
    throw new PeerCryptoError('A relayed message failed authentication.');
  }
}

/** Derives a short label from a secret (relay room names: unlinkable to the keys themselves). */
export async function labelFrom(secret: Uint8Array, label: string): Promise<string> {
  const b = await hkdf(secret, new Uint8Array(32), `${INFO} label ${label}`, 16);
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}
