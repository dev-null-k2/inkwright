import { describe, expect, it } from 'vitest';
import { AnthropicProvider, createProvider, toAnthropicMessages, type StreamEvent, type ToolDef } from '../src/index.ts';
import { PNG_1PX, jsonResponse, mockFetch, sse, streamResponse } from './helpers.ts';

const TOOLS: ToolDef[] = [{ name: 'search_notes', description: 'Search notes', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer' } }, required: ['query'] } }];

/** Recorded-style Messages API stream with a text block and a tool_use block. */
const STREAM = sse([
  { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-sonnet-5-5', stop_reason: null, usage: { input_tokens: 200, cache_read_input_tokens: 50, output_tokens: 1 } } } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { event: 'ping', data: { type: 'ping' } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Searching ' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'your notes.' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'search_notes', input: {} } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"query": "lau' } } },
  { event: 'content_block_delta', data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'nch", "limit": 5}' } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
  { event: 'content_block_start', data: { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_02', name: 'search_notes', input: {} } } },
  { event: 'content_block_stop', data: { type: 'content_block_stop', index: 2 } },
  { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 42 } } },
  { event: 'message_stop', data: { type: 'message_stop' } },
]);

const make = (fetch: ReturnType<typeof mockFetch>) => new AnthropicProvider({ apiKey: 'sk-ant', fetch, retryBaseMs: 1 });

describe('Anthropic provider', () => {
  it('streams text and tool_use with input_json_delta', async () => {
    const fetch = mockFetch(() => streamResponse(STREAM, { chunkSize: 11 }));
    const events: StreamEvent[] = [];
    const r = await make(fetch).chat({ model: 'claude-sonnet-5-5', messages: [{ role: 'user', content: 'launch?' }], tools: TOOLS }, (e) => events.push(e));
    expect(r.text).toBe('Searching your notes.');
    expect(r.toolCalls).toEqual([
      { id: 'toolu_01', name: 'search_notes', arguments: { query: 'launch', limit: 5 } },
      { id: 'toolu_02', name: 'search_notes', arguments: {} },
    ]);
    expect(r.stopReason).toBe('tool_calls');
    expect(r.usage).toEqual({ inputTokens: 250, outputTokens: 42 });
    expect(events.map((e) => e.type)).toEqual(['text', 'text', 'tool_call', 'tool_call', 'done']);
  });

  it('sends Messages API headers and body', async () => {
    const fetch = mockFetch(() => streamResponse(STREAM));
    await make(fetch).chat(
      {
        model: 'claude-haiku-5-5',
        messages: [
          { role: 'system', content: 'You are helpful.' },
          { role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'image', mediaType: 'image/png', data: PNG_1PX }] },
        ],
        tools: TOOLS,
        toolChoice: 'required',
        temperature: 0,
      },
      () => {},
    );
    const req = fetch.calls[0]!;
    expect(req.url).toBe('https://api.anthropic.com/v1/messages');
    expect(req.headers).toMatchObject({
      'x-api-key': 'sk-ant',
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    });
    expect(req.headers.authorization).toBeUndefined();
    expect(req.body).toEqual({
      model: 'claude-haiku-5-5',
      max_tokens: 4096,
      stream: true,
      system: 'You are helpful.',
      temperature: 0,
      tool_choice: { type: 'any' },
      tools: [{ name: 'search_notes', description: 'Search notes', input_schema: TOOLS[0]!.parameters }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read this' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_1PX } }] }],
    });
  });

  it('merges tool results into one user turn with tool_result blocks', () => {
    const { system, messages } = toAnthropicMessages([
      { role: 'system', content: 'S1' },
      { role: 'system', content: 'S2' },
      { role: 'user', content: 'Find and show' },
      { role: 'assistant', content: 'On it.', toolCalls: [{ id: 't1', name: 'search_notes', arguments: { query: 'x' } }, { id: 't2', name: 'get_page_image', arguments: {} }] },
      { role: 'tool', toolCallId: 't1', content: '{"count":0}' },
      { role: 'tool', toolCallId: 't2', content: [{ type: 'text', text: 'Page 0' }, { type: 'image', mediaType: 'image/jpeg', data: 'abc' }] },
      { role: 'user', content: 'thanks' },
      { role: 'assistant', content: '' },
    ]);
    expect(system).toBe('S1\n\nS2');
    expect(messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'Find and show' }] },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', id: 't1', name: 'search_notes', input: { query: 'x' } },
          { type: 'tool_use', id: 't2', name: 'get_page_image', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '{"count":0}' }] },
          { type: 'tool_result', tool_use_id: 't2', content: [{ type: 'text', text: 'Page 0' }, { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'abc' } }] },
          { type: 'text', text: 'thanks' },
        ],
      },
    ]);
  });

  it('marks error tool results and starts with a user turn', () => {
    const { messages } = toAnthropicMessages([
      { role: 'assistant', content: 'Hi', toolCalls: [{ id: 't', name: 'x', arguments: {} }] },
      { role: 'tool', toolCallId: 't', content: 'Error: nope', isError: true },
    ]);
    expect(messages[0]).toEqual({ role: 'user', content: [{ type: 'text', text: '(continue)' }] });
    expect(messages[2]!.content[0]).toEqual({ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: 'Error: nope' }], is_error: true });
  });

  it('parses a non-streaming response', async () => {
    const fetch = mockFetch(() =>
      jsonResponse({
        id: 'msg',
        type: 'message',
        content: [{ type: 'text', text: 'Hello' }, { type: 'tool_use', id: 'toolu_9', name: 'search_notes', input: { query: 'q' } }],
        stop_reason: 'tool_use',
        usage: { input_tokens: 10, output_tokens: 3 },
      }),
    );
    const r = await make(fetch).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], maxTokens: 99 });
    expect(fetch.calls[0]!.body.max_tokens).toBe(99);
    expect(fetch.calls[0]!.body.stream).toBeUndefined();
    expect(r).toMatchObject({ text: 'Hello', stopReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 3 }, toolCalls: [{ id: 'toolu_9', arguments: { query: 'q' } }] });
  });

  it('adds a JSON instruction (no native JSON mode)', async () => {
    const fetch = mockFetch(() => jsonResponse({ content: [{ type: 'text', text: '{}' }], stop_reason: 'end_turn' }));
    await make(fetch).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], json: true });
    expect(fetch.calls[0]!.body.system).toMatch(/only valid JSON/);
  });

  it('maps an error event mid-stream to an overloaded AIError', async () => {
    const body = sse([
      { event: 'message_start', data: { type: 'message_start', message: { usage: { input_tokens: 1, output_tokens: 0 } } } },
      { event: 'error', data: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } },
    ]);
    await expect(make(mockFetch(() => streamResponse(body))).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, () => {})).rejects.toMatchObject({
      code: 'server',
      status: 529,
      retryable: true,
      message: expect.stringMatching(/overloaded/i),
    });
  });

  it('lists models with pagination', async () => {
    const fetch = mockFetch([
      jsonResponse({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }], has_more: true, last_id: 'claude-opus-5-5' }),
      jsonResponse({ data: [{ id: 'claude-haiku-5-5', display_name: 'Claude Haiku 5.5' }], has_more: false }),
    ]);
    const models = await make(fetch).listModels();
    expect(models.map((m) => m.id)).toEqual(['claude-opus-5-5', 'claude-haiku-5-5']);
    expect(fetch.calls[1]!.url).toBe('https://api.anthropic.com/v1/models?limit=1000&after_id=claude-opus-5-5');
    expect(fetch.calls[0]!.headers['anthropic-version']).toBe('2023-06-01');
  });

  it('createProvider accepts a base URL with /v1', async () => {
    const fetch = mockFetch(() => jsonResponse({ content: [], stop_reason: 'end_turn' }));
    await createProvider({ providerId: 'anthropic', apiKey: 'k', baseUrl: 'https://proxy.example.com/v1', fetch }).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] });
    expect(fetch.calls[0]!.url).toBe('https://proxy.example.com/v1/messages');
  });
});
