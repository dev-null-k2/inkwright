import { describe, expect, it } from 'vitest';
import { AIError, OpenAICompatibleProvider, createProvider, httpError, isLocalUrl, networkError, parseRetryAfter, send } from '../src/index.ts';
import { hangingStream, jsonResponse, mockFetch, sse, streamResponse } from './helpers.ts';

const ok = () => jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] });
const msgs = [{ role: 'user' as const, content: 'x' }];

describe('error mapping', () => {
  const map = (status: number, body: unknown) => httpError({ provider: 'p', label: 'Prov', status, body });

  it('maps statuses to codes with friendly messages', () => {
    expect(map(401, { error: { message: 'Incorrect API key provided' } })).toMatchObject({ code: 'auth', retryable: false, message: expect.stringMatching(/rejected the API key/) });
    expect(map(403, { error: { message: 'no access' } })).toMatchObject({ code: 'permission', retryable: false });
    expect(map(404, { error: { message: 'The model `gpt-9` does not exist' } })).toMatchObject({ code: 'not_found', message: expect.stringMatching(/model name/) });
    expect(map(429, { error: { message: 'Rate limit reached' } })).toMatchObject({ code: 'rate_limit', retryable: true, message: expect.stringMatching(/rate-limiting/) });
    expect(map(429, { error: { message: 'You exceeded your current quota', type: 'insufficient_quota' } })).toMatchObject({ code: 'quota', retryable: false });
    expect(map(402, {})).toMatchObject({ code: 'quota' });
    expect(map(500, 'oops')).toMatchObject({ code: 'server', retryable: true, status: 500 });
    expect(map(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } })).toMatchObject({ code: 'server', message: expect.stringMatching(/overloaded/) });
    expect(map(400, { error: { message: "This model's maximum context length is 8192 tokens" } })).toMatchObject({ code: 'context_length' });
    expect(map(400, { type: 'error', error: { type: 'invalid_request_error', message: 'prompt is too long: 250000 tokens' } })).toMatchObject({ code: 'context_length' });
    expect(map(422, { detail: [{ msg: 'Extra inputs are not permitted' }] })).toMatchObject({ code: 'bad_request', detail: 'Extra inputs are not permitted' });
  });

  it('is an Error with provider details', () => {
    const e = map(401, { error: { message: 'bad key' } });
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(AIError);
    expect(e.name).toBe('AIError');
    expect(e.detail).toBe('bad key');
    expect(e.provider).toBe('p');
  });

  it('gives a CORS/server hint for local servers', () => {
    expect(isLocalUrl('http://localhost:11434/v1')).toBe(true);
    expect(isLocalUrl('http://192.168.1.20:1234')).toBe(true);
    expect(isLocalUrl('https://api.openai.com')).toBe(false);
    expect(networkError('ollama', 'Ollama', 'http://localhost:11434/v1/chat/completions', new TypeError('fetch failed')).message).toMatch(/OLLAMA_ORIGINS/);
    expect(networkError('openai', 'OpenAI', 'https://api.openai.com/v1', new TypeError('Failed to fetch')).message).toMatch(/internet connection.*CORS/s);
  });

  it('parses retry-after headers', () => {
    expect(parseRetryAfter(new Headers({ 'retry-after': '2' }))).toBe(2000);
    expect(parseRetryAfter(new Headers({ 'retry-after-ms': '150' }))).toBe(150);
    expect(parseRetryAfter(new Headers())).toBeUndefined();
  });

  it('wraps fetch failures as network errors', async () => {
    const fetch = mockFetch([new TypeError('fetch failed')]);
    const p = createProvider({ providerId: 'ollama', fetch });
    await expect(p.chat({ model: 'llama3.2', messages: msgs })).rejects.toMatchObject({ code: 'network', provider: 'ollama', retryable: true });
  });
});

