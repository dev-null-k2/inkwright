/**
 * The credential executor: the encrypted store, the OS keychain backends (with a recording
 * `exec`, so no real keychain is touched), and the executor process boundary end to end over its
 * real Unix socket — provider calls (plain and streamed) made with keys the client never holds,
 * destinations pinned to each key, the AI policy and allow-lists on every request, connector
 * tool calls against a real Inkwright MCP server, and a verifiable audit trail.
 */
import { connect } from 'node:net';
import { chmod, mkdtemp, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { exportAuditJsonl, parsePolicy, serializePolicy, verifyAudit, type ChatResult } from '@inkwright/ai';
import { NodeFS } from '../src/nodefs.ts';
import { CredentialStore } from '../src/creds/store.ts';
import { DpapiKeychain, MacKeychain, SecretServiceKeychain, type Exec, type Keychain } from '../src/creds/keychain.ts';
import { CredentialExecutor, checkDestination, checkProviderRequest } from '../src/creds/executor.ts';
import { CREDENTIAL_PLACEHOLDER, CredentialClient } from '../src/creds/client.ts';
import { connectorToolsViaExecutor } from '../src/creds/agent.ts';
import { executorEndpoint, tokenFile } from '../src/creds/protocol.ts';
import { parseCli } from '../src/cli.ts';
import { aiFromOptionsAsync, serveHttp } from '../src/serve.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

const unix = process.platform !== 'win32';
const FAST = 2 ** 10; // scrypt cost for tests (the default is 2^17)

class MemoryKeychain implements Keychain {
  readonly id = 'secret-service' as const;
  readonly label = 'a test keychain';
  items = new Map<string, string>();
  async get(a: string) { return this.items.get(a) ?? null; }
  async set(a: string, s: string) { this.items.set(a, s); }
  async delete(a: string) { this.items.delete(a); }
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'iw-creds-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('credential store', () => {
  it('seals keys with a passphrase-derived key; a wrong passphrase is told apart', async () => {
    const s = await CredentialStore.create(path.join(dir, 'c'), { passphrase: 'correct horse battery', scryptN: FAST });
    await s.put('anthropic', { kind: 'provider', provider: 'anthropic', baseUrl: 'https://api.anthropic.com/' }, 'sk-ant-secret');
    const raw = await readFile(path.join(dir, 'c', 'store.json'), 'utf8');
    expect(raw).not.toContain('sk-ant-secret');
    if (unix) {
      expect((await stat(path.join(dir, 'c', 'store.json'))).mode & 0o777).toBe(0o600);
      expect((await stat(path.join(dir, 'c'))).mode & 0o777).toBe(0o700);
    }
    const again = await CredentialStore.unlock(path.join(dir, 'c'), { passphrase: async () => 'correct horse battery' });
    expect(again.list()).toEqual([expect.objectContaining({ name: 'anthropic', kind: 'provider', baseUrl: 'https://api.anthropic.com' })]);
    expect(again.secretOf('anthropic')).toBe('sk-ant-secret');
    await expect(CredentialStore.unlock(path.join(dir, 'c'), { passphrase: async () => 'wrong passphrase!' })).rejects.toMatchObject({ code: 'bad_passphrase' });
  });

  it('binds each key to where it may be sent: editing the file to re-point it breaks the seal', async () => {
    const s = await CredentialStore.create(path.join(dir, 'c'), { passphrase: 'correct horse battery', scryptN: FAST });
    await s.put('openai', { kind: 'provider', provider: 'openai', baseUrl: 'https://api.openai.com/v1' }, 'sk-real');
    const f = path.join(dir, 'c', 'store.json');
    const j = JSON.parse(await readFile(f, 'utf8'));
    j.entries[0].meta.baseUrl = 'https://attacker.example/v1';
    await writeFile(f, JSON.stringify(j));
    const t = await CredentialStore.unlock(path.join(dir, 'c'), { passphrase: async () => 'correct horse battery' });
    expect(() => t.secretOf('openai')).toThrow(/does not match its description/);
  });

  it('keeps the data key in a keychain when there is one, and checks names and URLs', async () => {
    const kc = new MemoryKeychain();
    const s = await CredentialStore.create(path.join(dir, 'k'), { keychain: kc });
    expect([...kc.items.keys()]).toEqual(['store-data-key']);
    expect(s.protection).toMatch(/keychain/);
    await expect(s.put('Bad Name', { kind: 'api', baseUrl: 'https://x.example' }, 'k')).rejects.toThrow(/lower-case/);
    await expect(s.put('peer', { kind: 'api', baseUrl: 'http://x.example' }, 'k')).rejects.toThrow(/https/);
    await expect(s.put('peer', { kind: 'api', baseUrl: 'https://u:p@x.example' }, 'k')).rejects.toThrow(/credentials/);
    await s.put('peer', { kind: 'api', baseUrl: 'http://127.0.0.1:9/' }, 'k');
    const t = await CredentialStore.unlock(path.join(dir, 'k'), { keychain: kc });
    expect(t.secretOf('peer')).toBe('k');
    await expect(CredentialStore.unlock(path.join(dir, 'k'), {})).rejects.toMatchObject({ code: 'locked' });
  });

  it.runIf(unix)('refuses a folder other users can read', async () => {
    await CredentialStore.create(path.join(dir, 'c'), { passphrase: 'correct horse battery', scryptN: FAST });
    await chmod(path.join(dir, 'c'), 0o755);
    await expect(CredentialStore.unlock(path.join(dir, 'c'), { passphrase: async () => 'correct horse battery' })).rejects.toMatchObject({ code: 'permissions' });
  });
});

