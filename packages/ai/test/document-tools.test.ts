import { describe, expect, it } from 'vitest';
import { createDocumentTools, createScriptedProvider, runAgent, undoOp, type DocumentToolHost, type NewActivityOp, type UndoTarget } from '../src/index.ts';

/** An in-memory host: one document and one ordinary note. */
function setup(markdown = '# Report\n\n## Findings\n\nSales rose.\n\n## Next steps\n\n- [ ] Call Ada\n') {
  const docs = new Map([['D1', { title: 'Report', markdown }]]);
  const ops: NewActivityOp[] = [];
  const host: DocumentToolHost = {
    async readDocument(id) {
      const d = docs.get(id);
      return d ? { title: d.title, markdown: d.markdown, pageId: 'P1', textId: 'BODY' } : null;
    },
    async writeDocument(id, expected, next) {
      const d = docs.get(id);
      if (!d) return 'missing';
      if (d.markdown !== expected) return 'changed';
      d.markdown = next;
      return 'written';
    },
  };
  const tools = createDocumentTools(host, { record: (op) => ops.push(op) });
  const run = (name: string, args: Record<string, unknown>) => tools.find((t) => t.name === name)!.execute(args, {} as never);
  return { docs, ops, tools, run };
}

describe('document tools', () => {
  it('read_document returns the Markdown with its outline and word count', async () => {
    const { run } = setup();
    const r = (await run('read_document', { note_id: 'D1' })) as any;
    expect(r.outline).toEqual(['# Report', '## Findings', '## Next steps']);
    expect(r.words).toBe(8);
    expect(r.markdown).toContain('Sales rose.');
    await expect(run('read_document', { note_id: 'nope' })).rejects.toThrow(/not a document/);
  });

  it('edit_document changes a section precisely and records an undoable text_replaced op', async () => {
    const { run, docs, ops } = setup();
    await run('edit_document', { note_id: 'D1', operation: 'append_to_section', heading: 'Next steps', markdown: '- [ ] Book the room' });
    expect(docs.get('D1')!.markdown).toContain('- [ ] Call Ada\n\n- [ ] Book the room');
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'text_replaced', tool: 'edit_document', noteId: 'D1', pageId: 'P1', textId: 'BODY' });

    // Undo goes through the app's replaceText, which only reverts while the text is unchanged.
    let current = docs.get('D1')!.markdown;
    const target = {
      replaceText: async (_n: string, _p: string, _t: string, expected: string, next: string) => {
        if (current !== expected) return 'changed' as const;
        current = next;
        return 'replaced' as const;
      },
    } as unknown as UndoTarget;
    const res = await undoOp({ ...(ops[0] as any), id: 'op1', at: 1 }, target);
    expect(res.ok).toBe(true);
    expect(current).not.toContain('Book the room');
  });

  it('explains what to do when an edit cannot apply, and refuses a stale write', async () => {
    const { run, docs } = setup();
    await expect(run('edit_document', { note_id: 'D1', operation: 'replace_text', find: 'Profits fell', replace: 'x' })).rejects.toThrow(/not in the document/);
    await expect(run('edit_document', { note_id: 'D1', operation: 'replace_text' })).rejects.toThrow(/needs find/);
    await expect(run('edit_document', { note_id: 'D1', operation: 'replace_section', heading: 'Nope', markdown: 'x' })).rejects.toThrow(/No heading/);
    const before = docs.get('D1')!.markdown;
    expect(await run('edit_document', { note_id: 'D1', operation: 'replace_text', find: 'Sales rose.', replace: 'Sales rose.' })).toEqual({ changed: false, note_id: 'D1' });
    expect(docs.get('D1')!.markdown).toBe(before);
  });

  it('works through the agent loop with a scripted model', async () => {
    const { tools, docs } = setup();
    const provider = createScriptedProvider([
      { toolCalls: [{ name: 'read_document', arguments: { note_id: 'D1' } }] },
      { toolCalls: [{ name: 'edit_document', arguments: { note_id: 'D1', operation: 'replace_text', find: 'Sales rose.', replace: 'Sales rose by **12 %**.' } }] },
      { text: 'Updated the findings.' },
    ]);
    const r = await runAgent({ provider, model: 'm', system: 's', messages: [{ role: 'user', content: 'Say sales rose 12 %' }], tools });
    expect(r.toolRuns.every((t) => t.ok)).toBe(true);
    expect(docs.get('D1')!.markdown).toContain('Sales rose by **12 %**.');
  });
});
