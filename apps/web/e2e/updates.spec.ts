import { expect, test, type Page, type Route } from '@playwright/test';
import { openApp } from './helpers.ts';

/**
 * In-app updates (docs/UPDATES.md), driven in a desktop browser: GitHub's API is answered by the
 * test, and the native updater (UpdaterPlugin.kt) by a scripted stand-in that e2e builds read
 * from `window.__inkwrightFakeUpdater` (updates/plugin.ts). It speaks the plugin's protocol:
 * a validated manifest, `progress` events while downloading, `install` and `installPermission`
 * events. What only a phone can show — the download itself, the checks against the real APK and
 * Android's installer — is covered by the JVM tests and must be checked on a device.
 */

const REPO = 'dev-null-k2/inkwright';
const BASE = `https://github.com/${REPO}/releases/download`;

interface Script {
  build: string;
  canInstall: boolean;
  /** ms between progress steps (a slow download can be cancelled). */
  stepMs: number;
  failDownload?: string;
}

async function installFakeUpdater(page: Page, script: Partial<Script> = {}) {
  await page.addInitScript((s: Script) => {
    const listeners: Record<string, Set<(e: unknown) => void>> = {};
    const emit = (ev: string, data: unknown) => listeners[ev]?.forEach((l) => l(data));
    const calls: string[] = [];
    let cancelled = false;
    const w = window as any;
    w.__updaterCalls = calls;
    w.__updaterScript = s;
    w.__updaterEmit = emit;
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    w.__inkwrightFakeUpdater = {
      async appInfo() { return { version: '0.9.0-beta.5', build: w.__updaterScript.build }; },
      async info() { return { abis: ['arm64-v8a', 'armeabi-v7a'], sdk: 35, repo: 'dev-null-k2/inkwright', distribution: 'github', canInstall: w.__updaterScript.canInstall, installerOfRecord: true, installer: 'app.inkwright' }; },
      async fetchManifest({ url }: { url: string }) {
        calls.push(`fetchManifest ${url}`);
        return {
          manifest: { version: '0.9.0-beta.6', versionCode: 900206, channel: 'beta', published: '2026-11-04T10:00:00Z', minSdk: 26, notes: '### Writing\n- Faster ink on the **Razr Fold**\n- Updates install from inside the app' },
          apk: { abi: 'arm64-v8a', url: 'https://github.com/dev-null-k2/inkwright/releases/download/v0.9.0-beta.6/Inkwright-0.9.0-beta.6-arm64-v8a.apk', size: 61_000_000, sha256: 'a'.repeat(64) },
        };
      },
      async download({ url }: { url: string }) {
        calls.push(`download ${url}`);
        cancelled = false;
        for (const f of [0.25, 0.5, 0.75, 1]) {
          await sleep(w.__updaterScript.stepMs);
          if (cancelled) throw Object.assign(new Error('cancelled'), { code: 'cancelled' });
          emit('progress', { phase: 'download', loaded: Math.round(61_000_000 * f), total: 61_000_000 });
        }
        emit('progress', { phase: 'verify', loaded: 61_000_000, total: 61_000_000 });
        await sleep(w.__updaterScript.stepMs);
        if (w.__updaterScript.failDownload) throw Object.assign(new Error('x'), { code: w.__updaterScript.failDownload });
        return { path: '/data/user/0/app.inkwright/cache/updates/Inkwright-900206-arm64-v8a.apk' };
      },
      async cancel() { calls.push('cancel'); cancelled = true; },
      async install({ path }: { path: string }) {
        calls.push(`install ${path}`);
        return { status: w.__updaterScript.canInstall ? 'started' : 'needs-permission' };
      },
      async openInstallSettings() { calls.push('openInstallSettings'); },
      async cleanup() { return { removed: 0 }; },
      async addListener(ev: string, cb: (e: unknown) => void) {
        (listeners[ev] ??= new Set()).add(cb);
        return { remove: async () => void listeners[ev]!.delete(cb) };
      },
    };
  }, { build: '900205', canInstall: true, stepMs: 120, ...script });
}

