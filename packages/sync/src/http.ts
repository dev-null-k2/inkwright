import { RemoteError } from './remote.ts';
import { abortError, isAbortError, sleep, toBufferView } from './util.ts';

export interface RetryOptions {
  /** Retries after the first attempt (default 5). */
  retries?: number;
  /** First backoff delay (default 500 ms); doubles each retry, with jitter. */
  baseDelayMs?: number;
  /** Cap for any single wait, including server `Retry-After` (default 30 s). */
  maxDelayMs?: number;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

export interface HttpRequest {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  signal?: AbortSignal;
}

export interface HttpClientOptions {
  fetch?: typeof fetch;
  /** Auth (and other per-attempt) headers; called before every attempt so refreshed tokens apply. */
  headers?: () => Promise<Record<string, string>> | Record<string, string>;
  /** Called once per request on a 401. Return true to retry with fresh headers. */
  onUnauthorized?: () => Promise<boolean>;
  /** Extra retry predicate (e.g. Drive's 403 rateLimitExceeded). 408/429/5xx always retry. */
  isRetryable?: (res: Response) => Promise<boolean> | boolean;
  retry?: RetryOptions;
}

const RETRY_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function retryAfterMs(res: Response, now: number): number | null {
  const h = res.headers.get('Retry-After');
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

/**
 * fetch with auth, one token refresh on 401, and exponential backoff with jitter on rate limits,
 * 5xx and network errors. Returns the final Response (possibly non-2xx) for the caller to map.
 */
export class HttpClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: HttpClientOptions = {}) {
    this.fetchImpl = opts.fetch ?? ((input, init) => globalThis.fetch(input, init));
  }

  async request(req: HttpRequest): Promise<Response> {
    const r = this.opts.retry ?? {};
    const retries = r.retries ?? 5;
    const base = r.baseDelayMs ?? 500;
    const max = r.maxDelayMs ?? 30_000;
    const doSleep = r.sleep ?? sleep;
    const random = r.random ?? Math.random;
    const backoff = (attempt: number) => Math.min(max, base * 2 ** attempt) * (0.5 + random() / 2);
    const body = typeof req.body === 'string' || req.body === undefined ? req.body : toBufferView(req.body);

    let attempt = 0;
    let refreshed = false;
    for (;;) {
      if (req.signal?.aborted) throw abortError(req.signal);
      const headers = { ...(await this.opts.headers?.()), ...req.headers };
      let res: Response;
      try {
        res = await this.fetchImpl(req.url, { method: req.method, headers, body, signal: req.signal });
      } catch (e) {
        if (isAbortError(e) || req.signal?.aborted) throw req.signal?.aborted ? abortError(req.signal) : e;
        if (attempt >= retries) throw new RemoteError(`Network error: ${(e as Error)?.message ?? e}`, undefined, true);
        await doSleep(backoff(attempt++), req.signal);
        continue;
      }
      if (res.status === 401 && !refreshed && this.opts.onUnauthorized) {
        refreshed = true;
        await res.body?.cancel().catch(() => {});
        if (await this.opts.onUnauthorized()) continue;
        return res;
      }
      if (attempt < retries && (RETRY_STATUS.has(res.status) || (await this.opts.isRetryable?.(res)))) {
        const wait = Math.min(max, retryAfterMs(res, Date.now()) ?? backoff(attempt));
        attempt++;
        await res.body?.cancel().catch(() => {});
        await doSleep(wait, req.signal);
        continue;
      }
      return res;
    }
  }
}

/** Builds a RemoteError from a failed response, including the server's message when present. */
export async function httpError(res: Response, what: string): Promise<RemoteError> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text);
      detail = j?.error?.message ?? j?.message ?? text;
    } catch {
      detail = text;
    }
  } catch {
    /* body unavailable */
  }
  const retryable = RETRY_STATUS.has(res.status);
  return new RemoteError(`${what} failed: HTTP ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`, res.status, retryable);
}
