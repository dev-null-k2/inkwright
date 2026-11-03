import { describe, expect, it } from 'vitest';
import {
  CallbackProvider,
  buildGrounding,
  compactTools,
  condenseHistory,
  contextBudget,
  extractiveAnswer,
  groundedUserMessage,
  isActionRequest,
  isDeflection,
  relevantMemory,
  runGroundedTurn,
  withPromptTools,
  type AgentTool,
  type ChatRequest,
  type MemoryHit,
  type MemoryItem,
} from '../src/index.ts';

const budgetNote = { id: 'n1', title: 'Budget', currentPage: 1, pages: [{ page: 1, text: 'Budget\nCar 4000$' }] };
const hit = (title: string, text: string, noteId = 'n2', pageIndex = 0): MemoryHit => ({ noteId, title, pageIndex, source: 'handwriting', text, score: 1 });
const mem = (kind: MemoryItem['kind'], text: string): MemoryItem => ({ id: text, kind, text, status: 'active', source: 'user', createdAt: 0, updatedAt: 0 });

describe('buildGrounding', () => {
  it('numbers the selection, the page on screen, then other notes, and skips repeats', () => {
    const g = buildGrounding({
      question: 'What is the budget here?',
      openNote: budgetNote,
      selection: { page: 1, text: 'Car 4000$' },
      hits: [hit('Budget', 'Budget\nCar 4000$', 'n1'), hit('Trip', 'Hotel 300$')],
    });
    expect(g.sources.map((s) => [s.n, s.kind])).toEqual([[1, 'selection'], [2, 'page'], [3, 'search']]);
    expect(g.context).toContain('[2] "Budget", page 1 (the page you are on):\nBudget\nCar 4000$');
    expect(g.hasContent).toBe(true);
  });

  it('marks unread ink so the reply can say so instead of guessing', () => {
    const g = buildGrounding({ question: 'What does it say?', openNote: { ...budgetNote, pages: [{ page: 1, text: '', unreadInk: true }] } });
    expect(g).toMatchObject({ hasContent: false, unreadInk: true });
    expect(groundedUserMessage('What does it say?', g)).toMatch(/could not be read/);
  });

  it('keeps within the character budget', () => {
    const long = 'word '.repeat(5000);
    const g = buildGrounding({ question: 'x', openNote: { ...budgetNote, pages: [{ page: 1, text: long }] }, hits: [hit('A', long), hit('B', long)], budgetChars: 3000 });
    expect(g.context.length).toBeLessThan(3400);
  });

  it('picks memory: instructions always, facts that share a word with the question', () => {
    const items = [mem('instruction', 'Answer in British English.'), mem('fact', 'The user\'s sister is called Mira.'), mem('fact', 'The user drives a hybrid.')];
    expect(relevantMemory(items, 'What is my sister called?').map((i) => i.text)).toEqual(['Answer in British English.', 'The user\'s sister is called Mira.']);
    expect(buildGrounding({ question: 'sister?', memory: items }).memory).toMatch(/Mira/);
  });

  it('sizes the budget to the context window', () => {
    expect(contextBudget(4096)).toBeGreaterThan(4000);
    expect(contextBudget(4096)).toBeLessThan(contextBudget(8192));
  });
});

