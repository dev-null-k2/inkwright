/**
 * The hand-written half of `@inkstone/sdk`: HTTP, authentication, errors, retries, pagination
 * and webhook verification. The generated half (`generated.ts`) adds one typed method per API
 * operation on top. Runs anywhere with `fetch` and Web Crypto: Node 20+, Deno, Bun, browsers,
 * Cloudflare Workers.
 */

/** RFC 9457 problem details, as the API returns them. */
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  errors?: { path: string; message: string }[];
}

/** Thrown for every non-2xx answer; `code` is the API's stable problem code. */
export class InkstoneApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly problem: ProblemDetails | null;
  readonly headers: Headers;
  constructor(status: number, problem: ProblemDetails | null, headers: Headers) {
    super(problem?.detail ?? problem?.title ?? `HTTP ${status}`);
    this.name = 'InkstoneApiError';
    this.status = status;
    this.code = problem?.code ?? 'http_error';
    this.problem = problem;
    this.headers = headers;
  }
}

export interface ClientOptions {
  /** The API base URL, e.g. http://127.0.0.1:8765/api/v1 or https://notes.example.com/api/v1. */
  baseUrl: string;
  /** An API key (`ink_…`), the server token, or an OAuth access token. */
  apiKey?: string;
  /** Custom fetch (tests, proxies). */
  fetch?: typeof globalThis.fetch;
  /**
   * Retries for 429 and 5xx answers and network errors (default 2). Only safe requests are
   * retried: GETs, and POSTs that carry an Idempotency-Key (the client adds one automatically).
   */
  maxRetries?: number;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
}

export interface RequestOptions {
  /** Sent as If-Match: the write fails with 412 if the note changed since you read this ETag. */
  ifMatch?: string;
  /** Sent as If-None-Match on reads; a match answers 304 and the method resolves to `null`. */
  ifNoneMatch?: string;
  /** Overrides the automatic Idempotency-Key. */
  idempotencyKey?: string;
  signal?: AbortSignal;
}

export interface Operation {
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: string;
  pathParams: readonly string[];
  queryParams: readonly string[];
  hasBody: boolean;
  idempotent: boolean;
  response: 'json' | 'text' | 'bytes' | 'none';
}

/** What the last response of a call carried besides its body (ETag, rate limit). */
export interface ResponseMeta {
  status: number;
  etag: string | null;
  rateLimit: string | null;
  location: string | null;
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(signal.reason); }, { once: true });
  });

export class BaseClient {
  protected readonly opts: Required<Pick<ClientOptions, 'baseUrl' | 'maxRetries'>> & ClientOptions;
  /** Metadata of the most recent response (ETag, rate limit…). */
  lastResponse: ResponseMeta | null = null;

  constructor(opts: ClientOptions) {
    if (!opts.baseUrl) throw new Error('Pass baseUrl, e.g. http://127.0.0.1:8765/api/v1');
    this.opts = { maxRetries: 2, ...opts, baseUrl: opts.baseUrl.replace(/\/+$/, '') };
  }

