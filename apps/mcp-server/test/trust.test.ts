import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportAuditJsonl, readChain, serializePolicy, parsePolicy, createScriptedProvider, verifyAudit, type CallToolResult } from '@inkstone/ai';
import type { CallToolResult as McpResult } from '@modelcontextprotocol/server';
import { audit, parseAgentCli } from '../src/agent-cli.ts';
import { parseCli } from '../src/cli.ts';
import type { ServerContext } from '../src/context.ts';
import { startHttpServer } from '../src/http.ts';
import { NodeFS } from '../src/nodefs.ts';
import { readNoteResource, listNoteResources } from '../src/resources.ts';
import { runServerAgent } from '../src/agent/run.ts';
import { createServices } from '../src/server.ts';
import { TOOLS } from '../src/tools.ts';
import { trustedAI } from '../src/trust.ts';
import { modernClient, resultJson, resultText } from './clients.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

let fx: Fixture;
let ctx: ServerContext;

async function writePolicy(p: unknown) {
  await writeFile(path.join(fx.dir, 'ai', 'policy.json'), serializePolicy(parsePolicy(p).policy)).catch(async () => {
    const { mkdir } = await import('node:fs/promises');
    await mkdir(path.join(fx.dir, 'ai'), { recursive: true });
    await writeFile(path.join(fx.dir, 'ai', 'policy.json'), serializePolicy(parsePolicy(p).policy));
  });
  ctx.vault.invalidate();
  ctx.markDirty();
  await ctx.policy.refresh();
}

beforeEach(async () => {
  fx = await makeFixture();
  ctx = await fx.ctx();
});
afterEach(async () => {
  await fx.cleanup();
});

