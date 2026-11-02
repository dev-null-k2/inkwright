import { afterEach, describe, expect, it } from 'vitest';
import { VersionHistory, unlockWith } from '@inkstone/core';
import { VaultNoteToolHost } from '../src/agent/host.ts';
import { makeFixture, type Fixture } from './fixtures.ts';

let fx: Fixture | null = null;
afterEach(async () => { await fx?.cleanup(); fx = null; });

describe('agents, version history and locked notes', () => {
  it('snapshots a note before an agent appends to it, so the change can be rolled back from history', async () => {
    fx = await makeFixture();
    const ctx = await fx.ctx();
    const host = new VaultNoteToolHost(ctx);
    await host.appendText(fx.notes.groceries.id, 'Oat milk');
    const history = new VersionHistory(fx.external);
    const list = await history.list(fx.notes.groceries.id);
    expect(list.map((s) => s.reason)).toEqual(['agent']);
    const before = (await history.read(fx.notes.groceries.id, list[0]!.id))!;
    expect(JSON.stringify(before.pages)).not.toContain('Oat milk');
  });

  it('a locked note is blank to agents and refuses their writes', async () => {
    fx = await makeFixture();
    const id = fx.notes.launch.id;
    const pages = await fx.external.readPages(fx.notes.launch);
    const locked = await fx.external.lockNote(fx.notes.launch, pages, 'tulip-42', { iterations: 1000 });
    fx.external.forget(id);
    const ctx = await fx.ctx();
    const host = new VaultNoteToolHost(ctx);
    const content = await host.readNote(id);
    expect(JSON.stringify(content)).not.toContain('Launch the beta');
    await expect(host.appendText(id, 'from an agent')).rejects.toThrow();
    // Still opens with the passcode, unchanged.
    fx.external.unlock(id, (await unlockWith(locked.lock!, 'tulip-42'))!);
    const back = await fx.external.readPages(locked, { unlocked: true });
    expect(back[0]!.recognizedText).toContain('Launch the beta');
    expect(JSON.stringify(back)).not.toContain('from an agent');
  });
});
