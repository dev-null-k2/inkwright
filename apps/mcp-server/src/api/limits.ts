/**
 * Rate limiting and idempotency for the REST API.
 *
 * Rate limits are a token bucket per caller (API key, token, OAuth subject or loopback), reported
 * with the IETF `RateLimit-Policy` / `RateLimit` headers (draft-ietf-httpapi-ratelimit-headers)
 * and `Retry-After` on 429.
 *
 * Idempotency follows draft-ietf-httpapi-idempotency-key-header: a POST with `Idempotency-Key`
 * is executed once per (caller, key); repeating it returns the stored response (with
 * `Idempotent-Replayed: true`), the same key with a different request is 422, and a repeat while
 * the first is still running is 409. Keys are remembered for 24 hours, in memory.
 */
import { createHash } from 'node:crypto';
import { ApiError, type ApiResult } from './core.ts';

export interface RateLimitDecision {
  allowed: boolean;
  limit: number;
  remaining: number;
  /** Seconds until the bucket is full again (or, when refused, until the next request fits). */
  resetSec: number;
}

export class RateLimiter {
  private buckets = new Map<string, { tokens: number; at: number }>();

  /** `limit` requests per `windowMs`, refilled continuously. */
  constructor(readonly limit: number, readonly windowMs: number, private clock: () => number = Date.now) {}

  take(key: string): RateLimitDecision {
    const now = this.clock();
    const rate = this.limit / this.windowMs;
    const b = this.buckets.get(key) ?? { tokens: this.limit, at: now };
    b.tokens = Math.min(this.limit, b.tokens + (now - b.at) * rate);
    b.at = now;
    const allowed = b.tokens >= 1;
    if (allowed) b.tokens -= 1;
    this.buckets.set(key, b);
    if (this.buckets.size > 10_000) {
      // Drop full buckets (idle callers) so the map can't grow without bound.
      for (const [k, v] of this.buckets) if (v.tokens + (now - v.at) * rate >= this.limit) this.buckets.delete(k);
    }
    const resetSec = allowed ? Math.ceil((this.limit - b.tokens) / rate / 1000) : Math.ceil((1 - b.tokens) / rate / 1000);
    return { allowed, limit: this.limit, remaining: Math.floor(b.tokens), resetSec };
  }

  headers(d: RateLimitDecision): Record<string, string> {
    const w = Math.round(this.windowMs / 1000);
    return { 'ratelimit-policy': `"default";q=${d.limit};w=${w}`, ratelimit: `"default";r=${d.remaining};t=${d.resetSec}` };
  }
}

interface Stored {
  fingerprint: string;
  at: number;
  result: ApiResult | null;
}

export class IdempotencyStore {
  private entries = new Map<string, Stored>();

  constructor(private clock: () => number = Date.now, private ttlMs = 24 * 3600_000, private max = 5000) {}

  static fingerprint(method: string, path: string, body: unknown): string {
    return createHash('sha256').update(`${method} ${path}\n${JSON.stringify(body ?? null)}`).digest('hex');
  }

  /**
   * Runs `fn` once per (principal, key). Returns the result and whether it was replayed.
   * Failed runs (thrown errors) are not stored, so the client can retry with the same key.
   */
  async run(principal: string, key: string, fingerprint: string, fn: () => Promise<ApiResult>): Promise<{ result: ApiResult; replayed: boolean }> {
    if (!/^[\x21-\x7e]{1,255}$/.test(key)) throw new ApiError('invalid_request', 'Idempotency-Key must be 1–255 visible ASCII characters (a UUID works well).');
    this.sweep();
    const id = `${principal}\u0000${key}`;
    const hit = this.entries.get(id);
    if (hit) {
      if (hit.fingerprint !== fingerprint) throw new ApiError('idempotency_key_reused', 'This Idempotency-Key was already used for a different request. Use a new key for a new request.');
      if (!hit.result) throw new ApiError('idempotency_key_in_use', 'A request with this Idempotency-Key is still being processed. Retry shortly.', { headers: { 'retry-after': '1' } });
      return { result: hit.result, replayed: true };
    }
    const entry: Stored = { fingerprint, at: this.clock(), result: null };
    this.entries.set(id, entry);
    try {
      entry.result = await fn();
      return { result: entry.result, replayed: false };
    } catch (e) {
      this.entries.delete(id);
      throw e;
    }
  }

  private sweep(): void {
    const now = this.clock();
    for (const [k, v] of this.entries) if (now - v.at > this.ttlMs && v.result) this.entries.delete(k);
    while (this.entries.size > this.max) this.entries.delete(this.entries.keys().next().value!);
  }
}
