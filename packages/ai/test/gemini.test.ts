import { describe, expect, it } from 'vitest';
import { GeminiProvider, toGeminiContents, toGeminiSchema, type ChatMessage, type StreamEvent, type ToolDef } from '../src/index.ts';
import { PNG_1PX, jsonResponse, mockFetch, sse, streamResponse } from './helpers.ts';

const TOOLS: ToolDef[] = [
  {
    name: 'search_notes',
    description: 'Search notes',
    parameters: { type: 'object', additionalProperties: false, $schema: 'x', properties: { query: { type: 'string', default: '' }, limit: { type: ['integer', 'null'] } }, required: ['query'] },
  },
];

/** Recorded-style streamGenerateContent?alt=sse output (Google uses CRLF). */
const STREAM = sse(
  [
    { data: { candidates: [{ content: { parts: [{ text: 'Let me look' }], role: 'model' }, index: 0 }], usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 3, totalTokenCount: 53 }, modelVersion: 'gemini-2.5-flash' } },
    { data: { candidates: [{ content: { parts: [{ text: 'thinking…', thought: true }, { text: ' that up.' }], role: 'model' }, index: 0 }] } },
    {
      data: {
        candidates: [{ content: { parts: [{ functionCall: { name: 'search_notes', args: { query: 'launch' } }, thoughtSignature: 'c2lnbmF0dXJl' }], role: 'model' }, finishReason: 'STOP', index: 0 }],
        usageMetadata: { promptTokenCount: 50, candidatesTokenCount: 12, thoughtsTokenCount: 8, totalTokenCount: 70 },
      },
    },
  ],
  '\r\n',
);

const make = (fetch: ReturnType<typeof mockFetch>) => new GeminiProvider({ apiKey: 'g-key', fetch, retryBaseMs: 1 });

