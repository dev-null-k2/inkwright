/**
 * Building blocks of the REST API: route definitions (everything the router, the OpenAPI
 * generator and the contract tests need to know about an operation) and errors as RFC 9457
 * problem details.
 */
import type { z } from 'zod';
import type { ApiScope } from '@inkstone/core';

export const API_PREFIX = '/api/v1';

/** Problem types link to their section of the built-in docs page. */
export const problemType = (code: string) => `${API_PREFIX}/docs#problem-${code.replace(/_/g, '-')}`;

const TITLES: Record<number, string> = {
  400: 'Bad request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not found',
  405: 'Method not allowed',
  406: 'Not acceptable',
  409: 'Conflict',
  412: 'Precondition failed',
  413: 'Payload too large',
  415: 'Unsupported media type',
  422: 'Unprocessable content',
  428: 'Precondition required',
  429: 'Too many requests',
  500: 'Internal server error',
  501: 'Not implemented',
  503: 'Service unavailable',
};

/** Every problem code the API can return, with its status (documented on the docs page). */
export const PROBLEM_CODES = {
  invalid_request: 400,
  unauthorized: 401,
  forbidden: 403,
  insufficient_scope: 403,
  not_found: 404,
  method_not_allowed: 405,
  not_acceptable: 406,
  conflict: 409,
  idempotency_key_in_use: 409,
  precondition_failed: 412,
  payload_too_large: 413,
  unsupported_media_type: 415,
  idempotency_key_reused: 422,
  rate_limited: 429,
  internal: 500,
  not_implemented: 501,
  unavailable: 503,
  read_only: 403,
  locked: 403,
} as const;

export type ProblemCode = keyof typeof PROBLEM_CODES;

/** An error the API turns into a problem+json response. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: ProblemCode;
  readonly errors?: { path: string; message: string }[];
  readonly headers: Record<string, string>;
  constructor(code: ProblemCode, detail: string, opts: { errors?: { path: string; message: string }[]; headers?: Record<string, string>; status?: number } = {}) {
    super(detail);
    this.code = code;
    this.status = opts.status ?? PROBLEM_CODES[code];
    if (opts.errors) this.errors = opts.errors;
    this.headers = opts.headers ?? {};
  }
}

export interface ProblemBody {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  code: string;
  errors?: { path: string; message: string }[];
}

export function problemBody(e: ApiError, instance?: string): ProblemBody {
  return {
    type: problemType(e.code),
    title: TITLES[e.status] ?? 'Error',
    status: e.status,
    detail: e.message,
    ...(instance ? { instance } : {}),
    code: e.code,
    ...(e.errors ? { errors: e.errors } : {}),
  };
}

/** zod issues → `errors` entries ("body.title: Too small…"). */
export function zodErrors(where: string, err: z.ZodError): { path: string; message: string }[] {
  return err.issues.map((i) => ({ path: [where, ...i.path.map(String)].join('.'), message: i.message }));
}

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

/** Who is calling, after authentication. */
export interface Principal {
  /** `key:<id>`, `token`, `oauth:<sub>` or `loopback` — used for rate limits and idempotency. */
  id: string;
  /** Shown in Activity next to the changes it made, e.g. "Shortcuts (API key)". */
  label: string;
  scopes: ReadonlySet<ApiScope>;
}

export interface ApiRequest<P = Record<string, string>, Q = Record<string, unknown>, B = unknown> {
  method: HttpMethod;
  url: URL;
  params: P;
  query: Q;
  body: B;
  headers: Headers;
  principal: Principal;
  /** The `If-Match` header, when sent (already parsed into entity tags). */
  ifMatch: string[] | null;
  /** Absolute URL of this API (e.g. https://notes.example.com/api/v1), for links. */
  baseUrl: string;
}

export interface ApiResult {
  status: number;
  /** JSON body (serialized by the router) — or raw bytes/text with `contentType`. */
  body?: unknown;
  raw?: Uint8Array | string;
  contentType?: string;
  headers?: Record<string, string>;
  /** Entity tag of the returned representation (adds ETag, answers If-None-Match with 304). */
  etag?: string;
}

export interface ResponseDef {
  description: string;
  /** JSON responses: a registered schema. */
  schema?: z.ZodType;
  /** Non-JSON responses: media types and a JSON-Schema-ish description of the body. */
  content?: Record<string, { schema: Record<string, unknown> }>;
  headers?: Record<string, { description: string; schema: Record<string, unknown> }>;
}

export interface RouteDef {
  method: HttpMethod;
  /** OpenAPI path template under /api/v1, e.g. `/notes/{id}`. */
  path: string;
  operationId: string;
  summary: string;
  description?: string;
  tag: string;
  /** Scope needed; null = any authenticated caller. */
  scope: ApiScope | null;
  params?: z.ZodObject;
  query?: z.ZodObject;
  body?: z.ZodType;
  /** Accepts `Idempotency-Key` (POSTs that create or run something). */
  idempotent?: boolean;
  /** Accepts `If-Match` (writes to a resource with an ETag). */
  conditional?: boolean;
  /** Writes to the vault (refused in read-only mode). */
  writes?: boolean;
  responses: Record<number, ResponseDef>;
  handler(req: ApiRequest<any, any, any>): Promise<ApiResult>;
}

export const defineRoute = (r: RouteDef) => r;

/** `"abc"` and `W/"abc"` from an If-Match / If-None-Match header; `*` stays `*`. */
export function parseEtags(header: string | null): string[] | null {
  if (header == null) return null;
  const out: string[] = [];
  for (const m of header.matchAll(/(\*|(?:W\/)?"[^"]*")/g)) out.push(m[1]!);
  return out;
}

/** Weak comparison (RFC 9110 §8.8.3.2): the opaque tags match ignoring W/. */
export function etagMatches(list: string[], etag: string): boolean {
  const strip = (t: string) => t.replace(/^W\//, '');
  return list.some((t) => t === '*' || strip(t) === strip(etag));
}

/** Base64url JSON cursors: opaque to clients, simple for us. */
export function encodeCursor(v: unknown): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

export function decodeCursor<T>(c: string | undefined, check: (v: unknown) => v is T): T | null {
  if (!c) return null;
  try {
    const v = JSON.parse(Buffer.from(c, 'base64url').toString('utf8'));
    if (check(v)) return v;
  } catch {
    /* fallthrough */
  }
  throw new ApiError('invalid_request', 'The cursor is not valid. Pass back the nextCursor of a previous page unchanged.');
}

/** Offset pagination for small, stable lists (notebooks, tags, keys…). */
export function offsetPage<T>(items: T[], limit: number, cursor: string | undefined): { data: T[]; nextCursor: string | null } {
  const at = decodeCursor(cursor, (v): v is { o: number } => !!v && typeof (v as { o?: unknown }).o === 'number' && (v as { o: number }).o >= 0)?.o ?? 0;
  const data = items.slice(at, at + limit);
  return { data, nextCursor: at + limit < items.length ? encodeCursor({ o: at + limit }) : null };
}

export const iso = (ms: number | undefined | null) => (ms ? new Date(ms).toISOString() : null);
