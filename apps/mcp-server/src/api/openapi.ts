/**
 * Builds the OpenAPI 3.1 document from the route definitions. Schemas come from zod
 * (`z.toJSONSchema`, JSON Schema 2020-12 — the dialect OpenAPI 3.1 uses), so the document, the
 * request validation and the generated SDK can never disagree.
 */
import { z } from 'zod';
import { API_SCOPES } from '@inkstone/core';
import { VERSION } from '../version.ts';
import { API_PREFIX, PROBLEM_CODES, type RouteDef } from './core.ts';
import { components } from './schemas.ts';

type Json = Record<string, unknown>;

const SCOPE_TEXT: Record<(typeof API_SCOPES)[number], string> = {
  'notes:read': 'Read notes, pages, notebooks, tags, links, search, assets, transcripts, activity and routines.',
  'notes:write': 'Create, change, trash and restore notes and notebooks.',
  'routines:run': 'Run routines.',
  webhooks: 'Manage webhook subscriptions.',
  admin: 'Manage API keys.',
};

const ref = (schema: z.ZodType): Json => {
  const id = components.get(schema)?.id;
  if (!id) throw new Error('Response schemas must be registered components (schemas.ts).');
  return { $ref: `#/components/schemas/${id}` };
};

/** JSON Schema for one zod schema (inline, request side). */
function inline(schema: z.ZodType): Json {
  const out = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }) as Json;
  delete out.$schema;
  return out;
}

export interface OpenApiOptions {
  /** Server URL shown in the document (the public URL + /api/v1). */
  serverUrl: string;
  /** Whether the server validates OAuth tokens (adds the OAuth security scheme). */
  oauth?: { issuer: string; readScope: string; writeScope: string } | null;
}

