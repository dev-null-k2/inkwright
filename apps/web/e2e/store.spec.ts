import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { modKey, openApp } from './helpers.ts';

/**
 * Google Play store screenshots, from the real app with the sample notebooks:
 *   STORE=<dir> npx playwright test e2e/store.spec.ts --project desktop
 * Writes <dir>/{phone,tablet-7,tablet-10}/NN-name.png at the sizes Play accepts (each side
 * 320–3840 px, long side at most twice the short side).
 */
const out = process.env.STORE;
test.skip(!out, 'store screenshots only (set STORE=<dir>)');

const DEVICES = [
  { dir: 'phone', viewport: { width: 405, height: 720 }, scale: 2.6667 }, // 1080×1920
  { dir: 'tablet-7', viewport: { width: 600, height: 960 }, scale: 2 }, // 1200×1920
  { dir: 'tablet-10', viewport: { width: 1280, height: 800 }, scale: 2 }, // 2560×1600
];

async function samples(page: Page) {
  await page.keyboard.press(`${await modKey(page)}+k`);
  await page.locator('.pal-input').fill('sample notebooks');
  await page.locator('.pal-row', { hasText: 'Add sample notebooks' }).first().click();
  await expect(page.locator('.note-card', { hasText: 'Lecture 7' }).first()).toBeAttached({ timeout: 20_000 });
}

async function open(page: Page, title: string) {
  await page.locator('.note-card', { hasText: title }).first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await page.waitForTimeout(500);
}

for (const d of DEVICES) {
  test.describe(d.dir, () => {
    test.use({ viewport: d.viewport, deviceScaleFactor: d.scale, hasTouch: true });
    test(`store screenshots: ${d.dir}`, async ({ page }) => {
      const dir = `${out}/${d.dir}`;
      mkdirSync(dir, { recursive: true });
      const shot = (n: string) => page.screenshot({ path: `${dir}/${n}.png` });
      await openApp(page);
      await samples(page);
      await page.waitForTimeout(800);
      await shot('01-library');
      await open(page, 'Asking the page');
      await shot('02-ai-answers-in-ink');
      await page.getByRole('button', { name: 'Back to library' }).click();
      await open(page, 'Lecture 7');
      await shot('03-lecture');
      await page.getByRole('button', { name: 'Back to library' }).click();
      await open(page, 'Design review');
      await shot('04-design-review');
      await page.getByRole('button', { name: 'Back to library' }).click();
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await page.evaluate(() => document.documentElement.setAttribute('data-palette', 'aizome'));
      await page.waitForTimeout(400);
      await shot('05-library-night');
      await page.evaluate(() => { document.documentElement.removeAttribute('data-theme'); document.documentElement.setAttribute('data-palette', 'duan'); });
      await page.keyboard.press(`${await modKey(page)}+k`);
      await page.locator('.pal-input').fill('Gibbs');
      await expect(page.locator('.pal-row', { hasText: 'Lecture 7' }).first()).toBeVisible();
      await shot('06-search-handwriting');
    });
  });
}
