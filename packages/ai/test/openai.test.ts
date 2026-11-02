import { describe, expect, it } from 'vitest';
import { AIError, OpenAICompatibleProvider, createProvider, toOpenAIMessages, type ChatMessage, type StreamEvent, type ToolDef } from '../src/index.ts';
import { PNG_1PX, jsonResponse, mockFetch, sse, streamResponse } from './helpers.ts';

const TOOLS: ToolDef[] = [
  { name: 'search_notes', description: 'Search notes', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'list_notebooks', description: 'List notebooks', parameters: { type: 'object', properties: {} } },
];

/** Recorded-style stream: text, then two tool calls whose arguments arrive in fragments. */
const TOOL_STREAM = sse([
  { data: { id: 'chatcmpl-1', object: 'chat.completion.chunk', choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] } },
  { data: { choices: [{ index: 0, delta: { content: 'Let me ' }, finish_reason: null }] } },
  { data: { choices: [{ index: 0, delta: { content: 'search.' }, finish_reason: null }] } },
  { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'search_notes', arguments: '' } }] }, finish_reason: null }] } },
  { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"qu' } }] }, finish_reason: null }] } },
  { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'ery": "launch' } }] }, finish_reason: null }] } },
  { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: ' plan"}' } }] }, finish_reason: null }] } },
  { data: { choices: [{ index: 0, delta: { tool_calls: [{ index: 1, id: 'call_def', type: 'function', function: { name: 'list_notebooks', arguments: '{}' } }] }, finish_reason: null }] } },
  { data: { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] } },
  { data: { choices: [], usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 } } },
  '[DONE]',
]);

