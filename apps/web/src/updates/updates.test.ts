import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchReleases, pickRelease, retryAtFrom, toReleaseInfo, type FetchDeps, type ReleaseInfo } from './github.ts';
import { versionCode as tsVersionCode, isPrerelease } from './versionCode.ts';
import { bannerVisible, isSnoozed, resetUpdatesForTests, snoozeOffer, SNOOZE_MS, useUpdates, type UpdateOffer } from './store.ts';
import { setUpdaterPluginForTests, type UpdaterPlugin, type ProgressEvent, type InstallEvent } from './plugin.ts';
import { __setUpdateDepsForTests, allowInstalls, cancelUpdate, checkForUpdates, setBetaUpdates, startUpdate, startUpdateChecks } from './service.ts';
import { parseNotes } from './ReleaseNotes.tsx';
import { reasonFor } from './messages.ts';
// @ts-expect-error plain ESM build script without type declarations
import { versionCode as mjsVersionCode } from '../../scripts/release/version-code.mjs';
// @ts-expect-error plain ESM build script without type declarations
import { buildManifest, readMinSdk } from '../../scripts/release/android-update.mjs';
import versionCodes from '../../android/app/src/test/resources/version-codes.json';
import variablesGradle from '../../android/variables.gradle?raw';

const REPO = 'dev-null-k2/inkwright';
const fixture = versionCodes as {
  cases: { version: string; code: number | null }[];
  ascending: string[];
  legacyHighest: number;
};

describe('versionCode scheme', () => {
  it('matches the table shared with Kotlin and the release script', () => {
    for (const c of fixture.cases) {
      expect(tsVersionCode(c.version), c.version).toBe(c.code);
      expect(mjsVersionCode(c.version), c.version).toBe(c.code);
    }
  });

  it('orders releases, finals above their betas, and beats every earlier install', () => {
    const codes = fixture.ascending.map((v) => tsVersionCode(v)!);
    expect([...codes].sort((a, b) => a - b)).toEqual(codes);
    expect(tsVersionCode('0.9.0-beta.6')!).toBeGreaterThan(fixture.legacyHighest);
    expect(tsVersionCode('0.9.0')!).toBeGreaterThan(tsVersionCode('0.9.0-rc.99')!);
    expect(isPrerelease('0.9.0-beta.6')).toBe(true);
    expect(isPrerelease('1.0.0')).toBe(false);
  });
});

describe('android-update.json (release script)', () => {
  const apks = [
    { abi: 'x86_64', size: 3, sha256: 'c'.repeat(64) },
    { abi: 'arm64-v8a', size: 1, sha256: 'a'.repeat(64) },
  ];

  it('describes each APK at its release download address', () => {
    const m = buildManifest({ version: '0.9.0-beta.6', repo: REPO, apks, notes: '- Faster ink\n', published: '2026-11-04T10:00:00Z', minSdk: 26 });
    expect(m).toMatchObject({ schema: 1, app: 'app.inkwright', version: '0.9.0-beta.6', versionCode: 900206, channel: 'beta', minSdk: 26, notes: '- Faster ink' });
    expect(Object.keys(m.apks)).toEqual(['arm64-v8a', 'x86_64']);
    expect(m.apks['arm64-v8a']).toEqual({ url: `https://github.com/${REPO}/releases/download/v0.9.0-beta.6/Inkwright-0.9.0-beta.6-arm64-v8a.apk`, size: 1, sha256: 'a'.repeat(64) });
    expect(buildManifest({ version: '1.0.0', repo: REPO, apks, published: 'x', minSdk: 26 }).channel).toBe('stable');
  });

  it('refuses releases the updater could not describe', () => {
    expect(() => buildManifest({ version: '0.9.0-nightly', repo: REPO, apks, published: 'x', minSdk: 26 })).toThrow(/scheme/);
    expect(() => buildManifest({ version: '0.9.0', repo: REPO, apks: apks.slice(0, 1), published: 'x', minSdk: 26 })).toThrow(/arm64-v8a/);
    expect(() => buildManifest({ version: '0.9.0', repo: 'not a repo', apks, published: 'x', minSdk: 26 })).toThrow(/repo/);
  });

  it('keeps notes within what the app accepts', () => {
    const m = buildManifest({ version: '0.9.0', repo: REPO, apks, notes: 'word '.repeat(10_000), published: 'x', minSdk: 26 });
    expect(m.notes.length).toBeLessThanOrEqual(20_000);
    expect(m.notes).toMatch(/release page/);
  });

  it('reads minSdk from the Gradle variables', () => {
    expect(readMinSdk(variablesGradle)).toBe(26);
  });
});

