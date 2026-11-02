/**
 * OpenClaw / pi session transcripts (sessions.ts), in the shape pi-coding-agent 0.73.1 documents
 * in docs/session-format.md and OpenClaw 2026.10.9 in reference/session-management-compaction:
 * a header, then a tree of entries; only the active branch and the latest reset window count.
 * Also the ```sh runbook block info string (runbook.ts).
 */
import { describe, expect, it } from 'vitest';
import { detectSessionTool, parseAgentSession, parseRunbookBlocks, sessionToMarkdown } from '../../src/index.ts';

const jl = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join('\n');
const t = (s: number) => `2026-10-30T09:00:${String(s).padStart(2, '0')}.000Z`;

export const OPENCLAW = jl(
  { type: 'session', version: 3, id: 'sess-uuid-1', timestamp: t(0), cwd: '/home/me/shop' },
  { type: 'message', id: 'a1', parentId: null, timestamp: t(1), message: { role: 'user', content: 'Why does checkout time out?', timestamp: 1 } },
  { type: 'message', id: 'a2', parentId: 'a1', timestamp: t(2), message: { role: 'assistant', provider: 'anthropic', model: 'claude-sonnet-4-5', stopReason: 'toolUse', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Checking the logs.' }, { type: 'toolCall', id: 'call_1', name: 'bash', arguments: { command: 'grep -n timeout logs/app.log' } }] } },
  { type: 'message', id: 'a3', parentId: 'a2', timestamp: t(3), message: { role: 'toolResult', toolCallId: 'call_1', toolName: 'bash', content: [{ type: 'text', text: 'app.log:88: upstream timeout after 30s' }], isError: false } },
  // An abandoned branch from a2: must not appear.
  { type: 'message', id: 'b1', parentId: 'a2', timestamp: t(4), message: { role: 'assistant', content: [{ type: 'text', text: 'ABANDONED BRANCH' }] } },
  { type: 'model_change', id: 'a4', parentId: 'a3', timestamp: t(5), provider: 'openai', modelId: 'gpt-5' },
  { type: 'session_info', id: 'a5', parentId: 'a4', timestamp: t(6), name: 'Checkout timeouts' },
  { type: 'message', id: 'a6', parentId: 'a5', timestamp: t(7), message: { role: 'bashExecution', command: 'npm test', output: '1 failing', exitCode: 1, cancelled: false, truncated: false } },
  { type: 'custom', id: 'a7', parentId: 'a6', timestamp: t(8), customType: 'ext', data: { n: 1 } },
  { type: 'custom_message', id: 'a8', parentId: 'a7', timestamp: t(9), customType: 'reminder', content: 'Run the e2e suite too.', display: true },
  { type: 'message', id: 'a9', parentId: 'a8', timestamp: t(10), message: { role: 'assistant', content: [{ type: 'text', text: 'The gateway timeout is 30 s; raising it to 60 s fixes it.' }], stopReason: 'stop' } },
);

describe('OpenClaw / pi transcripts', () => {
  it('is detected, and shows only the active branch', () => {
    expect(detectSessionTool(OPENCLAW)).toBe('openclaw');
    const s = parseAgentSession('2026-10-30_sess.jsonl', OPENCLAW);
    expect(s).toMatchObject({ tool: 'openclaw', id: 'sess-uuid-1', title: 'Checkout timeouts', cwd: '/home/me/shop', model: 'gpt-5' });
    const md = sessionToMarkdown(s);
    expect(md).not.toContain('ABANDONED BRANCH');
    expect(md).not.toContain('hmm'); // thinking is left out
    expect(s.turns.map((x) => x.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'assistant', 'assistant']);
    const call = s.turns.find((x) => x.tool?.name === 'bash' && x.tool.input?.includes('grep'))!;
    expect(call.tool!.output).toContain('upstream timeout');
    expect(s.turns.find((x) => x.tool?.input === 'npm test')!.tool!.error).toBe(true);
    expect(md).toContain('reminder: Run the e2e suite too.');
  });

  it('keeps only the latest reset window, with the messages the reset keeps', () => {
    const text = jl(
      { type: 'session', version: 3, id: 's2', timestamp: t(0), cwd: '/x' },
      { type: 'message', id: 'm1', parentId: null, timestamp: t(1), message: { role: 'user', content: 'old question' } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: t(2), message: { role: 'user', content: 'kept question' } },
      { type: 'compaction', id: 'm3', parentId: 'm2', timestamp: t(3), summary: 'earlier work', firstKeptEntryId: 'm2', tokensBefore: 9000 },
      { type: 'reset', id: 'm4', parentId: 'm3', timestamp: t(4), firstKeptEntryId: 'm2' },
      { type: 'message', id: 'm5', parentId: 'm4', timestamp: t(5), message: { role: 'user', content: 'new question' } },
    );
    const s = parseAgentSession('s2.jsonl', text);
    const md = sessionToMarkdown(s);
    expect(md).not.toContain('old question');
    expect(md).toContain('kept question');
    expect(md).toContain('new question');
  });

  it('is not mistaken for Codex or Claude Code', () => {
    expect(detectSessionTool(jl({ type: 'session_meta', payload: {} }))).not.toBe('openclaw');
    expect(detectSessionTool(jl({ type: 'session', id: 'x' }, { type: 'response_item', payload: {} }))).not.toBe('openclaw');
  });
});

describe('```sh runbook blocks', () => {
  it('carry their dialect, working folder and name', () => {
    const b = parseRunbookBlocks('```bash cwd=~/code/shop restart\nsystemctl --user restart shop\n```\n```sh\nls\n```\n```pwsh cwd="C:/Program Files/app" check\nGet-Service\n```');
    expect(b.map((x) => [x.lang, x.shell, x.name ?? null])).toEqual([
      ['sh', { dialect: 'bash', cwd: '~/code/shop' }, 'restart'],
      ['sh', { dialect: 'sh' }, null],
      ['sh', { dialect: 'pwsh', cwd: 'C:/Program Files/app' }, 'check'],
    ]);
  });
});