describe('OS keychain backends never put the secret on a command line', () => {
  const recorder = (out = 'c2VjcmV0') => {
    const calls: Array<{ cmd: string; args: string[]; stdin?: string }> = [];
    const exec: Exec = async (cmd, args, stdin) => {
      calls.push({ cmd, args, ...(stdin !== undefined ? { stdin } : {}) });
      return { code: 0, stdout: `${out}\n`, stderr: '' };
    };
    return { calls, exec };
  };

  it('macOS: security -i with the command on stdin; reads with find-generic-password -w', async () => {
    const r = recorder();
    const k = new MacKeychain(r.exec);
    await k.set('store-data-key', 'QUJDRA==');
    expect(r.calls[0]!.args).toEqual(['-i']);
    expect(r.calls[0]!.stdin).toContain('add-generic-password -U -s app.inkwright.credentials -a store-data-key');
    expect(r.calls[0]!.args.join(' ')).not.toContain('QUJDRA==');
    expect(await k.get('store-data-key')).toBe('c2VjcmV0');
    expect(r.calls[1]!.args).toEqual(['find-generic-password', '-s', 'app.inkwright.credentials', '-a', 'store-data-key', '-w']);
  });

  it('Linux: secret-tool store reads the secret from stdin', async () => {
    const r = recorder();
    await new SecretServiceKeychain(r.exec).set('store-data-key', 'QUJDRA==');
    expect(r.calls[0]).toEqual({ cmd: 'secret-tool', args: ['store', '--label=Inkwright credentials', 'service', 'app.inkwright.credentials', 'account', 'store-data-key'], stdin: 'QUJDRA==' });
  });

  it('Windows: DPAPI through PowerShell with the script on stdin, the blob in a 0600 file', async () => {
    const r = recorder('UFJPVEVDVEVE');
    const k = new DpapiKeychain(dir, r.exec);
    await k.set('store-data-key', 'QUJDRA==');
    expect(r.calls[0]!.args).toEqual(['-NoProfile', '-NonInteractive', '-Command', '-']);
    expect(r.calls[0]!.stdin).toContain('ProtectedData]::Protect');
    expect(await readFile(path.join(dir, 'store-data-key.dpapi'), 'utf8')).toBe('UFJPVEVDVEVE\n');
    await k.get('store-data-key');
    expect(r.calls[1]!.stdin).toContain("FromBase64String('UFJPVEVDVEVE')");
  });

  it('refuses account names that could inject keychain commands', async () => {
    await expect(new MacKeychain(recorder().exec).set('x -w evil', 'QQ==')).rejects.toThrow(/account names/);
  });
});

