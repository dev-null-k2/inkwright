import { expect, test } from '@playwright/test';
import { openApp } from './helpers.ts';

// Phones and foldables: the library's search field is the way into search-everything.
test('on touch screens the library search field opens search everything', async ({ page, isMobile }) => {
  test.skip(!isMobile, 'touch layouts only');
  await openApp(page);
  await page.locator('.search input').tap();
  await expect(page.locator('.palette')).toBeVisible();
  await page.locator('.pal-input').fill('flashcards');
  await expect(page.locator('.pal-row', { hasText: 'typed text' }).first()).toBeVisible();
  // The palette fits the screen: no horizontal overflow.
  const fits = await page.evaluate(() => {
    const r = document.querySelector('.palette')!.getBoundingClientRect();
    return r.left >= 0 && r.right <= window.innerWidth;
  });
  expect(fits).toBe(true);
  await page.locator('.pal-row', { hasText: 'typed text' }).first().tap();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await expect(page.locator('.ink-flash')).toBeVisible();
});