// ---- GitHub ----------------------------------------------------------------------------------------

const asset = (tag: string, name = 'android-update.json', repo = REPO) => ({ name, browser_download_url: `https://github.com/${repo}/releases/download/${tag}/${name}` });
const rawRelease = (tag: string, o: { prerelease?: boolean; draft?: boolean; assets?: unknown[]; published?: string } = {}) => ({
  tag_name: tag,
  prerelease: o.prerelease ?? tag.includes('-'),
  draft: o.draft ?? false,
  published_at: o.published ?? '2026-11-01T00:00:00Z',
  html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
  assets: o.assets ?? [asset(tag), { name: 'Inkwright.apk', browser_download_url: 'x' }],
});

describe('choosing a release', () => {
  const releases = toReleaseInfo([
    rawRelease('v0.9.0-beta.6', { published: '2026-11-03T00:00:00Z' }),
    rawRelease('v0.8.2', { published: '2026-11-04T00:00:00Z' }), // a hotfix of an older line, published later
    rawRelease('v0.9.0-beta.7', { draft: true }),
    rawRelease('v0.9.0-beta.8', { assets: [] }), // no manifest: built before the updater
    rawRelease('v0.9.0-beta.9', { assets: [asset('v0.9.0-beta.9', 'android-update.json', 'someone/else')] }),
    rawRelease('nightly-2026-11-04'),
    rawRelease('v0.8.0'),
  ], REPO);

  it('keeps published releases in the scheme that carry this repository’s manifest', () => {
    expect(releases.map((r) => r.tag)).toEqual(['v0.9.0-beta.6', 'v0.8.2', 'v0.8.0']);
    expect(releases[0]).toMatchObject({ version: '0.9.0-beta.6', versionCode: 900206, prerelease: true, manifestUrl: `https://github.com/${REPO}/releases/download/v0.9.0-beta.6/android-update.json` });
    expect(toReleaseInfo({ message: 'Not Found' }, REPO)).toEqual([]);
  });

  it('beta takes the newest of everything; stable only final releases; by versionCode, not date', () => {
    expect(pickRelease(releases, 'beta')!.tag).toBe('v0.9.0-beta.6');
    expect(pickRelease(releases, 'stable')!.tag).toBe('v0.8.2');
    expect(pickRelease([], 'beta')).toBeNull();
    expect(pickRelease(releases.filter((r) => r.prerelease), 'stable')).toBeNull();
  });
});

function response(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return { status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => body } as unknown as Response;
}

function deps(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, o: { online?: boolean; now?: number } = {}): FetchDeps & { calls: { url: string; init: RequestInit }[] } {
  const calls: { url: string; init: RequestInit }[] = [];
  return {
    calls,
    fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return fetchImpl(url, init); }) as typeof fetch,
    now: () => o.now ?? 1_000_000,
    online: () => o.online ?? true,
  };
}

