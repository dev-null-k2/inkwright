/**
 * The context-saving proxy (`inkwright-mcp proxy`): a local OpenAI- and Anthropic-compatible
 * endpoint that other tools (Claude Code, Codex, Aider, Cline, any SDK with a base-URL setting)
 * talk to instead of the provider. On the way through it applies Inkwright's reversible context
 * budgeter (`ContextBudgeter`, docs/TRUST.md) to large tool results and logs, keeps every
 * original on this computer with a retrieval handle, meters what it saved into the vault's usage
 * files (the app's AI usage page shows it as "Context proxy"), and forwards the request upstream.
 *
 * How the model gets an original back, by what the client offers (docs/PROXY.md):
 *
 * | the request… | shortening | `retrieve_original` is answered by |
 * | --- | --- | --- |
 * | offers `retrieve_original` itself (the client runs the Inkwright MCP server) | lossy | the client, through the MCP tool (same store) — streams untouched |
 * | offers other tools (chat completions or messages) | lossy | the proxy: it adds the tool, answers the calls and asks again; a streamed request is then made unstreamed upstream and replayed as a stream |
 * | offers no tools, or is a Responses request without the tool | lossless only | — |
 *
 * Only this computer can reach it: it listens on loopback, checks `Host`, and refuses browser
 * requests (any `Origin` header) and non-JSON bodies, so a web page can't spend the user's key.
 */
import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { hostname } from 'node:os';
import * as path from 'node:path';
import { ContextBudgeter, UsageStore, estimateTokens, type AIPolicy, type ChatMessage, type CompressionItem, type ContentStore } from '@inkwright/ai';
import { NodeFS } from '../nodefs.ts';
import { PolicySource } from '../trust.ts';
import { appendRetrieveRound, callsOf, declaresRetrieve, dialectOf, hasTools, injectRetrieve, responseToSse, slotsOf, usageOf, StreamUsage, type Dialect } from './formats.ts';

export type Upstream = 'openai' | 'anthropic';

/** How the proxy authenticates upstream: the client's own header, a key from the environment, or the credential executor. */
export type UpstreamAuth = { kind: 'client' } | { kind: 'key'; key: string } | { kind: 'executor'; fetch: typeof globalThis.fetch; baseUrl: string };

export interface ProxyOptions {
  vaultRoot: string;
  managedPolicyFile?: string;
  originals: ContentStore;
  upstreams: Record<Upstream, { baseUrl: string; auth: UpstreamAuth }>;
  port: number;
  host?: string;
  /** Turn shortening off (metering only). */
  compress?: boolean;
  /** Most `retrieve_original` rounds the proxy answers per request (default 3). */
  maxRetrieveRounds?: number;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  log?: (m: string) => void;
}

const HOP = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer', 'proxy-authorization', 'accept-encoding', 'origin', 'referer', 'cookie']);
const AUTH = ['authorization', 'x-api-key', 'api-key', 'x-goog-api-key'];
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

export interface ProxyStats {
  requests: number;
  shortenedBlocks: number;
  originalTokens: number;
  sentTokens: number;
  retrieveRounds: number;
}

/** What stays the same across a conversation's turns: model, system prompt, first user message. */
export function sessionKey(dialect: Dialect, body: Record<string, any>): string {
  const first = dialect === 'openai-responses'
    ? (Array.isArray(body.input) ? body.input.find((m: any) => m?.role === 'user') : body.input)
    : (body.messages ?? []).find((m: any) => m?.role === 'user');
  const system = dialect === 'anthropic' ? body.system : dialect === 'openai-responses' ? body.instructions : (body.messages ?? []).find((m: any) => m?.role === 'system' || m?.role === 'developer')?.content;
  return createHash('sha256').update(JSON.stringify([body.model ?? '', system ?? '', first ?? ''])).digest('hex').slice(0, 24);
}

export class ContextProxy {
  private server: Server | null = null;
  private fs: NodeFS;
  private policy: PolicySource;
  readonly usage: UsageStore;
  readonly device: string;
  /** One budgeter per conversation (see `sessionKey`), most recently used last. */
  private budgeters = new Map<string, ContextBudgeter>();
  private clock: () => number;
  private fetchFn: typeof globalThis.fetch;
  readonly stats: ProxyStats = { requests: 0, shortenedBlocks: 0, originalTokens: 0, sentTokens: 0, retrieveRounds: 0 };
  url = '';

  constructor(private o: ProxyOptions) {
    this.fs = new NodeFS(o.vaultRoot);
    this.policy = new PolicySource(this.fs, o.managedPolicyFile);
    this.device = `proxy-${createHash('sha256').update(`${hostname()}\n${path.resolve(o.vaultRoot)}`).digest('hex').slice(0, 8)}`;
    this.usage = new UsageStore(this.fs, this.device, () => this.policy.current);
    this.clock = o.clock ?? Date.now;
    this.fetchFn = o.fetch ?? globalThis.fetch;
  }

