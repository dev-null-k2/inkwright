/**
 * The credential executor: a separate process that holds provider API keys and connector tokens
 * and makes calls *with* them for local clients (the always-on runner, the context-saving proxy,
 * the desktop app's sidecar), so none of those processes ever holds a key. docs/CREDENTIALS.md
 * has the threat model; in short:
 *
 * - **Narrow interface.** Clients can ask for one HTTPS request to a credential's own base URL,
 *   or one tool call on a connector — never for the key. Auth headers a client sends are
 *   dropped; the executor adds the credential's own, and only toward the URL bound to it.
 * - **Local only, same user only.** A Unix socket in a 0700 folder (mode 0600), or a per-user
 *   named pipe on Windows; and a capability token from a 0600 file in the same folder that each
 *   connection must present first. Node exposes no `SO_PEERCRED`/`getpeereid`, so the file
 *   permissions are the peer check: only the user (and root/administrators) can read the token.
 * - **Policy on every request.** The vault's AI policy (`ai/policy.json`, plus a managed policy)
 *   is re-read and applied: task routes switched off or kept on the device, monthly budgets,
 *   per-credential model and tool allow-lists, and the policy's tool deny list.
 * - **Audit on every request**, allowed or refused, into the vault's signed audit trail under the
 *   executor's own chain (`ai/audit/cred-…/`).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { hostname } from 'node:os';
import * as path from 'node:path';
import {
  AuditLog,
  McpConnection,
  UsageStore,
  decideRoute,
  getProviderInfo,
  inferTask,
  isLoopbackUrl,
  monthOf,
  totalsOf,
  toolAllowed,
  type AIPolicy,
  type AuditSigner,
} from '@inkwright/ai';
import { NodeFS } from '../nodefs.ts';
import { PolicySource, loadAuditSigner } from '../trust.ts';
import { VERSION } from '../version.ts';
import { MAX_FRAME, PROTOCOL_VERSION, executorEndpoint, readFrames, tokenFile, writeFrame, type Actor, type CredentialSummary, type ErrorCode, type Request } from './protocol.ts';
import { checkPrivate, type CredentialInfo, type CredentialStore } from './store.ts';

export interface ExecutorOptions {
  store: CredentialStore;
  /** The vault whose AI policy applies and whose audit trail records each request. */
  vaultRoot: string;
  /** Managed policy file (users can only tighten it). */
  managedPolicyFile?: string;
  /** P-256 private JWK that signs the executor's audit chain (default: a key per process). */
  auditKeyFile?: string;
  /** Listen here instead of the default endpoint for the store's folder. */
  endpoint?: string;
  fetch?: typeof globalThis.fetch;
  clock?: () => number;
  log?: (msg: string) => void;
  /** Requests in flight per connection (default 8). */
  maxInFlight?: number;
}

/** Auth headers a client might send; all are removed before the executor adds its own. */
const AUTH_HEADERS = new Set(['authorization', 'x-api-key', 'x-goog-api-key', 'api-key', 'proxy-authorization', 'cookie', 'host', 'content-length', 'connection', 'transfer-encoding', 'keep-alive', 'upgrade', 'te', 'trailer']);

const globMatch = (pattern: string, s: string) => new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(s);

export function summarize(c: CredentialInfo): CredentialSummary {
  if (c.kind === 'provider') return { name: c.name, kind: c.kind, provider: c.provider, url: c.baseUrl };
  if (c.kind === 'connector') return { name: c.name, kind: c.kind, url: c.url, ...(c.server ? { server: c.server } : {}) };
  return { name: c.name, kind: c.kind, url: c.baseUrl };
}

/** The header that carries a credential's secret toward its service. */
export function authHeaderFor(c: CredentialInfo, secret: string): [string, string] {
  if (c.kind === 'provider') {
    const kind = getProviderInfo(c.provider)?.kind;
    if (kind === 'anthropic') return ['x-api-key', secret];
    if (kind === 'gemini') return ['x-goog-api-key', secret];
    if (c.provider === 'azure-openai') return ['api-key', secret];
  }
  return ['authorization', `Bearer ${secret}`];
}