describe('policy checks (pure)', () => {
  const cred = { name: 'anthropic', kind: 'provider' as const, provider: 'anthropic', baseUrl: 'https://api.anthropic.com', createdAt: 0 };
  it('pins destinations to the credential', () => {
    expect(checkDestination(cred, 'https://api.anthropic.com/v1/messages').ok).toBe(true);
    expect(checkDestination(cred, 'https://api.anthropic.com.evil.example/v1/messages').ok).toBe(false);
    expect(checkDestination(cred, 'https://api.anthropic.com/v1/../../x').ok).toBe(false);
    expect(checkDestination({ ...cred, baseUrl: 'https://gw.example/anthropic' }, 'https://gw.example/other/v1/messages').ok).toBe(false);
    const k = checkDestination({ ...cred, provider: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com' }, 'https://generativelanguage.googleapis.com/v1beta/models/x:generateContent?key=planted');
    expect(k.ok && k.url.search).toBe('');
  });
  it('applies routes, budgets and model allow-lists', () => {
    const p = (x: unknown) => parsePolicy(x).policy;
    const d = { model: 'claude-sonnet-4-5', hasImages: false, tools: true };
    expect(checkProviderRequest(p({}), cred, d, 0).ok).toBe(true);
    expect(checkProviderRequest(p({ routes: { chat: 'off' } }), cred, d, 0)).toMatchObject({ ok: false, reason: expect.stringMatching(/switched off/) });
    expect(checkProviderRequest(p({ routes: { vision: 'device' } }), cred, { ...d, hasImages: true }, 0)).toMatchObject({ ok: false, reason: expect.stringMatching(/cloud service/) });
    expect(checkProviderRequest(p({ budgets: { anthropic: { monthlyUsd: 5, onExceed: 'block' } } }), cred, d, 5.01)).toMatchObject({ ok: false, reason: expect.stringMatching(/budget/) });
    expect(checkProviderRequest(p({}), { ...cred, models: ['claude-haiku-*'] }, d, 0)).toMatchObject({ ok: false, reason: expect.stringMatching(/may not be used with claude-sonnet-4-5/) });
  });
});

describe('the executor process boundary', () => {
  let fx: Fixture;
  let cdir: string;
  let ex: CredentialExecutor;
  const upstream: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let mcp: Awaited<ReturnType<typeof serveHttp>>;

  /** A fake provider API: answers Anthropic messages, plain or streamed, and records what it got. */
  const fakeFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith('http://127.0.0.1') || url.startsWith('http://localhost')) return fetch(input, init); // the MCP connector
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    const body = init?.body ? JSON.parse(Buffer.from(init.body as Uint8Array).toString('utf8')) : null;
    upstream.push({ url, headers, body });
    if (body?.stream) {
      const events = [
        { type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 12, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } },
        { type: 'message_stop' },
      ];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return Response.json({ id: 'm1', type: 'message', role: 'assistant', model: body?.model, content: [{ type: 'text', text: 'Hello from upstream' }], stop_reason: 'end_turn', usage: { input_tokens: 12, output_tokens: 4 } }, { headers: { 'set-cookie': 'tracking=1' } });
  };

  beforeAll(async () => {
    fx = await makeFixture();
    cdir = await mkdtemp(path.join(tmpdir(), 'iw-ex-'));
    const store = await CredentialStore.create(path.join(cdir, 'c'), { passphrase: 'correct horse battery', scryptN: FAST });
    await store.put('anthropic', { kind: 'provider', provider: 'anthropic', baseUrl: 'https://api.anthropic.com' }, 'sk-ant-REAL');
    await store.put('haiku-only', { kind: 'provider', provider: 'anthropic', baseUrl: 'https://api.anthropic.com', models: ['claude-haiku-*'] }, 'sk-ant-HAIKU');
    // A connected app: the Inkwright MCP server itself, over HTTP with a bearer token.
    const ctx2 = await fx.ctx();
    mcp = await serveHttp(ctx2, parseCli(['--vault', fx.dir, '--http', '0', '--token', 'connector-token-123'], {}), null, () => {});
    await store.put('notes-app', { kind: 'connector', url: mcp.http.url, server: 'inkwright-notes' }, 'connector-token-123');
    ex = new CredentialExecutor({ store, vaultRoot: fx.dir, fetch: fakeFetch as typeof fetch });
    await ex.listen();
  });

  afterAll(async () => {
    await ex.close();
    mcp.services.tasks.close();
    await mcp.http.close();
    await fx.cleanup();
    await rm(cdir, { recursive: true, force: true });
  });

  const client = () => CredentialClient.connect({ dir: path.join(cdir, 'c'), name: 'test-runner', actor: { source: 'runner', label: 'Test runner' } });

  it.runIf(unix)('listens on a 0600 socket in a 0700 folder, with a 0600 token', async () => {
    expect((await stat(executorEndpoint(path.join(cdir, 'c')))).mode & 0o777).toBe(0o600);
    expect((await stat(path.join(cdir, 'c', 'run'))).mode & 0o777).toBe(0o700);
    expect((await stat(tokenFile(path.join(cdir, 'c')))).mode & 0o777).toBe(0o600);
  });

  it('makes provider calls with a key the client never sees (plain and streamed)', async () => {
    const c = await client();
    expect(c.credentials.map((x) => x.name)).toEqual(['anthropic', 'haiku-only', 'notes-app']);
    expect(JSON.stringify(c.credentials)).not.toMatch(/sk-ant|connector-token/);
    const provider = c.providerFor('anthropic');
    const r: ChatResult = await provider.chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hi' }] });
    expect(r.text).toBe('Hello from upstream');
    const sent = upstream.at(-1)!;
    expect(sent.url).toBe('https://api.anthropic.com/v1/messages');
    expect(sent.headers['x-api-key']).toBe('sk-ant-REAL');
    expect(JSON.stringify(sent.headers)).not.toContain(CREDENTIAL_PLACEHOLDER);
    let streamed = '';
    const s = await provider.chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'Hi' }] }, (e) => { if (e.type === 'text') streamed += e.delta; });
    expect(streamed).toBe('Hello');
    expect(s.text).toBe('Hello');
    c.close();
  });

  it('gives the runner its AI through the executor with --ai-credential', async () => {
    const logs: string[] = [];
    const ai = await aiFromOptionsAsync(parseCli(['--vault', fx.dir, '--ai-credential', 'anthropic', '--credentials-dir', path.join(cdir, 'c')], {}), (m) => logs.push(m));
    expect(ai?.label).toMatch(/^Anthropic/);
    expect(logs.join('\n')).toMatch(/holds no key/);
    expect((await ai!.provider.chat({ model: ai!.model, messages: [{ role: 'user', content: 'Hi' }] })).text).toBe('Hello from upstream');
    expect(ai!.connectorTools).toBeTypeOf('function');
    ai!.close?.();
    expect(await aiFromOptionsAsync(parseCli(['--vault', fx.dir, '--ai-credential', 'nope', '--credentials-dir', path.join(cdir, 'c')], {}), (m) => logs.push(m))).toBeNull();
    expect(logs.at(-1)).toMatch(/no credential named nope/);
  });

  it('drops cookies from responses and auth headers from requests', async () => {
    const c = await client();
    const f = c.fetchFor('anthropic');
    const r = await f('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'client-supplied', authorization: 'Bearer client' }, body: JSON.stringify({ model: 'claude-sonnet-4-5', messages: [] }) });
    expect(r.headers.get('set-cookie')).toBeNull();
    expect(upstream.at(-1)!.headers['x-api-key']).toBe('sk-ant-REAL');
    expect(upstream.at(-1)!.headers.authorization).toBeUndefined();
    c.close();
  });

  it('refuses other destinations, other models, unknown operations and wrong tokens', async () => {
    const c = await client();
    const f = c.fetchFor('anthropic');
    await expect(f('https://evil.example/v1/messages', { method: 'POST', body: '{}' })).rejects.toMatchObject({ code: 'policy_blocked', message: expect.stringMatching(/only be sent to https:\/\/api\.anthropic\.com/) });
    await expect(c.providerFor('haiku-only').chat({ model: 'claude-opus-4-1', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/may not be used with claude-opus-4-1/);
    await expect((c as any).call({ op: 'get', credential: 'anthropic' })).rejects.toThrow(/no operation that returns a key/);
    c.close();
    // A process without the token gets nothing.
    const reply = await new Promise<string>((resolve) => {
      const s = connect(executorEndpoint(path.join(cdir, 'c')));
      let buf = '';
      s.on('data', (d) => (buf += d));
      s.on('close', () => resolve(buf));
      s.write(`${JSON.stringify({ id: 1, op: 'hello', token: 'guess', client: { name: 'x', pid: 1 } })}\n${JSON.stringify({ id: 2, op: 'list' })}\n`);
    });
    expect(reply).toContain('unauthenticated');
    expect(reply).not.toContain('anthropic');
  });

  it('applies the vault’s AI policy on every request, re-read live', async () => {
    await mkdir(path.join(fx.dir, 'ai'), { recursive: true });
    await writeFile(path.join(fx.dir, 'ai', 'policy.json'), serializePolicy(parsePolicy({ routes: { background: 'off' } }).policy));
    const c = await client();
    await expect(c.providerFor('anthropic').chat({ model: 'claude-sonnet-4-5', messages: [{ role: 'user', content: 'x' }] })).rejects.toThrow(/switched off/);
    await writeFile(path.join(fx.dir, 'ai', 'policy.json'), serializePolicy(parsePolicy({ tools: { deny: ['inkwright-notes__trash_note'] } }).policy));
    await expect(c.callTool('notes-app', 'trash_note', { id: 'LAUNCH' })).rejects.toMatchObject({ code: 'policy_blocked' });
    c.close();
  });

  it('calls a connected app’s tools with its token, and offers routines only the read-only ones', async () => {
    const c = await client();
    const tools = await c.listTools('notes-app');
    expect(tools.map((t) => t.name)).toContain('search_notes');
    expect(tools.map((t) => t.name)).not.toContain('trash_note'); // denied by the policy above
    const r = await c.callTool('notes-app', 'search_notes', { query: 'beta' });
    expect(r.kind).toBe('result');
    expect(JSON.stringify(r)).toContain('Launch plan');
    const forRoutine = await connectorToolsViaExecutor(c, ['inkwright-notes', 'not-configured'], { source: 'routine', label: 'Morning' });
    expect(forRoutine.missing).toEqual(['not-configured']);
    expect(forRoutine.tools.length).toBeGreaterThan(3);
    expect(forRoutine.tools.every((t) => t.readOnly)).toBe(true);
    expect(forRoutine.tools.map((t) => t.name)).not.toContain('inkwright_notes__create_note');
    const out = await forRoutine.tools.find((t) => t.name === 'inkwright_notes__search_notes')!.execute({ query: 'beta' }, { toolCallId: 't', messages: [] });
    expect(JSON.stringify(out)).toContain('Launch plan');
    c.close();
  });

  it('records every request, allowed and refused, in a verifiable signed audit trail', async () => {
    await (ex as any).audit.flush();
    const jsonl = await exportAuditJsonl(new NodeFS(fx.dir));
    const mine = jsonl.split('\n').filter((l) => l.includes(`"dev":"${ex.device}"`));
    expect(mine.some((l) => l.includes('"kind":"ai_call"') && l.includes('with credential anthropic'))).toBe(true);
    expect(mine.some((l) => l.includes('"kind":"blocked"') && l.includes('evil.example'))).toBe(true);
    expect(mine.some((l) => l.includes('"tool":"inkwright-notes__search_notes"'))).toBe(true);
    expect(jsonl).not.toMatch(/sk-ant-REAL|connector-token-123/);
    const report = await verifyAudit(jsonl);
    expect(report.ok, report.problems.join('; ')).toBe(true);
  });
});
