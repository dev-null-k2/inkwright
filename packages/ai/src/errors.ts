export type AIErrorCode =
  | 'auth'
  | 'permission'
  | 'rate_limit'
  | 'quota'
  | 'bad_request'
  | 'context_length'
  | 'not_found'
  | 'server'
  | 'network'
  | 'aborted'
  | 'content_filter'
  | 'parse'
  | 'unsupported'
  | 'unknown';

export interface AIErrorInit {
  code: AIErrorCode;
  provider: string;
  message: string;
  status?: number;
  retryable?: boolean;
  /** The provider's own error text, for logs and "details" disclosure. */
  detail?: string;
  retryAfterMs?: number;
  cause?: unknown;
}

/**
 * The one error type every provider throws. `message` is written for end users; `detail` keeps
 * the provider's raw message. `retryable` says whether the same request may succeed later.
 */
export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly provider: string;
  readonly status?: number;
  readonly retryable: boolean;
  readonly detail?: string;
  readonly retryAfterMs?: number;

  constructor(init: AIErrorInit) {
    super(init.message, init.cause !== undefined ? { cause: init.cause } : undefined);
    this.name = 'AIError';
    this.code = init.code;
    this.provider = init.provider;
    this.status = init.status;
    this.retryable = init.retryable ?? false;
    this.detail = init.detail;
    this.retryAfterMs = init.retryAfterMs;
  }
}

export function isAIError(e: unknown): e is AIError {
  return e instanceof AIError;
}

export function abortError(provider: string, cause?: unknown): AIError {
  return new AIError({ code: 'aborted', provider, message: 'Request cancelled.', cause });
}

export function isAbortLike(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (e instanceof AIError) return e.code === 'aborted';
  const name = (e as { name?: string } | null)?.name;
  return name === 'AbortError' || name === 'TimeoutError';
}

/** Pulls a human message out of the usual error bodies (OpenAI, Anthropic, Gemini, generic). */
export function providerErrorMessage(body: unknown, fallback = ''): string {
  if (body && typeof body === 'object') {
    const b = body as Record<string, any>;
    const e = Array.isArray(b) ? b[0]?.error : b.error;
    if (typeof e === 'string') return e;
    if (e && typeof e === 'object') {
      if (typeof e.message === 'string') return e.message;
      if (typeof e.msg === 'string') return e.msg;
    }
    if (typeof b.message === 'string') return b.message;
    if (typeof b.detail === 'string') return b.detail;
    if (Array.isArray(b.detail) && b.detail[0]?.msg) return String(b.detail[0].msg);
  }
  return fallback;
}

function errorType(body: unknown): string {
  const b = body as Record<string, any> | null;
  const e = b && typeof b === 'object' ? (Array.isArray(b) ? b[0]?.error : b.error) : undefined;
  if (e && typeof e === 'object') return String(e.type ?? e.code ?? e.status ?? '');
  return '';
}

export function parseRetryAfter(headers: Headers | undefined): number | undefined {
  if (!headers) return undefined;
  const ms = headers.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Math.max(0, Number(ms));
  const ra = headers.get('retry-after');
  if (!ra) return undefined;
  const secs = Number(ra);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(ra);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : undefined;
}

export function isLocalUrl(url: string | undefined): boolean {
  if (!url) return false;
  try {
    const h = new URL(url).hostname;
    return (
      h === 'localhost' ||
      h === '0.0.0.0' ||
      h.endsWith('.local') ||
      /^127\./.test(h) ||
      /^10\./.test(h) ||
      /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h === '[::1]'
    );
  } catch {
    return false;
  }
}

