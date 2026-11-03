import { describe, expect, it } from 'vitest';
import {
  CallbackProvider,
  ToolSyntaxStream,
  normalizeToolName,
  parseToolCalls,
  readRelaxedValue,
  repairArguments,
  runAgent,
  stripToolSyntax,
  withPromptTools,
  type AgentTool,
  type ChatRequest,
  type StreamEvent,
  type ToolDef,
} from '../src/index.ts';

const TOOLS: ToolDef[] = [
  { name: 'search_notes', description: 'Search notes', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } },
  { name: 'create_note', description: 'Create a note', parameters: { type: 'object', properties: { title: { type: 'string' }, text: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } }, required: ['title', 'text'] } },
  { name: 'append_to_note', description: 'Append', parameters: { type: 'object', properties: { note_id: { type: 'string' }, text: { type: 'string' } }, required: ['note_id', 'text'] } },
];

const one = (text: string) => {
  const r = parseToolCalls(text, TOOLS);
  expect(r.toolCalls).toHaveLength(1);
  return r;
};

/**
 * Each case is what a model actually wrote. The first is verbatim from the founder's Razr Fold
 * (Gemma 4 E2B through LiteRT-LM, Nov 2026); the others from the model cards' chat templates and
 * from our own eval runs (docs/LOCAL_AI.md › Real-model evals).
 */
describe('tool-call dialects from real transcripts', () => {
  it('Gemma 4 on the phone: invented tool_ prefix, argument wrapped twice, plain quotes', () => {
    const r = one('<|tool_call>call:tool_search_notes{query:{"query": "car budget"}}<tool_call|>');
    expect(r.toolCalls[0]).toMatchObject({ name: 'search_notes', arguments: { query: 'car budget' } });
    expect(r.text).toBe('');
    expect(r.dialects).toEqual(['gemma']);
  });

  it('Gemma 4 canonical: <|"|> string delimiters, numbers, arrays, two calls', () => {
    const r = parseToolCalls(
      'Let me look.<|tool_call>call:search_notes{query:<|"|>budget, car<|"|>,limit:3}<tool_call|><|tool_call>call:create_note{title:<|"|>Car<|"|>,text:<|"|>Budget: 4000$<|"|>,tags:[<|"|>money<|"|>,<|"|>car<|"|>]}<tool_call|>',
      TOOLS,
    );
    expect(r.toolCalls.map((c) => [c.name, c.arguments])).toEqual([
      ['search_notes', { query: 'budget, car', limit: 3 }],
      ['create_note', { title: 'Car', text: 'Budget: 4000$', tags: ['money', 'car'] }],
    ]);
    expect(r.text).toBe('Let me look.');
  });

  it('Gemma 4 cut off before its closing token', () => {
    expect(one('<|tool_call>call:search_notes{query:<|"|>car<|"|>}').toolCalls[0]!.arguments).toEqual({ query: 'car' });
  });

  it('FunctionGemma markers', () => {
    expect(one('<start_function_call>call:create_note{title:<|"|>Groceries<|"|>,text:<|"|>- [ ] milk<|"|>}<end_function_call>').toolCalls[0]).toMatchObject({ name: 'create_note', arguments: { title: 'Groceries', text: '- [ ] milk' } });
  });

  it('Qwen3 / Hermes: <tool_call>{json}</tool_call>, with thinking already removed', () => {
    const r = one('I will search your notes.\n<tool_call>\n{"name": "search_notes", "arguments": {"query": "car budget"}}\n</tool_call>');
    expect(r.toolCalls[0]).toMatchObject({ name: 'search_notes', arguments: { query: 'car budget' } });
    expect(r.text).toBe('I will search your notes.');
    expect(r.dialects).toEqual(['hermes']);
  });

  it('Qwen3 0.6B: Hermes block left open at the end, "5" for an integer', () => {
    expect(one('<tool_call>{"name": "search_notes", "arguments": {"query": "car", "limit": "5"}}').toolCalls[0]!.arguments).toEqual({ query: 'car', limit: 5 });
  });

  it('Llama 3.1 python_tag and <function=…>', () => {
    expect(one('<|python_tag|>{"name": "search_notes", "parameters": {"query": "car"}}<|eom_id|>').toolCalls[0]).toMatchObject({ name: 'search_notes', arguments: { query: 'car' } });
    expect(one('<function=search_notes>{"query": "car"}</function>').toolCalls[0]).toMatchObject({ name: 'search_notes', arguments: { query: 'car' } });
  });

  it('Mistral [TOOL_CALLS], both generations', () => {
    expect(one('[TOOL_CALLS][{"name": "search_notes", "arguments": {"query": "car"}}]').toolCalls[0]!.name).toBe('search_notes');
    expect(one('[TOOL_CALLS]search_notes[ARGS]{"query": "car"}').toolCalls[0]!.arguments).toEqual({ query: 'car' });
  });

  it('bare and fenced JSON naming a known tool, OpenAI-style wrapper', () => {
    expect(one('{"name": "search_notes", "arguments": {"query": "car"}}').dialects).toEqual(['json']);
    expect(one('```json\n{"tool_call": {"name": "functions.search_notes", "arguments": "{\\"query\\": \\"car\\"}"}}\n```').toolCalls[0]!.arguments).toEqual({ query: 'car' });
  });

  it('Llama 3.2 / Gemma 3 pythonic calls', () => {
    expect(one('[search_notes(query="car budget", limit=2)]').toolCalls[0]!.arguments).toEqual({ query: 'car budget', limit: 2 });
    expect(one("```tool_code\ncreate_note(title='Car', text='4000$')\n```").toolCalls[0]!.arguments).toEqual({ title: 'Car', text: '4000$' });
  });

  it('leaves answers that merely contain JSON or code alone', () => {
    const answer = 'Your budget is:\n```json\n{"car": 4000}\n```';
    expect(parseToolCalls(answer, TOOLS)).toMatchObject({ toolCalls: [], text: answer });
    expect(parseToolCalls('{"name": "Ana", "arguments": 3}', TOOLS).toolCalls).toEqual([]);
    expect(parseToolCalls('Call search_notes(query) to find it.', TOOLS).toolCalls).toEqual([]);
  });

  it('reports markers it cannot read as malformed, without showing them', () => {
    const r = parseToolCalls('Sure. <tool_call>search notes for car</tool_call>', TOOLS);
    expect(r.toolCalls).toEqual([]);
    expect(r.malformed).toHaveLength(1);
    expect(r.text).toBe('Sure.');
  });
});

