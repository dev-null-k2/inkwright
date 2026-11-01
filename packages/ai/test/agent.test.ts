import { describe, expect, it } from 'vitest';
import {
  AIError,
  askOnce,
  createProvider,
  createScriptedProvider,
  richResult,
  runAgent,
  type AgentEvent,
  type AgentTool,
  type ChatMessage,
} from '../src/index.ts';
import { PNG_1PX, deferred, jsonResponse, mockFetch, sse, streamResponse } from './helpers.ts';

const user = (content: string): ChatMessage[] => [{ role: 'user', content }];

function tool(name: string, execute: AgentTool['execute'], extra: Partial<AgentTool> = {}): AgentTool {
  return {
    name,
    description: `${name} tool`,
    parameters: { type: 'object', properties: { query: { type: 'string' }, n: { type: 'integer' } }, required: [] },
    execute,
    ...extra,
  };
}

describe('runAgent', () => {
  it('runs a multi-step loop, feeding tool results back until a final answer', async () => {
    const provider = createScriptedProvider([
      { text: 'Searching.', toolCalls: [{ name: 'search', arguments: { query: 'launch' } }] },
      (ctx) => ({ toolCalls: [{ name: 'read', arguments: { query: (ctx.toolResults[0]!.value as { id: string }).id } }] }),
      (ctx) => ({ text: `The launch is on ${(ctx.toolResults[0]!.value as { date: string }).date}.` }),
    ]);
    const search = tool('search', async (a) => ({ id: `note-for-${a.query}` }));
    const read = tool('read', async (a) => ({ date: a.query === 'note-for-launch' ? 'March 3' : '?' }));
    const events: AgentEvent[] = [];
    const r = await runAgent({ provider, model: 'fake', system: 'You help.', messages: user('When is the launch?'), tools: [search, read], onEvent: (e) => events.push(e) });

    expect(r.text).toBe('The launch is on March 3.');
    expect(r.steps).toBe(3);
    expect(r.stopReason).toBe('done');
    expect(r.toolRuns.map((t) => [t.call.name, t.ok, t.step])).toEqual([
      ['search', true, 1],
      ['read', true, 2],
    ]);
    expect(r.usage.inputTokens).toBe(30);
    // Transcript: system, user, assistant(tool), tool, assistant(tool), tool, assistant(final)
    expect(r.messages.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant']);
    expect(r.newMessages).toHaveLength(5);
    expect(r.messages[3]).toMatchObject({ role: 'tool', name: 'search', toolCallId: r.messages[2]!.toolCalls![0]!.id, content: [{ type: 'text', text: '{"id":"note-for-launch"}' }] });
    // Tools were offered to the model on every step.
    expect(provider.requests.every((q) => q.tools?.map((t) => t.name).join() === 'search,read')).toBe(true);
    expect(provider.requests[0]!.messages[0]).toEqual({ role: 'system', content: 'You help.' });

    const types = events.map((e) => e.type);
    expect(types.slice(0, 5)).toEqual(['step_start', 'text', 'step_end', 'tool_start', 'tool_result']);
    expect(types.at(-1)).toBe('done');
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta).join('')).toBe('Searching.The launch is on March 3.');
  });

  it('executes multiple tool calls of one step in parallel, keeping result order', async () => {
    const gateA = deferred();
    const started: string[] = [];
    const slow = tool('slow', async () => {
      started.push('slow');
      await gateA.promise;
      return 'A';
    });
    const fast = tool('fast', async () => {
      started.push('fast');
      gateA.resolve(); // would deadlock if tools ran sequentially
      return 'B';
    });
    const provider = createScriptedProvider([{ toolCalls: [{ name: 'slow' }, { name: 'fast' }] }, { text: 'ok' }]);
    const r = await runAgent({ provider, model: 'm', messages: user('go'), tools: [slow, fast] });
    expect(started).toEqual(['slow', 'fast']);
    expect(r.messages.filter((m) => m.role === 'tool').map((m) => m.name)).toEqual(['slow', 'fast']);
  });

  it('returns unknown tools, invalid JSON, invalid args and thrown errors to the model', async () => {
    const provider = createScriptedProvider([
      { toolCalls: [{ name: 'nope' }, { name: 'search', arguments: { n: 'many' } }, { name: 'boom' }, { name: 'search', arguments: { n: '3' } }] },
      { text: 'Recovered.' },
    ]);
    const seen: unknown[] = [];
    const search = tool('search', async (a) => (seen.push(a), 'ok'));
    const boom = tool('boom', async () => {
      throw new Error('disk full');
    });
    const r = await runAgent({ provider, model: 'm', messages: user('x'), tools: [search, boom] });
    const results = r.messages.filter((m) => m.role === 'tool');
    expect(results.map((m) => !!m.isError)).toEqual([true, true, true, false]);
    expect(results[0]!.content).toMatch(/Unknown tool "nope"\. Available tools: search, boom/);
    expect(results[1]!.content).toMatch(/Invalid arguments for search: n must be integer/);
    expect(results[2]!.content).toBe('Error: disk full');
    expect(seen).toEqual([{ n: 3 }]); // coerced "3" → 3
    expect(r.text).toBe('Recovered.');
    expect(r.toolRuns.filter((t) => !t.ok)).toHaveLength(3);
  });

  it('reports invalid argument JSON from the model', async () => {
    const provider = createScriptedProvider([{ toolCalls: [{ name: 'search' }] }, { text: 'k' }]);
    // Simulate a provider that could not parse the arguments.
    const orig = provider.chat.bind(provider);
    let first = true;
    provider.chat = async (req, on) => {
      const r = await orig(req, on);
      if (first) {
        first = false;
        r.toolCalls[0]!.invalidArguments = '{"query": ';
      }
      return r;
    };
    const r = await runAgent({ provider, model: 'm', messages: user('x'), tools: [tool('search', async () => 'never')] });
    expect(r.messages[2]!.content).toMatch(/not valid JSON/);
  });

  describe('destructive tools', () => {
    const trash = (log: string[]) => tool('trash', async () => (log.push('trashed'), { ok: true }), { destructive: true });
    const script = () => createScriptedProvider([{ toolCalls: [{ name: 'trash', arguments: { query: 'n1' } }] }, { text: 'Done.' }]);

    it('refuses without a confirm handler', async () => {
      const log: string[] = [];
      const events: AgentEvent[] = [];
      const r = await runAgent({ provider: script(), model: 'm', messages: user('delete it'), tools: [trash(log)], onEvent: (e) => events.push(e) });
      expect(log).toEqual([]);
      expect(r.toolRuns[0]).toMatchObject({ ok: false, denied: true });
      expect(r.messages[2]!.content).toMatch(/needs the user’s confirmation/);
      expect(events.find((e) => e.type === 'tool_start')).toMatchObject({ destructive: true });
      expect(events.find((e) => e.type === 'tool_error')).toMatchObject({ denied: true });
    });

    it('does not run when the user declines', async () => {
      const log: string[] = [];
      const asked: string[] = [];
      const r = await runAgent({ provider: script(), model: 'm', messages: user('delete it'), tools: [trash(log)], confirm: (c) => (asked.push(c.name), false) });
      expect(asked).toEqual(['trash']);
      expect(log).toEqual([]);
      expect(r.messages[2]!.content).toMatch(/declined/);
    });

    it('runs when confirmed (async confirm)', async () => {
      const log: string[] = [];
      const r = await runAgent({ provider: script(), model: 'm', messages: user('delete it'), tools: [trash(log)], confirm: async () => true });
      expect(log).toEqual(['trashed']);
      expect(r.toolRuns[0]!.ok).toBe(true);
    });
  });

  it('stops at maxSteps, still answering every tool call', async () => {
    const provider = createScriptedProvider(() => ({ toolCalls: [{ name: 'search', arguments: { query: 'again' } }] }));
    let runs = 0;
    const r = await runAgent({ provider, model: 'm', messages: user('loop'), tools: [tool('search', async () => ++runs)], maxSteps: 3 });
    expect(r.stopReason).toBe('max_steps');
    expect(r.steps).toBe(3);
    expect(runs).toBe(3);
    expect(r.messages.at(-1)!.role).toBe('tool');
  });

  it('passes through length/content_filter stop reasons', async () => {
    const r = await runAgent({ provider: createScriptedProvider([{ text: 'cut', stopReason: 'length' }]), model: 'm', messages: user('x') });
    expect(r.stopReason).toBe('length');
  });

  it('aborts between steps and inside tools', async () => {
    const ctl = new AbortController();
    const provider = createScriptedProvider(() => ({ toolCalls: [{ name: 'slow' }] }));
    const slow = tool('slow', async (_a, ctx) => {
      expect(ctx.signal).toBe(ctl.signal);
      ctl.abort();
      return 'late';
    });
    await expect(runAgent({ provider, model: 'm', messages: user('x'), tools: [slow], signal: ctl.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(provider.requests).toHaveLength(1);
  });

  it('propagates provider errors', async () => {
    const fetch = mockFetch(() => jsonResponse({ error: { message: 'bad key' } }, 401));
    const provider = createProvider({ providerId: 'openai', apiKey: 'k', fetch });
    await expect(runAgent({ provider, model: 'm', messages: user('x') })).rejects.toBeInstanceOf(AIError);
  });

  it('sends rich (image) tool results', async () => {
    const provider = createScriptedProvider([{ toolCalls: [{ name: 'look' }] }, { text: 'I see it.' }]);
    const look = tool('look', async () => richResult([{ type: 'text', text: 'page' }, { type: 'image', mediaType: 'image/png', data: PNG_1PX }]));
    const r = await runAgent({ provider, model: 'm', messages: user('look'), tools: [look] });
    expect(provider.requests[1]!.messages.at(-1)).toMatchObject({ role: 'tool', content: [{ type: 'text', text: 'page' }, { type: 'image', data: PNG_1PX }] });
    expect(r.text).toBe('I see it.');
  });

  it('truncates huge tool results', async () => {
    const provider = createScriptedProvider([{ toolCalls: [{ name: 'big' }] }, { text: 'ok' }]);
    await runAgent({ provider, model: 'm', messages: user('x'), tools: [tool('big', async () => 'x'.repeat(5000))], maxToolResultChars: 100 });
    const content = provider.requests[1]!.messages.at(-1)!.content as Array<{ text: string }>;
    expect(content[0]!.text).toMatch(/^x{100}\n…\[truncated 4900 characters\]$/);
  });

  it('a throwing UI handler does not break the loop', async () => {
    const r = await runAgent({ provider: createScriptedProvider([{ text: 'hi' }]), model: 'm', messages: user('x'), onEvent: () => { throw new Error('ui'); } });
    expect(r.text).toBe('hi');
  });

  it('works end-to-end against the OpenAI wire format', async () => {
    const first = sse([
      { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"query":' } }] } }] } },
      { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"pancakes"}' } }] }, finish_reason: 'tool_calls' }] } },
      '[DONE]',
    ]);
    const second = sse([{ data: { choices: [{ index: 0, delta: { content: 'Found [Pancakes].' }, finish_reason: 'stop' }] } }, '[DONE]']);
    const fetch = mockFetch([streamResponse(first), streamResponse(second)]);
    const provider = createProvider({ providerId: 'openai', apiKey: 'k', fetch });
    const r = await runAgent({ provider, model: 'gpt-5-mini', messages: user('pancakes?'), tools: [tool('search', async (a) => ({ hits: [a.query] }))] });
    expect(r.text).toBe('Found [Pancakes].');
    const body = fetch.calls[1]!.body;
    expect(body.messages.slice(-2)).toEqual([
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"query":"pancakes"}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: '{"hits":["pancakes"]}' },
    ]);
  });
});

describe('askOnce', () => {
  it('returns the text and streams it', async () => {
    const provider = createScriptedProvider([{ text: 'Paris is the capital of France.' }], { chunk: 5 });
    const seen: string[] = [];
    const out = await askOnce(provider, 'm', 'Capital of France?', { system: 'Short answers.', onText: (_d, soFar) => seen.push(soFar), json: false });
    expect(out).toBe('Paris is the capital of France.');
    expect(seen.at(-1)).toBe(out);
    expect(seen.length).toBeGreaterThan(1);
    expect(provider.requests[0]!.messages).toEqual([
      { role: 'system', content: 'Short answers.' },
      { role: 'user', content: 'Capital of France?' },
    ]);
  });

  it('attaches images', async () => {
    const provider = createScriptedProvider([{ text: 'A dot.' }]);
    await askOnce(provider, 'm', 'What is this?', { images: [{ mediaType: 'image/png', data: PNG_1PX }], maxTokens: 10, temperature: 0 });
    expect(provider.requests[0]).toMatchObject({ maxTokens: 10, temperature: 0, messages: [{ role: 'user', content: [{ type: 'text' }, { type: 'image', mediaType: 'image/png' }] }] });
  });
});
