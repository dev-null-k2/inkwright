import { expect, test } from '@playwright/test';
import { openApp } from './helpers.ts';

for (const screen of ['library', 'editor', 'settings'] as const) {
  test(`${screen} fits the screen without horizontal scrolling or errors`, async ({ page }, info) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openApp(page);
    if (screen === 'editor') {
      await page.locator('.note-open').first().click();
      await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
      await expect(page.locator('.dock')).toBeVisible();
    }
    if (screen === 'settings') {
      if (await page.getByRole('button', { name: 'Settings' }).isVisible()) await page.getByRole('button', { name: 'Settings' }).click();
      else { await page.getByRole('button', { name: 'Menu' }).click(); await page.getByRole('button', { name: 'Settings' }).click(); }
      await expect(page.locator('.settings')).toBeVisible();
    }
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `test-results/${info.project.name}-${screen}.png` });
    expect(errors).toEqual([]);
  });
}

test('every pen in the tray is reachable on this screen', async ({ page }) => {
  await openApp(page);
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  const pens = page.locator('.pen');
  const n = await pens.count();
  for (let i = 0; i < n; i++) {
    await pens.nth(i).scrollIntoViewIfNeeded();
    await expect(pens.nth(i)).toBeInViewport();
  }
});