/**
 * Where a request may go: under the credential's base URL, no dot segments, no credentials or
 * `key=` in the URL. Returns the normalized URL or a reason.
 */
export function checkDestination(c: CredentialInfo, raw: string): { ok: true; url: URL } | { ok: false; reason: string } {
  const base = new URL(c.kind === 'connector' ? c.url : c.baseUrl);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'The request URL is not a URL.' };
  }
  if (/(^|\/)\.\.?(\/|$)/.test(decodeURIComponent(raw.replace(/^[a-z]+:\/\/[^/]+/i, '').split('?')[0]!))) return { ok: false, reason: 'The request URL has dot segments.' };
  if (u.username || u.password) return { ok: false, reason: 'The request URL carries credentials.' };
  if (u.origin !== base.origin) return { ok: false, reason: `Credential ${c.name} may only be sent to ${base.origin}.` };
  const prefix = base.pathname.replace(/\/+$/, '');
  if (u.pathname !== prefix && !u.pathname.startsWith(`${prefix}/`)) return { ok: false, reason: `Credential ${c.name} may only be used under ${base.origin}${prefix}/.` };
  u.searchParams.delete('key');
  return { ok: true, url: u };
}

/** What a provider request body says about itself (model, images, tools), for the policy. */
export function describeBody(url: URL, body: Uint8Array | undefined): { model: string | null; hasImages: boolean; tools: boolean } {
  let j: Record<string, unknown> = {};
  if (body?.length) {
    try {
      j = JSON.parse(Buffer.from(body).toString('utf8')) as Record<string, unknown>;
    } catch {
      /* not JSON: nothing to read */
    }
  }
  const gemini = /\/models\/([^/:]+):/.exec(url.pathname)?.[1];
  const model = typeof j.model === 'string' ? j.model : gemini ? decodeURIComponent(gemini) : null;
  const s = body?.length ? Buffer.from(body).toString('utf8') : '';
  const hasImages = /"type"\s*:\s*"(image_url|image|input_image)"|"inlineData"\s*:|"inline_data"\s*:/.test(s);
  const tools = Array.isArray(j.tools) ? j.tools.length > 0 : false;
  return { model, hasImages, tools };
}

export type PolicyVerdict = { ok: true } | { ok: false; reason: string };

/**
 * The AI policy applied to one provider request. The executor sees the request, not the notes
 * behind it — note-level rules (hidden, local-only notes) are applied by the guarded provider in
 * the client before anything reaches here; this is the second, process-separated check.
 */
export function checkProviderRequest(policy: AIPolicy, c: CredentialInfo & { kind: 'provider' }, d: { model: string | null; hasImages: boolean; tools: boolean }, spentUsd: number): PolicyVerdict {
  if (c.models?.length) {
    if (!d.model) return { ok: false, reason: `Credential ${c.name} is limited to certain models, and this request names none.` };
    if (!c.models.some((p) => globMatch(p, d.model!))) return { ok: false, reason: `Credential ${c.name} may not be used with ${d.model} (allowed: ${c.models.join(', ')}).` };
  }
  const task = inferTask({ hasImages: d.hasImages, tools: d.tools });
  const route = decideRoute(policy, task);
  if (route.target === 'off') return { ok: false, reason: route.why };
  if (route.target === 'device' && !isLoopbackUrl(c.baseUrl)) return { ok: false, reason: `${route.why} Credential ${c.name} is for a cloud service.` };
  const budget = policy.budgets[c.name] ?? policy.budgets[c.provider];
  if (budget && budget.monthlyUsd >= 0 && spentUsd >= budget.monthlyUsd) return { ok: false, reason: `This month's budget for ${c.provider} ($${budget.monthlyUsd}) is used up (AI policy).` };
  return { ok: true };
}