  /** Calls one operation. Generated methods use this; call it directly for anything they lack. */
  async request<T>(op: Operation, args: Record<string, unknown> = {}, ro: RequestOptions = {}): Promise<T> {
    let path = op.path;
    for (const p of op.pathParams) {
      const v = args[p];
      if (v === undefined || v === null || v === '') throw new Error(`Missing path parameter "${p}".`);
      path = path.replace(`{${p}}`, encodeURIComponent(String(v)));
    }
    const qs = new URLSearchParams();
    for (const q of op.queryParams) if (args[q] !== undefined && args[q] !== null) qs.set(q, String(args[q]));
    const url = `${this.opts.baseUrl}${path}${qs.size ? `?${qs}` : ''}`;
    const headers: Record<string, string> = { accept: op.response === 'json' ? 'application/json' : '*/*', ...this.opts.headers };
    if (this.opts.apiKey) headers.authorization = `Bearer ${this.opts.apiKey}`;
    if (ro.ifMatch) headers['if-match'] = ro.ifMatch;
    if (ro.ifNoneMatch) headers['if-none-match'] = ro.ifNoneMatch;
    if (op.idempotent) headers['idempotency-key'] = ro.idempotencyKey ?? crypto.randomUUID();
    let body: string | undefined;
    if (op.hasBody) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(args.body ?? {});
    }
    const retryable = op.method === 'GET' || op.idempotent;
    const fetchFn = this.opts.fetch ?? globalThis.fetch;
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchFn(url, { method: op.method, headers, body, signal: ro.signal });
      } catch (e) {
        if (!retryable || attempt >= this.opts.maxRetries || ro.signal?.aborted) throw e;
        await sleep(250 * 2 ** attempt, ro.signal);
        continue;
      }
      this.lastResponse = { status: res.status, etag: res.headers.get('etag'), rateLimit: res.headers.get('ratelimit'), location: res.headers.get('location') };
      if ((res.status === 429 || res.status >= 500) && retryable && attempt < this.opts.maxRetries) {
        const after = Number(res.headers.get('retry-after'));
        await res.body?.cancel().catch(() => {});
        await sleep(Number.isFinite(after) && after > 0 ? Math.min(after, 60) * 1000 : 250 * 2 ** attempt, ro.signal);
        continue;
      }
      if (res.status === 304) return null as T;
      if (!res.ok) {
        let problem: ProblemDetails | null = null;
        try {
          problem = (await res.json()) as ProblemDetails;
        } catch {
          /* not a problem document */
        }
        throw new InkstoneApiError(res.status, problem, res.headers);
      }
      if (op.response === 'none' || res.status === 204) return undefined as T;
      if (op.response === 'text') return (await res.text()) as T;
      if (op.response === 'bytes') return new Uint8Array(await res.arrayBuffer()) as T;
      return (await res.json()) as T;
    }
  }
}

/**
 * Walks every page of a list operation: `for await (const n of paginate((cursor) => client.listNotes({ cursor })))`.
 */
export async function* paginate<T>(page: (cursor: string | undefined) => Promise<{ data: T[]; nextCursor: string | null }>): AsyncGenerator<T> {
  let cursor: string | undefined;
  do {
    const p = await page(cursor);
    yield* p.data;
    cursor = p.nextCursor ?? undefined;
  } while (cursor);
}

function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

function b64encode(b: Uint8Array): string {
  let s = '';
  for (const x of b) s += String.fromCharCode(x);
  return btoa(s);
}

/**
 * Verifies a webhook delivery (Standard Webhooks): the HMAC-SHA256 signature over
 * `id.timestamp.body` and a timestamp within `toleranceSec` (default 5 minutes). Pass the raw
 * body exactly as received.
 */
export async function verifyWebhook(secret: string, headers: Headers | Record<string, string | undefined>, body: string, opts: { now?: number; toleranceSec?: number } = {}): Promise<boolean> {
  const get = (k: string) => (headers instanceof Headers ? headers.get(k) : headers[k] ?? headers[k.toLowerCase()]) ?? null;
  const id = get('webhook-id');
  const ts = get('webhook-timestamp');
  const sig = get('webhook-signature');
  if (!id || !ts || !sig) return false;
  const t = Number(ts);
  if (!Number.isInteger(t) || Math.abs((opts.now ?? Date.now()) / 1000 - t) > (opts.toleranceSec ?? 300)) return false;
  const key = await crypto.subtle.importKey('raw', b64decode(secret.replace(/^whsec_/, '')) as BufferSource, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const want = b64encode(new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${t}.${body}`))));
  return sig.split(' ').some((part) => {
    const [v, s] = part.split(',');
    if (v !== 'v1' || !s || s.length !== want.length) return false;
    let diff = 0;
    for (let i = 0; i < s.length; i++) diff |= s.charCodeAt(i) ^ want.charCodeAt(i);
    return diff === 0;
  });
}

/** The JSON body of a webhook delivery. */
export interface WebhookMessage<T = Record<string, unknown>> {
  type: 'note.created' | 'note.updated' | 'note.trashed' | 'note.restored' | 'recording.ended' | 'routine.finished';
  timestamp: string;
  data: T;
}