const release = (tag: string, prerelease = tag.includes('-')) => ({
  tag_name: tag, prerelease, draft: false, published_at: '2026-11-04T10:00:00Z', html_url: `https://github.com/${REPO}/releases/tag/${tag}`,
  assets: [{ name: 'android-update.json', browser_download_url: `${BASE}/${tag}/android-update.json` }],
});

type Api = { requests: { ifNoneMatch: string | undefined }[] };

/** Answers GitHub's releases API: a list with an ETag, 304 when asked with it, or a scripted failure. */
async function githubApi(page: Page, mode: 'ok' | 'rate-limited' | 'offline' = 'ok', releases = [release('v0.9.0-beta.6'), release('v0.8.0')]): Promise<Api> {
  const api: Api = { requests: [] };
  await page.route('https://api.github.com/**', async (route: Route) => {
    const req = route.request();
    const ifNoneMatch = req.headers()['if-none-match'];
    if (req.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    api.requests.push({ ifNoneMatch });
    expect(req.url()).toBe(`https://api.github.com/repos/${REPO}/releases?per_page=10`);
    if (mode === 'offline') return route.abort('internetdisconnected');
    if (mode === 'rate-limited') return route.fulfill({ status: 403, headers: { ...cors, 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800) }, body: '{"message":"API rate limit exceeded"}' });
    if (ifNoneMatch === '"r1"') return route.fulfill({ status: 304, headers: { ...cors, etag: '"r1"' } });
    return route.fulfill({ status: 200, headers: { ...cors, etag: '"r1"', 'content-type': 'application/json' }, body: JSON.stringify(releases) });
  });
  return api;
}

const cors = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'Accept, If-None-Match, X-GitHub-Api-Version',
  'access-control-expose-headers': 'ETag, X-RateLimit-Remaining, X-RateLimit-Reset, Retry-After',
};

const banner = (page: Page) => page.getByRole('region', { name: 'Update', exact: true });
const calls = (page: Page) => page.evaluate(() => (window as any).__updaterCalls as string[]);

