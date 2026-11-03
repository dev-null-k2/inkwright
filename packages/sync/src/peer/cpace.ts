/**
 * CPace: a password-authenticated key exchange (PAKE), so that two devices which share only a
 * short code derive a strong session key, and nobody in between — the relay included — can learn
 * the code or test guesses of it offline.
 *
 * Why CPace (and not SPAKE2, OPAQUE or a hash of the code):
 * - **A hash or HMAC of a short code is brute-forced offline** in milliseconds by whoever relays
 *   it. A PAKE gives an active attacker exactly one guess per run, and a passive one none.
 * - **CPace is the balanced PAKE the IRTF CFRG selected** (2020 PAKE selection) and is being
 *   standardised in draft-irtf-cfrg-cpace. It has a UC security proof, needs no trusted setup and
 *   is one hash-to-group plus one scalar multiplication per side.
 * - **SPAKE2** (RFC 9382) needs two fixed group elements M and N whose discrete logs nobody may
 *   know; RFC 9382 defines them for some curves, not for ristretto255, and SPAKE2's proof is in a
 *   weaker model. OPAQUE is augmented (client/server), which does not fit two equal devices.
 * - **No vetted JavaScript CPace library exists**, so this file composes audited primitives:
 *   ristretto255, its element derivation (RFC 9496 §4.3.4) and SHA-512 from `@noble/curves` and
 *   `@noble/hashes` (audited by Cure53 in 2024 and Trail of Bits in 2023). The construction
 *   follows draft-irtf-cfrg-cpace-12 for ristretto255/SHA-512 exactly, and the unit tests check it
 *   against the draft's published test vectors (generator, Ya, Yb, K, ISK and sid output).
 *
 * Usage here (shortcode.ts): the guest is the initiator, the host the responder; the channel
 * identifier binds the rendezvous room and protocol, the session id is a fresh random value the
 * guest picks, and the associated data names each role. After CPace, explicit key confirmation
 * (`confirmationTag`) lets each side reject a wrong code before anything else is sent.
 */
import { ristretto255, ristretto255_hasher } from '@noble/curves/ed25519.js';
import { bytesToNumberLE } from '@noble/curves/utils.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { hmac } from '@noble/hashes/hmac.js';
import { sha256, sha512 } from '@noble/hashes/sha2.js';
import { concatBytes, utf8Encode } from '../util.ts';
import { randomBytes, timingSafeEqual } from './crypto.ts';

const Point = ristretto255.Point;
type RPoint = InstanceType<typeof Point>;

/** Domain separation identifier of the draft's ristretto255 instantiation. */
export const CPACE_DSI = utf8Encode('CPaceRistretto255');
/** SHA-512's input block size: the generator string is zero-padded so the password fills the first block. */
const S_IN_BYTES = 128;

export class PakeError extends Error {
  override name = 'PakeError';
}

/** LEB128 length prefix (draft "prepend_len"). */
export function prependLen(data: Uint8Array): Uint8Array {
  const out: number[] = [];
  let n = data.length;
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return concatBytes([Uint8Array.from(out), data]);
}

/** Concatenation of length-prefixed parts (draft "lv_cat"): unambiguous whatever the parts hold. */
export function lvCat(...parts: Uint8Array[]): Uint8Array {
  return concatBytes(parts.map(prependLen));
}

/** The string hashed onto the group: DSI, the password, zero padding, channel id and session id. */
export function generatorString(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): Uint8Array {
  const zpad = Math.max(0, S_IN_BYTES - 1 - prependLen(prs).length - prependLen(CPACE_DSI).length);
  return lvCat(CPACE_DSI, prs, new Uint8Array(zpad), ci, sid);
}

/** The password-dependent generator g = element_derivation(SHA-512(generator string)). */
export function calculateGenerator(prs: Uint8Array, ci: Uint8Array, sid: Uint8Array): RPoint {
  return ristretto255_hasher.deriveToCurve!(sha512(generatorString(prs, ci, sid)));
}

/** A uniformly random non-zero scalar (64 random bytes reduced mod the group order: negligible bias). */
export function sampleScalar(): bigint {
  for (;;) {
    const s = Point.Fn.create(bytesToNumberLE(randomBytes(64)));
    if (s !== 0n) return s;
  }
}

