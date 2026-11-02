import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { createServices, type ServerServices } from '../src/server.ts';
import { APPROVALS_UI, NOTE_PAGE_UI, SEARCH_UI, SVG_META_KEY, UI_MIME } from '../src/ui.ts';
import { MCP_URL, legacyClient, mcpFetch, modernClient, resultJson, resultText } from './clients.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let fx: Fixture;
let services: ServerServices;

beforeEach(async () => {
  fx = await makeFixture();
  services = createServices(await fx.ctx(), { transport: 'http' });
});
afterEach(async () => {
  services.tasks.close();
  await fx.cleanup();
});

describe('protocol versions over Streamable HTTP', () => {
  it('a 2026-07-28 client negotiates the new protocol through server/discover', async () => {
    const c = await modernClient(services);
    expect(c.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    expect(c.getServerVersion()).toMatchObject({ name: 'inkwright', title: 'Inkwright notes' });
    const caps = c.getServerCapabilities() as { extensions?: Record<string, unknown> };
    expect(caps.extensions).toHaveProperty('io.modelcontextprotocol/tasks');
    const tools = (await c.listTools()).tools.map((t) => t.name);
    expect(tools).toEqual(expect.arrayContaining(['search_notes', 'read_note', 'create_note', 'show_note_page', 'summarize_notebook', 'transcribe_pages', 'run_routine', 'list_routines', 'list_pending_approvals', 'decide_approval']));
    const r = await c.callTool({ name: 'search_notes', arguments: { query: 'maria pricing' } });
    expect(resultJson(r).hits[0].id).toBe('LAUNCH');
    await c.close();
  });

  it('every request is self-contained: the protocol version and client info travel in _meta', async () => {
    const f = mcpFetch(services);
    const meta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'curl', version: '1' }, 'io.modelcontextprotocol/clientCapabilities': {} };
    const res = await f(MCP_URL, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'list_notebooks' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'list_notebooks', arguments: {}, _meta: meta } }) });
    expect(res.status).toBe(200);
    const body = await res.json() as { result: { resultType: string; content: Array<{ text: string }>; _meta: Record<string, unknown> } };
    expect(body.result.resultType).toBe('complete');
    expect(body.result._meta['io.modelcontextprotocol/serverInfo']).toMatchObject({ name: 'inkwright' });
    expect(JSON.parse(body.result.content[0]!.text).notebooks.map((n: { name: string }) => n.name)).toContain('Work');
  });

  it('a 2025 client (initialize handshake) is served by the stateless fallback with the same tools', async () => {
    const c = await legacyClient(services);
    const tools = (await c.listTools()).tools;
    expect(tools.find((t) => t.name === 'search_notes')?.annotations?.readOnlyHint).toBe(true);
    const created = resultJson(await c.callTool({ name: 'create_note', arguments: { title: 'From 2025', text: 'still works' } }));
    expect(created.created).toBe(true);
    const page = await c.callTool({ name: 'show_note_page', arguments: { id: created.id } });
    expect(resultText(page)).toContain('still works');
    await c.close();
  });

  it('a 2025 client never gets a task: long tools run inline', async () => {
    const c = await legacyClient(services);
    const r = await c.callTool({ name: 'summarize_notebook', arguments: { notebook: 'Work' } });
    expect(r.isError).toBe(true); // no AI configured: a plain explanation, not a task handle
    expect(resultText(r)).toMatch(/needs an AI configured/);
    expect((r as Record<string, unknown>).resultType).toBeUndefined();
    await c.close();
  });
});

describe('MCP Apps', () => {
  it('serves the ui:// views as MCP Apps HTML and links them from tools', async () => {
    const c = await modernClient(services);
    const resources = (await c.listResources()).resources;
    for (const uri of [NOTE_PAGE_UI, SEARCH_UI, APPROVALS_UI]) {
      const r = resources.find((x) => x.uri === uri);
      expect(r?.mimeType).toBe(UI_MIME);
      const read = await c.readResource({ uri });
      const html = (read.contents[0] as { text: string }).text;
      expect(html).toMatch(/^<!doctype html>/);
      expect(html).toContain("rpc('ui/initialize'");
      expect(html).toContain('ui/notifications/size-changed');
      expect(html).not.toMatch(/<script[^>]+src=|<link[^>]+href=|https?:\/\/(?!www\.w3)/); // self-contained
    }
    const tools = (await c.listTools()).tools;
    const meta = (n: string) => tools.find((t) => t.name === n)?._meta as { ui?: { resourceUri?: string; visibility?: string[] } } | undefined;
    expect(meta('show_note_page')?.ui?.resourceUri).toBe(NOTE_PAGE_UI);
    expect(meta('search_notes')?.ui?.resourceUri).toBe(SEARCH_UI);
    expect(meta('list_pending_approvals')?.ui?.resourceUri).toBe(APPROVALS_UI);
    expect(meta('decide_approval')?.ui?.visibility).toEqual(['app', 'model']);
    await c.close();
  });

  it('the page view gets the ink as SVG out of band, the model gets text', async () => {
    const c = await modernClient(services);
    const r = await c.callTool({ name: 'show_note_page', arguments: { id: 'LAUNCH', page: 1 } });
    expect(resultText(r)).toContain('Launch the beta on Friday');
    expect(r.structuredContent).toMatchObject({ noteId: 'LAUNCH', title: 'Launch plan', page: 1, pageCount: 2 });
    expect(String((r._meta as Record<string, unknown>)[SVG_META_KEY])).toMatch(/^<svg/);
    const sketch = await c.callTool({ name: 'show_note_page', arguments: { id: 'SKETCH' } });
    expect(resultText(sketch)).toMatch(/not been converted to text/);
    const search = await c.callTool({ name: 'search_notes', arguments: { query: 'budget beta' } });
    expect(search.structuredContent).toMatchObject({ query: 'budget beta', hits: [expect.objectContaining({ id: 'LAUNCH', page: 2 })] });
    await c.close();
  });
});

describe('stdio', () => {
  let client: Client;
  let sfx: Fixture;
  beforeAll(async () => {
    sfx = await makeFixture();
    client = new Client({ name: 'stdio-2026', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
    await client.connect(new StdioClientTransport({ command: 'npx', args: ['tsx', '--import', './apps/mcp-server/scripts/raw-hooks.mjs', 'apps/mcp-server/src/index.ts', '--vault', sfx.dir], cwd: repoRoot, stderr: 'pipe' }));
  }, 60_000);
  afterAll(async () => {
    await client?.close();
    await sfx?.cleanup();
  });

  it('a 2026-07-28 client over stdio', async () => {
    expect(client.getNegotiatedProtocolVersion()).toBe('2026-07-28');
    const r = await client.callTool({ name: 'read_note', arguments: { id: 'GROCERIES' } });
    expect(resultText(r)).toContain('coffee');
  });
});