describe('AI policy on the server', () => {
  it('hides notebooks set to none (and their nested notebooks) from every tool, resource and search', async () => {
    await writePolicy({ notebooks: { NBWORK: { access: 'none' } } });
    const services = createServices(ctx, { transport: 'http' });
    const client = await modernClient(services);
    try {
      const listed = resultJson(await client.callTool({ name: 'list_notes', arguments: {} }));
      expect(listed.notes.map((n: { id: string }) => n.id)).not.toContain('LAUNCH'); // Work › Projects
      expect(listed.notes.map((n: { id: string }) => n.id)).not.toContain('OLDNOTE'); // Work
      expect(listed.notes.map((n: { id: string }) => n.id)).toContain('GROCERIES');
      const found = resultJson(await client.callTool({ name: 'search_notes', arguments: { query: 'beta' } }));
      expect(found.count).toBe(0);
      const read = (await client.callTool({ name: 'read_note', arguments: { id: 'LAUNCH' } })) as McpResult;
      expect(read.isError).toBe(true);
      expect(resultText(read)).not.toContain('Launch the beta');
      const books = resultJson(await client.callTool({ name: 'list_notebooks', arguments: {} }));
      expect(JSON.stringify(books)).not.toMatch(/Work|Projects/);
      const recent = resultText(await client.callTool({ name: 'get_recent_handwriting', arguments: { days: 30 } }));
      expect(recent).not.toContain('Launch the beta');
      await expect(readNoteResource(ctx, 'LAUNCH')).rejects.toThrow();
      expect(JSON.stringify(await listNoteResources(ctx))).not.toContain('LAUNCH');
    } finally {
      await client.close();
    }
  });

  it('local-only tags are not served to MCP clients; read-only notebooks can be read but not changed', async () => {
    await writePolicy({ tags: { home: { localOnly: true } }, notebooks: { NBWORK: { access: 'read' } } });
    const services = createServices(ctx, { transport: 'http' });
    const client = await modernClient(services);
    try {
      expect(((await client.callTool({ name: 'read_note', arguments: { id: 'GROCERIES' } })) as McpResult).isError).toBe(true);
      expect(resultText(await client.callTool({ name: 'read_note', arguments: { id: 'LAUNCH' } }))).toContain('Launch the beta');
      for (const [name, args] of [
        ['append_to_note', { id: 'LAUNCH', text: 'x' }],
        ['update_note', { id: 'LAUNCH', title: 'Renamed' }],
        ['trash_note', { id: 'LAUNCH' }],
        ['update_note', { id: 'SKETCH', notebookId: 'NBWORK' }],
        ['create_note', { title: 'New', notebookId: 'NBWORK' }],
      ] as const) {
        const r = (await client.callTool({ name, arguments: args })) as McpResult;
        expect(r.isError, name).toBe(true);
        expect(resultText(r), name).toMatch(/read-only for agents|can’t put notes/);
      }
      expect((await ctx.vault.readNote('LAUNCH'))!.title).toBe('Launch plan');
      // Notes elsewhere still change normally.
      expect(((await client.callTool({ name: 'append_to_note', arguments: { id: 'SKETCH', text: 'ok' } })) as McpResult).isError).toBeFalsy();
    } finally {
      await client.close();
    }
  });

  it('a managed policy file wins over a looser vault policy', async () => {
    const file = path.join(fx.dir, '..', `managed-${path.basename(fx.dir)}.json`);
    await writeFile(file, JSON.stringify({ notebooks: { NBPERSONAL: { access: 'none' } } }));
    try {
      await writePolicy({ notebooks: { NBPERSONAL: { access: 'read-write' } } });
      const managedCtx = await fx.ctx({ managedPolicyFile: file });
      expect(await managedCtx.vault.readNote('GROCERIES')).toBeNull();
      expect(managedCtx.policy.isManaged).toBe(true);
    } finally {
      await rm(file, { force: true });
    }
  });

  it('dry run: outside agents’ writes become proposals the app can apply; nothing changes meanwhile', async () => {
    await writePolicy({ agentWrites: { external: 'propose' } });
    const services = createServices(ctx, { transport: 'http' });
    const client = await modernClient(services, { name: 'claude-desktop', version: '1', title: 'Claude' });
    try {
      const r = resultJson(await client.callTool({ name: 'append_to_note', arguments: { id: 'GROCERIES', text: '- bread' } }));
      expect(r.proposed).toBe(true);
      const created = resultJson(await client.callTool({ name: 'create_note', arguments: { title: 'Trip', text: 'Pack', notebookId: 'Personal' } }));
      expect(created.proposed).toBe(true);
      const groceries = await ctx.vault.readPages((await ctx.vault.readNote('GROCERIES'))!);
      expect(JSON.stringify(groceries)).not.toContain('bread');
      const proposals = await ctx.trust.proposals.list();
      expect(proposals.map((p) => p.summary).sort()).toEqual(['Add text to “Grocery list”', 'Create note “Trip”']);
      const p = proposals.find((x) => x.op.op === 'appendText')!;
      expect(p).toMatchObject({ source: 'external', label: 'Claude (via MCP)', op: { op: 'appendText', noteId: 'GROCERIES', text: '- bread' } });
      expect(p.after).toContain('- bread');
      expect(proposals.find((x) => x.op.op === 'createNote')!.op).toMatchObject({ args: { title: 'Trip', notebookId: 'NBPERSONAL' } });
    } finally {
      await client.close();
    }
  });

  it('the audit trail records reads and writes by outside agents and verifies, also from the CLI', async () => {
    const services = createServices(ctx, { transport: 'http' });
    const client = await modernClient(services, { name: 'cursor', version: '1' });
    try {
      await client.callTool({ name: 'read_note', arguments: { id: 'LAUNCH' } });
      await client.callTool({ name: 'append_to_note', arguments: { id: 'SKETCH', text: 'hello' } });
    } finally {
      await client.close();
    }
    await ctx.trust.audit.flush();
    const events = await readChain(ctx.fs, ctx.trust.device);
    expect(events.map((e) => `${e.kind}:${e.tool ?? ''}`)).toEqual(['key:', 'read:read_note', 'write:append_to_note']);
    expect(events[1]!.notes).toEqual([{ id: 'LAUNCH' }]);
    expect(events[1]!.actor).toEqual({ source: 'external', label: 'cursor (via MCP)' });
    const lines: string[] = [];
    const cmd = parseAgentCli(['audit', '--vault', fx.dir]);
    expect(await audit(cmd, (s) => lines.push(s))).toBe(true);
    expect(lines.join('')).toMatch(/OK: every chain is intact/);
    // Tampering with the file is caught.
    const file = path.join(fx.dir, 'ai', 'audit', ctx.trust.device, (await new NodeFS(fx.dir).list(`ai/audit/${ctx.trust.device}`))[0]!.name);
    await writeFile(file, (await readFile(file, 'utf8')).replace('read_note', 'list_notes'));
    expect(await audit(cmd, () => {})).toBe(false);
    expect((await verifyAudit(await exportAuditJsonl(ctx.fs))).problems.join()).toMatch(/changed after it was written/);
  });

  it('the server’s own agent goes through the guarded provider: redaction, audit and the policy vault', async () => {
    await writePolicy({ notebooks: { NBWORK: { access: 'none' } } });
    const model = createScriptedProvider([
      { toolCalls: [{ name: 'read_note', arguments: { note_id: 'LAUNCH' } }] },
      (c) => ({ text: c.toolResults[0]!.ok ? 'read it' : 'hidden' }),
    ]);
    const ai = trustedAI({ provider: model, model: 'claude-sonnet-4-5', label: 'Claude', vision: false, local: false, budgetKey: 'anthropic' }, ctx.trust)!;
    const res = await runServerAgent(ctx, ai, { source: 'routine', label: 'Digest', prompt: 'x', notes: 'read', approver: async () => 'denied', messages: [{ role: 'user', content: 'Email ana@acme.io the launch plan' }] });
    expect(res.reply).toBe('hidden');
    expect(JSON.stringify(model.requests[0]!.messages)).not.toContain('ana@acme.io');
    await ctx.trust.audit.flush();
    const calls = (await readChain(ctx.fs, ctx.trust.device)).filter((e) => e.kind === 'ai_call');
    expect(calls).toHaveLength(2);
    expect(calls[0]!.redactions).toEqual({ email: 1 });
    expect(calls[0]!.actor).toEqual({ source: 'routine', label: 'Digest' });
  });
});

