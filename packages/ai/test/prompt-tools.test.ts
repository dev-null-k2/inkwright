import { describe, expect, it } from 'vitest';
import {
  CallbackProvider,
  MemoryNoteToolHost,
  createClaudeSampleProvider,
  createNoteTools,
  parseToolCallText,
  renderToolTranscript,
  runAgent,
  toSampleInput,
  withPromptTools,
  type ClaudeSampleFn,
  type StreamEvent,
  type ToolDef,
} from '../src/index.ts';
import { PNG_1PX } from './helpers.ts';

const TOOLS: ToolDef[] = [{ name: 'search_notes', description: 'Search', parameters: { type: 'object', properties: { query: { type: 'string' } } } }];

describe('CallbackProvider', () => {
  it('normalizes string returns and emits text + done once', async () => {
    const p = new CallbackProvider({ handler: async () => 'hello' });
    const events: StreamEvent[] = [];
    const r = await p.chat({ model: 'x', messages: [] }, (e) => events.push(e));
    expect(r).toEqual({ text: 'hello', toolCalls: [], stopReason: 'stop' });
    expect(events.map((e) => e.type)).toEqual(['text', 'done']);
  });

  it('does not duplicate streamed text or tool calls', async () => {
    const p = new CallbackProvider({
      handler: async (_req, emit) => {
        emit({ type: 'text', delta: 'a' });
        emit({ type: 'text', delta: 'b' });
        emit({ type: 'tool_call', call: { id: 'c1', name: 't', arguments: {} } });
        return { toolCalls: [{ id: 'c1', name: 't', arguments: {} }, { id: '', name: 'u', arguments: {} }] };
      },
    });
    const events: StreamEvent[] = [];
    const r = await p.chat({ model: 'x', messages: [] }, (e) => events.push(e));
    expect(r.text).toBe('ab');
    expect(r.stopReason).toBe('tool_calls');
    expect(r.toolCalls[1]!.id).toMatch(/^cb1_/);
    expect(events.map((e) => e.type)).toEqual(['text', 'text', 'tool_call', 'tool_call', 'done']);
  });

  it('wraps handler errors and aborts', async () => {
    await expect(new CallbackProvider({ handler: () => Promise.reject(new Error('boom')) }).chat({ model: 'x', messages: [] })).rejects.toMatchObject({ code: 'unknown', message: expect.stringMatching(/boom/) });
    const ctl = new AbortController();
    ctl.abort();
    await expect(new CallbackProvider({ handler: async () => 'x' }).chat({ model: 'x', messages: [], signal: ctl.signal })).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('prompt tool protocol', () => {
  it('parses tool_call blocks, an unterminated last block and prose', () => {
    const r = parseToolCallText('I will search.\n<tool_call>{"name":"search_notes","arguments":{"query":"a"}}</tool_call>\n<tool_call>{"name": "search_notes", "arguments": "{\\"query\\": \\"b\\"}"}', TOOLS);
    expect(r.text).toBe('I will search.');
    expect(r.toolCalls.map((c) => c.arguments)).toEqual([{ query: 'a' }, { query: 'b' }]);
  });

  it('accepts a bare {"name","arguments"} object for a known tool only', () => {
    expect(parseToolCallText('{"name": "search_notes", "arguments": {"query": "x"}}', TOOLS).toolCalls).toHaveLength(1);
    expect(parseToolCallText('{"name": "other", "arguments": {}}', TOOLS).toolCalls).toHaveLength(0);
    expect(parseToolCallText('Plain answer', TOOLS)).toEqual({ text: 'Plain answer', toolCalls: [] });
  });

  it('renders tool turns as text for text-only models', () => {
    const out = renderToolTranscript([
      { role: 'user', content: 'q' },
      { role: 'assistant', content: 'Let me check.', toolCalls: [{ id: '1', name: 'search_notes', arguments: { query: 'q' } }] },
      { role: 'tool', toolCallId: '1', content: '{"count":0}' },
      { role: 'tool', toolCallId: '1', content: 'bad', isError: true },
    ]);
    expect(out[1]).toEqual({ role: 'assistant', content: 'Let me check.\n<tool_call>{"name":"search_notes","arguments":{"query":"q"}}</tool_call>' });
    // Consecutive results merge into one user turn (strictly alternating APIs).
    expect(out).toHaveLength(3);
    const parts = out[2]!.content as Array<{ text: string }>;
    expect(out[2]!.role).toBe('user');
    expect(parts[0]!.text).toBe('<tool_result name="search_notes">\n{"count":0}\n</tool_result>');
    expect(parts[2]!.text).toContain('error="true"');
  });

  it('merges a user message that follows tool results, keeping roles alternating', () => {
    const out = renderToolTranscript([
      { role: 'assistant', content: '', toolCalls: [{ id: '1', name: 't', arguments: {} }] },
      { role: 'tool', toolCallId: '1', content: 'r' },
      { role: 'user', content: 'and also?' },
    ]);
    expect(out.map((m) => m.role)).toEqual(['assistant', 'user']);
    expect((out[1]!.content as Array<{ text: string }>).map((p) => p.text).join('')).toBe('<tool_result name="t">\nr\n</tool_result>\n\nand also?');
    expect('fromTool' in out[1]!).toBe(false);
  });

  it('withPromptTools instructs the model, hides tool markup from the stream and returns calls', async () => {
    const seen: string[] = [];
    const inner = new CallbackProvider({
      capabilities: { tools: false },
      handler: async (req, emit) => {
        seen.push(req.messages.map((m) => (typeof m.content === 'string' ? m.content : '')).join('\n'));
        expect(req.tools).toBeUndefined();
        for (const piece of ['Checking', ' now.\n<tool', '_call>{"name":"search_notes",', '"arguments":{"query":"x"}}</tool_call>']) emit({ type: 'text', delta: piece });
        return { stopReason: 'stop' };
      },
    });
    const p = withPromptTools(inner);
    expect(p.capabilities.tools).toBe(true);
    const deltas: string[] = [];
    const r = await p.chat({ model: 'm', messages: [{ role: 'user', content: 'find x' }], tools: TOOLS }, (e) => (e.type === 'text' ? deltas.push(e.delta) : undefined));
    expect(deltas.join('')).toBe('Checking now.\n');
    expect(r.text).toBe('Checking now.');
    expect(r.toolCalls).toMatchObject([{ name: 'search_notes', arguments: { query: 'x' } }]);
    expect(r.stopReason).toBe('tool_calls');
    expect(seen[0]).toMatch(/# Tools[\s\S]*### search_notes/);
  });

  it('flushes held-back text that turned out not to be a tag', async () => {
    const inner = new CallbackProvider({ handler: async (_r, emit) => (emit({ type: 'text', delta: 'a <' }), emit({ type: 'text', delta: 'b' }), {}) });
    const deltas: string[] = [];
    await withPromptTools(inner).chat({ model: 'm', messages: [], tools: TOOLS }, (e) => (e.type === 'text' ? deltas.push(e.delta) : undefined));
    expect(deltas.join('')).toBe('a <b');
  });
});

describe('Claude via the claude.ai sample capability', () => {
  it('maps messages to user-first turns with instructions, tiers and images', async () => {
    const calls: Array<{ input: unknown; options: any }> = [];
    const sample: ClaudeSampleFn = async (input, options) => {
      calls.push({ input, options });
      options?.onText?.({ text: 'Hi', delta: 'Hi' });
      options?.onText?.({ text: 'Hi there', delta: ' there' });
      return { text: 'Hi there', truncated: false };
    };
    const p = createClaudeSampleProvider(sample, { images: true });
    const deltas: string[] = [];
    const r = await p.chat(
      {
        model: 'quick',
        messages: [
          { role: 'system', content: 'Be nice.' },
          { role: 'user', content: [{ type: 'text', text: 'What is this?' }, { type: 'image', mediaType: 'image/png', data: PNG_1PX }] },
        ],
      },
      (e) => (e.type === 'text' ? deltas.push(e.delta) : undefined),
    );
    expect(r.text).toBe('Hi there');
    expect(deltas).toEqual(['Hi', ' there']);
    const { input, options } = calls[0]!;
    expect(input).toEqual([
      { role: 'user', content: 'Instructions for this conversation:\nBe nice.' },
      { role: 'user', content: 'What is this?' },
    ]);
    expect(options.modelTier).toBe('quick');
    expect(options.cache).toBe(false);
    expect(options.images).toHaveLength(1);
    expect(options.images[0]).toBeInstanceOf(Blob);
    expect(options.images[0].type).toBe('image/png');
    expect(options.images[0].size).toBe(atob(PNG_1PX).length);
  });

  it('passes Claude model ids and maps sample errors', async () => {
    let opts: any;
    const sample: ClaudeSampleFn = async (_i, o) => {
      opts = o;
      throw { code: 'rate_limited', message: 'slow down' };
    };
    const p = createClaudeSampleProvider(sample);
    await expect(p.chat({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'rate_limit', retryable: true, provider: 'claude-sample' });
    expect(opts).toMatchObject({ model: 'claude-sonnet-5-5', modelTier: 'default' });
    const denied = createClaudeSampleProvider(async () => Promise.reject({ code: 'not_granted', message: '' }));
    await expect(denied.chat({ model: 'default', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'permission' });
  });

  it('toSampleInput ends on a user turn and summarizes earlier images', () => {
    const a = toSampleInput([
      { role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'a' }] },
      { role: 'assistant', content: 'It is a cat.' },
    ]);
    expect(a.turns).toEqual([
      { role: 'user', content: '(see the attached image)' },
      { role: 'assistant', content: 'It is a cat.' },
      { role: 'user', content: 'Continue.' },
    ]);
    expect(a.images).toHaveLength(1);
    const b = toSampleInput(
      [
        { role: 'user', content: [{ type: 'text', text: 'What is it?' }, { type: 'image', mediaType: 'image/png', data: 'a' }] },
        { role: 'assistant', content: 'A cat.' },
        { role: 'user', content: 'What colour?' },
      ],
      true,
    );
    expect(b.turns).toEqual([
      { role: 'user', content: expect.stringMatching(/^Instructions for this conversation:\nRespond with only valid JSON/) },
      { role: 'user', content: 'What is it?\n[1 image(s) shown earlier]' },
      { role: 'assistant', content: 'A cat.' },
      { role: 'user', content: 'What colour?' },
    ]);
    expect(b.images).toEqual([]);
  });

  it('runs the notes agent through the text tool protocol', async () => {
    const host = await MemoryNoteToolHost.create();
    await host.seed({ title: 'Beta launch plan', text: 'Launch on March 3' });
    let n = 0;
    const sample: ClaudeSampleFn = async (input) => {
      const last = Array.isArray(input) ? input.at(-1)!.content : input;
      n++;
      if (n === 1) return { text: 'Let me look.\n<tool_call>{"name":"search_notes","arguments":{"query":"launch"}}</tool_call>' };
      expect(last).toContain('<tool_result name="search_notes">');
      expect(last).toContain('Beta launch plan');
      return { text: 'Your launch is on March 3 [Beta launch plan].' };
    };
    const r = await runAgent({ provider: createClaudeSampleProvider(sample), model: 'default', messages: [{ role: 'user', content: 'When is the launch?' }], tools: createNoteTools(host) });
    expect(r.text).toBe('Your launch is on March 3 [Beta launch plan].');
    expect(r.toolRuns).toHaveLength(1);
    expect(r.toolRuns[0]!.ok).toBe(true);
  });
});
