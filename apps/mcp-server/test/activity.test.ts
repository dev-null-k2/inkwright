import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { ActivityStore, VaultUndoTarget, undoRun } from '@inkstone/ai';
import type { ServerContext } from '../src/context.ts';
import { createMcpServer } from '../src/server.ts';
import { json, makeFixture, type Fixture } from './fixtures.ts';

let fx: Fixture;
let ctx: ServerContext;

beforeEach(async () => {
  fx = await makeFixture();
  ctx = await fx.ctx();
});
afterEach(async () => {
  await fx.cleanup();
});

async function connect() {
  const server = createMcpServer(ctx);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const client = new Client({ name: 'claude-desktop', title: 'Claude Desktop', version: '1.0.0' });
  await client.connect(a);
  return client;
}

describe('activity log for external agents', () => {
  it('logs writes made through the server as one undoable run, in the app’s format', async () => {
    const client = await connect();
    const created = json(await client.callTool({ name: 'create_note', arguments: { title: 'From Claude', text: 'hello' } }) as never);
    await client.callTool({ name: 'append_to_note', arguments: { id: 'LAUNCH', text: 'Added by the agent' } });
    await client.callTool({ name: 'update_note', arguments: { id: 'GROCERIES', title: 'Shopping', tags: ['errands'] } });
    await client.callTool({ name: 'trash_note', arguments: { id: 'OLDNOTE' } });
    await client.callTool({ name: 'search_notes', arguments: { query: 'launch' } }); // reads are not logged
    await new Promise((r) => setTimeout(r, 50));

    const store = new ActivityStore(ctx.fs);
    const runs = await store.list();
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.source).toBe('external');
    expect(run.label).toBe('Claude Desktop (via MCP)');
    expect(run.ops.map((o) => o.kind)).toEqual(['note_created', 'text_appended', 'meta_changed', 'note_trashed']);
    expect(run.ops[2]!.summary).toContain('renamed');

    // The app's undo reverts it all on the files.
    ctx.vault.invalidate();
    await undoRun(run, new VaultUndoTarget(ctx.vault));
    ctx.vault.invalidate();
    expect((await ctx.vault.readNote(created.id))!.trashedAt).toBeTypeOf('number');
    expect((await ctx.vault.readNote('OLDNOTE'))!.trashedAt).toBeUndefined();
    const groceries = (await ctx.vault.readNote('GROCERIES'))!;
    expect(groceries.title).toBe(fx.notes.groceries.title);
    expect(groceries.tags).toEqual(fx.notes.groceries.tags);
    const launchPages = await ctx.vault.readPages((await ctx.vault.readNote('LAUNCH'))!);
    expect(JSON.stringify(launchPages)).not.toContain('Added by the agent');
    await client.close();
  });

  it('failed calls are not logged', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'append_to_note', arguments: { id: 'NOPE', text: 'x' } });
    expect(r.isError).toBe(true);
    expect(await new ActivityStore(ctx.fs).list()).toEqual([]);
    await client.close();
  });
});
