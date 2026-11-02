/**
 * Federated search across a team: each person runs their own Inkwright server over their own
 * vault, and a search fans out to the teammates' servers and merges what comes back. There is no
 * central index and nothing is cached: every search asks every peer, live, and keeps nothing.
 *
 * Two halves (docs/FEDERATION.md):
 *
 * - **Serving** (`localTeamResults`): what a peer may see when it searches *your* notes — only
 *   notes in the notebooks and tags you share in the team file, minus anything the AI policy
 *   hides from agents or keeps on the device; titles and short snippets only, never full text.
 *   Served at `GET /api/v1/federated/search` to API keys with the `federation:search` scope.
 * - **Searching** (`teamSearch`): your own notes plus every peer's shared results, fetched in
 *   parallel with a per-peer timeout, merged by normalized score, each result labelled with the
 *   person and server it came from. A slow or failing peer shows up in `peers[]`; it never fails
 *   the search.
 *
 * The team file (`--team <file>`, default `~/.config/inkwright/team.json`) holds peers' API keys,
 * so it lives outside the vault (it must not sync to the people whose keys these are not) and
 * must be readable only by you (0600).
 */
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import type { NoteMeta, NotebookMeta } from '@inkwright/core';
import { notebookPath, type ServerContext } from '../context.ts';

export interface TeamPeer {
  /** How results from this person are labelled. */
  name: string;
  /** Their server's public base URL (https; http only for this computer). */
  url: string;
  /** Their API key for you (scope `federation:search`), inline… */
  key?: string;
  /** …or from this environment variable… */
  keyEnv?: string;
  /** …or held by the credential executor (an `api` credential for their URL; docs/CREDENTIALS.md). */
  credential?: string;
}

export interface TeamConfig {
  /** Your name as your teammates see it on your results. */
  self: string;
  /** What teammates may search on your server: notebook names, paths or ids (with sub-notebooks), and tags. Empty: nothing. */
  share: { notebooks: string[]; tags: string[] };
  peers: TeamPeer[];
  /** Per-peer timeout in milliseconds (default 3000). */
  timeoutMs: number;
  /** Results asked of each peer (default 10). */
  perPeerLimit: number;
}

export function defaultTeamFile(env: NodeJS.ProcessEnv = process.env): string {
  return env.INKWRIGHT_TEAM_FILE ? path.resolve(env.INKWRIGHT_TEAM_FILE) : path.join(homedir(), '.config', 'inkwright', 'team.json');
}

/** Parses and checks a team file's JSON. Throws one message listing every problem. */
export function parseTeamConfig(raw: unknown): TeamConfig {
  const problems: string[] = [];
  const j = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  const strs = (v: unknown, what: string) => {
    if (v === undefined) return [];
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) problems.push(`${what} must be a list of strings`);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : [];
  };
  const self = typeof j.self === 'string' && j.self.trim() ? j.self.trim().slice(0, 80) : (problems.push('self (your name) is missing'), '');
  const share = { notebooks: strs(j.share?.notebooks, 'share.notebooks'), tags: strs(j.share?.tags, 'share.tags').map((t) => t.replace(/^#/, '').toLowerCase()) };
  const peers: TeamPeer[] = [];
  const seen = new Set<string>();
  (Array.isArray(j.peers) ? j.peers : (j.peers === undefined ? [] : (problems.push('peers must be a list'), []))).forEach((p: Record<string, unknown>, i: number) => {
    const where = `peers[${i}]`;
    const name = typeof p?.name === 'string' && p.name.trim() ? p.name.trim().slice(0, 80) : (problems.push(`${where}.name is missing`), '');
    let url = '';
    try {
      const u = new URL(String(p?.url ?? ''));
      const loop = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(u.hostname);
      if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loop)) problems.push(`${where}.url must be https`);
      if (u.username || u.password || u.search) problems.push(`${where}.url can't carry credentials or a query`);
      url = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    } catch {
      problems.push(`${where}.url is not a URL`);
    }
    const ways = ['key', 'keyEnv', 'credential'].filter((k) => typeof p?.[k] === 'string' && (p[k] as string).length);
    if (ways.length !== 1) problems.push(`${where} needs exactly one of key, keyEnv or credential`);
    if (seen.has(name.toLowerCase())) problems.push(`${where}.name ${name} is used twice`);
    seen.add(name.toLowerCase());
    peers.push({ name, url, ...(typeof p?.key === 'string' ? { key: p.key } : {}), ...(typeof p?.keyEnv === 'string' ? { keyEnv: p.keyEnv } : {}), ...(typeof p?.credential === 'string' ? { credential: p.credential } : {}) });
  });
  const timeoutMs = j.timeoutMs === undefined ? 3000 : Number(j.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) problems.push('timeoutMs must be between 100 and 60000');
  const perPeerLimit = j.perPeerLimit === undefined ? 10 : Number(j.perPeerLimit);
  if (!Number.isInteger(perPeerLimit) || perPeerLimit < 1 || perPeerLimit > 50) problems.push('perPeerLimit must be between 1 and 50');
  if (problems.length) throw new Error(`The team file has problems: ${problems.join('; ')}.`);
  return { self, share, peers, timeoutMs, perPeerLimit };
}