function provider(fetch: ReturnType<typeof mockFetch>, extra: Partial<ConstructorParameters<typeof OpenAICompatibleProvider>[0]> = {}) {
  return new OpenAICompatibleProvider({ id: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-test', fetch, retryBaseMs: 1, ...extra });
}

describe('OpenAI-compatible provider', () => {
  it('streams text and assembles fragmented tool-call arguments', async () => {
    const fetch = mockFetch(() => streamResponse(TOOL_STREAM, { chunkSize: 5 }));
    const events: StreamEvent[] = [];
    const r = await provider(fetch).chat({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'find launch' }], tools: TOOLS }, (e) => events.push(e));

    expect(r.text).toBe('Let me search.');
    expect(r.toolCalls).toEqual([
      { id: 'call_abc', name: 'search_notes', arguments: { query: 'launch plan' } },
      { id: 'call_def', name: 'list_notebooks', arguments: {} },
    ]);
    expect(r.stopReason).toBe('tool_calls');
    expect(r.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(events.filter((e) => e.type === 'text').map((e) => (e as { delta: string }).delta)).toEqual(['Let me ', 'search.']);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(2);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('sends the Chat Completions request shape', async () => {
    const fetch = mockFetch(() => streamResponse(sse(['{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}', '[DONE]'])));
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'What is on this page?' }, { type: 'image', mediaType: 'image/png', data: PNG_1PX }] },
    ];
    await provider(fetch).chat({ model: 'gpt-4o', messages, tools: TOOLS, toolChoice: 'auto', temperature: 0.2, maxTokens: 300 }, () => {});
    const req = fetch.calls[0]!;
    expect(req.url).toBe('https://api.openai.com/v1/chat/completions');
    expect(req.method).toBe('POST');
    expect(req.headers.authorization).toBe('Bearer sk-test');
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.body).toMatchObject({
      model: 'gpt-4o',
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0.2,
      max_tokens: 300,
      tool_choice: 'auto',
      messages: [
        { role: 'system', content: 'Be brief.' },
        { role: 'user', content: [{ type: 'text', text: 'What is on this page?' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1PX}` } }] },
      ],
      tools: [{ type: 'function', function: { name: 'search_notes', description: 'Search notes', parameters: TOOLS[0]!.parameters } }, { type: 'function' }],
    });
  });

  it('serializes assistant tool calls and tool results (images go in a following user turn)', () => {
    const msgs = toOpenAIMessages([
      { role: 'user', content: 'show page 1' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_page_image', arguments: { note_id: 'n1' } }, { id: 'c2', name: 'read_note', arguments: { note_id: 'n1' } }] },
      { role: 'tool', toolCallId: 'c1', content: [{ type: 'text', text: 'Page 0' }, { type: 'image', mediaType: 'image/png', data: PNG_1PX }] },
      { role: 'tool', toolCallId: 'c2', content: 'not found', isError: true },
      { role: 'assistant', content: 'Here it is.' },
    ]);
    expect(msgs).toEqual([
      { role: 'user', content: 'show page 1' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'get_page_image', arguments: '{"note_id":"n1"}' } },
          { id: 'c2', type: 'function', function: { name: 'read_note', arguments: '{"note_id":"n1"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'Page 0' },
      { role: 'tool', tool_call_id: 'c2', content: 'Error: not found' },
      { role: 'user', content: [{ type: 'text', text: 'Images returned by the tool calls above:' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_1PX}` } }] },
      { role: 'assistant', content: 'Here it is.' },
    ]);
  });

  it('parses a non-streaming response', async () => {
    const fetch = mockFetch(() =>
      jsonResponse({
        choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'search_notes', arguments: '{"query":"x"}' } }] }, finish_reason: 'tool_calls' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 },
      }),
    );
    const r = await provider(fetch).chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    expect(fetch.calls[0]!.body.stream).toBeUndefined();
    expect(r).toMatchObject({ text: '', stopReason: 'tool_calls', usage: { inputTokens: 10, outputTokens: 5 }, toolCalls: [{ id: 'call_1', name: 'search_notes', arguments: { query: 'x' } }] });
  });

  it('handles index-less tool calls (Mistral/Ollama style) and invalid argument JSON', async () => {
    const body = sse([
      { data: { choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'search_notes', arguments: '{"query": "a"}' } }] } }] } },
      { data: { choices: [{ delta: { tool_calls: [{ id: 'b', function: { name: 'search_notes', arguments: '{"query": ' } }] } }] } },
      { data: { choices: [{ delta: {}, finish_reason: 'stop' }] } },
      '[DONE]',
    ]);
    const r = await provider(mockFetch(() => streamResponse(body))).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], tools: TOOLS }, () => {});
    expect(r.toolCalls.map((c) => c.id)).toEqual(['a', 'b']);
    expect(r.toolCalls[0]!.arguments).toEqual({ query: 'a' });
    expect(r.toolCalls[1]!.invalidArguments).toBe('{"query":');
    expect(r.stopReason).toBe('tool_calls');
  });

  it('turns an in-stream error chunk into an AIError', async () => {
    const body = sse([{ data: { choices: [{ delta: { content: 'Hi' } }] } }, { data: { error: { message: 'Rate limit reached', type: 'rate_limit_error' } } }]);
    const p = provider(mockFetch(() => streamResponse(body)));
    await expect(p.chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, () => {})).rejects.toMatchObject({ code: 'rate_limit', provider: 'openai' });
  });

  it('sets response_format for JSON mode and mentions JSON in the system prompt', async () => {
    const fetch = mockFetch(() => jsonResponse({ choices: [{ message: { content: '{"a":1}' }, finish_reason: 'stop' }] }));
    const r = await provider(fetch).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }], json: true });
    expect(fetch.calls[0]!.body.response_format).toEqual({ type: 'json_object' });
    expect(fetch.calls[0]!.body.messages[0]).toMatchObject({ role: 'system', content: expect.stringMatching(/JSON/) });
    expect(r.text).toBe('{"a":1}');
  });

  it('accepts a JSON body when the server ignored stream: true', async () => {
    const fetch = mockFetch(() => jsonResponse({ choices: [{ message: { content: 'whole answer' }, finish_reason: 'stop' }] }));
    const events: StreamEvent[] = [];
    const r = await provider(fetch).chat({ model: 'm', messages: [{ role: 'user', content: 'x' }] }, (e) => events.push(e));
    expect(fetch.calls[0]!.body.stream).toBe(true);
    expect(r.text).toBe('whole answer');
    expect(events).toEqual([{ type: 'text', delta: 'whole answer' }, { type: 'done', result: r }]);
  });

  it('lists models', async () => {
    const fetch = mockFetch(() => jsonResponse({ object: 'list', data: [{ id: 'gpt-5' }, { id: 'gpt-4o', context_length: 128000, architecture: { input_modalities: ['text', 'image'] } }] }));
    const models = await provider(fetch).listModels();
    expect(fetch.calls[0]!.url).toBe('https://api.openai.com/v1/models');
    expect(fetch.calls[0]!.method).toBe('GET');
    expect(models).toEqual([{ id: 'gpt-4o', contextWindow: 128000, vision: true }, { id: 'gpt-5' }]);
  });
});