describe('names, arguments and display', () => {
  it('maps invented names onto real tools and rejects strangers in free text', () => {
    expect(normalizeToolName('tool_search_notes', TOOLS)).toBe('search_notes');
    expect(normalizeToolName('default_api.create_note', TOOLS)).toBe('create_note');
    expect(normalizeToolName('Search-Notes', TOOLS)).toBe('search_notes');
    expect(normalizeToolName('delete_everything', TOOLS)).toBeNull();
  });

  it('repairs shapes against the schema', () => {
    const schema = TOOLS[0]!.parameters;
    expect(repairArguments({ arguments: { query: 'x' } }, schema).args).toEqual({ query: 'x' });
    expect(repairArguments({ query: ['car', 'budget'] }, schema).args).toEqual({ query: 'car, budget' });
    expect(repairArguments({ q: 'car' }, schema).args).toEqual({ query: 'car' });
    expect(repairArguments({}, schema).errors.length).toBeGreaterThan(0);
  });

  it('reads relaxed values', () => {
    expect(readRelaxedValue("{a:'x', b:True, c:None, d:[1, 2.5], e:<|\"|>q<|\"|>}")!.value).toEqual({ a: 'x', b: true, c: null, d: [1, 2.5], e: 'q' });
  });

  it('strips stray control tokens from prose', () => {
    expect(stripToolSyntax('The budget is 4000$.<end_of_turn><tool_call|>')).toBe('The budget is 4000$.<end_of_turn>');
    expect(stripToolSyntax('Done<|im_end|>')).toBe('Done');
  });
});

