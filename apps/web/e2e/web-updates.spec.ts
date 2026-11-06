import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers.ts';

/**
 * Updates for the web app and Home Screen apps (src/updates/web.ts, docs/UPDATES.md): the server's
 * version.json is answered by the test. Also the iPhone/iPad "Add to Home Screen" hint.
 */

const NOTES = '### Writing\n- Faster ink on iPad\n- The web app updates like the Android app';

async function serveVersion(page: Page, version: string | (() => string)) {
  await page.route('**/version.json*', (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify({ version: typeof version === 'string' ? version : version(), notes: NOTES }) }));
}

test.describe('web app updates', () => {
  test('a newer deployment shows the banner, What’s new, Later and Update', async ({ page }) => {
    await serveVersion(page, '9.9.9-next');
    await openApp(page);
    const banner = page.getByRole('region', { name: 'Update' });
    await expect(banner).toContainText('Inkwright 9.9.9-next is ready', { timeout: 20_000 });

    await banner.getByRole('button', { name: 'What’s new' }).click();
    const dialog = page.getByRole('dialog', { name: /What’s new in 9\.9\.9-next/ });
    await expect(dialog).toContainText('Faster ink on iPad');
    await dialog.getByRole('button', { name: 'Close' }).click();

    await banner.getByRole('button', { name: 'Later' }).click();
    await expect(banner).toBeHidden();

    // Settings › About › Updates still offers it, and Check now asks again.
    await page.goto('/?e2e#settings/about');
    const section = page.getByRole('region', { name: 'Updates' }).or(page.locator('section[aria-labelledby="updates-h"]'));
    await expect(section).toContainText('Inkwright 9.9.9-next is ready');
    await section.getByRole('button', { name: 'Check now' }).click();
    await expect(section).toContainText('Last checked');

    // Update reloads into the new version (here the same build, so the offer comes back).
    await section.getByRole('button', { name: 'Update' }).click();
    await page.waitForEvent('load');
  });

  test('nothing is offered when the deployment is the running version', async ({ page }) => {
    const running = await (async () => { await openApp(page); return page.evaluate(() => fetch('./version.json').then((r) => r.json()).then((j) => j.version as string)); })();
    await serveVersion(page, running);
    await page.reload();
    await page.waitForTimeout(10_000);
    await expect(page.getByRole('region', { name: 'Update' })).toHaveCount(0);
  });

  test('after an update the library says so once, with the notes', async ({ page }) => {
    await page.addInitScript(() => { if (!sessionStorage.getItem('seen')) { localStorage.setItem('inkwright.web.version', '0.0.1'); sessionStorage.setItem('seen', '1'); } });
    await openApp(page);
    const running = await page.evaluate(() => fetch('./version.json').then((r) => r.json()).then((j) => j.version as string));
    await serveVersion(page, running);
    const notice = page.getByRole('region', { name: 'Updated' });
    await expect(notice).toContainText(`Updated to Inkwright ${running}`, { timeout: 20_000 });
    await notice.getByRole('button', { name: 'What’s new' }).click();
    await expect(page.getByRole('dialog')).toContainText('The web app updates like the Android app');
    await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
    await expect(notice).toBeHidden();
    await page.reload();
    await page.waitForTimeout(3_000);
    await expect(page.getByRole('region', { name: 'Updated' })).toHaveCount(0);
  });
});

test.describe('Safari on iPhone', () => {
  test.use({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1' });

  test('suggests Add to Home Screen until dismissed', async ({ page }) => {
    await openApp(page);
    const hint = page.getByRole('region', { name: 'Add to Home Screen' });
    await expect(hint).toContainText('Add Inkwright to your Home Screen');
    await hint.getByRole('button', { name: /Not now|Dismiss/ }).click();
    await expect(hint).toBeHidden();
    await page.reload();
    await expect(page.locator('.lib-scroll')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Add to Home Screen' })).toHaveCount(0);
  });

  test('not shown in the Home Screen app', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'standalone', { get: () => true }));
    await openApp(page);
    await expect(page.locator('.lib-scroll')).toBeVisible();
    await page.waitForTimeout(1_000);
    await expect(page.getByRole('region', { name: 'Add to Home Screen' })).toHaveCount(0);
  });
});
