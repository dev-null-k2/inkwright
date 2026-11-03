/**
 * Short connection codes: eight characters a person can read out, type on a phone or send in a
 * message — `K7PM-2Q9X` — instead of a kilobyte-long WebRTC offer.
 *
 * A code has two parts with different jobs, in the style of Magic Wormhole:
 *
 * - the first **3 characters (15 bits) are the nameplate**: they only say *where to meet*. The
 *   rendezvous room on the relay is a hash of them, so the relay never sees the code itself, but
 *   15 bits are not a secret and are not treated as one;
 * - the last **5 characters (25 bits) are the password**. They never leave the device: both sides
 *   feed them into CPace (cpace.ts), which turns them into a strong shared key. An attacker —
 *   the relay, or anyone posting to it — gets **one guess per attempt**, and the host locks the
 *   code after `MAX_ATTEMPTS` attempts, so the chance of guessing a live code is at most
 *   `MAX_ATTEMPTS / 2^25` ≈ 1.5 × 10⁻⁷ — and that only within its ten minutes.
 *
 * The alphabet is Crockford's base 32: digits and capitals without I, L, O and U, so nothing looks
 * alike; when reading, `O` counts as `0`, `I` and `L` as `1`, case and spaces or dashes don't matter.
 */
import { utf8Encode } from '../util.ts';
import { randomBytes, sha256 } from './crypto.ts';

export const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const CODE_LENGTH = 8;
export const NAMEPLATE_LENGTH = 3;
/** 5 bits per character. */
export const NAMEPLATE_BITS = NAMEPLATE_LENGTH * 5;
export const PASSWORD_BITS = (CODE_LENGTH - NAMEPLATE_LENGTH) * 5;
/** Attempts (PAKE runs) a host answers per code before locking it. */
export const MAX_ATTEMPTS = 5;
/** Codes work for ten minutes, like the long codes. */
export const CODE_TTL_MS = 10 * 60_000;
/** The most an online attacker can hope for against one code: MAX_ATTEMPTS guesses of 2^PASSWORD_BITS. */
export const GUESS_BOUND = MAX_ATTEMPTS / 2 ** PASSWORD_BITS;

export interface ShortCode {
  /** The eight characters, canonical (no dash). */
  value: string;
  /** Public part: picks the rendezvous room. */
  nameplate: string;
  /** Secret part: the CPace password. */
  password: string;
}

const split = (value: string): ShortCode => ({ value, nameplate: value.slice(0, NAMEPLATE_LENGTH), password: value.slice(NAMEPLATE_LENGTH) });

/** A fresh random code (each character uniform: 256 is a multiple of 32). */
export function generateShortCode(): ShortCode {
  const b = randomBytes(CODE_LENGTH);
  return split([...b].map((x) => CODE_ALPHABET[x & 31]).join(''));
}

/** The code as people see it: two groups of four. */
export function formatShortCode(code: ShortCode | string): string {
  const v = typeof code === 'string' ? code : code.value;
  return `${v.slice(0, 4)}-${v.slice(4)}`;
}

/**
 * Reads what a person typed or a link carried. Returns null unless it is exactly a code (after
 * the forgiving substitutions), so callers can wait for more typing instead of failing.
 */
export function parseShortCode(input: string): ShortCode | null {
  const v = input
    .toUpperCase()
    .replace(/[\s\-_.·]+/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (v.length !== CODE_LENGTH) return null;
  for (const c of v) if (!CODE_ALPHABET.includes(c)) return null;
  return split(v);
}

/** Letters a person may type that can never be part of a code (for a calm "U isn't used" hint). */
export const isCodeCharacter = (c: string): boolean => CODE_ALPHABET.includes(c.toUpperCase().replace('O', '0').replace(/[IL]/, '1'));

/**
 * The rendezvous room for a nameplate: a domain-separated hash, so the relay sees an opaque id
 * rather than the typed characters and other apps on the same relay never share our rooms.
 * (Anyone can compute it from the nameplate, which is why the nameplate carries no secret.)
 */
export async function rendezvousRoom(nameplate: string): Promise<string> {
  const h = await sha256(utf8Encode(`inkwright.rendezvous.v1 ${nameplate}`));
  return `iw1${[...h.subarray(0, 20)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export type CodeStatus = 'open' | 'used' | 'expired' | 'locked';

/**
 * The host's bookkeeping for one code: one-time use, expiry, and the attempt budget that bounds
 * online guessing. Every PAKE run the host answers counts — the answer is what tells a guesser
 * whether the guess was right — whether or not the other side then confirms.
 */
export class CodeGuard {
  private attempts = 0;
  private pending = 0;
  private used = false;
  readonly expiresAt: number;

  constructor(readonly createdAt: number = Date.now(), ttlMs = CODE_TTL_MS, readonly maxAttempts = MAX_ATTEMPTS) {
    this.expiresAt = createdAt + ttlMs;
  }

  status(now = Date.now()): CodeStatus {
    if (this.used) return 'used';
    if (now >= this.expiresAt) return 'expired';
    if (this.attempts >= this.maxAttempts && this.pending === 0) return 'locked';
    return 'open';
  }

  get attemptsUsed(): number {
    return this.attempts;
  }

  /** Takes one attempt from the budget; false when the code may not be tried any more. */
  begin(now = Date.now()): boolean {
    if (this.status(now) !== 'open' || this.attempts >= this.maxAttempts) return false;
    this.attempts++;
    this.pending++;
    return true;
  }

  /** An attempt ended without proving the code (wrong code, or it never confirmed). */
  fail(): void {
    this.pending = Math.max(0, this.pending - 1);
  }

  /** An attempt proved the code: it is used up. */
  succeed(): void {
    this.pending = Math.max(0, this.pending - 1);
    this.used = true;
  }
}
