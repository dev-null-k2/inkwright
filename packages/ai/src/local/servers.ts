import type { FetchLike } from '../types.ts';

/**
 * Local model servers people already run on their computers. All four speak the OpenAI Chat
 * Completions API, so once found they are ordinary OpenAI-compatible providers. A browser page may
 * only read their answers if the server sends CORS headers for the page's origin; when it does not,
 * detection still notices the server (an opaque `no-cors` request succeeds) and the UI explains
 * the one setting to change.
 */
export interface LocalServerInfo {
  id: 'ollama' | 'lmstudio' | 'llamacpp' | 'foundry';
  label: string;
  /** Provider registry id it maps to. */
  providerId: 'ollama' | 'lmstudio' | 'llamacpp' | 'foundry-local';
  /** Ports to try, most likely first. */
  ports: number[];
  /** Path of the model list relative to the base URL. */
  modelsPath: string;
  /** How to let the web app connect (shown when the browser was blocked). */
  corsHelp: string;
  downloadUrl: string;
}

export const LOCAL_SERVERS: readonly LocalServerInfo[] = [
  {
    id: 'ollama', label: 'Ollama', providerId: 'ollama', ports: [11434], modelsPath: '/v1/models', downloadUrl: 'https://ollama.com/download',
    corsHelp: 'Allow Inkwright to connect: set OLLAMA_ORIGINS to this page’s address (or *) and restart Ollama. macOS: launchctl setenv OLLAMA_ORIGINS "*" — Windows: add a user environment variable OLLAMA_ORIGINS — Linux: Environment="OLLAMA_ORIGINS=*" in the ollama service.',
  },
  {
    id: 'lmstudio', label: 'LM Studio', providerId: 'lmstudio', ports: [1234], modelsPath: '/v1/models', downloadUrl: 'https://lmstudio.ai',
    corsHelp: 'In LM Studio open Developer › Server settings, turn on “Enable CORS”, and make sure the server is running.',
  },
  {
    id: 'llamacpp', label: 'llama.cpp server', providerId: 'llamacpp', ports: [8080], modelsPath: '/v1/models', downloadUrl: 'https://github.com/ggml-org/llama.cpp',
    corsHelp: 'Start llama-server with --cors "*" (or your page’s address) so the browser may read its answers.',
  },
  {
    id: 'foundry', label: 'Foundry Local', providerId: 'foundry-local', ports: [5272, 5273], modelsPath: '/v1/models', downloadUrl: 'https://github.com/microsoft/Foundry-Local',
    corsHelp: 'Foundry Local picks a new port each start; fix it with “foundry service set --port 5272”, then check its CORS settings allow this page.',
  },
];

export type ServerStatus = 'ready' | 'blocked';

export interface DetectedServer {
  server: LocalServerInfo;
  /** OpenAI-compatible base URL (…/v1). */
  baseUrl: string;
  status: ServerStatus;
  /** Model ids it serves (empty when blocked or nothing is loaded). */
  models: string[];
}

function withTimeout(ms: number, outer?: AbortSignal): { signal: AbortSignal; done: () => void } {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  const onOuter = () => ac.abort();
  outer?.addEventListener('abort', onOuter, { once: true });
  return { signal: ac.signal, done: () => { clearTimeout(t); outer?.removeEventListener('abort', onOuter); } };
}

function modelIds(body: unknown): string[] {
  const b = body as { data?: { id?: string }[]; models?: { name?: string; model?: string }[] } | string[] | null;
  if (Array.isArray(b)) return b.filter((x): x is string => typeof x === 'string');
  const list = b?.data?.map((m) => m.id) ?? b?.models?.map((m) => m.name ?? m.model) ?? [];
  return list.filter((x): x is string => typeof x === 'string' && !/embed/i.test(x));
}

/** Probes one server on one port. Null when nothing answers. */
export async function probeServer(server: LocalServerInfo, port: number, opts: { fetch?: FetchLike; host?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DetectedServer | null> {
  const f = opts.fetch ?? ((u, i) => fetch(u, i));
  const origin = `${opts.host ?? 'http://localhost'}:${port}`;
  const baseUrl = `${origin}/v1`;
  const t = withTimeout(opts.timeoutMs ?? 1200, opts.signal);
  try {
    const res = await f(`${origin}${server.modelsPath}`, { signal: t.signal });
    if (!res.ok) {
      // Up, but the list endpoint differs (older builds): still usable as a chat server.
      return res.status === 404 ? { server, baseUrl, status: 'ready', models: [] } : null;
    }
    let models: string[] = [];
    try { models = modelIds(await res.json()); } catch { /* not JSON */ }
    return { server, baseUrl, status: 'ready', models };
  } catch {
    if (t.signal.aborted && !opts.signal?.aborted) return null; // timed out: nothing listening
    // A CORS refusal looks like a network error. If an opaque request gets through, the server is
    // there and only the browser's cross-origin rule is in the way.
    const t2 = withTimeout(opts.timeoutMs ?? 1200, opts.signal);
    try {
      await f(`${origin}${server.modelsPath}`, { mode: 'no-cors', signal: t2.signal });
      return { server, baseUrl, status: 'blocked', models: [] };
    } catch {
      return null;
    } finally {
      t2.done();
    }
  } finally {
    t.done();
  }
}

/** Looks for every known local server at once (about a second when none are running). */
export async function detectLocalServers(opts: { fetch?: FetchLike; host?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<DetectedServer[]> {
  const probes = LOCAL_SERVERS.flatMap((s) => s.ports.map((p) => probeServer(s, p, opts)));
  const found = (await Promise.all(probes)).filter((x): x is DetectedServer => !!x);
  // One entry per server (the first port that answered).
  return found.filter((d, i) => found.findIndex((o) => o.server.id === d.server.id) === i);
}