/** Decodes the peer's element and multiplies; refuses invalid encodings and the identity (draft "scalar_mult_vfy"). */
export function scalarMultVfy(y: bigint, encoded: Uint8Array): Uint8Array {
  let X: RPoint;
  try {
    X = Point.fromBytes(encoded);
  } catch {
    throw new PakeError('The other device sent an invalid key-exchange message.');
  }
  const K = X.multiply(y);
  if (K.is0()) throw new PakeError('The other device sent an invalid key-exchange message.');
  return K.toBytes();
}

/** Intermediate session key for the initiator–responder setting (draft "ISK" with transcript_ir). */
export function intermediateSessionKey(o: { sid: Uint8Array; K: Uint8Array; Ya: Uint8Array; ADa: Uint8Array; Yb: Uint8Array; ADb: Uint8Array }): Uint8Array {
  const prefix = lvCat(concatBytes([CPACE_DSI, utf8Encode('_ISK')]), o.sid, o.K);
  return sha512(concatBytes([prefix, lvCat(o.Ya, o.ADa), lvCat(o.Yb, o.ADb)]));
}

/** The draft's optional session-id output for the initiator–responder setting (tests only). */
export function sidOutputIR(o: { Ya: Uint8Array; ADa: Uint8Array; Yb: Uint8Array; ADb: Uint8Array }): Uint8Array {
  return sha512(concatBytes([utf8Encode('CPaceSidOutput'), lvCat(o.Ya, o.ADa), lvCat(o.Yb, o.ADb)]));
}

export interface CpaceParams {
  /** The password-related string: the secret part of the short code. */
  prs: Uint8Array;
  /** Channel identifier: binds the protocol and the rendezvous room. */
  ci: Uint8Array;
  /** Session id: fresh and random per run (the initiator picks it). */
  sid: Uint8Array;
}

/** One side of one CPace run. Scalars stay in this object and are never serialised. */
export class CpaceParty {
  /** Our public share Y = y·g (32 bytes): safe to send over any channel. */
  readonly share: Uint8Array;
  private readonly y: bigint;

  /** `scalar` is for test vectors only; real runs always sample a fresh one. */
  constructor(private readonly role: 'initiator' | 'responder', private readonly p: CpaceParams, readonly ad: Uint8Array, scalar?: bigint) {
    this.y = scalar ?? sampleScalar();
    this.share = calculateGenerator(p.prs, p.ci, p.sid).multiply(this.y).toBytes();
  }

  /**
   * Combines the peer's share into the ISK (64 bytes). Equal on both sides exactly when both used
   * the same password, channel id and session id and saw the same shares and associated data.
   *
   * A responder is made per run (one share answered = one guess for whoever sent it). An
   * initiator may combine several replies to its single share — if two hosts happen to listen in
   * one rendezvous room, only the one with the same code confirms; that gives nobody an extra
   * guess, since each reply is checked against the one password this side holds.
   */
  finish(peerShare: Uint8Array, peerAd: Uint8Array): Uint8Array {
    const K = scalarMultVfy(this.y, peerShare);
    const [Ya, ADa, Yb, ADb] = this.role === 'initiator' ? [this.share, this.ad, peerShare, peerAd] : [peerShare, peerAd, this.share, this.ad];
    return intermediateSessionKey({ sid: this.p.sid, K, Ya, ADa, Yb, ADb });
  }
}

// ---- What the rest of the peer link takes from the ISK ------------------------------------------

const INFO = 'inkwright.shortcode.v1';

/** A 32-byte key for one purpose, derived from the ISK with HKDF-SHA-256. */
export function iskKey(isk: Uint8Array, purpose: string): Uint8Array {
  return hkdf(sha256, isk, new Uint8Array(0), utf8Encode(`${INFO} ${purpose}`), 32);
}

/**
 * Explicit key confirmation: a tag only a holder of the same ISK can compute, different for each
 * role so one side's tag can't be reflected back as the other's.
 */
export function confirmationTag(isk: Uint8Array, role: 'host' | 'guest'): Uint8Array {
  return hmac(sha256, iskKey(isk, `confirm ${role}`), utf8Encode(`${INFO} key confirmation ${role}`));
}

/** Checks the other side's confirmation tag in constant time. */
export function verifyConfirmation(isk: Uint8Array, role: 'host' | 'guest', tag: Uint8Array): boolean {
  return timingSafeEqual(confirmationTag(isk, role), tag);
}

export const newSessionId = (): Uint8Array => randomBytes(16);
