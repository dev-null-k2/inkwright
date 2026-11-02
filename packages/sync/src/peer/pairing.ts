/**
 * Pairing and connection handshakes for the peer link, exchanged out of band (QR codes, copy and
 * paste) or through an optional relay (signal.ts). No server of ours is involved.
 *
 * One connection = one **offer** (from the device that starts it) and one **answer**. Each
 * carries the device's identity key, a fresh ephemeral key, a nonce and its WebRTC session
 * description. The offer of a first pairing or a live-collaboration invite also carries a
 * one-time **pairing secret** (`psk`): only someone who saw the QR code knows it, the answer must
 * prove it (`mac`), and it is mixed into the session keys. Later connections between paired
 * devices don't need it: their remembered identity keys authenticate them.
 *
 * Codes are `ink1:` + base64url(deflate-raw(JSON)) — small enough for a QR code with a complete
 * (non-trickle) SDP — or `ink0:` + base64url(JSON) where CompressionStream is unavailable.
 */
import { fromBase64Url, toBase64Url } from '@inkwright/core';
import { utf8Decode, utf8Encode } from '../util.ts';
import { deriveSessionKeys, generateKeyPair, pairingMac, randomBytes, timingSafeEqual, type KeyPair, type SessionKeys } from './crypto.ts';

export const PEER_PROTOCOL_VERSION = 1;

/** Why a link is opened: pairing a device, syncing with a paired one, or a live-collaboration invite. */
export type LinkPurpose = 'pair' | 'sync' | 'collab';

export type CollabPermission = 'view' | 'write';

export interface DeviceInfo {
  /** Stable random id of the device (not secret). */
  id: string;
  /** What the person called it ("Ada's tablet"); shown, never trusted. */
  name: string;
  /** Identity public key, base64url (32 bytes, X25519). */
  key: string;
}

export interface CollabInvite {
  /** The shared note (its id) and title, shown on the invitee's screen. */
  noteId: string;
  title: string;
  permission: CollabPermission;
}

export interface PeerOffer {
  t: 'offer';
  v: number;
  purpose: LinkPurpose;
  from: DeviceInfo;
  /** Ephemeral public key, base64url. */
  eph: string;
  nonce: string;
  /** WebRTC offer SDP with its ICE candidates (non-trickle); empty when a relay carries it. */
  sdp: string;
  /** One-time pairing secret (pairing and invites only), base64url. */
  psk?: string;
  invite?: CollabInvite;
  /** Epoch ms after which the offer is refused. */
  expires: number;
}

export interface PeerAnswer {
  t: 'answer';
  v: number;
  from: DeviceInfo;
  eph: string;
  nonce: string;
  sdp: string;
  /** Proof of the pairing secret (when the offer had one), base64url. */
  mac?: string;
}

export class PairingError extends Error {
  override name = 'PairingError';
}

/** Offers are short-lived: a QR code left on a screen stops working. */
export const OFFER_TTL_MS = 10 * 60_000;

// ---- Codes ------------------------------------------------------------------------------------

async function deflate(bytes: Uint8Array, mode: 'compress' | 'decompress'): Promise<Uint8Array> {
  const Ctor = mode === 'compress' ? globalThis.CompressionStream : globalThis.DecompressionStream;
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new Ctor('deflate-raw') as unknown as ReadableWritablePair<Uint8Array<ArrayBuffer>, Uint8Array<ArrayBuffer>>);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const canCompress = () => typeof globalThis.CompressionStream === 'function' && typeof globalThis.DecompressionStream === 'function';

/** Encodes an offer or answer as a pasteable / QR-able code. */
export async function encodeCode(v: PeerOffer | PeerAnswer): Promise<string> {
  const json = utf8Encode(JSON.stringify(v));
  if (canCompress()) return `ink1:${toBase64Url(await deflate(json, 'compress'))}`;
  return `ink0:${toBase64Url(json)}`;
}

/** Decodes a code (whitespace and line breaks from copying are ignored). */
export async function decodeCode(code: string): Promise<PeerOffer | PeerAnswer> {
  const s = code.replace(/\s+/g, '');
  let json: Uint8Array;
  try {
    if (s.startsWith('ink1:')) {
      if (!canCompress()) throw new PairingError('This device cannot read compressed codes.');
      json = await deflate(fromBase64Url(s.slice(5)), 'decompress');
    } else if (s.startsWith('ink0:')) json = fromBase64Url(s.slice(5));
    else throw new PairingError('That is not an Inkwright connection code.');
  } catch (e) {
    if (e instanceof PairingError) throw e;
    throw new PairingError('The code is incomplete or damaged; copy it again.');
  }
  let v: unknown;
  try {
    v = JSON.parse(utf8Decode(json));
  } catch {
    throw new PairingError('The code is incomplete or damaged; copy it again.');
  }
  return validate(v);
}

const isStr = (x: unknown, max = 20_000): x is string => typeof x === 'string' && x.length <= max;

function validDevice(d: unknown): d is DeviceInfo {
  const o = d as DeviceInfo;
  return !!o && isStr(o.id, 64) && isStr(o.name, 120) && isStr(o.key, 64) && fromBase64Url(o.key).length === 32;
}