describe('fetching releases (ETag and rate limit)', () => {
  const list = [rawRelease('v0.9.0-beta.6')];

  it('asks the API for ten releases and keeps the ETag', async () => {
    const d = deps(async () => response(200, list, { etag: 'W/"abc"' }));
    const res = await fetchReleases(REPO, null, d);
    expect(d.calls[0].url).toBe(`https://api.github.com/repos/${REPO}/releases?per_page=10`);
    expect((d.calls[0].init.headers as Record<string, string>)['If-None-Match']).toBeUndefined();
    expect(res).toMatchObject({ kind: 'ok', notModified: false, cache: { etag: 'W/"abc"' } });
    if (res.kind === 'ok') expect(res.releases.map((r) => r.tag)).toEqual(['v0.9.0-beta.6']);
  });

  it('sends If-None-Match and reuses the cached list on 304', async () => {
    const cache = { etag: 'W/"abc"', releases: toReleaseInfo(list, REPO) };
    const d = deps(async () => response(304, null));
    const res = await fetchReleases(REPO, cache, d);
    expect((d.calls[0].init.headers as Record<string, string>)['If-None-Match']).toBe('W/"abc"');
    expect(res).toEqual({ kind: 'ok', releases: cache.releases, cache, notModified: true });
  });

  it('reports the rate limit with when to come back', async () => {
    const reset = 2_000; // seconds
    expect(await fetchReleases(REPO, null, deps(async () => response(403, { message: 'API rate limit exceeded' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) }))))
      .toEqual({ kind: 'rate-limited', retryAt: reset * 1000 });
    expect(await fetchReleases(REPO, null, deps(async () => response(429, {}, { 'retry-after': '60' }), { now: 5_000 })))
      .toEqual({ kind: 'rate-limited', retryAt: 65_000 });
    expect(retryAtFrom(new Headers(), 0)).toBe(60 * 60 * 1000);
  });

  it('is quiet offline and on errors', async () => {
    const never = deps(async () => { throw new Error('should not be called'); }, { online: false });
    expect(await fetchReleases(REPO, null, never)).toEqual({ kind: 'offline' });
    expect(never.calls).toHaveLength(0);
    expect(await fetchReleases(REPO, null, deps(async () => { throw new TypeError('Failed to fetch'); }))).toEqual({ kind: 'offline' });
    expect(await fetchReleases(REPO, null, deps(async () => response(500, {})))).toEqual({ kind: 'error', status: 500 });
    expect(await fetchReleases(REPO, null, deps(async () => response(403, { message: 'blocked' })))).toEqual({ kind: 'error', status: 403 });
  });
});

// ---- Snooze ----------------------------------------------------------------------------------------

const offer = (versionCode = 900206): UpdateOffer => ({ version: '0.9.0-beta.6', versionCode, channel: 'beta', published: '', notes: '', url: 'u', size: 1, abi: 'arm64-v8a', pageUrl: 'p' });

describe('banner and Later', () => {
  beforeEach(() => resetUpdatesForTests());

  it('shows an available update until Later, then for 24 hours not', () => {
    useUpdates.setState({ offer: offer(), phase: { kind: 'available' } });
    expect(bannerVisible(useUpdates.getState())).toBe(true);
    snoozeOffer(1_000);
    const s = useUpdates.getState();
    expect(s.snooze).toEqual({ versionCode: 900206, until: 1_000 + SNOOZE_MS });
    expect(bannerVisible(s, 1_000 + SNOOZE_MS - 1)).toBe(false);
    expect(bannerVisible(s, 1_000 + SNOOZE_MS)).toBe(true);
  });

  it('shows a newer version at once even while an older one is snoozed', () => {
    useUpdates.setState({ snooze: { versionCode: 900206, until: Date.now() + SNOOZE_MS } });
    expect(isSnoozed(useUpdates.getState(), offer(900206))).toBe(true);
    expect(isSnoozed(useUpdates.getState(), offer(900207))).toBe(false);
  });

  it('keeps showing an update that is under way, and nothing when up to date', () => {
    useUpdates.setState({ offer: offer(), snooze: { versionCode: 900206, until: Date.now() + SNOOZE_MS } });
    for (const kind of ['downloading', 'verifying', 'installing'] as const) {
      useUpdates.setState({ phase: kind === 'downloading' ? { kind, loaded: 0, total: 1 } : kind === 'installing' ? { kind, path: 'p' } : { kind } });
      expect(bannerVisible(useUpdates.getState()), kind).toBe(true);
    }
    useUpdates.setState({ phase: { kind: 'up-to-date' } });
    expect(bannerVisible(useUpdates.getState())).toBe(false);
    useUpdates.setState({ offer: null, phase: { kind: 'available' } });
    expect(bannerVisible(useUpdates.getState())).toBe(false);
  });

  it('remembers choices across restarts', () => {
    useUpdates.setState({ beta: false, snooze: { versionCode: 1, until: 2 }, lastChecked: 3 });
    const saved = JSON.parse(localStorage.getItem('inkwright.updates.v1')!);
    expect(saved).toMatchObject({ beta: false, snooze: { versionCode: 1, until: 2 }, lastChecked: 3 });
  });
});

