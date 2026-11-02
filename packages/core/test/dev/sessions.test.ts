import { describe, expect, it } from 'vitest';
import { LessonStore, MemoryFS, detectSessionTool, lessonsToAppend, parseAgentSession, sessionDigest, sessionToMarkdown } from '../../src/index.ts';

const jl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');

/** As written by Claude Code to ~/.claude/projects/<project>/<session>.jsonl. */
export const CLAUDE = jl(
  { type: 'summary', summary: 'Fix flaky login test', leafUuid: 'u9' },
  { type: 'user', uuid: 'u1', sessionId: 'abc-123', cwd: '/home/me/shop', gitBranch: 'fix/login', timestamp: '2026-10-30T09:00:00.000Z', isSidechain: false, message: { role: 'user', content: '<command-name>/init</command-name>\n<command-args></command-args>' } },
  { type: 'user', uuid: 'u2', sessionId: 'abc-123', timestamp: '2026-10-30T09:00:05.000Z', message: { role: 'user', content: [{ type: 'text', text: 'The login test fails on CI about one run in five.' }] } },
  { type: 'assistant', uuid: 'u3', timestamp: '2026-10-30T09:00:09.000Z', message: { role: 'assistant', model: 'claude-opus-4-5', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Let me run it in a loop.' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'npm test -- login --repeat 20' } }] } },
  { type: 'user', uuid: 'u4', timestamp: '2026-10-30T09:01:00.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', is_error: true, content: [{ type: 'text', text: 'Timeout waiting for session cookie' }] }] } },
  { type: 'assistant', uuid: 'u5', isSidechain: true, message: { role: 'assistant', content: [{ type: 'text', text: 'sub-agent chatter' }] } },
  { type: 'user', uuid: 'u6', isMeta: true, message: { role: 'user', content: 'Caveat: meta' } },
  { type: 'assistant', uuid: 'u7', timestamp: '2026-10-30T09:02:00.000Z', message: { role: 'assistant', content: [{ type: 'text', text: 'The test waits on a fixed 500 ms sleep; I replaced it with waiting for the cookie.' }] } },
  { type: 'file-history-snapshot', snapshot: {} },
) + '\n{"type":"assistant","message":{"rol';

export const CODEX = jl(
  { timestamp: '2026-10-31T10:00:00.000Z', type: 'session_meta', payload: { id: 'cdx-1', cwd: '/home/me/shop', git: { branch: 'main' }, timestamp: '2026-10-31T10:00:00.000Z' } },
  { timestamp: '2026-10-31T10:00:00.100Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
  { timestamp: '2026-10-31T10:00:01.000Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add an index on orders.created_at' }] } },
  { timestamp: '2026-10-31T10:00:01.000Z', type: 'event_msg', payload: { type: 'user_message', message: 'Add an index on orders.created_at' } },
  { timestamp: '2026-10-31T10:00:02.000Z', type: 'turn_context', payload: { model: 'gpt-5-codex' } },
  { timestamp: '2026-10-31T10:00:03.000Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: JSON.stringify({ command: ['bash', '-lc', 'rg created_at migrations'] }), call_id: 'c1' } },
  { timestamp: '2026-10-31T10:00:04.000Z', type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: JSON.stringify({ output: 'migrations/007.sql', metadata: { exit_code: 0 } }) } },
  { timestamp: '2026-10-31T10:00:05.000Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added migrations/008_orders_created_at.sql.' }] } },
);

export const GEMINI = JSON.stringify({
  sessionId: 'gem-7', projectHash: 'ff', startTime: '2026-11-01T08:00:00.000Z', lastUpdated: '2026-11-01T08:05:00.000Z',
  messages: [
    { id: '1', timestamp: '2026-11-01T08:00:00.000Z', type: 'user', content: 'Why is the build slow?' },
    { id: '2', timestamp: '2026-11-01T08:01:00.000Z', type: 'gemini', model: 'gemini-2.5-pro', content: 'Checking the bundle.', toolCalls: [{ id: 't', name: 'run_shell_command', args: { command: 'du -sh dist' }, status: 'success', result: [{ functionResponse: { response: { output: '48M dist' } } }] }] },
    { id: '3', timestamp: '2026-11-01T08:02:00.000Z', type: 'info', content: 'Request cancelled.' },
    { id: '4', timestamp: '2026-11-01T08:03:00.000Z', type: 'gemini', content: [{ text: 'Source maps are 40 MB of it.' }] },
  ],
}, null, 2);