function validate(v: unknown): PeerOffer | PeerAnswer {
  const o = v as Omit<PeerOffer, 't'> & Omit<PeerAnswer, 't'> & { t: unknown };
  if (!o || (o.t !== 'offer' && o.t !== 'answer')) throw new PairingError('That is not an Inkwright connection code.');
  if (o.v !== PEER_PROTOCOL_VERSION) throw new PairingError('The other device runs a different version of Inkwright; update both.');
  if (!validDevice(o.from) || !isStr(o.eph, 64) || fromBase64Url(o.eph).length !== 32 || !isStr(o.nonce, 64) || !isStr(o.sdp)) throw new PairingError('The code is incomplete or damaged; copy it again.');
  if (o.t === 'offer') {
    if (o.purpose !== 'pair' && o.purpose !== 'sync' && o.purpose !== 'collab') throw new PairingError('Unknown kind of connection.');
    if (typeof o.expires !== 'number') throw new PairingError('The code is incomplete or damaged; copy it again.');
    if (o.psk !== undefined && (!isStr(o.psk, 64) || fromBase64Url(o.psk).length !== 32)) throw new PairingError('The code is incomplete or damaged; copy it again.');
    if (o.purpose !== 'sync' && !o.psk) throw new PairingError('This invitation has no pairing secret.');
    if (o.invite && (!isStr(o.invite.noteId, 64) || !isStr(o.invite.title, 300) || (o.invite.permission !== 'view' && o.invite.permission !== 'write'))) throw new PairingError('The invitation is damaged.');
    if (o.purpose === 'collab' && !o.invite) throw new PairingError('The invitation is damaged.');
  } else if (o.mac !== undefined && !isStr(o.mac, 64)) throw new PairingError('The code is incomplete or damaged; copy it again.');
  return o as PeerOffer | PeerAnswer;
}

export const isOffer = (v: PeerOffer | PeerAnswer): v is PeerOffer => v.t === 'offer';

// ---- Handshake --------------------------------------------------------------------------------

/**
 * The bytes both sides hash into the key schedule: everything in the offer and answer except
 * the secret and the MAC (the secret goes in as key material; the MAC is computed over this).
 */
export function transcriptBytes(offer: PeerOffer, answer: Omit<PeerAnswer, 'mac'>): Uint8Array {
  const { psk: _psk, ...o } = offer;
  const { mac: _mac, ...a } = answer as PeerAnswer;
  return utf8Encode(JSON.stringify(['inkwright.peer.transcript.v1', o, a]));
}

export interface StartedOffer {
  offer: PeerOffer;
  ephemeral: KeyPair;
  psk?: Uint8Array;
}

/** Starts a connection: a new ephemeral key, a nonce, and a pairing secret unless `purpose` is `sync`. */
export async function createOffer(o: { device: DeviceInfo; purpose: LinkPurpose; sdp: string; invite?: CollabInvite; now?: number; ttlMs?: number }): Promise<StartedOffer> {
  const ephemeral = await generateKeyPair();
  const psk = o.purpose === 'sync' ? undefined : randomBytes(32);
  const offer: PeerOffer = {
    t: 'offer',
    v: PEER_PROTOCOL_VERSION,
    purpose: o.purpose,
    from: o.device,
    eph: toBase64Url(ephemeral.publicRaw),
    nonce: toBase64Url(randomBytes(16)),
    sdp: o.sdp,
    expires: (o.now ?? Date.now()) + (o.ttlMs ?? OFFER_TTL_MS),
  };
  if (psk) offer.psk = toBase64Url(psk);
  if (o.invite) offer.invite = o.invite;
  return { offer, ephemeral, ...(psk ? { psk } : {}) };
}

/**
 * The answering side: checks the offer, builds the answer (with proof of the secret) and
 * derives the session keys. The caller decides beforehand whether to trust `offer.from`.
 */
export async function answerOffer(o: { offer: PeerOffer; identity: KeyPair; device: DeviceInfo; sdp: string; now?: number }): Promise<{ answer: PeerAnswer; keys: SessionKeys }> {
  const { offer } = o;
  if ((o.now ?? Date.now()) > offer.expires) throw new PairingError('This code has expired; ask for a new one.');
  if (offer.from.key === o.device.key) throw new PairingError('That code is from this device.');
  const ephemeral = await generateKeyPair();
  const answer: PeerAnswer = { t: 'answer', v: PEER_PROTOCOL_VERSION, from: o.device, eph: toBase64Url(ephemeral.publicRaw), nonce: toBase64Url(randomBytes(16)), sdp: o.sdp };
  const transcript = transcriptBytes(offer, answer);
  const psk = offer.psk ? fromBase64Url(offer.psk) : undefined;
  if (psk) answer.mac = toBase64Url(await pairingMac(psk, transcript));
  const keys = await deriveSessionKeys({ role: 'responder', identity: o.identity, ephemeral, peerIdentity: fromBase64Url(offer.from.key), peerEphemeral: fromBase64Url(offer.eph), transcript, ...(psk ? { psk } : {}) });
  return { answer, keys };
}

/**
 * The offering side, once the answer is back: verifies the proof of the pairing secret (or that
 * the answer comes from the expected paired device) and derives the session keys.
 */
export async function completeOffer(o: { started: StartedOffer; answer: PeerAnswer; identity: KeyPair; expectPeerKey?: string; now?: number }): Promise<SessionKeys> {
  const { offer, ephemeral, psk } = o.started;
  const { answer } = o;
  if ((o.now ?? Date.now()) > offer.expires + 60_000) throw new PairingError('This connection attempt has expired; start again.');
  if (o.expectPeerKey && answer.from.key !== o.expectPeerKey) throw new PairingError(`The answer came from a different device than “${answer.from.name}” was paired as.`);
  const transcript = transcriptBytes(offer, answer);
  if (psk) {
    const mac = answer.mac ? fromBase64Url(answer.mac) : null;
    if (!mac || !timingSafeEqual(mac, await pairingMac(psk, transcript))) throw new PairingError('The answer is not from a device that scanned this code.');
  }
  return deriveSessionKeys({ role: 'initiator', identity: o.identity, ephemeral, peerIdentity: fromBase64Url(answer.from.key), peerEphemeral: fromBase64Url(answer.eph), transcript, ...(psk ? { psk } : {}) });
}