/** Reads the team file; refuses one others can read when it holds keys. */
export function loadTeamConfig(file: string): TeamConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new Error(`Can't read the team file ${file}: ${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error(`The team file ${file} is not JSON: ${(e as Error).message}`);
  }
  const cfg = parseTeamConfig(raw);
  if (process.platform !== 'win32' && cfg.peers.some((p) => p.key) && statSync(file).mode & 0o077) throw new Error(`${file} holds API keys and other users can read it: run chmod 600 "${file}".`);
  return cfg;
}

// ---- Serving: what peers may see ----------------------------------------------------------------

/** Whether a note is shared with the team (its notebook or a parent is shared, or it has a shared tag). */
export function sharedWithTeam(share: TeamConfig['share'], note: Pick<NoteMeta, 'notebookId' | 'tags'>, notebooks: readonly NotebookMeta[]): boolean {
  if (note.tags?.some((t) => share.tags.includes(t.toLowerCase()))) return true;
  if (!share.notebooks.length) return false;
  // Paths match with or without spaces around "/" ("Work/Projects" = "Work / Projects").
  const norm = (s: string) => s.toLowerCase().replace(/\s*\/\s*/g, '/').trim();
  const want = new Set(share.notebooks.map(norm));
  for (let id = note.notebookId ?? undefined, guard = 0; id && guard < 32; guard++) {
    const nb = notebooks.find((b) => b.id === id);
    if (!nb) break;
    if (want.has(norm(nb.id)) || want.has(norm(nb.name)) || want.has(norm(notebookPath(notebooks as NotebookMeta[], nb.id) ?? ''))) return true;
    id = nb.parentId ?? undefined;
  }
  return false;
}

export interface TeamResult {
  noteId: string;
  title: string;
  snippet: string;
  notebook: string | null;
  tags: string[];
  updatedAt: string;
  score: number;
}

/**
 * This server's results for a teammate: the AI policy's view of the vault (hidden and local-only
 * notes are missing), then only what the team file shares, then titles and short snippets.
 */
export async function localTeamResults(ctx: ServerContext, share: TeamConfig['share'], query: string, limit: number): Promise<TeamResult[]> {
  await ctx.refresh();
  const hits = (await ctx.searchIndex()).search(query, { limit: Math.min(200, limit * 5) });
  const notebooks = await ctx.vault.listNotebooks();
  const out: TeamResult[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    if (seen.has(h.noteId)) continue;
    const n = await ctx.vault.readNote(h.noteId);
    if (!n || n.trashedAt || n.lock || !sharedWithTeam(share, n, notebooks)) continue;
    seen.add(h.noteId);
    out.push({ noteId: n.id, title: n.title, snippet: h.snippet.slice(0, 300), notebook: notebookPath(notebooks, n.notebookId), tags: n.tags, updatedAt: new Date(n.updatedAt).toISOString(), score: Math.round(h.score * 1000) / 1000 });
    if (out.length >= limit) break;
  }
  return out;
}

// ---- Searching: fan-out and merge -----------------------------------------------------------------

export interface MergedResult extends TeamResult {
  /** Who it came from: your own name for your notes, the peer's otherwise. */
  person: string;
  /** The server that answered (your own: "local"). */
  server: string;
  /** The score divided by the best score from the same source (0–1), used to merge. */
  relevance: number;
}

export interface PeerStatus {
  name: string;
  url: string;
  status: 'ok' | 'timeout' | 'unauthorized' | 'unavailable' | 'error';
  results: number;
  ms: number;
  error?: string;
}

export interface TeamSearchResult {
  query: string;
  results: MergedResult[];
  peers: PeerStatus[];
}

export interface TeamSearchOptions {
  limit?: number;
  /** Also search your own notes (default true). */
  includeSelf?: boolean;
  fetch?: typeof globalThis.fetch;
  env?: NodeJS.ProcessEnv;
  /** For `credential` peers: a fetch through the credential executor. */
  credentialFetch?: (name: string) => Promise<typeof globalThis.fetch>;
  /** Your own results (default: none). */
  self?: (query: string, limit: number) => Promise<TeamResult[]>;
  clock?: () => number;
}

async function askPeer(p: TeamPeer, cfg: TeamConfig, query: string, o: TeamSearchOptions): Promise<{ status: PeerStatus; results: TeamResult[] }> {
  const clock = o.clock ?? Date.now;
  const started = clock();
  const done = (status: PeerStatus['status'], results: TeamResult[] = [], error?: string) => ({ status: { name: p.name, url: p.url, status, results: results.length, ms: clock() - started, ...(error ? { error } : {}) }, results });
  let fetchFn = o.fetch ?? globalThis.fetch;
  const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'inkwright-federation/1' };
  if (p.credential) {
    if (!o.credentialFetch) return done('error', [], 'This peer uses a credential, and the credential executor is not configured (--credentials-dir).');
    try {
      fetchFn = await o.credentialFetch(p.credential);
    } catch (e) {
      return done('error', [], (e as Error).message);
    }
  } else {
    const key = p.key ?? (p.keyEnv ? (o.env ?? process.env)[p.keyEnv] : undefined);
    if (!key) return done('error', [], `No API key for ${p.name} (${p.keyEnv ? `${p.keyEnv} is not set` : 'key missing'}).`);
    headers.authorization = `Bearer ${key}`;
  }
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), cfg.timeoutMs);
  try {
    const url = `${p.url}/api/v1/federated/search?q=${encodeURIComponent(query)}&limit=${cfg.perPeerLimit}`;
    const r = await fetchFn(url, { headers, signal: ctl.signal, redirect: 'manual' });
    if (r.status === 401 || r.status === 403) return done('unauthorized', [], `${r.status}: check the API key ${p.name} gave you (scope federation:search).`);
    if (r.status === 404) return done('unavailable', [], `${p.name}'s server does not offer team search (started without --team?).`);
    if (!r.ok) return done('error', [], `HTTP ${r.status}`);
    const j = (await r.json()) as { data?: unknown };
    const data = Array.isArray(j.data) ? j.data : [];
    // A peer's answer is untrusted input: keep only well-formed fields, bounded.
    const results: TeamResult[] = data.slice(0, cfg.perPeerLimit).flatMap((x: any) => (x && typeof x.noteId === 'string' && typeof x.title === 'string' ? [{ noteId: x.noteId.slice(0, 64), title: x.title.slice(0, 300), snippet: String(x.snippet ?? '').slice(0, 300), notebook: typeof x.notebook === 'string' ? x.notebook.slice(0, 300) : null, tags: Array.isArray(x.tags) ? x.tags.filter((t: unknown) => typeof t === 'string').slice(0, 20) : [], updatedAt: typeof x.updatedAt === 'string' ? x.updatedAt.slice(0, 40) : '', score: Number.isFinite(x.score) ? Math.max(0, Number(x.score)) : 0 }] : []));
    return done('ok', results);
  } catch (e) {
    return ctl.signal.aborted ? done('timeout', [], `No answer within ${cfg.timeoutMs} ms.`) : done('unavailable', [], (e as Error).message);
  } finally {
    clearTimeout(timer);
  }
}

