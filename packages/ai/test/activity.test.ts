import { describe, expect, it } from 'vitest';
import { MemoryFS } from '@inkwright/core';
import {
  ActivityStore,
  MemoryNoteToolHost,
  RecordingNoteToolHost,
  RunRecorder,
  VaultUndoTarget,
  createNoteTools,
  createScriptedProvider,
  runAgent,
  undoOpInRun,
  undoRun,
} from '../src/index.ts';

async function setup() {
  let t = Date.UTC(2026, 10, 1, 9);
  const clock = () => (t += 1000);
  const host = await MemoryNoteToolHost.create({ clock });
  const store = new ActivityStore(new MemoryFS());
  const rec = new RunRecorder(store, { source: 'assistant', label: 'Assistant', prompt: 'tidy up' }, clock);
  const recording = new RecordingNoteToolHost(host, rec.record, clock);
  const target = new VaultUndoTarget(host.vault, () => host.reindexAll());
  return { host, store, rec, recording, target, clock };
}

describe('activity log', () => {
  it('records every change an agent run makes, with before/after summaries', async () => {
    const { host, store, rec, recording } = await setup();
    const n = await host.seed({ title: 'Lecture 4', text: 'Entropy and the second law', tags: ['physics'] });
    const provider = createScriptedProvider([
      { toolCalls: [{ name: 'update_note', arguments: { note_id: n.id, title: 'Thermodynamics 4', tags: ['physics', 'exam'] } }] },
      { toolCalls: [{ name: 'append_to_note', arguments: { note_id: n.id, text: '- [ ] Revise entropy' } }] },
      { toolCalls: [{ name: 'create_notebook', arguments: { name: 'Physics' } }] },
      { toolCalls: [{ name: 'create_note', arguments: { title: 'Tasks', text: '- [ ] Revise entropy' } }] },
      { text: 'Done.' },
    ]);
    await runAgent({ provider, model: 'm', messages: [{ role: 'user', content: 'tidy' }], tools: createNoteTools(recording) });
    await rec.finish('done', { reply: 'Done.' });
    const runs = await store.list();
    expect(runs).toHaveLength(1);
    const ops = runs[0]!.ops;
    expect(ops.map((o) => o.kind)).toEqual(['meta_changed', 'text_appended', 'notebook_created', 'note_created']);
    expect(ops[0]!.summary).toBe('“Lecture 4”: renamed “Lecture 4” → “Thermodynamics 4”, tagged #exam');
    expect(ops[1]!.summary).toContain('Revise entropy');
    expect(runs[0]!.status).toBe('done');
    expect(runs[0]!.reply).toBe('Done.');
  });

  it('runs with no changes are not logged, unless asked (routines)', async () => {
    const { store, clock } = await setup();
    await new RunRecorder(store, { source: 'assistant', label: 'Assistant' }, clock).finish('done');
    expect(await store.list()).toHaveLength(0);
    await new RunRecorder(store, { source: 'routine', label: 'File my notes' }, clock).finish('done', { alwaysLog: true });
    expect(await store.list()).toHaveLength(1);
  });

  it('undo really restores the vault: per action and per run', async () => {
    const { host, store, rec, recording, target } = await setup();
    const n = await host.seed({ title: 'Lecture 4', text: 'Entropy', tags: ['physics'] });
    const before = await host.readNote(n.id);
    await recording.updateNote(n.id, { title: 'Thermo', tags: ['physics', 'exam'], pinned: true });
    await recording.appendText(n.id, 'Added by AI');
    const created = await recording.createNote({ title: 'Tasks', text: 'x' });
    const victim = await host.seed({ title: 'Old list', text: 'bananas' });
    await recording.trashNote(victim.id);
    await rec.finish('done');
    const run = (await store.get(rec.run.id))!;

    // Undo just the append.
    const appendOp = run.ops.find((o) => o.kind === 'text_appended')!;
    expect((await undoOpInRun(run, appendOp.id, target)).ok).toBe(true);
    expect((await host.readNote(n.id))!.pages[0]!.text).toBe(before!.pages[0]!.text);

    // Then the rest of the run.
    const results = await undoRun(run, target);
    expect([...results.values()].every((r) => r.ok)).toBe(true);
    const after = (await host.vault.readNote(n.id))!;
    expect(after.title).toBe('Lecture 4');
    expect(after.tags).toEqual(['physics']);
    expect(after.pinned).toBe(false);
    expect((await host.vault.readNote(created.id))!.trashedAt).toBeTypeOf('number');
    expect((await host.vault.readNote(victim.id))!.trashedAt).toBeUndefined();
    expect(run.ops.every((o) => o.undoneAt)).toBe(true);
    // Search index follows (the trashed-by-AI note is findable again).
    expect((await host.searchNotes('bananas')).map((h) => h.noteId)).toContain(victim.id);
  });

  it('undo keeps edits the user made afterwards', async () => {
    const { host, rec, recording, target } = await setup();
    const n = await host.seed({ title: 'Draft', tags: [] });
    await recording.updateNote(n.id, { title: 'AI title', tags: ['ai'] });
    // The user renames it again by hand.
    await host.vault.updateNote(n.id, (m) => ({ ...m, title: 'My own title' }));
    const op = rec.run.ops[0]!;
    const r = await undoOpInRun(rec.run, op.id, target);
    expect(r.ok).toBe(true);
    expect(r.message).toMatch(/Kept your later change to the title/);
    const m = (await host.vault.readNote(n.id))!;
    expect(m.title).toBe('My own title');
    expect(m.tags).toEqual([]);
  });

  it('removes an appended text even after other edits, and a page the AI added', async () => {
    const { host, rec, recording, target } = await setup();
    const n = await host.seed({ title: 'Long', text: 'start' });
    const pagesBefore = (await host.vault.readNote(n.id))!.pageIds.length;
    // Too long for the rest of the page, so the host flows it onto a new page.
    await recording.appendText(n.id, `AI tail\n${'more\n'.repeat(200)}`);
    const op = rec.run.ops.find((o) => o.kind === 'text_appended')!;
    const grew = (await host.vault.readNote(n.id))!.pageIds.length > pagesBefore;
    await undoOpInRun(rec.run, op.id, target);
    const m = (await host.vault.readNote(n.id))!;
    expect(grew).toBe(true);
    expect(m.pageIds.length).toBe(pagesBefore);
    const all = (await host.readNote(n.id))!.pages.map((p) => p.text).join('\n');
    expect(all).not.toContain('AI tail');
  });

  it('keeps a notebook the user has filed notes into', async () => {
    const { host, rec, recording, target } = await setup();
    const nb = await recording.createNotebook('Physics');
    const n = await host.seed({ title: 'Mine' });
    await host.vault.updateNote(n.id, (m) => ({ ...m, notebookId: nb.id }));
    const r = await undoOpInRun(rec.run, rec.run.ops[0]!.id, target);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/1 note in it/);
    expect((await host.vault.listNotebooks()).map((b) => b.id)).toContain(nb.id);
  });

  it('external (connected app) actions are listed but not reversible here', async () => {
    const { rec, target } = await setup();
    rec.record({ kind: 'external', tool: 'notion__create_page', server: 'Notion', summary: 'Used “Create page” in Notion' });
    const r = await undoOpInRun(rec.run, rec.run.ops[0]!.id, target);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/another app/);
  });

  it('prunes old runs', async () => {
    const fs = new MemoryFS();
    const store = new ActivityStore(fs, { maxRuns: 3 });
    let t = 1;
    for (let i = 0; i < 5; i++) await new RunRecorder(store, { source: 'routine', label: `r${i}` }, () => (t += 1000)).finish('done', { alwaysLog: true });
    expect(await store.prune()).toBe(2);
    expect((await store.list()).map((r) => r.label)).toEqual(['r4', 'r3', 'r2']);
  });
});