describe('retry', () => {
  const provider = (fetch: ReturnType<typeof mockFetch>, maxRetries?: number) => new OpenAICompatibleProvider({ baseUrl: 'https://x.test/v1', apiKey: 'k', fetch, retryBaseMs: 1, maxRetries });

  it('retries 429 and 5xx, then succeeds', async () => {
    const fetch = mockFetch([jsonResponse({ error: { message: 'slow down' } }, 429), jsonResponse({}, 503), ok()]);
    const r = await provider(fetch).chat({ model: 'm', messages: msgs });
    expect(r.text).toBe('ok');
    expect(fetch.calls).toHaveLength(3);
  });

  it('gives up after maxRetries (2) retries', async () => {
    const fetch = mockFetch(() => jsonResponse({ error: { message: 'down' } }, 500));
    await expect(provider(fetch).chat({ model: 'm', messages: msgs })).rejects.toMatchObject({ code: 'server' });
    expect(fetch.calls).toHaveLength(3);
  });

  it('does not retry auth, bad request or quota errors', async () => {
    for (const [status, body] of [
      [401, { error: { message: 'bad key' } }],
      [400, { error: { message: 'bad' } }],
      [429, { error: { message: 'quota', type: 'insufficient_quota' } }],
    ] as const) {
      const fetch = mockFetch(() => jsonResponse(body, status));
      await expect(provider(fetch).chat({ model: 'm', messages: msgs })).rejects.toBeInstanceOf(AIError);
      expect(fetch.calls).toHaveLength(1);
    }
  });

  it('honours retry-after', async () => {
    const fetch = mockFetch([jsonResponse({}, 429, { 'retry-after-ms': '30' }), ok()]);
    const t0 = Date.now();
    await provider(fetch).chat({ model: 'm', messages: msgs });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(25);
  });

  it('respects maxRetries: 0', async () => {
    const fetch = mockFetch(() => jsonResponse({}, 503));
    await expect(provider(fetch, 0).chat({ model: 'm', messages: msgs })).rejects.toMatchObject({ code: 'server' });
    expect(fetch.calls).toHaveLength(1);
  });
});

describe('abort', () => {
  it('rejects immediately when already aborted, without calling fetch', async () => {
    const fetch = mockFetch(ok);
    const ctl = new AbortController();
    ctl.abort();
    await expect(createProvider({ providerId: 'openai', apiKey: 'k', fetch }).chat({ model: 'm', messages: msgs, signal: ctl.signal })).rejects.toMatchObject({ code: 'aborted' });
    expect(fetch.calls).toHaveLength(0);
  });

  it('stops waiting for a retry when aborted during backoff', async () => {
    const fetch = mockFetch(() => jsonResponse({}, 429, { 'retry-after': '20' }));
    const ctl = new AbortController();
    const p = send({ provider: 'p', label: 'P', url: 'https://x.test', init: {}, fetch, signal: ctl.signal });
    setTimeout(() => ctl.abort(), 10);
    const t0 = Date.now();
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(fetch.calls).toHaveLength(1);
  });

  it('cancels a stream mid-way and keeps the deltas already delivered', async () => {
    const first = sse([{ data: { choices: [{ delta: { content: 'partial' } }] } }]);
    const fetch = mockFetch(() => hangingStream(first));
    const ctl = new AbortController();
    const deltas: string[] = [];
    const p = createProvider({ providerId: 'openai', apiKey: 'k', fetch }).chat({ model: 'm', messages: msgs, signal: ctl.signal }, (e) => {
      if (e.type === 'text') {
        deltas.push(e.delta);
        ctl.abort();
      }
    });
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
    expect(deltas).toEqual(['partial']);
    expect(fetch.calls[0]!.signal).toBe(ctl.signal);
  });

  it('aborts Anthropic and Gemini streams too', async () => {
    for (const id of ['anthropic', 'gemini'] as const) {
      const ctl = new AbortController();
      const fetch = mockFetch(() => hangingStream(': keep-alive\n\n'));
      const p = createProvider({ providerId: id, apiKey: 'k', fetch }).chat({ model: 'm', messages: msgs, signal: ctl.signal }, () => {});
      setTimeout(() => ctl.abort(), 5);
      await expect(p).rejects.toMatchObject({ code: 'aborted', provider: id });
    }
  });

  it('a complete stream after abort still reports aborted', async () => {
    const ctl = new AbortController();
    const fetch = mockFetch(() => streamResponse(sse(['{"choices":[{"delta":{"content":"a"}}]}', '[DONE]'])));
    const p = createProvider({ providerId: 'openai', apiKey: 'k', fetch }).chat({ model: 'm', messages: msgs, signal: ctl.signal }, () => ctl.abort());
    await expect(p).rejects.toMatchObject({ code: 'aborted' });
  });
});
