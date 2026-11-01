import { AIError, abortError, httpError, isAbortLike, networkError } from './errors.ts';
import type { FetchLike, HttpOptions } from './types.ts';

export interface SSEMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * Incremental Server-Sent Events parser (WHATWG rules: `event`/`data`/`id` fields, multi-line
 * data joined with `\n`, comments, CR/LF/CRLF line endings, BOM). Feed it decoded text chunks.
 */
export class SSEParser {
  private buf = '';
  private event = '';
  private data: string[] = [];
  private id: string | undefined;
  private first = true;

  /** Returns the messages completed by this chunk. */
  push(chunk: string): SSEMessage[] {
    if (this.first) {
      if (chunk.charCodeAt(0) === 0xfeff) chunk = chunk.slice(1);
      if (chunk) this.first = false;
    }
    this.buf += chunk;
    const out: SSEMessage[] = [];
    let start = 0;
    for (let i = 0; i < this.buf.length; i++) {
      const c = this.buf[i];
      if (c !== '\n' && c !== '\r') continue;
      // A trailing lone CR might be the first half of CRLF; wait for more input.
      if (c === '\r' && i === this.buf.length - 1) break;
      const line = this.buf.slice(start, i);
      if (c === '\r' && this.buf[i + 1] === '\n') i++;
      start = i + 1;
      const msg = this.line(line);
      if (msg) out.push(msg);
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** Flushes a final event that was not terminated by a blank line. */
  end(): SSEMessage[] {
    const out: SSEMessage[] = [];
    if (this.buf) {
      const m = this.line(this.buf.replace(/\r$/, ''));
      if (m) out.push(m);
      this.buf = '';
    }
    const m = this.dispatch();
    if (m) out.push(m);
    return out;
  }

  private line(line: string): SSEMessage | null {
    if (line === '') return this.dispatch();
    if (line.startsWith(':')) return null;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    else if (field === 'id') this.id = value;
    return null;
  }

  private dispatch(): SSEMessage | null {
    if (!this.data.length) {
      this.event = '';
      return null;
    }
    const msg: SSEMessage = { event: this.event || 'message', data: this.data.join('\n') };
    if (this.id !== undefined) msg.id = this.id;
    this.event = '';
    this.data = [];
    return msg;
  }
}

/** Iterates the SSE messages of a streaming response body. */
export async function* readSSE(res: Response, opts: { provider: string; label: string; url: string; signal?: AbortSignal }): AsyncGenerator<SSEMessage> {
  const parser = new SSEParser();
  if (!res.body) {
    // Some fetch shims buffer the whole body.
    const all = await res.text();
    yield* parser.push(all);
    yield* parser.end();
    return;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  const onAbort = () => void reader.cancel().catch(() => {});
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    for (;;) {
      if (opts.signal?.aborted) throw abortError(opts.provider, opts.signal.reason);
      let r: ReadableStreamReadResult<Uint8Array>;
      try {
        r = await reader.read();
      } catch (e) {
        if (isAbortLike(e, opts.signal)) throw abortError(opts.provider, e);
        throw networkError(opts.provider, opts.label, opts.url, e);
      }
      if (opts.signal?.aborted) throw abortError(opts.provider, opts.signal.reason);
      if (r.done) break;
      yield* parser.push(decoder.decode(r.value, { stream: true }));
    }
    yield* parser.push(decoder.decode());
    yield* parser.end();
  } finally {
    opts.signal?.removeEventListener('abort', onAbort);
    try {
      reader.releaseLock();
    } catch {
      /* already released */
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export function resolveFetch(f?: FetchLike): FetchLike {
  if (f) return f;
  const g = (globalThis as { fetch?: FetchLike }).fetch;
  if (!g) throw new Error('No fetch available: pass `fetch` in the provider config.');
  // Calling an unbound window.fetch throws "Illegal invocation" in browsers.
  return (input, init) => g.call(globalThis, input, init);
}

export interface SendOptions extends HttpOptions {
  provider: string;
  label: string;
  url: string;
  init: RequestInit;
  signal?: AbortSignal;
}

const RETRY_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MAX_RETRY_AFTER_MS = 30_000;

/**
 * fetch + error normalization + retry with exponential backoff for 408/429/5xx (honouring
 * `retry-after`), never after an abort. Returns the OK response; throws AIError otherwise.
 */
export async function send(opts: SendOptions): Promise<Response> {
  const doFetch = resolveFetch(opts.fetch);
  const maxRetries = opts.maxRetries ?? 2;
  const base = opts.retryBaseMs ?? 600;
  for (let attempt = 0; ; attempt++) {
    if (opts.signal?.aborted) throw abortError(opts.provider, opts.signal.reason);
    let res: Response;
    try {
      res = await doFetch(opts.url, { ...opts.init, signal: opts.signal });
    } catch (e) {
      if (isAbortLike(e, opts.signal)) throw abortError(opts.provider, e);
      throw networkError(opts.provider, opts.label, opts.url, e);
    }
    if (res.ok) return res;
    const rawText = await res.text().catch(() => '');
    let body: unknown = rawText;
    try {
      body = JSON.parse(rawText);
    } catch {
      /* not JSON */
    }
    const err = httpError({ provider: opts.provider, label: opts.label, status: res.status, body, rawText, headers: res.headers });
    const canRetry = RETRY_STATUSES.has(res.status) && err.code !== 'quota' && attempt < maxRetries;
    if (!canRetry) throw err;
    const backoff = base * 2 ** attempt * (1 + Math.random() * 0.25);
    const wait = Math.min(MAX_RETRY_AFTER_MS, err.retryAfterMs ?? backoff);
    try {
      await sleep(wait, opts.signal);
    } catch (e) {
      throw abortError(opts.provider, e);
    }
  }
}

/** Reads a JSON body, mapping malformed bodies to AIError('parse'). */
export async function readJson(res: Response, provider: string): Promise<any> {
  const t = await res.text();
  try {
    return JSON.parse(t);
  } catch (e) {
    throw new AIError({ code: 'parse', provider, message: 'The AI provider sent a response Inkstone could not read.', detail: t.slice(0, 300), cause: e });
  }
}

export function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export function joinUrl(base: string, path: string): string {
  return base.replace(/\/+$/, '') + '/' + path.replace(/^\/+/, '');
}
