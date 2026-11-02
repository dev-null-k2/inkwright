import { describe, expect, it } from 'vitest';
import { transcriberForProvider } from '../src/index.ts';

describe('transcribers', () => {
  it('OpenAI-compatible: multipart upload to /audio/transcriptions', async () => {
    let seen: { url: string; form: FormData; auth: string | null } | null = null;
    const t = transcriberForProvider({
      providerId: 'groq', label: 'Groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: 'k',
      fetch: async (url, init) => {
        seen = { url, form: init!.body as FormData, auth: new Headers(init!.headers).get('authorization') };
        return new Response(JSON.stringify({ text: ' Hello there. ' }), { headers: { 'content-type': 'application/json' } });
      },
    })!;
    const text = await t.transcribe(new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/webm;codecs=opus' }), { language: 'en-US' });
    expect(text).toBe('Hello there.');
    expect(seen!.url).toBe('https://api.groq.com/openai/v1/audio/transcriptions');
    expect(seen!.auth).toBe('Bearer k');
    expect(seen!.form.get('model')).toBe('whisper-large-v3-turbo');
    expect(seen!.form.get('language')).toBe('en');
    expect((seen!.form.get('file') as File).name).toBe('speech.webm');
  });

  it('Gemini: inline audio in generateContent', async () => {
    let body: any = null;
    let url = '';
    const t = transcriberForProvider({
      providerId: 'gemini', label: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com', apiKey: 'g',
      fetch: async (u, init) => {
        url = u;
        body = JSON.parse(init!.body as string);
        return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Make a note' }] } }] }), { headers: { 'content-type': 'application/json' } });
      },
    })!;
    expect(await t.transcribe(new Blob([new Uint8Array([9, 9])], { type: 'audio/ogg' }))).toBe('Make a note');
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent');
    expect(body.contents[0].parts[1].inline_data).toEqual({ mime_type: 'audio/ogg', data: 'CQk=' });
  });

  it('providers without speech-to-text have no transcriber', () => {
    expect(transcriberForProvider({ providerId: 'anthropic', label: 'Claude', baseUrl: 'https://api.anthropic.com' })).toBeNull();
  });

  it('surfaces HTTP errors', async () => {
    const t = transcriberForProvider({ providerId: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', apiKey: 'bad', fetch: async () => new Response(JSON.stringify({ error: { message: 'Incorrect API key' } }), { status: 401 }) })!;
    await expect(t.transcribe(new Blob([new Uint8Array([1])]))).rejects.toThrow();
  });
});
