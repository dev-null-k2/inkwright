import { describe, expect, it } from 'vitest';
import { BranchStore, MemoryFS, Vault } from '@inkstone/core';
import { MemoryNoteToolHost, ProposalStore, ProposingNoteToolHost, applyProposalToBranch } from '../src/index.ts';

describe('applying dry-run proposals to a branch', () => {
  it('stacks proposals on a shadow copy and leaves the notes untouched', async () => {
    let t = 1_000;
    const clock = () => ++t;
    const fs = new MemoryFS(clock);
    const vault = new Vault(fs, clock);
    await vault.init();
    const live = await MemoryNoteToolHost.create({ vault, clock });
    const note = await live.createNote({ title: 'Groceries', text: 'eggs' });

    // The agent works in dry-run mode: its writes become proposals.
    const proposals = new ProposalStore(fs, clock);
    const proposing = new ProposingNoteToolHost(live, proposals, { source: 'assistant', label: 'Assistant' });
    await proposing.appendText(note.id, 'milk');
    await proposing.createNote({ title: 'Meal plan', text: 'Monday: soup' });
    const [p2, p1] = await proposals.list();

    const store = new BranchStore(fs, clock);
    const branch = await store.create('Shopping ideas', { source: 'assistant', label: 'Assistant' });
    const r1 = await applyProposalToBranch(p1!, store, branch);
    expect(r1.summary).toMatch(/Added text/);
    expect(r1.notes).toEqual([note.id]);
    const r2 = await applyProposalToBranch(p2!, store, (await store.get(branch.id))!);
    expect(r2.notes).toHaveLength(1);

    // Main: unchanged. Branch: both changes.
    expect((await live.readNote(note.id))!.pages.map((p) => p.text).join('\n')).not.toContain('milk');
    expect((await vault.listNotes()).map((n) => n.title)).toEqual(['Groceries']);
    const b = (await store.get(branch.id))!;
    expect(b.proposals).toEqual([p1!.id, p2!.id]);
    const sides = (await store.sides(b, note.id))!;
    expect(sides.head.pages[0]!.texts!.map((x) => x.text)).toEqual(['eggs', 'milk']);
    // What the agent wrote is AI content; what was there stays as it was.
    expect(sides.head.pages[0]!.texts!.map((x) => x.origin ?? null)).toEqual([null, 'ai']);
    expect(Object.values(b.notes).map((n) => n.title).sort()).toEqual(['Groceries', 'Meal plan']);

    await store.decide(branch.id, 'merged');
    await expect(applyProposalToBranch(p1!, store, (await store.get(branch.id))!)).rejects.toThrow(/already merged/);
  });
});
