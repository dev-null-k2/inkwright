import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ActivityStore, VaultUndoTarget, undoRun } from '@inkstone/ai';
import type { ServerContext } from '../src/context.ts';
import { createServices, type ServerServices } from '../src/server.ts';
import { legacyClient, modernClient } from './clients.ts';
import { json, makeFixture, type Fixture } from './fixtures.ts';

let fx: Fixture;
let ctx: ServerContext;
let services: ServerServices;

beforeEach(async () => {
  fx = await makeFixture();
  ctx = await fx.ctx();
  services = createServices(ctx, { transport: 'http' });
});
afterEach(async () => {
  await fx.cleanup();
});

// Over stateless HTTP every request gets its own MCP server; writes still join one run per agent.
const connect = () => modernClient(services, { name: 'claude-desktop', title: 'Claude Desktop', version: '1.0.0' });

describe('activity log for external agents', () => {
  it('logs writes made through the server as one undoable run, in the app’s format', async () => {
    const client = await connect();
    const created = json(await client.callTool({ name: 'create_note', arguments: { title: 'From Claude', text: 'hello' } }) as never);
    await client.callTool({ name: 'append_to_note', arguments: { id: 'LAUNCH', text: 'Added by the agent' } });
    await client.callTool({ name: 'update_note', arguments: { id: 'GROCERIES', title: 'Shopping', tags: ['errands'] } });
    await client.callTool({ name: 'trash_note', arguments: { id: 'OLDNOTE' } });
    await client.callTool({ name: 'search_notes', arguments: { query: 'launch' } }); // reads are not logged
    await services.activity.flush();

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

  it('2025-era clients are logged the same way, as a separate agent', async () => {
    const old = await legacyClient(services, { name: 'cursor', title: 'Cursor', version: '1.0.0' });
    await old.callTool({ name: 'create_note', arguments: { title: 'From Cursor', text: 'hi' } });
    const modern = await connect();
    await modern.callTool({ name: 'create_note', arguments: { title: 'From Claude', text: 'hi' } });
    await services.activity.flush();
    const runs = await new ActivityStore(ctx.fs).list();
    expect(runs.map((r) => r.label).sort()).toEqual(['Claude Desktop (via MCP)', 'Cursor (via MCP)']);
    await old.close();
    await modern.close();
  });

  it('failed calls are not logged', async () => {
    const client = await connect();
    const r = await client.callTool({ name: 'append_to_note', arguments: { id: 'NOPE', text: 'x' } });
    expect(r.isError).toBe(true);
    expect(await new ActivityStore(ctx.fs).list()).toEqual([]);
    await client.close();
  });
});