/** The AI policy applied to one connector tool call. */
export function checkToolCall(policy: AIPolicy, c: CredentialInfo & { kind: 'connector' }, tool: string): PolicyVerdict {
  if (c.tools?.length && !c.tools.some((p) => globMatch(p, tool))) return { ok: false, reason: `Credential ${c.name} may not call ${tool} (allowed: ${c.tools.join(', ')}).` };
  const qualified = `${c.server ?? c.name}__${tool}`;
  if (!toolAllowed(policy, tool) || !toolAllowed(policy, qualified)) return { ok: false, reason: `The AI policy doesn't allow agents to call ${qualified}.` };
  return { ok: true };
}

class ReqError extends Error {
  constructor(readonly code: ErrorCode, message: string) {
    super(message);
  }
}

interface ConnState {
  authed: boolean;
  client: string;
  inFlight: Map<number, AbortController>;
}

export class CredentialExecutor {
  private server: Server | null = null;
  private token = randomBytes(32).toString('base64url');
  private fs: NodeFS;
  private policy: PolicySource;
  private audit!: AuditLog;
  private usage: UsageStore;
  private spentCache = new Map<string, { at: number; usd: number }>();
  private connectors = new Map<string, Promise<McpConnection>>();
  private sockets = new Set<Socket>();
  readonly endpoint: string;
  readonly device: string;
  private clock: () => number;
  private log: (m: string) => void;
  private fetchFn: typeof globalThis.fetch;

  constructor(private o: ExecutorOptions) {
    this.fs = new NodeFS(o.vaultRoot);
    this.policy = new PolicySource(this.fs, o.managedPolicyFile);
    this.endpoint = o.endpoint ?? executorEndpoint(o.store.dir);
    this.device = `cred-${createHash('sha256').update(`${hostname()}\n${path.resolve(o.vaultRoot)}`).digest('hex').slice(0, 8)}`;
    this.clock = o.clock ?? Date.now;
    this.log = o.log ?? (() => {});
    this.fetchFn = o.fetch ?? globalThis.fetch;
    this.usage = new UsageStore(this.fs, this.device, () => this.policy.current);
  }