describe('helpers', () => {
  it('tells actions from questions', () => {
    for (const q of ['Make a new note called Groceries with milk and eggs', 'Add a to-do to this note: call the hotel', 'create a checklist for packing', 'Remind me to pay rent', 'Save this as a note']) expect(isActionRequest(q), q).toBe(true);
    for (const q of ['What\'s the budget here?', 'add up these numbers', 'How much', 'Explain this', 'I had written a budget, what is it for car']) expect(isActionRequest(q), q).toBe(false);
  });

  it('recognizes dodges', () => {
    expect(isDeflection('Please provide more context so I can help.')).toBe(true);
    expect(isDeflection('')).toBe(true);
    expect(isDeflection('Your car budget is 4000$ [1].')).toBe(false);
  });

  it('quotes the best-matching line when the model gives nothing usable', () => {
    const g = buildGrounding({ question: 'What is the budget for the car?', openNote: budgetNote });
    expect(extractiveAnswer("What is the budget for the car?", g)).toBe("Here is what your notes say: “Budget Car 4000$” [1]");
  });

  it('keeps only plain recent turns of history', () => {
    const h = condenseHistory([
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c', name: 'search_notes', arguments: {} }] },
      { role: 'tool', toolCallId: 'c', content: '[...]' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
      { role: 'assistant', content: 'a2' },
    ], { maxTurns: 3 });
    expect(h).toEqual([{ role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' }]);
  });

  it('offers a few short tools sized to the model', () => {
    const t = (name: string): AgentTool => ({ name, description: `Does ${name}. Long explanation follows here.`, parameters: { type: 'object', properties: { q: { type: 'string', description: 'x'.repeat(200) } } }, execute: async () => null });
    const all = ['list_notes', 'search_notes', 'search_memory', 'read_note', 'create_note', 'append_to_note', 'trash_note', 'remember'].map(t);
    const small = compactTools(all, 4096);
    expect(small.map((x) => x.name)).toEqual(['create_note', 'append_to_note', 'search_memory']);
    expect(small[0]!.description).toBe('Does create_note.');
    expect(((small[0]!.parameters.properties as any).q.description as string).length).toBeLessThanOrEqual(80);
    expect(typeof small[0]!.execute).toBe('function');
    expect(compactTools(all, 8192)).toHaveLength(5);
  });
});

describe('runGroundedTurn', () => {
  const scripted = (turns: string[], seen: ChatRequest[] = []) => withPromptTools(new CallbackProvider({ handler: async (r) => { seen.push(r); return turns[Math.min(seen.length - 1, turns.length - 1)]!; } }));

  it('answers from the page in one turn, with the context in the user message', async () => {
    const seen: ChatRequest[] = [];
    const g = buildGrounding({ question: 'What\'s the budget here?', openNote: budgetNote });
    const r = await runGroundedTurn({ provider: scripted(['Your car budget is 4000$ [1].'], seen), model: 'm', question: 'What\'s the budget here?', history: [], grounding: g, contextTokens: 4096 });
    expect(r).toMatchObject({ text: 'Your car budget is 4000$ [1].', by: 'model' });
    expect(String(seen[0]!.messages.at(-1)!.content)).toMatch(/Car 4000\$[\s\S]*Question: What's the budget here\?/);
    expect(r.remember).toEqual([{ role: 'user', content: 'What\'s the budget here?' }, { role: 'assistant', content: 'Your car budget is 4000$ [1].' }]);
  });

  it('nudges once after a dodge, then quotes the notes', async () => {
    const g = buildGrounding({ question: 'How much for the car?', openNote: budgetNote });
    const nudged = await runGroundedTurn({ provider: scripted(['Please provide more context.', 'The car budget is 4000$ [1].']), model: 'm', question: 'How much for the car?', history: [], grounding: g, contextTokens: 4096 });
    expect(nudged).toMatchObject({ by: 'retry', text: 'The car budget is 4000$ [1].' });
    const quoted = await runGroundedTurn({ provider: scripted(['Could you clarify?']), model: 'm', question: 'How much for the car?', history: [], grounding: g, contextTokens: 4096 });
    expect(quoted).toMatchObject({ by: 'extractive', text: 'Here is what your notes say: “Car 4000$” [1]' });
  });

  it('says plainly when nothing was found', async () => {
    const g = buildGrounding({ question: 'dentist?' });
    const r = await runGroundedTurn({ provider: scripted(['']), model: 'm', question: 'dentist?', history: [], grounding: g, contextTokens: 4096 });
    expect(r).toMatchObject({ by: 'nothing-found' });
    expect(r.text).toMatch(/couldn’t find that in your notes/);
  });

  it('passes earlier turns for follow-ups', async () => {
    const seen: ChatRequest[] = [];
    const g = buildGrounding({ question: 'And half of that?', openNote: budgetNote });
    await runGroundedTurn({ provider: scripted(['2000$ [1].'], seen), model: 'm', question: 'And half of that?', history: [{ role: 'user', content: 'What\'s the budget?' }, { role: 'assistant', content: '4000$ [1].' }], grounding: g, contextTokens: 4096 });
    expect(seen[0]!.messages.filter((m) => m.role !== 'system').map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });

  it('requires a tool call for actions and runs it (Gemma syntax included)', async () => {
    const seen: ChatRequest[] = [];
    const created: unknown[] = [];
    const create: AgentTool = { name: 'create_note', description: 'Create a note.', parameters: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' } }, required: ['title', 'text'] }, execute: async (a) => { created.push(a); return { id: 'n9' }; } };
    const g = buildGrounding({ question: 'Make a new note called Groceries with milk and eggs' });
    const r = await runGroundedTurn({
      provider: scripted(['<|tool_call>call:create_note{title:<|"|>Groceries<|"|>,text:<|"|>- milk\n- eggs<|"|>}<tool_call|>', 'Created the note Groceries.'], seen),
      model: 'm', question: 'Make a new note called Groceries with milk and eggs', history: [], grounding: g, tools: [create], contextTokens: 4096,
    });
    expect(created).toEqual([{ title: 'Groceries', text: '- milk\n- eggs' }]);
    expect(r.text).toBe('Created the note Groceries.');
    expect(String(seen[0]!.messages[0]!.content)).toMatch(/You must call at least one tool now/);
  });
});

describe('compact tool schemas', () => {
  it('leave out optional ids small models invent, and drop them if sent anyway', async () => {
    const got: unknown[] = [];
    const create: AgentTool = {
      name: 'create_note', description: 'Create a note.',
      parameters: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, notebook_id: { type: 'string' } }, required: ['title', 'text'], additionalProperties: false },
      execute: async (a) => { got.push(a); return 'ok'; },
    };
    const [slim] = compactTools([create], 4096);
    expect(Object.keys((slim!.parameters as any).properties)).toEqual(['title', 'text']);
    await slim!.execute({ title: 'Groceries', text: 'milk', notebook_id: 'groceries_notebook' }, { toolCallId: 'c', messages: [] });
    expect(got).toEqual([{ title: 'Groceries', text: 'milk' }]);
  });
});
