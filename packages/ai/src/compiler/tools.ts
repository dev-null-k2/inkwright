/**
 * Agent tools for the compiler, so the assistant and routines can use it ("update my wiki",
 * the nightly compile, "follow-ups from today's meetings"). None of them changes a note: compiling
 * makes a proposal the user reviews; the others only read.
 */
import type { AgentTool } from '../agent.ts';

export interface CompilerToolHost {
  /** Runs a compile and returns a short summary (the proposal waits for the user). */
  compile(reason: string): Promise<{ summary: string; proposalId?: string; changes: number }>;
  /** Open conflicts across notes. */
  conflicts(limit: number): Promise<Array<{ a: string; aNote: string; b: string; bNote: string; reason: string; confidence: number; link?: string }>>;
  /** Action items and follow-ups in notes changed since `sinceMs` (epoch ms). */
  followUps(sinceMs: number): Promise<Array<{ text: string; owner: string; person?: string; due?: string; done: boolean; note: string; noteId: string; link?: string }>>;
}

export const COMPILER_TOOL_NAMES = ['compile_wiki', 'list_conflicts', 'list_followups'] as const;

export function createCompilerTools(host: CompilerToolHost): AgentTool[] {
  return [
    {
      name: 'compile_wiki',
      description: 'Re-compile the user\'s compiled wiki from its sources (only pages whose sources changed). Changes are not applied: they become a proposal the user reviews in Compiled wiki. Returns a summary.',
      parameters: { type: 'object', properties: { reason: { type: 'string', description: 'Why (shown on the proposal), e.g. "Nightly".' } }, additionalProperties: false },
      readOnly: true,
      async execute(a: { reason?: string }) {
        return host.compile(a.reason?.slice(0, 60) || 'Assistant');
      },
    },
    {
      name: 'list_conflicts',
      description: 'List places where the user\'s notes contradict each other (numbers, limits, dates, decisions), with both sentences, the notes and a link to each. Use for "do my notes disagree anywhere?".',
      parameters: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
      readOnly: true,
      async execute(a: { limit?: number }) {
        const list = await host.conflicts(a.limit ?? 20);
        return { count: list.length, conflicts: list };
      },
    },
    {
      name: 'list_followups',
      description: 'List action items, to-dos and follow-ups (with owner, person and due date) written in notes changed since a time. Use for meeting follow-ups. `since` is an ISO date or date-time; default is the start of today.',
      parameters: { type: 'object', properties: { since: { type: 'string', description: 'ISO date/time, e.g. 2026-11-02 or 2026-11-02T09:00' } }, additionalProperties: false },
      readOnly: true,
      async execute(a: { since?: string }) {
        const d = a.since ? new Date(a.since.length <= 10 ? `${a.since}T00:00:00` : a.since) : new Date(new Date().setHours(0, 0, 0, 0));
        const since = Number.isFinite(d.getTime()) ? d.getTime() : new Date(new Date().setHours(0, 0, 0, 0)).getTime();
        const items = await host.followUps(since);
        return { since: new Date(since).toISOString(), count: items.length, items };
      },
    },
  ];
}
