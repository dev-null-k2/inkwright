import { parseRecallQuery, searchCaptures } from '@inkwright/core';
import type { AgentTool } from '@inkwright/ai';
import { useApp } from '../state/app.ts';
import { recallStore } from './state.ts';

/**
 * `search_timeline(query)`: lets the user's own assistant answer "what was that command in
 * Tuesday's lecture?". The captures it returns were redacted when they were stored, and the
 * guarded provider's privacy firewall applies again on the way out (docs/TRUST.md). This is the
 * only way timeline text reaches an AI: when the user asks theirs.
 */
export function searchTimelineTool(): AgentTool<{ query: string; limit?: number }> {
  return {
    name: 'search_timeline',
    description: 'Search the user\'s memory timeline: text that was on their screen (and, if they turned it on, speech near their computer), captured on their own computer and redacted. Understands dates and times in the query ("Tuesday afternoon", "yesterday", "around 3pm") and "in <App>". Returns moments with time, app, window title and matching lines, each with a link (#recall/<ms>) the user can open.',
    parameters: { type: 'object', properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 20 } }, required: ['query'] },
    readOnly: true,
    async execute(a) {
      const vault = useApp.getState().vault;
      if (!vault) throw new Error('The vault is not open');
      const now = Date.now();
      const probe = parseRecallQuery(a.query, now);
      const caps = await recallStore(vault).readRange(probe.from ?? 0, probe.to ?? now + 60_000);
      const q = parseRecallQuery(a.query, now, [...new Set(caps.map((c) => c.app).filter((x): x is string => !!x))]);
      const hits = searchCaptures(caps, q, { limit: Math.min(20, a.limit ?? 8) });
      return {
        when: q.when ?? 'any time kept',
        moments: hits.map((h) => ({ at: new Date(h.capture.at).toISOString(), kind: h.capture.kind, app: h.capture.app, title: h.capture.title, lines: h.lines, link: `#recall/${h.capture.at}` })),
        ...(hits.length ? {} : { note: 'Nothing in the timeline matches. It keeps only what the user\'s desktop app captured during the retention period.' }),
      };
    },
  };
}
