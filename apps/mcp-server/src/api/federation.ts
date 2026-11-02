/**
 * REST routes for team (federated) search (docs/FEDERATION.md). Both exist in the API document
 * always and answer 404 when the server was started without a team file, so the SDK can call
 * them and a server can say plainly that the feature is off.
 *
 * - `GET /federated/search` — what a teammate's server asks *this* server: only shared notes,
 *   titles and snippets, for API keys with the `federation:search` scope. Read-only, never fans
 *   out further (no transitive search), nothing stored.
 * - `GET /federated/team-search` — the fan-out for the owner: your notes plus every peer's.
 */
import { z } from 'zod';
import { ApiError, defineRoute, type ApiRequest, type RouteDef } from './core.ts';
import { components } from './schemas.ts';
import * as S from './schemas.ts';
import type { ApiDeps } from './routes.ts';
import { localTeamResults } from '../federation/team.ts';
import { runTeamSearch } from '../federation/tools.ts';

const named = <T extends z.ZodType>(id: string, schema: T, description: string): T => {
  components.add(schema, { id, description });
  return schema;
};

export const FederatedHit = named(
  'FederatedHit',
  z.object({
    noteId: z.string(),
    title: z.string(),
    snippet: z.string().describe('At most 300 characters around the match.'),
    notebook: z.string().nullable(),
    tags: z.array(z.string()),
    updatedAt: z.string(),
    score: z.number(),
  }),
  'A note a teammate may see: title, snippet and where it is — never the full text.',
);

export const FederatedSearchResult = named(
  'FederatedSearchResult',
  z.object({ query: z.string(), server: z.string().describe('The name this server’s owner goes by on the team.'), data: z.array(FederatedHit) }),
  'This server’s shared results for a teammate.',
);

export const TeamSearchHit = named(
  'TeamSearchHit',
  z.object({
    person: z.string().describe('Whose note it is.'),
    server: z.string().describe('The server that answered; "local" for your own.'),
    noteId: z.string(),
    title: z.string(),
    snippet: z.string(),
    notebook: z.string().nullable(),
    tags: z.array(z.string()),
    updatedAt: z.string(),
    score: z.number(),
    relevance: z.number().describe('Score relative to the best result from the same source (0–1); the merge order.'),
  }),
  'One merged result with its provenance.',
);

export const PeerStatus = named(
  'PeerStatus',
  z.object({ name: z.string(), url: z.string(), status: z.enum(['ok', 'timeout', 'unauthorized', 'unavailable', 'error']), results: z.number().int(), ms: z.number(), error: z.string().optional() }),
  'How one teammate’s server answered.',
);

export const TeamSearchResult = named(
  'TeamSearchResult',
  z.object({ query: z.string(), data: z.array(TeamSearchHit), peers: z.array(PeerStatus) }),
  'Your notes and your teammates’ shared notes, merged.',
);

const json = (schema: z.ZodType, description: string) => ({ description, schema });
const OFF = 'Team search is off on this server (start it with --team <file>; docs/FEDERATION.md).';

export function federationRoutes(d: ApiDeps): RouteDef[] {
  return [
    defineRoute({
      method: 'GET', path: '/federated/search', operationId: 'federatedSearch', tag: 'Team', scope: 'federation:search',
      summary: 'Search what this server shares with the team',
      description: 'For teammates’ servers. Returns only notes in the notebooks and tags the owner shares (team file), minus anything the AI policy hides from agents or keeps on the device, as titles and snippets. Never asks other servers. 404 when team search is off.',
      query: z.object({ q: z.string().trim().min(1).max(500).describe('What to look for.'), limit: z.coerce.number().int().min(1).max(50).default(10).describe('Results (default 10, at most 50).') }),
      responses: { 200: json(FederatedSearchResult, 'Shared matches, best first.'), 404: json(S.Problem, 'Team search is off.') },
      async handler(req: ApiRequest<unknown, { q: string; limit: number }>) {
        const team = d.ctx.features?.team;
        if (!team) throw new ApiError('not_found', OFF);
        const data = await localTeamResults(d.ctx, team.share, req.query.q, req.query.limit);
        return { status: 200, body: { query: req.query.q, server: team.self, data } };
      },
    }),
    defineRoute({
      method: 'GET', path: '/federated/team-search', operationId: 'teamSearch', tag: 'Team', scope: 'notes:read',
      summary: 'Search your notes and your teammates’ at once',
      description: 'Asks every peer in the team file in parallel (each with its own timeout), merges the results by relevance and labels each with whose it is. Peers that did not answer are listed in `peers`; nothing is cached. 404 when team search is off.',
      query: z.object({ q: z.string().trim().min(1).max(500).describe('What to look for.'), limit: z.coerce.number().int().min(1).max(100).default(20).describe('Results (default 20, at most 100).') }),
      responses: { 200: json(TeamSearchResult, 'Merged results with provenance.'), 404: json(S.Problem, 'Team search is off.') },
      async handler(req: ApiRequest<unknown, { q: string; limit: number }>) {
        const team = d.ctx.features?.team;
        if (!team) throw new ApiError('not_found', OFF);
        const r = await runTeamSearch(d.ctx, team, req.query.q, req.query.limit);
        return { status: 200, body: { query: r.query, data: r.results, peers: r.peers } };
      },
    }),
  ];
}
