/**
 * Finding Inkwright's releases on GitHub (docs/UPDATES.md, "Checking").
 *
 * One request to the REST API lists the ten newest releases. Without a token GitHub allows 60
 * requests an hour per IP address, shared by everything on that network, so the updater keeps the
 * response's ETag and asks with If-None-Match: an unchanged list comes back as 304 Not Modified,
 * which GitHub does not count against the limit, and the cached list is used. When the limit is
 * reached anyway (403/429) the result says until when to wait; offline and other failures are
 * reported as such and never shown as errors in the library.
 *
 * Pure apart from the injected `fetch`, so the rules are unit-tested.
 */
import { versionCode } from './versionCode.ts';

export type Channel = 'stable' | 'beta';

/** What the updater needs from one GitHub release. */
export interface ReleaseInfo {
  tag: string;
  /** The tag without its leading "v". */
  version: string;
  /** From the tag, by the versioning scheme; the manifest must agree. */
  versionCode: number;
  prerelease: boolean;
  /** ISO date GitHub published it. */
  published: string;
  /** The release's android-update.json download address. */
  manifestUrl: string;
  /** The release page, for "See on GitHub". */
  pageUrl: string;
}

export interface ReleasesCache {
  etag: string;
  releases: ReleaseInfo[];
}

export type ReleasesResult =
  | { kind: 'ok'; releases: ReleaseInfo[]; cache: ReleasesCache | null; notModified: boolean }
  | { kind: 'rate-limited'; retryAt: number }
  | { kind: 'offline' }
  | { kind: 'error'; status: number };

export const MANIFEST_ASSET = 'android-update.json';
const API = 'https://api.github.com';
/** When GitHub says nothing about when to come back. */
const DEFAULT_BACKOFF_MS = 60 * 60 * 1000;

interface RawAsset { name?: unknown; browser_download_url?: unknown }
interface RawRelease { tag_name?: unknown; draft?: unknown; prerelease?: unknown; published_at?: unknown; html_url?: unknown; assets?: unknown }

/**
 * The releases the updater can use, from the API's JSON: published (not drafts), tagged with a
 * version in the scheme, with an android-update.json asset served from this repository's releases.
 */
export function toReleaseInfo(raw: unknown, repo: string): ReleaseInfo[] {
  if (!Array.isArray(raw)) return [];
  const prefix = `https://github.com/${repo}/releases/download/`;
  const out: ReleaseInfo[] = [];
  for (const r of raw as RawRelease[]) {
    if (!r || typeof r !== 'object' || r.draft === true || typeof r.tag_name !== 'string') continue;
    const code = versionCode(r.tag_name);
    if (code == null) continue;
    const assets = Array.isArray(r.assets) ? (r.assets as RawAsset[]) : [];
    const manifest = assets.find((a) => a?.name === MANIFEST_ASSET && typeof a.browser_download_url === 'string' && a.browser_download_url.startsWith(prefix));
    if (!manifest) continue;
    out.push({
      tag: r.tag_name,
      version: r.tag_name.replace(/^v/, ''),
      versionCode: code,
      prerelease: r.prerelease === true,
      published: typeof r.published_at === 'string' ? r.published_at : '',
      manifestUrl: manifest.browser_download_url as string,
      pageUrl: typeof r.html_url === 'string' ? r.html_url : `https://github.com/${repo}/releases`,
    });
  }
  return out;
}

/**
 * The newest release for a channel: "beta" takes pre-releases and final releases alike, "stable"
 * final releases only. Newest by versionCode, not by date, so a hotfix published for an older line
 * never outranks the current one.
 */
export function pickRelease(releases: readonly ReleaseInfo[], channel: Channel): ReleaseInfo | null {
  let best: ReleaseInfo | null = null;
  for (const r of releases) {
    if (channel === 'stable' && r.prerelease) continue;
    if (!best || r.versionCode > best.versionCode) best = r;
  }
  return best;
}

/** When to try again after GitHub refused because of its rate limit, from its headers. */
export function retryAtFrom(headers: Headers, now: number): number {
  const after = Number(headers.get('retry-after'));
  if (Number.isFinite(after) && after > 0) return now + after * 1000;
  const reset = Number(headers.get('x-ratelimit-reset'));
  if (Number.isFinite(reset) && reset > 0 && reset * 1000 > now) return reset * 1000;
  return now + DEFAULT_BACKOFF_MS;
}

export interface FetchDeps {
  fetch: typeof fetch;
  now: () => number;
  /** False when the device says it is offline (navigator.onLine). */
  online: () => boolean;
}

const defaultDeps = (): FetchDeps => ({
  fetch: (...a) => globalThis.fetch(...a),
  now: Date.now,
  online: () => typeof navigator === 'undefined' || navigator.onLine !== false,
});

/** Lists the repository's newest releases, using and refreshing `cache` (the last ETag and list). */
export async function fetchReleases(repo: string, cache: ReleasesCache | null, deps: FetchDeps = defaultDeps()): Promise<ReleasesResult> {
  if (!deps.online()) return { kind: 'offline' };
  const headers: Record<string, string> = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (cache?.etag) headers['If-None-Match'] = cache.etag;
  let res: Response;
  try {
    // no-store: the ETag is handled here, so the WebView's HTTP cache must not answer for GitHub.
    res = await deps.fetch(`${API}/repos/${repo}/releases?per_page=10`, { headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    // A network error (or a CORS failure, which looks the same): nothing to tell the person.
    return { kind: 'offline' };
  }
  if (res.status === 304 && cache) return { kind: 'ok', releases: cache.releases, cache, notModified: true };
  if (res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')))) {
    return { kind: 'rate-limited', retryAt: retryAtFrom(res.headers, deps.now()) };
  }
  if (!res.ok) return { kind: 'error', status: res.status };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: 'error', status: res.status };
  }
  const releases = toReleaseInfo(body, repo);
  const etag = res.headers.get('etag');
  return { kind: 'ok', releases, cache: etag ? { etag, releases } : null, notModified: false };
}
