import { describe, expect, it } from 'vitest';
import { SSEParser, extractJson, extractJsonArray, readSSE, repairJson, stripFences, validateArgs } from '../src/index.ts';
import { streamResponse } from './helpers.ts';

describe('SSEParser', () => {
  it('parses events, multi-line data, ids and comments', () => {
    const p = new SSEParser();
    const msgs = p.push(': keep-alive\nevent: ping\ndata: {}\n\nid: 7\ndata: line one\ndata: line two\n\n');
    expect(msgs).toEqual([
      { event: 'ping', data: '{}' },
      { event: 'message', data: 'line one\nline two', id: '7' },
    ]);
  });

  it('handles CRLF and CR line endings split across chunks', () => {
    const p = new SSEParser();
    const text = 'data: a\r\n\r\ndata: b\r\rdata: c\n\n';
    const out = [];
    for (const ch of text) out.push(...p.push(ch));
    out.push(...p.end());
    expect(out.map((m) => m.data)).toEqual(['a', 'b', 'c']);
  });

  it('strips a BOM, ignores a data-less event and flushes an unterminated final event', () => {
    const p = new SSEParser();
    const out = [...p.push('﻿event: x\n\ndata:no-space\n\ndata: tail'), ...p.end()];
    expect(out).toEqual([
      { event: 'message', data: 'no-space' },
      { event: 'message', data: 'tail' },
    ]);
  });

  it('readSSE decodes multi-byte UTF-8 split across chunks', async () => {
    const res = streamResponse('data: héllo — 日本語 ✓\n\n', { chunkSize: 1 });
    const out: string[] = [];
    for await (const m of readSSE(res, { provider: 't', label: 'T', url: 'https://x' })) out.push(m.data);
    expect(out).toEqual(['héllo — 日本語 ✓']);
  });
});

describe('extractJson', () => {
  it('parses plain JSON', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    expect(extractJson(' [1,2] ')).toEqual([1, 2]);
  });

  it('prefers fenced blocks and tolerates prose around them', () => {
    const t = 'Sure! Here you go:\n```json\n{"todos": [{"text": "Buy milk"}]}\n```\nLet me know if you need more.';
    expect(extractJson(t)).toEqual({ todos: [{ text: 'Buy milk' }] });
  });

  it('finds a balanced object amid prose, skipping bracketed prose and strings with braces', () => {
    const t = 'Result [draft]: {"q": "What is {x}?", "a": "a \\"quoted\\" value"} — done';
    expect(extractJson(t)).toEqual({ q: 'What is {x}?', a: 'a "quoted" value' });
  });

  it('repairs trailing commas and smart quotes', () => {
    expect(extractJson('{"tags": ["a", "b",],}')).toEqual({ tags: ['a', 'b'] });
    expect(extractJson('{“a”: 1}')).toEqual({ a: 1 });
    expect(repairJson('[1,2,]')).toBe('[1,2]');
  });

  it('handles an unterminated fence (truncated output)', () => {
    expect(extractJson('```json\n{"cards": []}')).toEqual({ cards: [] });
  });

  it('returns undefined when there is no JSON', () => {
    expect(extractJson('no json here')).toBeUndefined();
    expect(extractJson('')).toBeUndefined();
    expect(extractJson('{broken')).toBeUndefined();
  });

  it('extractJsonArray unwraps {"key": [...]} and single objects', () => {
    expect(extractJsonArray('{"cards":[{"q":"a","a":"b"}]}')).toEqual([{ q: 'a', a: 'b' }]);
    expect(extractJsonArray('{"q":"a","a":"b"}')).toEqual([{ q: 'a', a: 'b' }]);
    expect(extractJsonArray('nothing')).toBeUndefined();
  });

  it('stripFences removes one wrapping fence', () => {
    expect(stripFences('```markdown\n# Title\n- a\n```')).toBe('# Title\n- a');
    expect(stripFences('plain')).toBe('plain');
  });
});

describe('validateArgs', () => {
  const schema = {
    type: 'object',
    properties: {
      query: { type: 'string', minLength: 1 },
      limit: { type: 'integer', minimum: 1, maximum: 50 },
      exact: { type: 'boolean' },
      tags: { type: 'array', items: { type: 'string' } },
      mode: { type: 'string', enum: ['plain', 'markdown'] },
      opt: { type: ['string', 'null'] },
    },
    required: ['query'],
  };

  it('accepts valid input', () => {
    const r = validateArgs(schema, { query: 'x', limit: 3, tags: ['a'], mode: 'plain' });
    expect(r).toEqual({ ok: true, errors: [], value: { query: 'x', limit: 3, tags: ['a'], mode: 'plain' } });
  });

  it('reports missing required fields and wrong types', () => {
    const r = validateArgs(schema, { limit: 2.5, exact: 'maybe', mode: 'html' });
    expect(r.ok).toBe(false);
    expect(r.errors).toContain('missing required query');
    expect(r.errors.some((e) => e.startsWith('limit must be integer'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('exact must be boolean'))).toBe(true);
    expect(r.errors.some((e) => e.startsWith('mode must be one of'))).toBe(true);
  });

  it('coerces numeric strings, boolean strings and scalars to arrays', () => {
    const r = validateArgs(schema, { query: 42, limit: '5', exact: 'TRUE', tags: 'solo' });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ query: '42', limit: 5, exact: true, tags: ['solo'] });
  });

  it('drops null optional fields unless null is allowed', () => {
    const r = validateArgs(schema, { query: 'x', limit: null, opt: null });
    expect(r.ok).toBe(true);
    expect(r.value).toEqual({ query: 'x', opt: null });
  });

  it('checks bounds and empty strings', () => {
    const r = validateArgs(schema, { query: '', limit: 99 });
    expect(r.errors).toEqual(['query must not be empty', 'limit must be ≤ 50']);
  });

  it('treats a missing argument object as {}', () => {
    expect(validateArgs({ type: 'object', properties: {} }, undefined).ok).toBe(true);
    expect(validateArgs(schema, undefined).errors).toEqual(['missing required query']);
  });
});

describe('content helpers', () => {
  it('builds parts and strips data URLs', async () => {
    const { textPart, imagePart, textOf, partsOf, hasImages } = await import('../src/index.ts');
    expect(textPart('a')).toEqual({ type: 'text', text: 'a' });
    expect(imagePart('image/png', 'data:image/png;base64,QUJD')).toEqual({ type: 'image', mediaType: 'image/png', data: 'QUJD' });
    expect(textOf([textPart('a'), imagePart('image/png', 'x'), textPart('b')])).toBe('ab');
    expect(partsOf('')).toEqual([]);
    expect(hasImages([{ role: 'user', content: [imagePart('image/png', 'x')] }])).toBe(true);
    expect(hasImages([{ role: 'user', content: 'x' }])).toBe(false);
  });
});