test.describe('in-app updates', () => {
  test('the library offers the new release; What’s new; Update downloads and installs', async ({ page }) => {
    await installFakeUpdater(page);
    const api = await githubApi(page);
    await openApp(page);
    const b = banner(page);
    await expect(b.getByText('Inkwright 0.9.0-beta.6 is ready')).toBeVisible({ timeout: 15_000 });
    expect(api.requests).toHaveLength(1);
    expect(await calls(page)).toEqual([`fetchManifest ${BASE}/v0.9.0-beta.6/android-update.json`]);

    await b.getByRole('button', { name: 'What’s new' }).click();
    const notes = page.getByRole('dialog', { name: 'What’s new in 0.9.0-beta.6' });
    await expect(notes.getByRole('heading', { name: 'Writing' })).toBeVisible();
    await expect(notes.getByText('Faster ink on the')).toBeVisible();
    await expect(notes.locator('strong')).toHaveText('Razr Fold');
    await expect(notes.getByRole('link', { name: 'Release page on GitHub' })).toHaveAttribute('href', `https://github.com/${REPO}/releases/tag/v0.9.0-beta.6`);
    await notes.getByRole('button', { name: 'Close' }).click();
    await expect(notes).toBeHidden();

    await b.getByRole('button', { name: 'Update' }).click();
    await expect(b.getByRole('progressbar', { name: 'Downloading the update' })).toBeVisible();
    await expect(b.getByText(/Downloading Inkwright 0\.9\.0-beta\.6/)).toBeVisible();
    await expect(b.getByText(/(25|50|75)% of 61 MB/)).toBeVisible();
    await expect(b.getByText('Installing Inkwright 0.9.0-beta.6…')).toBeVisible();
    expect((await calls(page)).slice(1)).toEqual([
      `download ${BASE}/v0.9.0-beta.6/Inkwright-0.9.0-beta.6-arm64-v8a.apk`,
      'install /data/user/0/app.inkwright/cache/updates/Inkwright-900206-arm64-v8a.apk',
    ]);
    // Android installs it (the real app is replaced and restarts here).
    await page.evaluate(() => (window as any).__updaterEmit('install', { status: 'success', reason: null }));
    await expect(b).toBeHidden();
  });

  test('Later hides the banner for a day, also after a restart', async ({ page }) => {
    await installFakeUpdater(page);
    await githubApi(page);
    await openApp(page);
    await expect(banner(page)).toBeVisible({ timeout: 15_000 });
    await banner(page).getByRole('button', { name: 'Later' }).click();
    await expect(banner(page)).toBeHidden();
    const snooze = await page.evaluate(() => JSON.parse(localStorage.getItem('inkwright.updates.v1')!).snooze);
    expect(snooze.versionCode).toBe(900206);
    expect(snooze.until - Date.now()).toBeGreaterThan(23.9 * 3600_000);
    await page.reload();
    await expect(page.locator('.library')).toBeVisible();
    await page.waitForTimeout(4500);
    await expect(banner(page)).toBeHidden();
    // Settings still says an update is there.
    await page.goto('/?e2e#settings/about');
    await expect(page.getByText('Inkwright 0.9.0-beta.6 is ready')).toBeVisible();
  });

  test('offline and rate-limited checks stay quiet in the library', async ({ page }) => {
    await installFakeUpdater(page);
    const api = await githubApi(page, 'offline');
    await openApp(page);
    await expect.poll(() => api.requests.length, { timeout: 15_000 }).toBe(1);
    await page.waitForTimeout(500);
    await expect(banner(page)).toBeHidden();
    await page.goto('/?e2e#settings/about');
    await expect(page.getByText('Couldn’t reach GitHub. Inkwright will try again when you’re online.')).toBeVisible();
  });

  test('a rate limit is waited out, and Check now uses the ETag', async ({ page }) => {
    await installFakeUpdater(page);
    let mode: 'ok' | 'rate-limited' = 'rate-limited';
    const requests: (string | undefined)[] = [];
    await page.route('https://api.github.com/**', (route) => {
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      const inm = route.request().headers()['if-none-match'];
      requests.push(inm);
      if (mode === 'rate-limited') return route.fulfill({ status: 403, headers: { ...cors, 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 1800) }, body: '{}' });
      if (inm === '"r1"') return route.fulfill({ status: 304, headers: { ...cors, etag: '"r1"' } });
      return route.fulfill({ status: 200, headers: { ...cors, etag: '"r1"', 'content-type': 'application/json' }, body: JSON.stringify([release('v0.9.0-beta.6')]) });
    });
    await openApp(page);
    await expect.poll(() => requests.length, { timeout: 15_000 }).toBe(1);
    await expect(banner(page)).toBeHidden();
    const retryAt = await page.evaluate(() => JSON.parse(localStorage.getItem('inkwright.updates.v1')!).retryAt);
    expect(retryAt).toBeGreaterThan(Date.now() + 25 * 60_000);
    // A restart doesn't ask again while GitHub said to wait.
    await page.reload();
    await expect(page.locator('.library')).toBeVisible();
    await page.waitForTimeout(4500);
    expect(requests).toHaveLength(1);
    await page.goto('/?e2e#settings/about');
    await expect(page.getByText('GitHub is limiting how often this network may ask. Inkwright will try again later.')).toBeVisible();

    mode = 'ok';
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.getByText('Inkwright 0.9.0-beta.6 is ready')).toBeVisible();
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2]).toBe('"r1"');
    await expect(page.getByText('Inkwright 0.9.0-beta.6 is ready')).toBeVisible();
  });

  test('Settings › About › Updates shows every state', async ({ page }) => {
    await installFakeUpdater(page, { build: '900206', stepMs: 400 });
    await githubApi(page);
    await page.goto('/?e2e#settings/about');
    const card = page.locator('.updates-card');
    await expect(card.getByText('Version 0.9.0-beta.5')).toBeVisible();
    // Up to date (the running build is 0.9.0-beta.6).
    await expect(card.getByText('Inkwright is up to date')).toBeVisible({ timeout: 15_000 });
    await expect(card.getByText(/Last checked/)).toBeVisible();
    await expect(card.getByRole('switch', { name: /Beta updates/ })).toBeChecked();
    await expect(card.getByRole('switch', { name: /Check automatically/ })).toBeChecked();

    // An older build: update available.
    await page.evaluate(() => { (window as any).__updaterScript.build = '900205'; (window as any).__updaterScript.canInstall = false; });
    await card.getByRole('button', { name: 'Check now' }).click();
    await expect(card.getByText('Inkwright 0.9.0-beta.6 is ready')).toBeVisible();
    await expect(card.getByText('· 61 MB')).toBeVisible();

    // Stable channel: no stable release is newer.
    await card.getByText('Beta updates').click();
    await expect(card.getByText('Inkwright is up to date')).toBeVisible();
    await card.getByText('Beta updates').click();
    await expect(card.getByText('Inkwright 0.9.0-beta.6 is ready')).toBeVisible();

    // Downloading, cancelled.
    await card.getByRole('button', { name: 'Update' }).click();
    await expect(card.getByRole('progressbar')).toBeVisible();
    await card.getByRole('button', { name: 'Cancel' }).click();
    await expect(card.getByText('Inkwright 0.9.0-beta.6 is ready')).toBeVisible();
    await expect.poll(() => calls(page)).toContain('cancel');

    // Downloading → checking → Android needs "Install unknown apps".
    await card.getByRole('button', { name: 'Update' }).click();
    await expect(card.getByText('Checking the download…')).toBeVisible();
    await expect(card.getByText('Allow Inkwright to install updates')).toBeVisible();
    await expect(card.getByText(/Turn on “Allow from this source”/)).toBeVisible();
    await card.getByRole('button', { name: 'Open Android settings' }).click();
    await expect.poll(() => calls(page)).toContain('openInstallSettings');
    // The person allows it and comes back: the install continues by itself.
    await page.evaluate(() => { (window as any).__updaterScript.canInstall = true; (window as any).__updaterEmit('installPermission', { granted: true }); });
    await expect(card.getByText('Installing Inkwright 0.9.0-beta.6…')).toBeVisible();
    // They cancel Android's confirmation: ready to install.
    await page.evaluate(() => (window as any).__updaterEmit('install', { status: 'failure', reason: 'aborted' }));
    await expect(card.getByText('Inkwright 0.9.0-beta.6 is ready to install')).toBeVisible();
    await card.getByRole('button', { name: 'Install' }).click();
    await expect(card.getByText('Installing Inkwright 0.9.0-beta.6…')).toBeVisible();
    // Android refuses: a plain reason and Try again.
    await page.evaluate(() => (window as any).__updaterEmit('install', { status: 'failure', reason: 'conflict' }));
    await expect(card.getByText('The update didn’t finish')).toBeVisible();
    await expect(card.getByText(/signed with a different key/)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Try again' })).toBeVisible();

    // Automatic checks can be switched off (the Updates module).
    await card.getByText('Check automatically').click();
    await expect(card.getByRole('switch', { name: /Check automatically/ })).not.toBeChecked();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('inkwright.modules.v1')!).enabled.updates)).toBe(false);
  });

  test('a failed download explains itself in the banner and retries', async ({ page }) => {
    await installFakeUpdater(page, { failDownload: 'signature', stepMs: 50 });
    await githubApi(page);
    await openApp(page);
    const b = banner(page);
    await b.getByRole('button', { name: 'Update' }).click({ timeout: 15_000 });
    await expect(b.getByText('The update didn’t finish')).toBeVisible();
    await expect(b.getByText('The downloaded app isn’t signed with Inkwright’s key, so it wasn’t installed.')).toBeVisible();
    await page.evaluate(() => { (window as any).__updaterScript.failDownload = undefined; });
    await b.getByRole('button', { name: 'Try again' }).click();
    await expect(b.getByText('Installing Inkwright 0.9.0-beta.6…')).toBeVisible();
  });

  test('without the native updater (web, Google Play builds) nothing checks', async ({ page }) => {
    const api = await githubApi(page);
    await openApp(page);
    await page.waitForTimeout(4500);
    expect(api.requests).toHaveLength(0);
    await page.goto('/?e2e#settings/about');
    await expect(page.locator('.updates-card')).toHaveCount(0);
  });

  for (const screen of [
    { name: 'phone folded (412 px)', width: 412, height: 915, insets: { top: 40, bottom: 24 } },
    { name: 'Razr Fold inner screen (720 px)', width: 720, height: 800, insets: { top: 32, bottom: 24 } },
  ]) {
    test.describe(screen.name, () => {
      test.use({ viewport: { width: screen.width, height: screen.height }, hasTouch: true });

      test('the banner, What’s new and Settings › Updates fit', async ({ page }) => {
        await page.addInitScript((v) => {
          const set = () => { const s = document.documentElement.style; s.setProperty('--safe-area-inset-top', `${v.top}px`); s.setProperty('--safe-area-inset-bottom', `${v.bottom}px`); };
          if (document.documentElement) set();
          document.addEventListener('DOMContentLoaded', set);
        }, screen.insets);
        await installFakeUpdater(page, { stepMs: 600 });
        await githubApi(page);
        await openApp(page);
        const b = banner(page);
        await expect(b).toBeVisible({ timeout: 15_000 });
        const fits = async (label: string) => {
          const r = await b.boundingBox();
          expect(r, label).not.toBeNull();
          expect(r!.x, `${label}: left`).toBeGreaterThanOrEqual(0);
          expect(r!.x + r!.width, `${label}: right`).toBeLessThanOrEqual(screen.width + 1);
          for (const btn of await b.getByRole('button').all()) {
            const br = (await btn.boundingBox())!;
            expect(br.x + br.width, `${label}: ${await btn.textContent()} inside the banner`).toBeLessThanOrEqual(r!.x + r!.width + 1);
            expect(br.height, `${label}: ${await btn.textContent()} is a comfortable tap`).toBeGreaterThanOrEqual(36);
          }
          expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${label}: no sideways scroll`).toBe(true);
        };
        await fits('offer');
        await b.getByRole('button', { name: 'What’s new' }).click();
        const d = page.locator('.dialog');
        const dr = (await d.boundingBox())!;
        expect(dr.y).toBeGreaterThanOrEqual(screen.insets.top - 1);
        expect(dr.y + dr.height).toBeLessThanOrEqual(screen.height - screen.insets.bottom + 1);
        expect(dr.x + dr.width).toBeLessThanOrEqual(screen.width + 1);
        await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
        await b.getByRole('button', { name: 'Update' }).click();
        await expect(b.getByRole('progressbar')).toBeVisible();
        await fits('downloading');

        // Settings while it downloads (the same page: the download carries on).
        await page.goto('/?e2e#settings/about');
        const card = page.locator('.updates-card');
        await expect(card.getByRole('status')).toContainText('Inkwright 0.9.0-beta.6');
        const cr = (await card.boundingBox())!;
        expect(cr.x + cr.width).toBeLessThanOrEqual(screen.width + 1);
        for (const btn of await card.getByRole('button').all()) {
          const br = (await btn.boundingBox())!;
          expect(br.x + br.width, `${await btn.textContent()} inside the card`).toBeLessThanOrEqual(cr.x + cr.width + 1);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      });
    });
  }
});