describe('Gemini provider', () => {
  it('streams text and function calls, keeping thought signatures', async () => {
    const fetch = mockFetch(() => streamResponse(STREAM, { chunkSize: 9 }));
    const events: StreamEvent[] = [];
    const r = await make(fetch).chat({ model: 'models/gemini-2.5-flash', messages: [{ role: 'user', content: 'launch?' }], tools: TOOLS }, (e) => events.push(e));
    expect(fetch.calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse');
    expect(fetch.calls[0]!.headers['x-goog-api-key']).toBe('g-key');
    expect(r.text).toBe('Let me look that up.');
    expect(r.toolCalls).toHaveLength(1);
    expect(r.toolCalls[0]).toMatchObject({ name: 'search_notes', arguments: { query: 'launch' }, providerData: { thoughtSignature: 'c2lnbmF0dXJl' } });
    expect(r.stopReason).toBe('tool_calls');
    expect(r.usage).toEqual({ inputTokens: 50, outputTokens: 20 });
    expect(events.map((e) => e.type)).toEqual(['text', 'text', 'tool_call', 'done']);
  });

  it('builds contents, systemInstruction, function declarations and responses', async () => {
    const fetch = mockFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: 'Found it.' }], role: 'model' }, finishReason: 'STOP' }] }));
    const messages: ChatMessage[] = [
      { role: 'system', content: 'Be brief.' },
      { role: 'user', content: [{ type: 'text', text: 'What does my page say?' }, { type: 'image', mediaType: 'image/png', data: PNG_1PX }] },
      { role: 'assistant', content: '', toolCalls: [{ id: 'g1', name: 'search_notes', arguments: { query: 'x' }, providerData: { thoughtSignature: 'sig', geminiId: 'fc-1' } }] },
      { role: 'tool', toolCallId: 'g1', content: '{"count":1,"results":[]}' },
    ];
    const r = await make(fetch).chat({ model: 'gemini-2.5-pro', messages, tools: TOOLS, toolChoice: { name: 'search_notes' }, temperature: 0.1, maxTokens: 64 });
    expect(r.text).toBe('Found it.');
    const req = fetch.calls[0]!;
    expect(req.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent');
    expect(req.body).toEqual({
      systemInstruction: { parts: [{ text: 'Be brief.' }] },
      contents: [
        { role: 'user', parts: [{ text: 'What does my page say?' }, { inlineData: { mimeType: 'image/png', data: PNG_1PX } }] },
        { role: 'model', parts: [{ functionCall: { name: 'search_notes', args: { query: 'x' }, id: 'fc-1' }, thoughtSignature: 'sig' }] },
        { role: 'user', parts: [{ functionResponse: { name: 'search_notes', id: 'fc-1', response: { count: 1, results: [] } } }] },
      ],
      tools: [
        {
          functionDeclarations: [
            { name: 'search_notes', description: 'Search notes', parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', nullable: true } }, required: ['query'] } },
          ],
        },
      ],
      toolConfig: { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: ['search_notes'] } },
      generationConfig: { temperature: 0.1, maxOutputTokens: 64 },
    });
  });

  it('wraps non-object and error tool results, and sends returned images as inlineData', () => {
    const { contents } = toGeminiContents([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', toolCalls: [{ id: 'a', name: 'list', arguments: {} }, { id: 'b', name: 'img', arguments: {} }, { id: 'c', name: 'bad', arguments: {} }] },
      { role: 'tool', toolCallId: 'a', content: 'plain text' },
      { role: 'tool', toolCallId: 'b', content: [{ type: 'text', text: 'Page 0' }, { type: 'image', mediaType: 'image/png', data: 'xyz' }] },
      { role: 'tool', toolCallId: 'c', content: 'Error: boom', isError: true },
    ]);
    expect(contents[2]).toEqual({
      role: 'user',
      parts: [
        { functionResponse: { name: 'list', response: { result: 'plain text' } } },
        { functionResponse: { name: 'img', response: { result: 'Page 0' } } },
        { inlineData: { mimeType: 'image/png', data: 'xyz' } },
        { functionResponse: { name: 'bad', response: { error: 'Error: boom' } } },
      ],
    });
  });

  it('uses responseMimeType for JSON without tools', async () => {
    const fetch = mockFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: '{"a":1}' }] }, finishReason: 'STOP' }] }));
    await make(fetch).chat({ model: 'gemini-2.5-flash', messages: [{ role: 'user', content: 'x' }], json: true });
    expect(fetch.calls[0]!.body.generationConfig).toEqual({ responseMimeType: 'application/json' });
  });

  it('reports blocked prompts and max-token stops', async () => {
    const blocked = mockFetch(() => jsonResponse({ promptFeedback: { blockReason: 'SAFETY' } }));
    await expect(make(blocked).chat({ model: 'g', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'content_filter' });
    const long = mockFetch(() => jsonResponse({ candidates: [{ content: { parts: [{ text: 'cut' }] }, finishReason: 'MAX_TOKENS' }] }));
    expect((await make(long).chat({ model: 'g', messages: [{ role: 'user', content: 'x' }] })).stopReason).toBe('length');
  });

  it('maps API errors (bad key)', async () => {
    const fetch = mockFetch(() => jsonResponse({ error: { code: 400, message: 'API key not valid. Please pass a valid API key.', status: 'INVALID_ARGUMENT' } }, 400));
    await expect(make(fetch).chat({ model: 'g', messages: [{ role: 'user', content: 'x' }] })).rejects.toMatchObject({ code: 'auth', status: 400, provider: 'gemini' });
    expect(fetch.calls).toHaveLength(1);
  });

  it('lists generateContent models', async () => {
    const fetch = mockFetch(() =>
      jsonResponse({
        models: [
          { name: 'models/gemini-2.5-flash', displayName: 'Gemini 2.5 Flash', inputTokenLimit: 1048576, supportedGenerationMethods: ['generateContent', 'countTokens'] },
          { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        ],
      }),
    );
    expect(await make(fetch).listModels()).toEqual([{ id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', contextWindow: 1048576, vision: true }]);
    expect(fetch.calls[0]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000');
  });

  it('sanitizes JSON Schema for Gemini', () => {
    expect(toGeminiSchema({ type: 'object', additionalProperties: false, properties: { tags: { type: 'array', items: { type: 'string', examples: ['a'] } }, n: { enum: [1, 2] } } })).toEqual({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } }, n: { enum: ['1', '2'] } },
    });
  });
});
