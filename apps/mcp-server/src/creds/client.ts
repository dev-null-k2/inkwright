/**
 * The client side of the credential executor, for the always-on runner, the context-saving proxy
 * and the desktop app's sidecar. It turns the executor's two operations into things those
 * processes already use:
 *
 * - `fetchFor(name)` — a `fetch` whose requests the executor makes with credential `name`. Hand it
 *   to any @inkwright/ai provider (`createProvider({ fetch, apiKey: CREDENTIAL_PLACEHOLDER })`):
 *   the provider builds its request as usual, the placeholder key it adds is dropped by the
 *   executor, and the real one is added there. Streaming responses stream.
 * - `providerFor(name, providerId)` — exactly that, ready-made.
 * - `listTools` / `callTool` — a connector's MCP tools.
 */
import { readFile } from 'node:fs/promises';
import { connect, type Socket } from 'node:net';
import { createProvider, type Provider } from '@inkwright/ai';
import { VERSION } from '../version.ts';
import { executorEndpoint, readFrames, tokenFile, writeFrame, type Actor, type CredentialSummary, type Response as Frame } from './protocol.ts';

/** What clients put where a key would go; the executor discards it. */
export const CREDENTIAL_PLACEHOLDER = 'inkwright-credential-executor';

export class CredentialExecutorError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'CredentialExecutorError';
  }
}

interface Pending {
  onFrame(f: Frame): void;
  onClose(e: Error): void;
}

export interface ConnectOptions {
  /** The credentials folder (default endpoint and token file). */
  dir: string;
  endpoint?: string;
  /** Client name in the executor's audit entries. */
  name: string;
  actor?: Actor;
  timeoutMs?: number;
}

export class CredentialClient {
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private closed: Error | null = null;
  credentials: CredentialSummary[] = [];

  private constructor(private socket: Socket, private actor: Actor) {
    readFrames(
      socket,
      (v) => {
        const f = v as Frame;
        this.pending.get(f.id)?.onFrame(f);
      },
      (e) => this.fail(e),
    );
    socket.on('close', () => this.fail(new CredentialExecutorError('closed', 'The credential executor closed the connection.')));
    socket.on('error', (e) => this.fail(new CredentialExecutorError('unavailable', `Credential executor: ${e.message}`)));
  }

