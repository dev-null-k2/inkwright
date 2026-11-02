import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CompilerStore } from '@inkstone/ai';
import { buildContextPack } from '@inkstone/core';
import { createServices, type ServerServices } from '../src/server.ts';
import { modernClient } from './clients.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

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

describe('context packs as MCP resources', () => {
  it('lists packs the app saved and serves their cited Markdown and JSON', async () => {
    const pack = buildContextPack({ title: 'Launch plan', createdAt: fx.now, notes: [{ id: fx.notes.launch.id, title: fx.notes.launch.title, tags: [], updatedAt: fx.now, pages: [{ index: 0, text: 'Price at $12.' }] }], compiled: [], images: [] });
    await new CompilerStore(fx.external.fs).savePack(pack.id, { json: JSON.stringify(pack.json), markdown: pack.markdown });
    const c = await modernClient(services);
    const listed = (await c.listResources()).resources.find((r) => r.uri === `inkstone://packs/${pack.id}`);
    expect(listed).toMatchObject({ name: 'Launch plan', mimeType: 'text/markdown' });
    const read = await c.readResource({ uri: `inkstone://packs/${pack.id}` });
    expect((read.contents[0] as { text: string }).text).toContain('# Launch plan');
    expect((read.contents[1] as { mimeType: string }).mimeType).toBe('application/json');
    await expect(c.readResource({ uri: 'inkstone://packs/nope' })).rejects.toThrow();
    await c.close();
  });
});
