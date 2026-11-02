import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { openApp } from './helpers.ts';

/**
 * Sample notebooks: added from the command palette, written in synthesized handwriting, searchable
 * at once. With SHOTS=<dir> it also captures the README / store screenshots from these pages.
 */
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
const shots = process.env.SHOTS;
if (shots) mkdirSync(shots, { recursive: true });
async function shot(page: Page, name: string) {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function addSamples(page: Page) {
  await page.keyboard.press(`${mod}+k`);
  await page.locator('.pal-input').fill('sample notebooks');
  await page.locator('.pal-row', { hasText: 'Add sample notebooks' }).first().click();
  await expect(page.locator('.note-card', { hasText: 'Lecture 7' })).toBeVisible({ timeout: 15_000 });
}

test('sample notebooks appear, open with ink, and are searchable', async ({ page }) => {
  await openApp(page);
  await addSamples(page);
  await expect(page.locator('.note-card', { hasText: 'Design review' })).toBeVisible();
  await page.waitForTimeout(600); // thumbnails
  await shot(page, 'library');
  await page.locator('nav button', { hasText: 'Signals & Systems' }).first().click();
  await page.waitForTimeout(600);
  await shot(page, 'notebook');

  await page.locator('.note-card', { hasText: 'Lecture 7' }).first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  const strokes = await page.evaluate(() => (window as any).__inkwright.doc.pages[0].strokes.length);
  expect(strokes).toBeGreaterThan(200);
  await page.waitForTimeout(400);
  await shot(page, 'lecture');

  // Recognized text is indexed: palette search finds a phrase written in the sample ink.
  await page.keyboard.press(`${mod}+k`);
  await page.locator('.pal-input').fill('Gibbs');
  await expect(page.locator('.pal-row', { hasText: 'Lecture 7' }).first()).toBeVisible();
  await shot(page, 'search');
});

test('screenshots in dark palettes', async ({ page }) => {
  test.skip(!shots, 'screenshots only');
  await openApp(page);
  await addSamples(page);
  for (const palette of ['aizome', 'celadon', 'sumi']) {
    await page.evaluate((p) => document.documentElement.setAttribute('data-palette', p), palette);
    await page.waitForTimeout(250);
    await shot(page, `library-${palette}`);
  }
  await page.evaluate(() => document.documentElement.setAttribute('data-palette', 'duan'));
  await page.locator('.note-card', { hasText: 'Asking the page' }).first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await page.waitForTimeout(400);
  await shot(page, 'ask');
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.locator('.note-card', { hasText: 'Design review' }).first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await page.waitForTimeout(400);
  await shot(page, 'review-dark');
});
