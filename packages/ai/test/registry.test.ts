import { describe, expect, it } from 'vitest';
import { PROVIDERS, createProvider, getProviderInfo, guessModelCapabilities } from '../src/index.ts';
import { jsonResponse, mockFetch } from './helpers.ts';

describe('provider registry', () => {
  it('has complete metadata for every provider', () => {
    const ids = PROVIDERS.map((p) => p.id);
    expect(ids).toEqual(['openai', 'anthropic', 'gemini', 'openrouter', 'groq', 'mistral', 'xai', 'deepseek', 'together', 'fireworks', 'perplexity', 'cerebras', 'azure-openai', 'ollama', 'lmstudio', 'custom']);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PROVIDERS) {
      expect(p.label).toBeTruthy();
      expect(p.needsBaseUrl || /^https?:\/\//.test(p.defaultBaseUrl)).toBe(true);
      if (p.needsKey) expect(p.keyUrl).toMatch(/^https:\/\//);
      if (p.models.length) expect(p.models).toContain(p.defaultModel);
      expect(p.capabilities).toMatchObject({ streaming: true });
    }
    expect(getProviderInfo('ollama')).toMatchObject({ local: true, needsKey: false, defaultBaseUrl: 'http://localhost:11434/v1' });
    expect(getProviderInfo('lmstudio')).toMatchObject({ local: true, defaultBaseUrl: 'http://localhost:1234/v1' });
  });

  it('creates a working provider for every entry', async () => {
    for (const info of PROVIDERS) {
      const fetch = mockFetch(() =>
        info.kind === 'anthropic'
          ? jsonResponse({ content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' })
          : info.kind === 'gemini'
            ? jsonResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })
            : jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
      );
      const p = createProvider({ providerId: info.id, apiKey: 'key', baseUrl: info.needsBaseUrl ? 'https://example.test/v1' : undefined, fetch });
      expect(p.id).toBe(info.id);
      expect(p.label).toBe(info.label);
      const r = await p.chat({ model: info.defaultModel || 'model', messages: [{ role: 'user', content: 'hi' }] });
      expect(r.text).toBe('ok');
      expect(fetch.calls).toHaveLength(1);
      if (info.defaultBaseUrl) expect(fetch.calls[0]!.url.startsWith(info.defaultBaseUrl.replace(/\/v1$/, ''))).toBe(true);
    }
  });

  it('wraps providers without native tools in the prompt protocol', async () => {
    const fetch = mockFetch(() => jsonResponse({ choices: [{ message: { content: '<tool_call>{"name":"search_notes","arguments":{"query":"x"}}</tool_call>' }, finish_reason: 'stop' }] }));
    const p = createProvider({ providerId: 'perplexity', apiKey: 'k', fetch });
    expect(p.capabilities.tools).toBe(true);
    const r = await p.chat({ model: 'sonar', messages: [{ role: 'user', content: 'x' }], tools: [{ name: 'search_notes', description: 'd', parameters: { type: 'object' } }] });
    expect(fetch.calls[0]!.body.tools).toBeUndefined();
    expect(fetch.calls[0]!.body.messages[0].content).toMatch(/<tool_call>/);
    expect(r.toolCalls[0]).toMatchObject({ name: 'search_notes', arguments: { query: 'x' } });

    const forced = createProvider({ providerId: 'ollama', promptTools: true, fetch: mockFetch(() => jsonResponse({ choices: [{ message: { content: 'hi' } }] })) });
    expect((await forced.chat({ model: 'llama3.2', messages: [{ role: 'user', content: 'x' }], tools: [] })).text).toBe('hi');
  });

  it('guesses model capabilities from names', () => {
    expect(guessModelCapabilities('gpt-4o-mini').vision).toBe(true);
    expect(guessModelCapabilities('claude-sonnet-5-5')).toEqual({ vision: true, reasoning: true });
    expect(guessModelCapabilities('llama3.2-vision').vision).toBe(true);
    expect(guessModelCapabilities('deepseek-reasoner')).toEqual({ vision: false, reasoning: true });
    expect(guessModelCapabilities('openai/gpt-oss-120b').vision).toBe(false);
    expect(guessModelCapabilities('llama-3.3-70b-versatile')).toEqual({ vision: false, reasoning: false });
  });
});