describe('OpenAI-compatible presets', () => {
  const ok = () => jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });

  it('OpenAI uses max_completion_tokens and drops temperature for reasoning models', async () => {
    const fetch = mockFetch(ok);
    const p = createProvider({ providerId: 'openai', apiKey: 'sk', fetch });
    await p.chat({ model: 'gpt-5-mini', messages: [{ role: 'user', content: 'x' }], temperature: 0.3, maxTokens: 50 });
    await p.chat({ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }], temperature: 0.3 });
    expect(fetch.calls[0]!.body).toMatchObject({ max_completion_tokens: 50 });
    expect(fetch.calls[0]!.body.temperature).toBeUndefined();
    expect(fetch.calls[0]!.body.max_tokens).toBeUndefined();
    expect(fetch.calls[1]!.body.temperature).toBe(0.3);
  });

  it('OpenRouter sends attribution headers', async () => {
    const fetch = mockFetch(ok);
    await createProvider({ providerId: 'openrouter', apiKey: 'or-key', fetch }).chat({ model: 'google/gemini-2.5-flash', messages: [{ role: 'user', content: 'x' }] });
    const r = fetch.calls[0]!;
    expect(r.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(r.headers).toMatchObject({ authorization: 'Bearer or-key', 'http-referer': 'https://inkwright.app', 'x-title': 'Inkwright' });
  });

  it('Azure OpenAI uses the deployment URL, api-key header and api-version', async () => {
    const fetch = mockFetch(ok);
    const p = createProvider({ providerId: 'azure-openai', apiKey: 'az-key', baseUrl: 'https://my-res.openai.azure.com/', azureApiVersion: '2025-01-01-preview', fetch });
    await p.chat({ model: 'my-gpt4o', messages: [{ role: 'user', content: 'x' }] });
    const r = fetch.calls[0]!;
    expect(r.url).toBe('https://my-res.openai.azure.com/openai/deployments/my-gpt4o/chat/completions?api-version=2025-01-01-preview');
    expect(r.headers['api-key']).toBe('az-key');
    expect(r.headers.authorization).toBeUndefined();
    expect(p.capabilities.listModels).toBe(false);
  });

  it('Azure accepts a full deployment URL as base', async () => {
    const fetch = mockFetch(ok);
    await createProvider({ providerId: 'azure-openai', apiKey: 'k', baseUrl: 'https://r.openai.azure.com/openai/deployments/dep1', fetch }).chat({ model: 'ignored', messages: [{ role: 'user', content: 'x' }] });
    expect(fetch.calls[0]!.url).toBe('https://r.openai.azure.com/openai/deployments/dep1/chat/completions?api-version=2024-10-21');
  });

  it('Ollama and LM Studio need no key and send no auth header', async () => {
    for (const [id, url] of [
      ['ollama', 'http://localhost:11434/v1/chat/completions'],
      ['lmstudio', 'http://localhost:1234/v1/chat/completions'],
    ] as const) {
      const fetch = mockFetch(ok);
      await createProvider({ providerId: id, fetch }).chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'x' }] });
      expect(fetch.calls[0]!.url).toBe(url);
      expect(fetch.calls[0]!.headers.authorization).toBeUndefined();
    }
  });

  it('Custom provider uses any base URL and optional key', async () => {
    const fetch = mockFetch(ok);
    await createProvider({ providerId: 'custom', baseUrl: 'https://llm.example.com/v1/', apiKey: 'k', extraHeaders: { 'x-team': 'ink' }, fetch }).chat({ model: 'qwen', messages: [{ role: 'user', content: 'x' }] });
    expect(fetch.calls[0]!.url).toBe('https://llm.example.com/v1/chat/completions');
    expect(fetch.calls[0]!.headers).toMatchObject({ authorization: 'Bearer k', 'x-team': 'ink' });
  });

  it('Mistral omits stream_options; Groq keeps it', async () => {
    const s = () => streamResponse(sse(['{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}', '[DONE]']));
    const f1 = mockFetch(s);
    await createProvider({ providerId: 'mistral', apiKey: 'k', fetch: f1 }).chat({ model: 'mistral-small-latest', messages: [{ role: 'user', content: 'x' }] }, () => {});
    expect(f1.calls[0]!.body.stream_options).toBeUndefined();
    const f2 = mockFetch(s);
    await createProvider({ providerId: 'groq', apiKey: 'k', fetch: f2 }).chat({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: 'x' }] }, () => {});
    expect(f2.calls[0]!.url).toBe('https://api.groq.com/openai/v1/chat/completions');
    expect(f2.calls[0]!.body.stream_options).toEqual({ include_usage: true });
  });

  it('requires a key and base URL where needed', () => {
    expect(() => createProvider({ providerId: 'openai' })).toThrow(AIError);
    expect(() => createProvider({ providerId: 'azure-openai', apiKey: 'k' })).toThrow(/base URL/);
    expect(() => createProvider({ providerId: 'nope' })).toThrow(/Unknown AI provider/);
  });
});