export function buildOpenApi(routes: RouteDef[], opts: OpenApiOptions): Json {
  const out = z.toJSONSchema(components, { target: 'draft-2020-12', io: 'output', unrepresentable: 'any', uri: (id) => `#/components/schemas/${id}` }) as { schemas: Record<string, Json> };
  const inputs = z.toJSONSchema(components, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any', uri: (id) => `#/components/schemas/${id}` }) as { schemas: Record<string, Json> };
  const schemas: Record<string, Json> = {};
  for (const [id, s] of Object.entries(out.schemas)) {
    // Request bodies use the input side (defaults are optional there); everything else the output side.
    const body = routes.some((r) => r.body && components.get(r.body)?.id === id);
    const chosen = { ...(body ? inputs.schemas[id] : s) };
    delete chosen.$schema;
    delete chosen.$id;
    delete chosen.id;
    schemas[id] = chosen;
  }

  const paths: Record<string, Record<string, Json>> = {};
  for (const r of routes) {
    const parameters: Json[] = [];
    for (const [where, obj] of [['path', r.params], ['query', r.query]] as const) {
      if (!obj) continue;
      const shape = inline(obj) as { properties?: Record<string, Json>; required?: string[] };
      for (const [name, schema] of Object.entries(shape.properties ?? {})) {
        const { description, ...rest } = schema as Json & { description?: string };
        parameters.push({ name, in: where, required: where === 'path' || ((shape.required ?? []).includes(name) && rest.default === undefined), ...(description ? { description } : {}), schema: rest });
      }
    }
    if (r.idempotent) parameters.push({ name: 'Idempotency-Key', in: 'header', required: false, description: 'Makes retries safe: the same key returns the first response instead of doing the work twice (kept 24 h).', schema: { type: 'string', maxLength: 255 } });
    if (r.conditional) parameters.push({ name: 'If-Match', in: 'header', required: false, description: 'ETag from a previous read; the write fails with 412 if the note changed since.', schema: { type: 'string' } });
    if (r.method === 'GET' && r.responses[304]) parameters.push({ name: 'If-None-Match', in: 'header', required: false, description: 'ETag from a previous read; answers 304 when unchanged.', schema: { type: 'string' } });

    const responses: Record<string, Json> = {};
    for (const [status, def] of Object.entries(r.responses)) {
      const content = def.schema ? { 'application/json': { schema: ref(def.schema) } } : def.content;
      const statusNum = Number(status);
      const rl = statusNum < 300 ? { ratelimit: { $ref: '#/components/headers/RateLimit' }, 'ratelimit-policy': { $ref: '#/components/headers/RateLimitPolicy' } } : {};
      const headers = { ...rl, ...(def.headers ?? {}) };
      responses[status] = { description: def.description, ...(content && statusNum !== 204 && statusNum !== 304 ? { content: statusNum >= 400 && def.schema ? { 'application/problem+json': { schema: ref(def.schema) } } : content } : {}), ...(Object.keys(headers).length ? { headers } : {}) };
    }
    const problem = (description: string) => ({ $ref: `#/components/responses/${description}` });
    responses['400'] ??= problem('BadRequest');
    responses['401'] ??= problem('Unauthorized');
    responses['403'] ??= problem('Forbidden');
    if (r.params) responses['404'] ??= problem('NotFound');
    if (r.body) {
      responses['413'] ??= problem('PayloadTooLarge');
      responses['415'] ??= problem('UnsupportedMediaType');
    }
    if (r.writes) responses['403'] ??= problem('Forbidden');
    if (r.conditional) responses['412'] ??= problem('PreconditionFailed');
    if (r.idempotent) {
      responses['409'] ??= problem('Conflict');
      responses['422'] ??= problem('IdempotencyKeyReused');
    }
    responses['429'] ??= problem('TooManyRequests');

    const op: Json = {
      operationId: r.operationId,
      summary: r.summary,
      ...(r.description ? { description: r.description } : {}),
      tags: [r.tag],
      ...(parameters.length ? { parameters } : {}),
      ...(r.body ? { requestBody: { required: true, content: { 'application/json': { schema: ref(r.body) } } } } : {}),
      responses,
      security: r.scope ? [{ apiKey: [r.scope] }, ...(opts.oauth ? [{ oauth: [r.scope === 'notes:read' ? opts.oauth.readScope : opts.oauth.writeScope] }] : [])] : [{ apiKey: [] }],
      'x-inkstone-scope': r.scope,
    };
    (paths[r.path] ??= {})[r.method.toLowerCase()] = op;
  }

  const problemResponse = (description: string) => ({ description, content: { 'application/problem+json': { schema: { $ref: '#/components/schemas/Problem' } } } });

  return {
    openapi: '3.1.0',
    jsonSchemaDialect: 'https://json-schema.org/draft/2020-12/schema',
    info: {
      title: 'Inkstone API',
      version: VERSION,
      summary: 'Your Inkstone notes vault over HTTP.',
      description:
        'A local REST API over an Inkstone vault, served by `inkstone-mcp --http` next to MCP and A2A. Authenticate with an API key (`Authorization: Bearer ink_…`, scoped; create keys in the app under Settings › Developer or with `inkstone-mcp keys create`), the server token, or OAuth. Errors are RFC 9457 problem details. Lists use cursor pagination. Writes accept `Idempotency-Key`; note writes accept `If-Match` with the ETag you read. Every write is logged in the app’s Activity under the key’s name and can be undone there.',
      license: { name: 'Apache-2.0', identifier: 'Apache-2.0' },
    },
    servers: [{ url: opts.serverUrl }],
    tags: [
      { name: 'Notes', description: 'Notes: list, read, create, change, trash and restore.' },
      { name: 'Pages', description: 'A note’s pages as JSON ink, text, SVG, PNG or PDF.' },
      { name: 'Notebooks', description: 'Notebooks and tags.' },
      { name: 'Search', description: 'Keyword and semantic search, links, backlinks and the graph.' },
      { name: 'Assets', description: 'Images, PDFs, recordings and transcripts.' },
      { name: 'Automation', description: 'Activity and routines.' },
      { name: 'Webhooks', description: 'Signed event deliveries (Standard Webhooks).' },
      { name: 'Keys', description: 'API keys (admin scope).' },
    ],
    paths,
    components: {
      schemas,
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', bearerFormat: 'ink_<id>_<secret>', description: `API key or the server token. Key scopes: ${API_SCOPES.map((s) => `\`${s}\` — ${SCOPE_TEXT[s]}`).join(' ')}` },
        ...(opts.oauth ? { oauth: { type: 'openIdConnect', openIdConnectUrl: `${opts.oauth.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, description: 'JWT access tokens from your identity provider (see docs/AGENTS.md).' } } : {}),
      },
      headers: {
        RateLimit: { description: 'Requests left in the current window and seconds until it resets (draft-ietf-httpapi-ratelimit-headers).', schema: { type: 'string' } },
        RateLimitPolicy: { description: 'The rate-limit policy: quota and window in seconds.', schema: { type: 'string' } },
      },
      responses: {
        BadRequest: problemResponse('The request is not valid; `errors` lists each problem.'),
        Unauthorized: problemResponse('No or a wrong API key or token.'),
        Forbidden: problemResponse('The key lacks the scope this operation needs, or the vault is read-only.'),
        NotFound: problemResponse('No such resource.'),
        Conflict: problemResponse('A request with this Idempotency-Key is still running.'),
        PayloadTooLarge: problemResponse('The body is too large.'),
        UnsupportedMediaType: problemResponse('The body is not JSON.'),
        PreconditionFailed: problemResponse('If-Match did not match: the note changed since you read it.'),
        IdempotencyKeyReused: problemResponse('This Idempotency-Key was used for a different request.'),
        TooManyRequests: { ...problemResponse('Rate limit reached; see Retry-After.'), headers: { 'retry-after': { description: 'Seconds to wait.', schema: { type: 'integer' } } } },
      },
    },
    'x-problem-codes': PROBLEM_CODES,
    externalDocs: { description: 'docs/API.md', url: `${API_PREFIX}/docs` },
  };
}
