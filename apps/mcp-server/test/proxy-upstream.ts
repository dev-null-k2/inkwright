/**
 * A fake OpenAI- and Anthropic-compatible API for the proxy's tests and benchmark: a "reader"
 * model that answers only from what it can see in the request, and calls `retrieve_original`
 * (when the request offers it) while facts it needs are missing — the behaviour the budgeter
 * relies on, made deterministic. Reports usage as the real APIs do (estimated tokens), streams
 * when asked, and records every request body it received.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { estimateTokens } from '@inkwright/ai';

export interface ReaderTask {
  /** The user's question (identifies the task). */
  question: string;
  /** Facts the answer needs. */
  facts: string[];
  /** Query the reader passes to retrieve_original on its first retrieval. */
  retrieveQuery?: string;
}

export interface FakeUpstream {
  url: string;
  requests: Array<{ path: string; headers: Record<string, string>; body: any }>;
  tasks: Map<string, ReaderTask>;
  close(): Promise<void>;
}

type J = Record<string, any>;
const textOf = (c: unknown): string => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p: J) => (typeof p?.text === 'string' ? p.text : typeof p?.content === 'string' ? p.content : Array.isArray(p?.content) ? textOf(p.content) : '')).join('\n') : '');

export async function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  const tasks = new Map<string, ReaderTask>();
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v;
    requests.push({ path: req.url ?? '', headers, body });
    if (req.method === 'GET') return void res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ object: 'list', data: [{ id: 'reader-1', object: 'model' }] }));
    const anthropic = (req.url ?? '').includes('/messages');
    const messages: J[] = body.messages ?? [];
    // What the model can see: tool results (and earlier user text).
    const visible = anthropic
      ? messages.filter((m) => m.role === 'user').map((m) => textOf(m.content)).join('\n')
      : messages.filter((m) => m.role === 'tool' || m.role === 'user').map((m) => textOf(m.content)).join('\n');
    const question = [...messages].reverse().map((m) => (m.role === 'user' ? textOf(anthropic && Array.isArray(m.content) ? m.content.filter((b: J) => b.type === 'text') : m.content) : '')).find((t) => t && tasks.has(t.trim())) ?? '';
    const task = tasks.get(question.trim()) ?? { question, facts: [] };
    const have = task.facts.filter((f) => visible.includes(f));
    const offersRetrieve = (body.tools ?? []).some((t: J) => (t.function?.name ?? t.name) === 'retrieve_original');
    const retrievedSoFar = anthropic ? messages.filter((m) => m.role === 'assistant' && Array.isArray(m.content) && m.content.some((b: J) => b.type === 'tool_use' && b.name === 'retrieve_original')).length : messages.filter((m) => m.role === 'assistant' && m.tool_calls?.some((c: J) => c.function?.name === 'retrieve_original')).length;
    const ref = /ref "([0-9a-f]{16})"/.exec(visible)?.[1];
    const input = estimateTokens(JSON.stringify(messages));
    const retrieve = have.length < task.facts.length && ref && offersRetrieve && retrievedSoFar < 2 ? { ref, ...(retrievedSoFar === 0 && task.retrieveQuery ? { query: task.retrieveQuery } : {}) } : null;
    const answer = `Answer: ${have.join('; ') || 'not found'}`;
    const model = body.model ?? 'reader-1';
    const json = (j: J) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(j));
    const sse = (events: Array<[string | null, J | string]>) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const [ev, d] of events) res.write(`${ev ? `event: ${ev}\n` : ''}data: ${typeof d === 'string' ? d : JSON.stringify(d)}\n\n`);
      res.end();
    };
    if (anthropic) {
      const content = retrieve ? [{ type: 'tool_use', id: `tu_${requests.length}`, name: 'retrieve_original', input: retrieve }] : [{ type: 'text', text: answer }];
      const msg = { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model, content, stop_reason: retrieve ? 'tool_use' : 'end_turn', stop_sequence: null, usage: { input_tokens: input, output_tokens: 20 } };
      if (!body.stream) return void json(msg);
      return void sse([
        ['message_start', { type: 'message_start', message: { ...msg, content: [], usage: { input_tokens: input, output_tokens: 0 } } }],
        ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
        ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: answer } }],
        ['content_block_stop', { type: 'content_block_stop', index: 0 }],
        ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 20 } }],
        ['message_stop', { type: 'message_stop' }],
      ]);
    }
    const message = retrieve ? { role: 'assistant', content: null, tool_calls: [{ id: `call_${requests.length}`, type: 'function', function: { name: 'retrieve_original', arguments: JSON.stringify(retrieve) } }] } : { role: 'assistant', content: answer };
    const completion = { id: `chatcmpl_${requests.length}`, object: 'chat.completion', created: 1, model, choices: [{ index: 0, message, finish_reason: retrieve ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: input, completion_tokens: 20, total_tokens: input + 20 } };
    if (!body.stream) return void json(completion);
    const base = { id: completion.id, object: 'chat.completion.chunk', created: 1, model };
    sse([
      [null, { ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] }],
      [null, { ...base, choices: [{ index: 0, delta: { content: answer }, finish_reason: null }] }],
      [null, { ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }],
      ...(body.stream_options?.include_usage ? [[null, { ...base, choices: [], usage: completion.usage }] as [null, J]] : []),
      [null, '[DONE]'],
    ]);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { url, requests, tasks, close: () => new Promise<void>((r) => server.close(() => r())) };
}