// ---- The whole flow with a scripted plugin ---------------------------------------------------------

interface Fake extends UpdaterPlugin {
  emit(event: 'progress', e: ProgressEvent): void;
  emit(event: 'install', e: InstallEvent): void;
  emit(event: 'installPermission', e: { granted: boolean }): void;
  calls: string[];
  canInstall: boolean;
  downloadImpl: () => Promise<{ path: string }>;
  apk: { abi: string; url: string; size: number; sha256: string } | null;
  build: string;
}

function fakePlugin(): Fake {
  const listeners = new Map<string, Set<(e: never) => void>>();
  const f: Fake = {
    calls: [],
    canInstall: true,
    build: '900205',
    apk: { abi: 'arm64-v8a', url: `https://github.com/${REPO}/releases/download/v0.9.0-beta.6/Inkwright-0.9.0-beta.6-arm64-v8a.apk`, size: 1000, sha256: 'a'.repeat(64) },
    downloadImpl: async () => {
      f.emit('progress', { phase: 'download', loaded: 500, total: 1000 });
      f.emit('progress', { phase: 'verify', loaded: 1000, total: 1000 });
      return { path: '/cache/updates/Inkwright-900206-arm64-v8a.apk' };
    },
    emit: ((event: string, e: unknown) => listeners.get(event)?.forEach((l) => l(e as never))) as Fake['emit'],
    appInfo: async () => ({ version: '0.9.0-beta.5', build: f.build }),
    info: async () => ({ abis: ['arm64-v8a'], sdk: 35, repo: REPO, distribution: 'github', canInstall: f.canInstall, installerOfRecord: true, installer: 'app.inkwright' }),
    fetchManifest: async ({ url }) => {
      f.calls.push(`fetchManifest ${url}`);
      return { manifest: { version: '0.9.0-beta.6', versionCode: 900206, channel: 'beta', published: '2026-11-04T10:00:00Z', minSdk: 26, notes: '- Faster ink' }, apk: f.apk };
    },
    download: async ({ url }) => { f.calls.push(`download ${url}`); return f.downloadImpl(); },
    cancel: async () => { f.calls.push('cancel'); },
    install: async ({ path }) => { f.calls.push(`install ${path}`); return { status: f.canInstall ? 'started' : 'needs-permission' }; },
    openInstallSettings: async () => { f.calls.push('openInstallSettings'); },
    cleanup: async () => ({ removed: 0 }),
    addListener: (async (event: string, cb: (e: never) => void) => {
      (listeners.get(event) ?? listeners.set(event, new Set()).get(event)!).add(cb);
      return { remove: async () => void listeners.get(event)?.delete(cb) };
    }) as UpdaterPlugin['addListener'],
  };
  return f;
}