describe('agent session transcripts', () => {
  it('detects which agent wrote a file', () => {
    expect(detectSessionTool(CLAUDE)).toBe('claude-code');
    expect(detectSessionTool(CODEX)).toBe('codex');
    expect(detectSessionTool(GEMINI)).toBe('gemini');
    expect(detectSessionTool('{"hello":1}')).toBeNull();
    expect(() => parseAgentSession('x.jsonl', 'nonsense')).toThrow(/not a Claude Code, Codex CLI or Gemini CLI session/);
  });

  it('reads Claude Code JSONL: summary title, commands, tool results, no sidechains or meta, torn last line', () => {
    const s = parseAgentSession('abc-123.jsonl', CLAUDE);
    expect(s).toMatchObject({ tool: 'claude-code', id: 'abc-123', title: 'Fix flaky login test', cwd: '/home/me/shop', branch: 'fix/login', model: 'claude-opus-4-5' });
    expect(s.turns.map((t) => t.role)).toEqual(['user', 'user', 'assistant', 'tool', 'assistant']);
    expect(s.turns[0]!.text).toBe('/init');
    expect(s.turns[3]!.tool).toEqual({ name: 'Bash', input: '{"command":"npm test -- login --repeat 20"}', output: 'Timeout waiting for session cookie', error: true });
    expect(s.startedAt).toBe(Date.parse('2026-10-30T09:00:00.000Z'));
  });

  it('reads Codex rollouts without the injected context or duplicate events', () => {
    const s = parseAgentSession('rollout-2026-10-31.jsonl', CODEX);
    expect(s).toMatchObject({ tool: 'codex', id: 'cdx-1', title: 'Add an index on orders.created_at', branch: 'main', model: 'gpt-5-codex' });
    expect(s.turns.map((t) => t.role)).toEqual(['user', 'tool', 'assistant']);
    expect(s.turns[1]!.tool).toMatchObject({ name: 'shell', input: 'bash -lc rg created_at migrations', output: 'migrations/007.sql' });
  });

  it('reads Gemini CLI session JSON', () => {
    const s = parseAgentSession('session-2026-11-01.json', GEMINI);
    expect(s).toMatchObject({ tool: 'gemini', id: 'gem-7', title: 'Why is the build slow?', model: 'gemini-2.5-pro' });
    expect(s.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(s.turns[2]!.tool).toMatchObject({ name: 'run_shell_command', output: '48M dist' });
  });

  it('writes a readable note and a compact digest', () => {
    const md = sessionToMarkdown(parseAgentSession('abc-123.jsonl', CLAUDE));
    expect(md).toContain('# Fix flaky login test');
    expect(md).toContain('Claude Code session 2026-10-30 09:00 in /home/me/shop on fix/login · claude-opus-4-5');
    expect(md).toContain('## You · 09:00\n\nThe login test fails on CI about one run in five.');
    expect(md).toContain('- ✗ Bash `{"command":"npm test -- login --repeat 20"}` — Timeout waiting for session cookie');
    expect(md).not.toContain('sub-agent chatter');
    const digest = sessionDigest(parseAgentSession('abc-123.jsonl', CLAUDE));
    expect(digest).toContain('[tool Bash FAILED]');
  });
});

describe('lessons', () => {
  it('stores proposals once, records decisions, and appends only new lessons', async () => {
    let n = 0;
    const store = new LessonStore(new MemoryFS(), () => 1000 + n, () => `l${++n}`);
    const added = await store.propose([{ text: 'Wait for conditions, never fixed sleeps, in e2e tests.', why: 'Flaky login test' }, { text: 'Wait for conditions, never fixed sleeps in e2e tests' }], { noteId: 'n1', noteTitle: 'Fix flaky login test' });
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({ id: 'l1', status: 'proposed', noteId: 'n1' });
    expect(await store.propose([{ text: 'wait for conditions, never fixed sleeps, in E2E tests' }])).toEqual([]);
    expect(await store.decide('l1', true)).toMatchObject({ status: 'accepted' });
    expect(await store.decide('l1', false)).toBeNull();
    const md = lessonsToAppend('# AGENTS.md\n\n- Run the linter before committing.', ['Run the linter before committing', 'Prefer rg over grep.'], new Date('2026-11-02T10:00:00Z'));
    expect(md).toBe('## Lessons · 2026-11-02\n\n- Prefer rg over grep.');
    expect(lessonsToAppend('- Prefer rg over grep.', ['Prefer rg over grep.'], new Date())).toBeNull();
  });
});