  /** Connects and authenticates with the token from the executor's private folder. */
  static async connect(o: ConnectOptions): Promise<CredentialClient> {
    const endpoint = o.endpoint ?? executorEndpoint(o.dir);
    const token = (await readFile(tokenFile(o.dir), 'utf8').catch(() => '')).trim();
    if (!token) throw new CredentialExecutorError('unavailable', `The credential executor is not running (no token in ${tokenFile(o.dir)}). Start it with: inkwright-mcp creds serve --vault <dir>`);
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(endpoint);
      const t = setTimeout(() => {
        s.destroy();
        reject(new CredentialExecutorError('unavailable', 'The credential executor did not answer.'));
      }, o.timeoutMs ?? 5000);
      s.once('connect', () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once('error', (e) => {
        clearTimeout(t);
        reject(new CredentialExecutorError('unavailable', `The credential executor is not reachable at ${endpoint}: ${e.message}`));
      });
    });
    const client = new CredentialClient(socket, o.actor ?? { source: o.name });
    const hello = (await client.call({ op: 'hello', token, client: { name: o.name, pid: process.pid, version: VERSION } })) as { credentials: CredentialSummary[] };
    client.credentials = hello.credentials;
    return client;
  }

  close(): void {
    this.socket.end();
    this.socket.destroy();
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = e;
    for (const p of this.pending.values()) p.onClose(e);
    this.pending.clear();
  }

  private send(body: Record<string, unknown>, p: Pending): number {
    if (this.closed) throw this.closed;
    const id = this.nextId++;
    this.pending.set(id, p);
    writeFrame(this.socket, { id, ...body });
    return id;
  }

  /** One request with one `ok` answer. */
  private call(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = this.send(body, {
        onFrame: (f) => {
          this.pending.delete(f.id);
          if (f.type === 'ok') resolve(f.result);
          else if (f.type === 'error') reject(new CredentialExecutorError(f.code, f.message));
          else reject(new CredentialExecutorError('protocol', `Unexpected ${f.type} frame.`));
        },
        onClose: reject,
      });
      signal?.addEventListener('abort', () => this.cancel(id), { once: true });
    });
  }

  private cancel(target: number): void {
    if (!this.closed) writeFrame(this.socket, { id: this.nextId++, op: 'cancel', target });
  }

  async list(): Promise<CredentialSummary[]> {
    const r = (await this.call({ op: 'list' })) as { credentials: CredentialSummary[] };
    this.credentials = r.credentials;
    return r.credentials;
  }

  find(name: string): CredentialSummary | undefined {
    return this.credentials.find((c) => c.name === name);
  }

  /**
   * A `fetch` whose requests the executor makes with credential `name`. The response body is a
   * stream fed as the executor relays the upstream body.
   */
  fetchFor(name: string, actor: Actor = this.actor): (input: string | URL | Request, init?: RequestInit) => Promise<Response> {
    return async (input, init) => {
      const req = input instanceof Request ? input : null;
      const url = req ? req.url : String(input);
      const method = (init?.method ?? req?.method ?? 'GET').toUpperCase();
      const headers: Record<string, string> = {};
      new Headers(init?.headers ?? req?.headers).forEach((v, k) => (headers[k] = v));
      const rawBody = init?.body ?? (req && method !== 'GET' ? await req.arrayBuffer() : undefined);
      const body = rawBody == null ? undefined : await new Response(rawBody as BodyInit).arrayBuffer();
      const signal = init?.signal ?? req?.signal ?? undefined;
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return new Promise<Response>((resolve, reject) => {
        let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
        let headed = false;
        const id = this.send(
          { op: 'http', credential: name, actor, request: { method, url, headers, ...(body ? { body: Buffer.from(body).toString('base64') } : {}) } },
          {
            onFrame: (f) => {
              if (f.type === 'head') {
                headed = true;
                const stream = new ReadableStream<Uint8Array>({
                  start: (c) => {
                    controller = c;
                  },
                  cancel: () => this.cancel(id),
                });
                const noBody = f.status === 204 || f.status === 304 || method === 'HEAD';
                resolve(new Response(noBody ? null : stream, { status: f.status, headers: f.headers }));
              } else if (f.type === 'chunk') controller?.enqueue(new Uint8Array(Buffer.from(f.data, 'base64')));
              else if (f.type === 'end') {
                this.pending.delete(f.id);
                try { controller?.close(); } catch { /* already closed by the reader */ }
              } else if (f.type === 'error') {
                this.pending.delete(f.id);
                const e = new CredentialExecutorError(f.code, f.message);
                if (headed) controller?.error(e);
                else reject(e);
              }
            },
            onClose: (e) => (headed ? controller?.error(e) : reject(e)),
          },
        );
        signal?.addEventListener('abort', () => this.cancel(id), { once: true });
      });
    };
  }

  /** An @inkwright/ai provider whose calls go out through the executor with credential `name`. */
  providerFor(name: string, actor?: Actor): Provider {
    const c = this.find(name);
    if (!c) throw new CredentialExecutorError('not_found', `The credential executor has no credential named ${name}.`);
    if (c.kind !== 'provider' || !c.provider) throw new CredentialExecutorError('bad_request', `${name} is not an AI provider credential.`);
    const f = this.fetchFor(name, actor);
    const p = createProvider({ providerId: c.provider, apiKey: CREDENTIAL_PLACEHOLDER, baseUrl: c.url, fetch: (i, init) => f(i, init) });
    // The provider reports a failed fetch as "couldn't reach"; the executor's own refusal (policy,
    // allow-list, unknown credential) is the real reason, and `policy_blocked` keeps its code so
    // the trust layer treats it like its own refusals.
    const chat: Provider['chat'] = async (req, onEvent) => {
      try {
        return await p.chat(req, onEvent);
      } catch (e) {
        const cause = (e as { cause?: unknown }).cause;
        throw cause instanceof CredentialExecutorError ? cause : e;
      }
    };
    return Object.assign(Object.create(Object.getPrototypeOf(p)) as Provider, p, { chat });
  }

  async listTools(name: string): Promise<Array<{ name: string; description: string; inputSchema: Record<string, unknown>; annotations?: Record<string, unknown> }>> {
    return ((await this.call({ op: 'tools', credential: name, actor: this.actor })) as { tools: never[] }).tools;
  }

  /** Calls a connector tool; the result is the MCP outcome (`{kind: 'result', result}` or a task). */
  async callTool(name: string, tool: string, args: Record<string, unknown>, o: { actor?: Actor; signal?: AbortSignal } = {}): Promise<{ kind: 'result'; result: { content: unknown[]; isError?: boolean; structuredContent?: unknown } } | { kind: 'task'; task: unknown }> {
    return (await this.call({ op: 'tool', credential: name, tool, args, actor: o.actor ?? this.actor }, o.signal)) as never;
  }
}