describe('checking and updating', () => {
  let fake: Fake;
  let api: ReturnType<typeof deps>;
  let releases: unknown[];

  beforeEach(() => {
    resetUpdatesForTests();
    localStorage.clear();
    fake = fakePlugin();
    setUpdaterPluginForTests(fake);
    releases = [rawRelease('v0.9.0-beta.6'), rawRelease('v0.8.0')];
    api = deps(async (_url, init) => ((init.headers as Record<string, string>)['If-None-Match'] === '"e1"' ? response(304, null) : response(200, releases, { etag: '"e1"' })), { now: Date.now() });
    __setUpdateDepsForTests(api);
  });
  afterEach(() => {
    setUpdaterPluginForTests(undefined);
    __setUpdateDepsForTests(undefined);
    vi.useRealTimers();
  });

  it('offers a newer release with its notes and size', async () => {
    await checkForUpdates();
    const s = useUpdates.getState();
    expect(s.current).toEqual({ version: '0.9.0-beta.5', versionCode: 900205 });
    expect(s.phase).toEqual({ kind: 'available' });
    expect(s.offer).toMatchObject({ version: '0.9.0-beta.6', versionCode: 900206, notes: '- Faster ink', size: 1000, abi: 'arm64-v8a' });
    expect(s.lastChecked).not.toBeNull();
    expect(s.silentInstall).toBe(true);
    expect(fake.calls).toEqual([`fetchManifest https://github.com/${REPO}/releases/download/v0.9.0-beta.6/android-update.json`]);
  });

  it('is up to date without reading any manifest when nothing is newer', async () => {
    fake.build = '900206';
    await checkForUpdates();
    expect(useUpdates.getState().phase).toEqual({ kind: 'up-to-date' });
    expect(fake.calls).toEqual([]);
  });

  it('follows the channel: stable skips betas', async () => {
    await setBetaUpdates(false);
    expect(useUpdates.getState().beta).toBe(false);
    expect(useUpdates.getState().phase).toEqual({ kind: 'up-to-date' });
    await setBetaUpdates(true);
    expect(useUpdates.getState().offer?.version).toBe('0.9.0-beta.6');
  });

  it('says so when a release has no build for this phone', async () => {
    fake.apk = null;
    await checkForUpdates();
    expect(useUpdates.getState()).toMatchObject({ phase: { kind: 'up-to-date' }, note: 'no-apk', offer: null });
  });

  it('uses the ETag on the next check', async () => {
    await checkForUpdates();
    await checkForUpdates({ manual: true });
    expect((api.calls[1].init.headers as Record<string, string>)['If-None-Match']).toBe('"e1"');
    expect(useUpdates.getState().phase).toEqual({ kind: 'available' });
    // The same offer is kept: its manifest is not read again.
    expect(fake.calls.filter((c) => c.startsWith('fetchManifest'))).toHaveLength(1);
  });

  it('backs off quietly when GitHub rate-limits, until Check now', async () => {
    const reset = Math.floor(Date.now() / 1000) + 3600;
    __setUpdateDepsForTests(deps(async () => response(403, {}, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })));
    await checkForUpdates();
    expect(useUpdates.getState()).toMatchObject({ note: 'rate-limited', retryAt: reset * 1000, phase: { kind: 'idle' } });
    __setUpdateDepsForTests(api);
    await checkForUpdates();
    expect(api.calls).toHaveLength(0); // automatic checks wait
    await checkForUpdates({ manual: true });
    expect(api.calls).toHaveLength(1);
    expect(useUpdates.getState()).toMatchObject({ note: null, retryAt: null, phase: { kind: 'available' } });
  });

  it('stays quiet offline', async () => {
    __setUpdateDepsForTests(deps(async () => response(200, []), { online: false }));
    await checkForUpdates();
    expect(useUpdates.getState()).toMatchObject({ note: 'offline', phase: { kind: 'idle' }, offer: null });
  });

  it('downloads with progress, then installs', async () => {
    await checkForUpdates();
    const seen: string[] = [];
    const unsub = useUpdates.subscribe((s) => seen.push(s.phase.kind === 'downloading' ? `downloading ${s.phase.loaded}` : s.phase.kind));
    await startUpdate();
    unsub();
    expect(seen).toEqual(['downloading 0', 'downloading 500', 'verifying', 'ready', 'installing']);
    expect(fake.calls.slice(1)).toEqual([`download ${fake.apk!.url}`, 'install /cache/updates/Inkwright-900206-arm64-v8a.apk']);
    fake.emit('install', { status: 'pending-user-action' });
    expect(useUpdates.getState().phase.kind).toBe('installing');
    fake.emit('install', { status: 'success' });
    expect(useUpdates.getState()).toMatchObject({ phase: { kind: 'up-to-date' }, offer: null });
  });

  it('asks for "Install unknown apps" and resumes when it is allowed', async () => {
    fake.canInstall = false;
    await checkForUpdates();
    await startUpdate();
    expect(useUpdates.getState().phase).toEqual({ kind: 'permission', path: '/cache/updates/Inkwright-900206-arm64-v8a.apk' });
    await allowInstalls();
    expect(fake.calls).toContain('openInstallSettings');
    fake.emit('installPermission', { granted: false });
    expect(useUpdates.getState().phase.kind).toBe('permission');
    fake.canInstall = true;
    fake.emit('installPermission', { granted: true });
    await vi.waitFor(() => expect(useUpdates.getState().phase.kind).toBe('installing'));
    expect(fake.calls.filter((c) => c.startsWith('install '))).toHaveLength(2);
  });

  it('cancelling the download goes back to the offer', async () => {
    await checkForUpdates();
    let reject!: (e: unknown) => void;
    fake.downloadImpl = () => new Promise((_, r) => { reject = r; });
    const running = startUpdate();
    await vi.waitFor(() => expect(useUpdates.getState().phase.kind).toBe('downloading'));
    await cancelUpdate();
    expect(fake.calls).toContain('cancel');
    reject(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
    await running;
    expect(useUpdates.getState().phase).toEqual({ kind: 'available' });
  });

  it('explains failures in plain language and retries', async () => {
    await checkForUpdates();
    fake.downloadImpl = async () => { throw Object.assign(new Error('x'), { code: 'signature' }); };
    await startUpdate();
    expect(useUpdates.getState().phase).toEqual({ kind: 'failed', reason: reasonFor('signature'), retry: 'download' });
    expect(reasonFor('signature')).toMatch(/isn’t signed with Inkwright’s key/);
    fake.downloadImpl = fakePlugin().downloadImpl;
    await startUpdate();
    expect(useUpdates.getState().phase.kind).toBe('installing');
    // Android's own refusal: back to failed with its reason.
    fake.emit('install', { status: 'failure', reason: 'conflict' });
    expect(useUpdates.getState().phase).toMatchObject({ kind: 'failed', retry: 'install', reason: reasonFor('conflict', 'install') });
  });

  it('treats cancelling Android’s confirmation as “ready to install”', async () => {
    await checkForUpdates();
    await startUpdate();
    fake.emit('install', { status: 'failure', reason: 'aborted' });
    expect(useUpdates.getState().phase).toEqual({ kind: 'ready', path: '/cache/updates/Inkwright-900206-arm64-v8a.apk' });
  });

  it('checks after startup and then every six hours, not on every launch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval', 'Date'] });
    const stop = startUpdateChecks({ firstDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    await vi.waitFor(() => expect(api.calls).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(5 * 60 * 60 * 1000);
    expect(api.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 15 * 60 * 1000);
    await vi.waitFor(() => expect(api.calls).toHaveLength(2));
    stop();
    // A relaunch minutes later doesn't ask again.
    const again = startUpdateChecks({ firstDelayMs: 1000 });
    await vi.advanceTimersByTimeAsync(1100);
    expect(api.calls).toHaveLength(2);
    again();
  });
});

describe('release notes', () => {
  it('reads headings, bullets with wrapped lines and paragraphs', () => {
    expect(parseNotes('### Ink\n- Faster **pen**\n  across pages\n- Fix\n\nThanks to `you`.')).toEqual([
      { kind: 'heading', text: 'Ink' },
      { kind: 'list', items: ['Faster **pen** across pages', 'Fix'] },
      { kind: 'paragraph', text: 'Thanks to `you`.' },
    ]);
    expect(parseNotes('')).toEqual([]);
  });
});