  /** Starts listening; writes the capability token for clients. */
  async listen(signer?: AuditSigner): Promise<void> {
    this.audit = new AuditLog(this.fs, this.device, signer ?? (await loadAuditSigner(this.o.auditKeyFile)), this.clock);
    await this.policy.refresh();
    const runDir = path.join(this.o.store.dir, 'run');
    await mkdir(runDir, { recursive: true, mode: 0o700 });
    if (process.platform !== 'win32') await chmod(runDir, 0o700);
    await checkPrivate(runDir);
    if (process.platform !== 'win32') await rm(this.endpoint, { force: true });
    await writeFile(tokenFile(this.o.store.dir), `${this.token}\n`, { mode: 0o600 });
    await chmod(tokenFile(this.o.store.dir), 0o600).catch(() => {});
    this.server = createServer((s) => this.accept(s));
    this.server.maxConnections = 64;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(this.endpoint, () => resolve());
    });
    if (process.platform !== 'win32') await chmod(this.endpoint, 0o600);
    this.audit.record({ kind: 'policy', actor: { source: 'credentials' }, summary: `Credential executor started with ${this.o.store.list().length} credential(s) (${this.o.store.protection})`, data: { credentials: this.o.store.list().map((c) => c.name), endpoint: this.endpoint } });
    this.log(`Credential executor listening on ${this.endpoint} (${this.o.store.list().length} credentials, ${this.o.store.protection})`);
  }

  async close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    await new Promise<void>((r) => (this.server ? this.server.close(() => r()) : r()));
    this.server = null;
    for (const c of this.connectors.values()) void c.then((x) => x.close?.()).catch(() => {});
    await rm(tokenFile(this.o.store.dir), { force: true });
    await this.audit?.flush();
    this.usage.close();
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket);
    const st: ConnState = { authed: false, client: 'unknown', inFlight: new Map() };
    const helloTimer = setTimeout(() => socket.destroy(), 5000);
    helloTimer.unref();
    socket.on('close', () => {
      clearTimeout(helloTimer);
      for (const a of st.inFlight.values()) a.abort();
      this.sockets.delete(socket);
    });
    socket.on('error', () => socket.destroy());
    readFrames(
      socket,
      (v) => {
        const req = v as Request;
        if (!req || typeof req !== 'object' || typeof req.id !== 'number' || typeof req.op !== 'string') {
          writeFrame(socket, { id: -1, type: 'error', code: 'bad_request', message: 'Malformed request.' });
          socket.destroy();
          return;
        }
        if (!st.authed) {
          clearTimeout(helloTimer);
          if (req.op !== 'hello' || !this.tokenOk(req.token)) {
            writeFrame(socket, { id: req.id, type: 'error', code: 'unauthenticated', message: 'Present the executor token first.' });
            this.audit.record({ kind: 'blocked', actor: { source: 'credentials' }, summary: 'A local process tried to use the credential executor without its token', outcome: 'blocked' });
            socket.end();
            return;
          }
          st.authed = true;
          st.client = String(req.client?.name ?? 'client').slice(0, 64);
          writeFrame(socket, { id: req.id, type: 'ok', result: { protocol: PROTOCOL_VERSION, version: VERSION, credentials: this.o.store.list().map(summarize) } });
          return;
        }
        void this.dispatch(socket, st, req);
      },
      (e) => {
        writeFrame(socket, { id: -1, type: 'error', code: e.message.includes('large') ? 'too_large' : 'bad_request', message: e.message });
        socket.destroy();
      },
    );
  }

  private tokenOk(t: unknown): boolean {
    if (typeof t !== 'string') return false;
    const a = createHash('sha256').update(t).digest();
    const b = createHash('sha256').update(this.token).digest();
    return timingSafeEqual(a, b);
  }

  private async dispatch(socket: Socket, st: ConnState, req: Request): Promise<void> {
    if (req.op === 'cancel') {
      st.inFlight.get(req.target)?.abort();
      return;
    }
    if (st.inFlight.size >= (this.o.maxInFlight ?? 8)) {
      writeFrame(socket, { id: req.id, type: 'error', code: 'busy', message: 'Too many requests in flight on this connection.' });
      return;
    }
    const abort = new AbortController();
    st.inFlight.set(req.id, abort);
    try {
      await this.policy.refresh();
      await this.o.store.reload().catch(() => {});
      switch (req.op) {
        case 'list':
          writeFrame(socket, { id: req.id, type: 'ok', result: { credentials: this.o.store.list().map(summarize) } });
          break;
        case 'http':
          await this.http(socket, st, req, abort.signal);
          break;
        case 'tools':
        case 'tool':
          await this.connector(socket, st, req, abort.signal);
          break;
        default:
          throw new ReqError('bad_request', `Unknown operation ${(req as { op: string }).op}. (There is no operation that returns a key.)`);
      }
    } catch (e) {
      const err = e instanceof ReqError ? e : abort.signal.aborted ? new ReqError('cancelled', 'Cancelled.') : new ReqError('internal', (e as Error).message);
      writeFrame(socket, { id: req.id, type: 'error', code: err.code, message: err.message });
    } finally {
      st.inFlight.delete(req.id);
    }
  }

  private credential(name: unknown): CredentialInfo {
    const c = typeof name === 'string' ? this.o.store.get(name) : null;
    if (!c) throw new ReqError('not_found', `No credential named ${String(name)}.`);
    return c;
  }

  private actorOf(st: ConnState, a: Actor | undefined) {
    return { source: typeof a?.source === 'string' ? a.source.slice(0, 32) : st.client, label: `${typeof a?.label === 'string' ? a.label.slice(0, 80) : st.client} (credential executor)`, ...(typeof a?.runId === 'string' ? { runId: a.runId.slice(0, 64) } : {}) };
  }

  private async spent(provider: string): Promise<number> {
    const hit = this.spentCache.get(provider);
    if (hit && this.clock() - hit.at < 15_000) return hit.usd;
    const usd = totalsOf((await this.usage.month(monthOf(this.clock()))).filter((r) => r.provider === provider)).costUsd;
    this.spentCache.set(provider, { at: this.clock(), usd });
    return usd;
  }

  private refuse(st: ConnState, actor: Actor | undefined, c: CredentialInfo | null, reason: string, extra: Record<string, unknown> = {}): never {
    this.audit.record({ kind: 'blocked', actor: this.actorOf(st, actor), summary: reason, outcome: 'blocked', ...(c?.kind === 'provider' ? { provider: c.provider } : {}), data: { ...(c ? { credential: c.name } : {}), client: st.client, ...extra } });
    throw new ReqError('policy_blocked', reason);
  }

  private async http(socket: Socket, st: ConnState, req: Extract<Request, { op: 'http' }>, signal: AbortSignal): Promise<void> {
    const c = this.credential(req.credential);
    if (c.kind === 'connector') throw new ReqError('bad_request', `${c.name} is a connector credential; use a tool call.`);
    const method = String(req.request?.method ?? 'POST').toUpperCase();
    if (method !== 'POST' && method !== 'GET') this.refuse(st, req.actor, c, `Only GET and POST requests can be made with credentials (got ${method}).`);
    const dest = checkDestination(c, String(req.request?.url ?? ''));
    if (!dest.ok) this.refuse(st, req.actor, c, dest.reason, { url: String(req.request?.url ?? '').slice(0, 200) });
    const url = dest.url;
    const body = req.request.body ? new Uint8Array(Buffer.from(req.request.body, 'base64')) : undefined;
    if (body && body.byteLength > MAX_FRAME) throw new ReqError('too_large', 'The request body is too large.');
    const d = describeBody(url, body);
    if (c.kind === 'provider') {
      const v = checkProviderRequest(this.policy.current, c, d, await this.spent(c.provider));
      if (!v.ok) this.refuse(st, req.actor, c, v.reason, { model: d.model });
    }
    const headers = new Headers();
    for (const [k, val] of Object.entries(req.request.headers ?? {})) if (!AUTH_HEADERS.has(k.toLowerCase()) && typeof val === 'string') headers.set(k, val);
    const [hk, hv] = authHeaderFor(c, this.o.store.secretOf(c.name));
    headers.set(hk, hv);
    const started = this.clock();
    let status = 0;
    let bytesIn = 0;
    let outcome: 'ok' | 'error' = 'ok';
    let error: string | undefined;
    try {
      const res = await this.fetchFn(url, { method, headers, ...(body && method === 'POST' ? { body } : {}), redirect: 'manual', signal });
      status = res.status;
      const h: Record<string, string> = {};
      res.headers.forEach((v, k) => {
        if (k !== 'set-cookie') h[k] = v;
      });
      writeFrame(socket, { id: req.id, type: 'head', status: res.status, headers: h });
      if (res.body) {
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          bytesIn += value.byteLength;
          if (!writeFrame(socket, { id: req.id, type: 'chunk', data: Buffer.from(value).toString('base64') })) await new Promise<void>((r) => socket.once('drain', () => r()));
          if (socket.destroyed) {
            await reader.cancel().catch(() => {});
            break;
          }
        }
      }
      writeFrame(socket, { id: req.id, type: 'end' });
      if (status >= 400) outcome = 'error';
    } catch (e) {
      outcome = 'error';
      error = signal.aborted ? 'cancelled' : (e as Error).message;
      throw signal.aborted ? new ReqError('cancelled', 'Cancelled.') : new ReqError('upstream', `${url.host}: ${(e as Error).message}`);
    } finally {
      this.audit.record({
        kind: 'ai_call',
        actor: this.actorOf(st, req.actor),
        summary: `${method} ${url.host}${url.pathname} with credential ${c.name}${status ? ` → ${status}` : ''}`,
        ...(c.kind === 'provider' ? { provider: c.provider, local: isLoopbackUrl(c.baseUrl) } : {}),
        ...(d.model ? { model: d.model } : {}),
        outcome,
        ...(error ? { error } : {}),
        data: { credential: c.name, client: st.client, host: url.host, path: url.pathname, status, bytesOut: body?.byteLength ?? 0, bytesIn, ms: this.clock() - started },
      });
    }
  }

  private connection(c: CredentialInfo & { kind: 'connector' }): Promise<McpConnection> {
    let p = this.connectors.get(c.name);
    if (!p) {
      const secret = () => this.o.store.secretOf(c.name);
      const origin = new URL(c.url).origin;
      const fetchFn = (input: string, init?: RequestInit) => {
        const h = new Headers(init?.headers);
        // Only the connector's own origin gets the token (the SDK may follow links in metadata).
        if (new URL(input).origin === origin) h.set('authorization', `Bearer ${secret()}`);
        return this.fetchFn(input, { ...init, headers: h, redirect: 'manual' });
      };
      const conn = new McpConnection({ id: c.name, name: c.server ?? c.name, url: c.url, auth: 'bearer', enabled: true, tools: {}, addedAt: c.createdAt }, { fetch: fetchFn, clientInfo: { name: 'inkwright-credential-executor', version: VERSION } });
      p = conn.connect().then(() => conn);
      p.catch(() => this.connectors.delete(c.name));
      this.connectors.set(c.name, p);
    }
    return p;
  }

  private async connector(socket: Socket, st: ConnState, req: Extract<Request, { op: 'tools' | 'tool' }>, signal: AbortSignal): Promise<void> {
    const c = this.credential(req.credential);
    if (c.kind !== 'connector') throw new ReqError('bad_request', `${c.name} is not a connector credential.`);
    let conn: McpConnection;
    try {
      conn = await this.connection(c);
    } catch (e) {
      throw new ReqError('upstream', `${new URL(c.url).host}: ${(e as Error).message}`);
    }
    if (req.op === 'tools') {
      const allowed = conn.tools.filter((t) => checkToolCall(this.policy.current, c, t.name).ok);
      writeFrame(socket, { id: req.id, type: 'ok', result: { tools: allowed.map((t) => ({ name: t.name, description: t.description ?? '', inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })) } });
      return;
    }
    const tool = String(req.tool ?? '');
    const v = checkToolCall(this.policy.current, c, tool);
    if (!v.ok) this.refuse(st, req.actor, c, v.reason, { tool });
    const args = req.args && typeof req.args === 'object' && !Array.isArray(req.args) ? req.args : {};
    let outcome: 'ok' | 'error' = 'ok';
    let error: string | undefined;
    try {
      const r = await conn.callTool(tool, args, signal);
      if (r.kind === 'result' && r.result.isError) outcome = 'error';
      writeFrame(socket, { id: req.id, type: 'ok', result: r });
    } catch (e) {
      outcome = 'error';
      error = (e as Error).message;
      throw new ReqError('upstream', `${c.server ?? c.name}: ${error}`);
    } finally {
      this.audit.record({ kind: 'ai_call', actor: this.actorOf(st, req.actor), tool: `${c.server ?? c.name}__${tool}`, summary: `Called ${tool} on ${new URL(c.url).host} with credential ${c.name}`, outcome, ...(error ? { error } : {}), data: { credential: c.name, client: st.client, args: Object.keys(args) } });
    }
  }
}
