import type { FetchLike } from '../src/index.ts';

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
  signal?: AbortSignal | null;
}

/** Builds an SSE body. Objects are JSON-encoded; `sep` lets tests use CRLF like Google does. */
export function sse(events: Array<{ event?: string; data: unknown } | string>, sep = '\n'): string {
  return events
    .map((e) => {
      if (typeof e === 'string') return `data: ${e}${sep}${sep}`;
      const data = typeof e.data === 'string' ? e.data : JSON.stringify(e.data);
      return `${e.event ? `event: ${e.event}${sep}` : ''}data: ${data}${sep}${sep}`;
    })
    .join('');
}

/** A streaming Response whose body arrives in small chunks (splitting lines and UTF-8 sequences). */
export function streamResponse(text: string, opts: { chunkSize?: number; status?: number; headers?: Record<string, string> } = {}): Response {
  const bytes = new TextEncoder().encode(text);
  const size = opts.chunkSize ?? 7;
  let i = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (i >= bytes.length) return ctrl.close();
      ctrl.enqueue(bytes.slice(i, i + size));
      i += size;
    },
  });
  return new Response(body, { status: opts.status ?? 200, headers: { 'content-type': 'text/event-stream', ...opts.headers } });
}

export function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

export type MockFetch = FetchLike & { calls: RecordedRequest[] };

/** A fetch that records every request and answers from `handler` (or a queue of responses). */
export function mockFetch(handler: ((req: RecordedRequest, n: number) => Response | Promise<Response>) | Array<Response | (() => Response) | Error>): MockFetch {
  const calls: RecordedRequest[] = [];
  const f = (async (input: string, init: RequestInit = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    let body: any = init.body;
    if (typeof body === 'string') {
      try {
        body = JSON.parse(body);
      } catch {
        /* keep text */
      }
    }
    const rec: RecordedRequest = { url: input, method: init.method ?? 'GET', headers, body, signal: init.signal };
    calls.push(rec);
    if (init.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (Array.isArray(handler)) {
      const next = handler[calls.length - 1];
      if (!next) throw new Error(`mockFetch: no response queued for call ${calls.length}`);
      if (next instanceof Error) throw next;
      return typeof next === 'function' ? next() : next;
    }
    return handler(rec, calls.length - 1);
  }) as MockFetch;
  f.calls = calls;
  return f;
}

/** A body that never ends until the request is aborted. */
export function hangingStream(first: string): Response {
  const enc = new TextEncoder();
  let sent = false;
  const body = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (!sent) {
        sent = true;
        ctrl.enqueue(enc.encode(first));
        return;
      }
      return new Promise<void>(() => {}); // never resolves
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

export function deferred<T = void>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** A 1×1 transparent PNG. */
export const PNG_1PX = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