/** Maps an HTTP error response to an AIError with a friendly message. */
export function httpError(args: {
  provider: string;
  label?: string;
  status: number;
  body: unknown;
  rawText?: string;
  headers?: Headers;
}): AIError {
  const { provider, status, body } = args;
  const label = args.label ?? provider;
  const detail = providerErrorMessage(body, args.rawText?.slice(0, 500) ?? '');
  const type = errorType(body).toLowerCase();
  const lower = (detail + ' ' + type).toLowerCase();
  const retryAfterMs = parseRetryAfter(args.headers);
  const base = { provider, status, detail, retryAfterMs };

  if (/context[_ ]length|context window|too many tokens|maximum context|prompt is too long|token limit/.test(lower)) {
    return new AIError({ ...base, code: 'context_length', message: `The conversation is too long for this ${label} model. Start a new chat or use fewer notes.` });
  }
  if (status === 401 || /invalid[_ ]api[_ ]key|incorrect api key|api key not valid|authentication/.test(lower)) {
    return new AIError({ ...base, code: 'auth', message: `${label} rejected the API key. Check the key in Settings → AI.` });
  }
  if (status === 402 || /insufficient_quota|quota exceeded|exceeded your current quota|billing|credit balance|out of credits|payment required/.test(lower)) {
    return new AIError({ ...base, code: 'quota', message: `Your ${label} account is out of credits or over its quota. Check billing on the provider's site.` });
  }
  if (status === 429) {
    return new AIError({ ...base, code: 'rate_limit', retryable: true, message: `${label} is rate-limiting requests. Wait a moment and try again.` });
  }
  if (status === 403) {
    return new AIError({ ...base, code: 'permission', message: `${label} refused the request: the key may not have access to this model or region.${detail ? ` (${detail})` : ''}` });
  }
  if (status === 404) {
    return new AIError({ ...base, code: 'not_found', message: `${label} could not find that model or endpoint. Check the model name and base URL.${detail ? ` (${detail})` : ''}` });
  }
  if (status === 408 || status >= 500) {
    const overloaded = status === 529 || /overloaded/.test(lower);
    return new AIError({
      ...base,
      code: 'server',
      retryable: true,
      message: overloaded ? `${label} is overloaded right now. Try again in a minute.` : `${label} had a problem (HTTP ${status}). Try again shortly.`,
    });
  }
  if (/safety|content[_ ]policy|content[_ ]filter/.test(lower)) {
    return new AIError({ ...base, code: 'content_filter', message: `${label} blocked this request under its content policy.` });
  }
  if (status >= 400 && status < 500) {
    return new AIError({ ...base, code: 'bad_request', message: `${label} rejected the request${detail ? `: ${detail}` : ` (HTTP ${status}).`}` });
  }
  return new AIError({ ...base, code: 'unknown', message: `${label} returned an unexpected response (HTTP ${status}).` });
}

/** Error thrown when fetch itself fails (offline, DNS, refused connection, CORS). */
export function networkError(provider: string, label: string, url: string, cause: unknown): AIError {
  const local = isLocalUrl(url);
  let origin = url;
  try {
    origin = new URL(url).origin;
  } catch {
    /* keep url */
  }
  const message = local
    ? `Couldn't reach ${label} at ${origin}. Make sure the server is running; in the web app it must also allow browser requests (CORS) — for Ollama set OLLAMA_ORIGINS=*, in LM Studio enable CORS in the server settings.`
    : `Couldn't reach ${label}. Check your internet connection. In the web app this can also mean the provider blocks browser requests (CORS) — try the desktop/mobile app or a provider such as OpenRouter.`;
  return new AIError({ code: 'network', provider, message, retryable: true, detail: (cause as Error)?.message, cause });
}

/** Turns an in-stream error payload (Anthropic `event: error`, OpenAI `{error}` chunk) into an AIError. */
export function streamError(provider: string, label: string, payload: unknown): AIError {
  const type = errorType(payload).toLowerCase();
  const status = type.includes('overloaded') ? 529 : type.includes('rate_limit') ? 429 : type.includes('authentication') ? 401 : type.includes('invalid_request') ? 400 : 500;
  return httpError({ provider, label, status, body: payload });
}