/** Normalizes each source's scores to its own best result and merges, best first. */
export function mergeResults(sources: Array<{ person: string; server: string; results: TeamResult[] }>, limit: number): MergedResult[] {
  const all: MergedResult[] = [];
  sources.forEach((s) => {
    const best = Math.max(0, ...s.results.map((r) => r.score));
    s.results.forEach((r, rank) => all.push({ ...r, person: s.person, server: s.server, relevance: Math.round((best > 0 ? r.score / best : 1 / (rank + 1)) * 1000) / 1000 }));
  });
  // Stable: equal relevance keeps source order (yours first), then each source's own order.
  return all.map((r, i) => ({ r, i })).sort((a, b) => b.r.relevance - a.r.relevance || a.i - b.i).slice(0, limit).map((x) => x.r);
}

/** Searches your notes and every peer's shared notes at once. Nothing is stored. */
export async function teamSearch(cfg: TeamConfig, query: string, o: TeamSearchOptions = {}): Promise<TeamSearchResult> {
  const limit = o.limit ?? 20;
  const [mine, ...theirs] = await Promise.all([
    o.includeSelf !== false && o.self ? o.self(query, limit).catch(() => [] as TeamResult[]) : Promise.resolve([] as TeamResult[]),
    ...cfg.peers.map((p) => askPeer(p, cfg, query, o)),
  ]);
  const results = mergeResults([{ person: cfg.self, server: 'local', results: mine! }, ...theirs.map((t, i) => ({ person: cfg.peers[i]!.name, server: cfg.peers[i]!.url, results: t.results }))], limit);
  return { query, results, peers: theirs.map((t) => t.status) };
}
