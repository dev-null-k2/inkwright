/**
 * `team_search` — the MCP face of federated search (team.ts): your notes and your teammates'
 * shared notes, merged, each result saying whose it is. Registered only when the server was
 * started with a team file (`--team`).
 */
import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import { notebookPath, type ServerContext } from '../context.ts';
import { jsonResult, type ToolDef } from '../tools.ts';
import { teamSearch, type TeamConfig, type TeamResult } from './team.ts';

/** Your own results for a team search: everything the AI policy lets agents see (not only what you share). */
export async function ownResults(ctx: ServerContext, query: string, limit: number): Promise<TeamResult[]> {
  await ctx.refresh();
  const hits = (await ctx.searchIndex()).search(query, { limit: limit * 2 });
  const notebooks = await ctx.vault.listNotebooks();
  const out: TeamResult[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.noteId)) continue;
    const n = await ctx.vault.readNote(h.noteId);
    if (!n || n.trashedAt) continue;
    seen.add(n.id);
    out.push({ noteId: n.id, title: n.title, snippet: h.snippet.slice(0, 300), notebook: notebookPath(notebooks, n.notebookId), tags: n.tags, updatedAt: new Date(n.updatedAt).toISOString(), score: Math.round(h.score * 1000) / 1000 });
    if (out.length >= limit) break;
  }
  return out;
}

/** A fetch through the credential executor for peers whose key it holds. */
export function credentialFetchFor(ctx: ServerContext): ((name: string) => Promise<typeof globalThis.fetch>) | undefined {
  let client: Promise<import('../creds/client.ts').CredentialClient> | null = null;
  return async (name) => {
    const { CredentialClient } = await import('../creds/client.ts');
    const { defaultCredentialsDir } = await import('../creds/store.ts');
    client ??= CredentialClient.connect({ dir: ctx.features?.credentialsDir ?? defaultCredentialsDir(), name: 'inkwright-federation', actor: { source: 'federation', label: 'Team search' } });
    client.catch(() => (client = null));
    return (await client).fetchFor(name) as typeof globalThis.fetch;
  };
}

export async function runTeamSearch(ctx: ServerContext, team: TeamConfig, query: string, limit: number, fetchFn?: typeof globalThis.fetch) {
  return teamSearch(team, query, { limit, self: (q, l) => ownResults(ctx, q, l), credentialFetch: credentialFetchFor(ctx), ...(fetchFn ? { fetch: fetchFn } : {}), clock: ctx.clock });
}

const shape = {
  query: z.string().trim().min(1).max(500).describe('What to look for.'),
  limit: z.number().int().min(1).max(50).optional().describe('Results (default 20).'),
};

async function teamSearchTool(ctx: ServerContext, a: { query: string; limit?: number }): Promise<CallToolResult> {
  const team = ctx.features?.team;
  if (!team) throw new Error('Team search is not set up on this server (start it with --team <file>; docs/FEDERATION.md).');
  const r = await runTeamSearch(ctx, team, a.query, a.limit ?? 20);
  const missing = r.peers.filter((p) => p.status !== 'ok');
  return jsonResult({
    query: r.query,
    count: r.results.length,
    results: r.results.map((x) => ({ person: x.person, server: x.server, noteId: x.noteId, title: x.title, snippet: x.snippet, notebook: x.notebook, updatedAt: x.updatedAt, relevance: x.relevance, ...(x.server === 'local' ? { uri: `inkwright://note/${x.noteId}` } : {}) })),
    peers: r.peers,
    ...(missing.length ? { note: `Not every teammate answered: ${missing.map((p) => `${p.name} (${p.status})`).join(', ')}. Their notes may be missing from these results.` } : {}),
  });
}

export const TEAM_TOOLS: ToolDef[] = [
  {
    name: 'team_search',
    title: 'Team search',
    description: 'Search your notes and the notes your teammates share with you, on their own Inkwright servers, at once. Results say whose they are (person) and come with a short snippet; teammates’ full notes are not available. Peers that did not answer are listed.',
    inputSchema: shape,
    write: false,
    annotations: { readOnlyHint: true, openWorldHint: true, title: 'Team search' },
    handler: (ctx, args) => teamSearchTool(ctx, args as never),
  },
];
