import { readFile } from 'node:fs/promises';
import { request } from 'node:http';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { VaultLayout, decodeNote } from '@inkstone/core';
import { startHttpServer, type RunningHttpServer } from '../src/http.ts';
import { createServices } from '../src/server.ts';
import { json, makeFixture, text, type Fixture } from './fixtures.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('stdio end-to-end', () => {
  let fx: Fixture;
  let client: Client;

  beforeAll(async () => {
    fx = await makeFixture();
    client = new Client({ name: 'inkstone-e2e', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: 'npx',
      args: ['tsx', '--import', './apps/mcp-server/scripts/raw-hooks.mjs', 'apps/mcp-server/src/index.ts', '--vault', fx.dir],
      cwd: repoRoot,
      stderr: 'pipe',
    });
    await client.connect(transport);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
    await fx?.cleanup();
  });

  it('lists tools, resources templates and prompts', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['list_notes', 'search_notes', 'read_note', 'get_page_image', 'list_notebooks', 'create_notebook', 'create_note', 'append_to_note', 'update_note', 'trash_note', 'get_recent_handwriting']));
    const search = tools.find((t) => t.name === 'search_notes')!;
    expect(search.inputSchema.required).toEqual(['query']);
    expect(search.annotations?.readOnlyHint).toBe(true);
    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate).sort()).toEqual(['inkstone://notes/{id}', 'inkstone://notes/{id}/pages/{n}.svg']);
    const { prompts } = await client.listPrompts();
    expect(prompts.map((p) => p.name).sort()).toEqual(['daily_review', 'summarize_note', 'todos_from_notes']);
  });

  it('searches, creates a note and reads it back', async () => {
    const hits = json((await client.callTool({ name: 'search_notes', arguments: { query: 'maria pricing' } })) as CallToolResult);
    expect(hits.hits[0]).toMatchObject({ id: 'LAUNCH', page: 1 });

    const created = json((await client.callTool({ name: 'create_note', arguments: { title: 'From an agent', text: 'Hello from **MCP**', tags: ['agent'] } })) as CallToolResult);
    expect(created).toMatchObject({ created: true, title: 'From an agent', pages: 1 });
    const onDisk = decodeNote(await readFile(path.join(fx.dir, VaultLayout.noteMeta(created.id)), 'utf8'));
    expect(onDisk).toMatchObject({ title: 'From an agent', tags: ['agent'] });

    const found = json((await client.callTool({ name: 'search_notes', arguments: { query: 'hello mcp' } })) as CallToolResult);
    expect(found.hits[0].id).toBe(created.id);

    const res = await client.readResource({ uri: `inkstone://notes/${created.id}` });
    expect((res.contents[0] as { text: string }).text).toContain('Hello from **MCP**');
    const svg = await client.readResource({ uri: `inkstone://notes/${created.id}/pages/1.svg` });
    expect((svg.contents[0] as { text: string }).text).toContain('<svg');

    const prompt = await client.getPrompt({ name: 'summarize_note', arguments: { id: 'LAUNCH' } });
    expect((prompt.messages[0]!.content as { text: string }).text).toContain('Launch the beta on Friday');
  });

  it('reports bad input as tool errors, including path traversal', async () => {
    const r = (await client.callTool({ name: 'read_note', arguments: { id: '../../etc/passwd' } })) as CallToolResult;
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Invalid id|Invalid arguments|validation/i);
    const missing = (await client.callTool({ name: 'read_note', arguments: { id: 'NOPE' } })) as CallToolResult;
    expect(missing.isError).toBe(true);
    expect(text(missing)).toMatch(/Note not found/);
  });
});

describe('Streamable HTTP', () => {
  let fx: Fixture;
  let http: RunningHttpServer;

  beforeAll(async () => {
    fx = await makeFixture();
    http = await startHttpServer(createServices(await fx.ctx({ readOnly: true }), { transport: 'http' }), { port: 0, token: 'sekret' });
  });
  afterAll(async () => {
    await http?.close();
    await fx?.cleanup();
  });

  it('requires the bearer token', async () => {
    const res = await fetch(http.url, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: '{}' });
    expect(res.status).toBe(401);
    const wrong = await fetch(http.url, { method: 'POST', headers: { authorization: 'Bearer nope', 'content-type': 'application/json' }, body: '{}' });
    expect(wrong.status).toBe(401);
    const wrongQuery = await fetch(`${http.url}?token=nope`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(wrongQuery.status).toBe(401);
    const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
    const viaQuery = await fetch(`${http.url}?token=sekret`, {
      method: 'POST',
      // A tunnel forwards its own Host header; with a token that is allowed.
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify(init),
    });
    expect(viaQuery.status).toBe(200);
  });

  it('serves MCP over HTTP; read-only hides and rejects write tools', async () => {
    const client = new Client({ name: 'inkstone-http', version: '0.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(http.url), { requestInit: { headers: { authorization: 'Bearer sekret' } } }));
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('search_notes');
      expect(names).not.toContain('create_note');
      const r = json((await client.callTool({ name: 'list_notes', arguments: { tag: 'launch' } })) as CallToolResult);
      expect(r.notes[0].id).toBe('LAUNCH');
      // Unknown tools are a protocol error (-32602) since MCP 2025-11-25.
      await expect(client.callTool({ name: 'create_note', arguments: { title: 'x' } })).rejects.toThrow(/not found/);
    } finally {
      await client.close();
    }
  });

  it('without a token, only accepts loopback Host headers', async () => {
    const open = await startHttpServer(createServices(await fx.ctx(), { transport: 'http' }), { port: 0 });
    try {
      const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
      const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
      const ok = await fetch(open.url, { method: 'POST', headers, body: JSON.stringify(init) });
      expect(ok.status).toBe(200);
      const evil = await fetch(open.url, { method: 'POST', headers: { ...headers, origin: 'https://evil.example' }, body: JSON.stringify(init) });
      expect(evil.status).toBe(403);
      const get = await fetch(open.url, { headers });
      expect(get.status).toBe(405);
      // DNS rebinding: a page on evil.example resolving to 127.0.0.1 sends its own Host header.
      const rebinding = await new Promise<number>((resolve, reject) => {
        const req = request({ host: '127.0.0.1', port: open.port, path: '/mcp', method: 'POST', headers: { ...headers, host: `evil.example:${open.port}` } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on('error', reject);
        req.end(JSON.stringify(init));
      });
      expect(rebinding).toBe(403);
    } finally {
      await open.close();
    }
  });
});
