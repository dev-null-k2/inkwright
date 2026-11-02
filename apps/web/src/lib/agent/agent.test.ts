import { beforeEach, describe, expect, it } from 'vitest';
import { createScriptedProvider, runAgent } from '@inkwright/ai';
import { pageText } from '@inkwright/core';
import { AppVault } from '../vault.ts';
import { EditorSession } from '../session.ts';
import { useApp } from '../../state/app.ts';
import { initAgentHub, requireHub } from './hub.ts';
import { prepareAgentRun } from './assistant.ts';
import { undoActivityOp, undoActivityRun } from './undo.ts';

async function setup() {
  const v = await AppVault.open();
  useApp.setState({ vault: v });
  await initAgentHub(v);
  const { note } = await v.vault.createNote({ title: 'Lecture 4' });
  const s = (await EditorSession.open(v, note.id))!;
  return { v, s, noteId: note.id };
}

async function agentRun(v: AppVault, script: Parameters<typeof createScriptedProvider>[0], openDoc: EditorSession['doc'] | null) {
  const provider = createScriptedProvider(script);
  const prep = await prepareAgentRun({ ai: { provider, model: 'm', label: 'Scripted', vision: false, tools: true }, vault: v, source: 'assistant', label: 'Assistant', prompt: 'tidy', openDoc, notes: 'write', skills: true, remember: true, mcp: 'all' });
  const res = await runAgent({ provider, model: 'm', system: prep.system, messages: [{ role: 'user', content: 'tidy' }], tools: prep.tools });
  return prep.recorder.finish('done', { reply: res.text });
}

describe('assistant runs in the app: logged and undoable', () => {
  beforeEach(() => indexedDB.deleteDatabase('inkwright-vault'));

  it('edits to the open note go through its document, and undo uses the document too', async () => {
    const { v, s, noteId } = await setup();
    const run = await agentRun(v, [
      { toolCalls: [{ name: 'append_to_note', arguments: { note_id: noteId, text: 'Entropy never decreases' } }, { name: 'update_note', arguments: { note_id: noteId, title: 'Thermodynamics', tags: ['physics'] } }] },
      { text: 'Done.' },
    ], s.doc);
    // Live in the open document (not only on disk).
    expect(pageText(s.doc.page(0))).toContain('Entropy never decreases');
    expect(s.doc.meta.title).toBe('Thermodynamics');
    expect(run.ops.map((o) => o.kind)).toEqual(['text_appended', 'meta_changed']);
    expect((await requireHub().activity.list())[0]!.id).toBe(run.id);

    const r = await undoActivityRun(run.id);
    expect(r.undone).toBe(2);
    expect(pageText(s.doc.page(0))).not.toContain('Entropy');
    expect(s.doc.meta.title).toBe('Lecture 4');
    expect(s.doc.meta.tags).toEqual([]);
    // The undo itself is an ordinary edit in the note's history: ⌘Z brings the text back.
    expect(s.doc.canUndo).toBe(true);
    s.doc.undo();
    expect(pageText(s.doc.page(0))).toContain('Entropy never decreases');
    // And the log remembers what was undone.
    const saved = (await requireHub().activity.get(run.id))!;
    expect(saved.ops.every((o) => o.undoneAt)).toBe(true);
    await s.close();
  });

  it('notes that are not open are changed and restored in the vault', async () => {
    const { v, s } = await setup();
    const run = await agentRun(v, [
      { toolCalls: [{ name: 'create_note', arguments: { title: 'Packing list', text: '- [ ] passport' } }] },
      { text: 'Created it.' },
    ], s.doc);
    const created = run.ops[0]!;
    expect(created.kind).toBe('note_created');
    const id = (created as { noteId: string }).noteId;
    expect(useApp.getState().notes.some((n) => n.id === id)).toBe(true);
    expect((await undoActivityOp(run.id, created.id)).ok).toBe(true);
    expect((await v.vault.readNote(id))!.trashedAt).toBeTypeOf('number');
    expect(useApp.getState().trash.some((n) => n.id === id)).toBe(true);
    expect(v.search.search('passport').some((h) => h.noteId === id)).toBe(false);
    await s.close();
  });

  it('the prompt carries memory, skills and the remember tool', async () => {
    const { v, s } = await setup();
    await requireHub().memory.add('instruction', 'Answer in bullet points');
    await requireHub().memory.propose('Has a cat');
    const provider = createScriptedProvider([{ text: 'ok' }]);
    const prep = await prepareAgentRun({ ai: { provider, model: 'm', label: 'x', vision: false, tools: true }, vault: v, source: 'assistant', label: 'Assistant', prompt: 'hi', openDoc: s.doc, notes: 'read', skills: true, remember: true, mcp: 'all' });
    expect(prep.system).toContain('- Answer in bullet points');
    expect(prep.system).not.toContain('Has a cat');
    expect(prep.system).toContain('- make-flashcards:');
    const names = prep.tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(['load_skill', 'read_skill_resource', 'remember', 'search_notes']));
    expect(names).not.toContain('create_note'); // read-only run
    await s.close();
  });
});