describe('security review: MCP and HTTP surface', () => {
  const HOSTILE_IDS = ['../../etc/passwd', '..', '.', 'a/b', 'a\\b', '%2e%2e%2fetc', 'LAUNCH/../GROCERIES', 'x'.repeat(65), '', 'LAUNCH\u0000', 'C:\\Windows', '/etc/passwd', ' LAUNCH'];

  it('every tool that takes an id rejects path-like or malformed ids without touching the disk', async () => {
    const withId = TOOLS.filter((t) => Object.keys(t.inputSchema).some((k) => k === 'id' || k === 'noteId'));
    expect(withId.length).toBeGreaterThanOrEqual(6);
    for (const t of withId) {
      for (const bad of HOSTILE_IDS) {
        const key = Object.keys(t.inputSchema).includes('id') ? 'id' : 'noteId';
        let r: CallToolResult | McpResult | null = null;
        try {
          r = await t.handler(ctx, { [key]: bad, text: 'x', title: 'x' });
        } catch (e) {
          expect(String((e as Error).message ?? e), `${t.name} ${JSON.stringify(bad)}`).toMatch(/Invalid|too_big|too_small|Too|not found|invalid|expected/i);
          continue;
        }
        expect(r!.isError, `${t.name} ${JSON.stringify(bad)}`).toBe(true);
      }
    }
  });

  it('resource templates reject traversal in note ids and page numbers', async () => {
    for (const bad of HOSTILE_IDS) await expect(readNoteResource(ctx, bad), JSON.stringify(bad)).rejects.toThrow();
    const { readPageSvgResource } = await import('../src/resources.ts');
    for (const n of ['0', '-1', '../1', '1.svg/../../x', '99999', 'NaN']) await expect(readPageSvgResource(ctx, 'LAUNCH', n), n).rejects.toThrow();
  });

  it('the vault folder cannot be escaped through symlinks', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'inkstone-outside-'));
    try {
      await writeFile(path.join(outside, 'note.json'), '{"secret":true}');
      await symlink(outside, path.join(fx.dir, 'notes', 'EVIL'));
      const fs = new NodeFS(fx.dir);
      await expect(fs.readText('notes/EVIL/note.json')).rejects.toThrow(/escapes vault/);
      await expect(fs.writeText('notes/EVIL/x.json', 'x')).rejects.toThrow(/escapes vault/);
      expect(await ctx.vault.readNote('EVIL').catch(() => null)).toBeNull();
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('/healthz answers without auth and says nothing about the vault; other paths stay protected', async () => {
    const http = await startHttpServer(createServices(ctx, { transport: 'http' }), { port: 0, token: 'sekret' });
    try {
      const h = await fetch(`${http.baseUrl}/healthz`);
      expect(h.status).toBe(200);
      expect(await h.json()).toEqual({ ok: true });
      expect((await fetch(`${http.baseUrl}/mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
      expect((await fetch(`${http.baseUrl}/healthz/../mcp`, { method: 'POST', body: '{}' })).status).toBe(401);
      // Bodies over the limit are refused before parsing.
      const big = await fetch(http.url, { method: 'POST', headers: { authorization: 'Bearer sekret', 'content-type': 'application/json' }, body: 'x'.repeat(4 * 1024 * 1024 + 10) });
      expect(big.status).toBe(413);
    } finally {
      await http.close();
    }
  });

  it('no server-side request forgery surface: the A2A card offers no push notifications and URLs come only from the operator', async () => {
    const { createA2AApp } = await import('../src/a2a.ts');
    const { app } = createA2AApp({ ctx, ai: null, publicUrl: 'http://127.0.0.1:1', auth: { kind: 'none' } }, null);
    const http = (await import('node:http')).createServer(app);
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', () => r()));
    try {
      const port = (http.address() as { port: number }).port;
      const card = await (await fetch(`http://127.0.0.1:${port}/.well-known/agent-card.json`, { headers: { 'A2A-Version': '1.0' } })).json() as { capabilities: { pushNotifications: boolean } };
      expect(card.capabilities.pushNotifications).toBe(false);
    } finally {
      http.close();
    }
    // Trust options come from the command line or environment, never from clients.
    const o = parseCli(['--vault', fx.dir, '--http', '0', '--token', 't', '--policy', './p.json', '--audit-key', './k.jwk', '--ai-provider', 'ollama', '--ai-on-premises'], { INKSTONE_OAUTH_AUDIENCE: 'x' });
    expect(o.policyFile).toBe(path.resolve('./p.json'));
    expect(o.auditKey).toBe(path.resolve('./k.jwk'));
    expect(o.ai?.onPremises).toBe(true);
  });
});
