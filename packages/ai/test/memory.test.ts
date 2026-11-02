import { describe, expect, it } from 'vitest';
import { MemoryFS } from '@inkwright/core';
import { MEMORY_PATH, MemoryStore, createRememberTool, createScriptedProvider, memoryPromptSection, runAgent } from '../src/index.ts';

describe('assistant memory', () => {
  it('stores user instructions and facts in the vault', async () => {
    const fs = new MemoryFS();
    const m = new MemoryStore(fs);
    await m.add('instruction', '  Always answer in bullet points. ');
    await m.add('fact', "I'm studying EE at TU Delft");
    const items = await new MemoryStore(fs).load();
    expect(items.map((i) => [i.kind, i.status, i.text])).toEqual([
      ['instruction', 'active', 'Always answer in bullet points.'],
      ['fact', 'active', "I'm studying EE at TU Delft"],
    ]);
    expect(JSON.parse((await fs.readText(MEMORY_PATH))!).version).toBe(1);
    await expect(m.add('fact', '   ')).rejects.toThrow();
  });

  it('remember only proposes; nothing reaches the prompt until accepted', async () => {
    const m = new MemoryStore(new MemoryFS());
    const proposed: string[] = [];
    const provider = createScriptedProvider([{ toolCalls: [{ name: 'remember', arguments: { text: 'Prefers metric units', kind: 'instruction', reason: 'said so' } }] }, { text: 'I proposed remembering that.' }]);
    const res = await runAgent({ provider, model: 'm', messages: [{ role: 'user', content: 'I always want metric' }], tools: [createRememberTool(m, (i) => proposed.push(i.text))] });
    expect(res.toolRuns[0]!.ok).toBe(true);
    expect(proposed).toEqual(['Prefers metric units']);
    let items = await m.load();
    expect(items[0]!.status).toBe('proposed');
    expect(memoryPromptSection(items)).toBe('');
    await m.accept(items[0]!.id);
    items = await m.load();
    expect(memoryPromptSection(items)).toContain('- Prefers metric units');
  });

  it('dedupes proposals and lets the user edit or dismiss them', async () => {
    const m = new MemoryStore(new MemoryFS());
    const a = await m.propose('Studies EE at TU Delft');
    const b = await m.propose('studies ee at tu delft!');
    expect(b.duplicate).toBe(true);
    expect(b.item.id).toBe(a.item.id);
    await m.accept(a.item.id, 'Studies electrical engineering at TU Delft');
    expect((await m.load())[0]!.text).toBe('Studies electrical engineering at TU Delft');
    const c = await m.propose('Has a cat');
    await m.remove(c.item.id);
    expect((await m.load()).map((i) => i.text)).toEqual(['Studies electrical engineering at TU Delft']);
    await m.update(a.item.id, { kind: 'instruction', text: 'Use EE examples' });
    expect((await m.load())[0]).toMatchObject({ kind: 'instruction', text: 'Use EE examples' });
  });

  it('puts instructions before facts and bounds the prompt', async () => {
    const m = new MemoryStore(new MemoryFS());
    await m.add('fact', 'Lives in McKinney');
    await m.add('instruction', 'Be brief');
    const s = memoryPromptSection(await m.load());
    expect(s.indexOf('Be brief')).toBeLessThan(s.indexOf('McKinney'));
    for (let i = 0; i < 30; i++) await m.add('fact', `Fact number ${i} ${'x'.repeat(200)}`);
    expect(memoryPromptSection(await m.load()).length).toBeLessThan(4100);
  });

  it('concurrent proposals are all kept', async () => {
    const m = new MemoryStore(new MemoryFS());
    await Promise.all(['a one', 'b two', 'c three', 'd four'].map((t) => m.propose(t)));
    expect((await m.load()).length).toBe(4);
  });
});