describe('streaming never shows tool syntax', () => {
  const feed = (chunks: string[]) => {
    let shown = '';
    const s = new ToolSyntaxStream((d) => (shown += d), TOOLS);
    for (const c of chunks) s.push(c);
    const parsed = parseToolCalls(chunks.join(''), TOOLS);
    if (!parsed.toolCalls.length) s.finish(parsed.text);
    return { shown, parsed };
  };

  it('hides a Gemma call split across deltas', () => {
    const { shown } = feed(['Let me check. <|', 'tool_', 'call>call:search_notes{query:', '<|"|>car<|"|>}<tool_call|>']);
    expect(shown).toBe('Let me check. ');
  });

  it('holds a reply that starts with JSON until it knows', () => {
    expect(feed(['{"name": "search_', 'notes", "arguments": {"query": "car"}}']).shown).toBe('');
    expect(feed(['{"car": ', '4000} is what I found']).shown).toBe('{"car": 4000} is what I found');
  });

  it('shows ordinary code fences once closed', () => {
    expect(feed(['Here:\n```', 'js\nlet a = 1\n', '```\nDone.']).shown).toBe('Here:\n```js\nlet a = 1\n```\nDone.');
  });

  it('streams plain prose as it comes', () => {
    const out: string[] = [];
    const s = new ToolSyntaxStream((d) => out.push(d), TOOLS);
    s.push('The budget ');
    s.push('is 4000$.');
    expect(out.join('')).toBe('The budget is 4000$.');
  });
});

describe('withPromptTools end to end', () => {
  const tool = (name: string, run: (a: any) => unknown): AgentTool => ({ ...TOOLS.find((t) => t.name === name)!, execute: async (a) => run(a) });

  it('runs a Gemma-style call from a text model and never streams it', async () => {
    const turns = ['<|tool_call>call:tool_search_notes{query:{"query": "car budget"}}<tool_call|>', 'Your car budget is 4000$ [Budget].'];
    let i = 0;
    const provider = withPromptTools(new CallbackProvider({ handler: async (_r, emit) => { const t = turns[i++]!; for (const ch of t.match(/.{1,7}/gs)!) emit({ type: 'text', delta: ch }); return t; } }));
    let streamed = '';
    const searched: string[] = [];
    const res = await runAgent({ provider, model: 'm', messages: [{ role: 'user', content: 'I had written a budget, what is it for car' }], tools: [tool('search_notes', (a) => { searched.push(a.query); return [{ title: 'Budget', snippet: 'Car 4000$' }]; })], onEvent: (e) => { if (e.type === 'text') streamed += e.delta; } });
    expect(searched).toEqual(['car budget']);
    expect(res.text).toBe('Your car budget is 4000$ [Budget].');
    expect(streamed).not.toMatch(/tool_call|call:/);
  });

  it('gives a malformed call one repair retry', async () => {
    const seen: ChatRequest[] = [];
    const turns = ['<tool_call>search for car</tool_call>', '<tool_call>{"name": "search_notes", "arguments": {"query": "car"}}</tool_call>'];
    const provider = withPromptTools(new CallbackProvider({ handler: async (r) => { seen.push(r); return turns[seen.length - 1]!; } }));
    const events: StreamEvent[] = [];
    const r = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'find car' }], tools: TOOLS }, (e) => events.push(e));
    expect(r.toolCalls[0]).toMatchObject({ name: 'search_notes', arguments: { query: 'car' } });
    expect(String(seen[1]!.messages.at(-1)!.content)).toMatch(/could not be read/);
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('');
  });

  it('ends as prose when the retry fails too', async () => {
    const provider = withPromptTools(new CallbackProvider({ handler: async () => 'Okay. <tool_call>???</tool_call>' }));
    const r = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
    expect(r).toMatchObject({ text: 'Okay.', toolCalls: [] });
  });

  it('strips tool syntax even when no tools were offered', async () => {
    const provider = withPromptTools(new CallbackProvider({ handler: async () => '<|tool_call>call:search_notes{query:<|"|>x<|"|>}<tool_call|>I can’t search right now.' }));
    const r = await provider.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(r).toMatchObject({ text: 'I can’t search right now.', toolCalls: [] });
  });
});