  async listen(): Promise<string> {
    await this.policy.refresh();
    this.server = createServer((req, res) => void this.handle(req, res).catch((e) => this.fail(res, 502, (e as Error).message)));
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.o.port, this.o.host ?? '127.0.0.1', () => resolve());
    });
    const addr = this.server.address();
    this.url = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : this.o.port}`;
    return this.url;
  }

  async close(): Promise<void> {
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    await this.usage.flush();
    this.usage.close();
  }

  /**
   * A budgeter per conversation. Its decisions keep every turn's bytes identical (provider prompt
   * caching), and an original the model fetched is sent in full on later turns of *that*
   * conversation only. Requests carry no session id, so a conversation is recognised by what
   * never changes between its turns: the model, the system prompt and the first user message.
   */
  private budgeterFor(policy: AIPolicy, session: string): ContextBudgeter {
    const key = `${policy.compression.minTokens}:${session}`;
    let b = this.budgeters.get(key);
    if (b) this.budgeters.delete(key);
    else b = new ContextBudgeter(this.o.originals, { minTokens: policy.compression.minTokens });
    this.budgeters.set(key, b);
    if (this.budgeters.size > 256) this.budgeters.delete(this.budgeters.keys().next().value!);
    return b;
  }

  private fail(res: ServerResponse, status: number, message: string, dialect: Dialect | null = null): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    const body = dialect === 'anthropic' ? { type: 'error', error: { type: status === 403 ? 'permission_error' : 'api_error', message } } : { error: { message, type: 'inkwright_proxy_error', code: status } };
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  }

  private upstreamFor(pathname: string, headers: IncomingMessage['headers']): Upstream {
    return pathname.startsWith('/v1/messages') || headers['anthropic-version'] ? 'anthropic' : 'openai';
  }

  /** Upstream URL and headers for a client request. */
  private target(up: Upstream, pathname: string, search: string, headers: IncomingMessage['headers']): { url: string; headers: Headers; fetch: typeof globalThis.fetch } {
    const cfg = this.o.upstreams[up];
    const base = (cfg.auth.kind === 'executor' ? cfg.auth.baseUrl : cfg.baseUrl).replace(/\/+$/, '');
    // OpenAI-style bases end in /v1; Anthropic's doesn't (clients send /v1/messages).
    const rel = /\/v1$/.test(base) ? pathname.replace(/^\/v1/, '') : pathname;
    const h = new Headers();
    for (const [k, v] of Object.entries(headers)) if (!HOP.has(k) && typeof v === 'string') h.set(k, v);
    if (cfg.auth.kind !== 'client') for (const a of AUTH) h.delete(a);
    if (cfg.auth.kind === 'key') h.set(up === 'anthropic' ? 'x-api-key' : 'authorization', up === 'anthropic' ? cfg.auth.key : `Bearer ${cfg.auth.key}`);
    h.set('accept-encoding', 'identity');
    return { url: `${base}${rel}${search}`, headers: h, fetch: cfg.auth.kind === 'executor' ? cfg.auth.fetch : this.fetchFn };
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!LOOPBACK_HOST.test(req.headers.host ?? '')) return this.fail(res, 403, 'The Inkwright proxy only answers requests addressed to localhost.');
    if (req.headers.origin) return this.fail(res, 403, 'The Inkwright proxy does not answer browsers.');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, ...this.stats }));
      return;
    }
    const up = this.upstreamFor(url.pathname, req.headers);
    const t = this.target(up, url.pathname, url.search, req.headers);
    const dialect = req.method === 'POST' ? dialectOf(url.pathname) : null;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 64 * 1024 * 1024) return this.fail(res, 413, 'Request too large for the proxy (64 MiB).', dialect);
      chunks.push(c as Buffer);
    }
    const raw = Buffer.concat(chunks);
    if (!dialect) {
      // Anything else (models, token counting, embeddings): passed through unchanged.
      if (req.method === 'POST' && raw.length && !/json/.test(String(req.headers['content-type'] ?? ''))) return this.fail(res, 415, 'Send JSON.');
      const r = await t.fetch(t.url, { method: req.method ?? 'GET', headers: t.headers, ...(raw.length ? { body: raw } : {}), redirect: 'manual' });
      return this.relay(r, res);
    }
    if (!/json/.test(String(req.headers['content-type'] ?? ''))) return this.fail(res, 415, 'Send JSON (Content-Type: application/json).', dialect);
    let body: Record<string, any>;
    try {
      body = JSON.parse(raw.toString('utf8'));
    } catch {
      return this.fail(res, 400, 'The request body is not JSON.', dialect);
    }
    this.stats.requests++;
    await this.policy.refresh();
    const policy = this.policy.current;
    const wantsStream = body.stream === true;
    const clientRetrieves = declaresRetrieve(dialect, body);
    const canInject = !clientRetrieves && hasTools(dialect, body) && dialect !== 'openai-responses';
    const session = sessionKey(dialect, body);
    const items = this.o.compress !== false && policy.compression.enabled ? await this.shorten(dialect, body, policy, clientRetrieves || canInject, session) : [];
    const lossy = items.some((i) => i.ref);
    const saved = items.reduce((a, i) => a + Math.max(0, i.originalTokens - i.compressedTokens), 0);
    const model = typeof body.model === 'string' ? body.model : 'unknown';
    const label = `Context proxy · ${String(req.headers['user-agent'] ?? 'client').split(/[\s/]/)[0]!.slice(0, 32)}`;
    const record = (input: number, output: number, rounds: number) => {
      // Every round re-sends the shortened blocks, so each round saved the same amount.
      this.usage.record({ at: this.clock(), provider: up, label, model, local: false, inputTokens: input, outputTokens: output, uncompressedInputTokens: input + saved * rounds, redactions: 0 });
    };
    const estimate = () => estimateTokens(JSON.stringify(dialect === 'openai-responses' ? body.input ?? '' : body.messages ?? ''));

    if (lossy && canInject) {
      // The proxy answers retrieve_original itself: the upstream call can't stream.
      injectRetrieve(dialect, body);
      delete body.stream;
      const includeUsage = body.stream_options?.include_usage === true;
      delete body.stream_options;
      let rounds = 0;
      let input = 0;
      let output = 0;
      for (;;) {
        const r = await t.fetch(t.url, { method: 'POST', headers: t.headers, body: JSON.stringify(body), redirect: 'manual' });
        const text = await r.text();
        rounds++;
        let j: Record<string, any> | null = null;
        try {
          j = JSON.parse(text);
        } catch {
          /* an error page: relay it */
        }
        const u = j ? usageOf(dialect, j) : null;
        input += u?.input ?? estimate();
        output += u?.output ?? 0;
        const retrieves = j && r.ok ? callsOf(dialect, j).filter((c) => c.name === 'retrieve_original') : [];
        if (!retrieves.length || rounds > (this.o.maxRetrieveRounds ?? 3)) {
          record(input, output, rounds);
          if (!r.ok || !j) return this.send(res, r.status, text, r.headers.get('content-type') ?? 'application/json');
          if (wantsStream) {
            res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' }).end(responseToSse(dialect, j, includeUsage));
            return;
          }
          return this.send(res, r.status, text, 'application/json');
        }
        this.stats.retrieveRounds++;
        const results = [];
        for (const c of retrieves) results.push({ id: c.id, text: (await this.budgeterFor(policy, session).retrieve(c.args)).text });
        appendRetrieveRound(dialect, body, j!, results);
      }
    }

    const r = await t.fetch(t.url, { method: 'POST', headers: t.headers, body: JSON.stringify(body), redirect: 'manual' });
    if (wantsStream && r.ok && r.body) {
      const meter = new StreamUsage(dialect);
      await this.relay(r, res, (s) => meter.push(s));
      record(meter.seen ? meter.input : estimate(), meter.output, 1);
      return;
    }
    const text = await r.text();
    let u: { input: number; output: number } | null = null;
    try {
      u = usageOf(dialect, JSON.parse(text));
    } catch {
      /* not JSON */
    }
    record(u?.input ?? estimate(), u?.output ?? 0, 1);
    this.send(res, r.status, text, r.headers.get('content-type') ?? 'application/json');
  }

  /** Runs the budgeter over a request's blocks in place; returns what it shortened. */
  async shorten(dialect: Dialect, body: Record<string, any>, policy: AIPolicy, canRetrieve: boolean, session = sessionKey(dialect, body)): Promise<CompressionItem[]> {
    const { slots, question } = slotsOf(dialect, body);
    if (!slots.length) return [];
    // The budgeter's input: each block as a message, the question last (it is never shortened).
    const messages: ChatMessage[] = [...slots.map((s): ChatMessage => (s.tool ? { role: 'tool', toolCallId: 'x', content: s.text } : { role: 'user', content: s.text })), { role: 'user', content: question }];
    const { messages: out, items } = await this.budgeterFor(policy, session).apply(messages, { canRetrieve, ...(question ? { query: question } : {}) });
    slots.forEach((s, i) => {
      const next = out[i]!.content as string;
      if (next !== s.text) s.set(next);
    });
    for (const it of items) {
      this.stats.shortenedBlocks++;
      this.stats.originalTokens += it.originalTokens;
      this.stats.sentTokens += it.compressedTokens;
    }
    return items;
  }

  private send(res: ServerResponse, status: number, text: string, type: string): void {
    res.writeHead(status, { 'content-type': type }).end(text);
  }

  private async relay(r: Response, res: ServerResponse, tap?: (s: string) => void): Promise<void> {
    const h: Record<string, string> = {};
    r.headers.forEach((v, k) => {
      if (!['content-length', 'content-encoding', 'transfer-encoding', 'connection', 'set-cookie'].includes(k)) h[k] = v;
    });
    res.writeHead(r.status, h);
    if (!r.body) return void res.end();
    const dec = new TextDecoder();
    const reader = r.body.getReader();
    res.on('close', () => void reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      tap?.(dec.decode(value, { stream: true }));
      if (!res.write(value)) await new Promise<void>((ok) => res.once('drain', () => ok()));
    }
    res.end();
  }
}
