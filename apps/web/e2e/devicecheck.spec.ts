import { expect, test } from '@playwright/test';
import { openApp, settingsGroup } from './helpers.ts';

/**
 * Settings › About › Check this device: draw on the test pad, make the report, copy it. The
 * numbers only mean something on a real device; here we check that it runs end to end and that
 * the report carries what it measured (synthetic pen events with pressure and tilt, and the
 * system bars as the Android app reports them).
 */
test('draws on the test pad and makes a report to copy', async ({ page, context, browserName }) => {
  await page.addInitScript(() => {
    const set = () => { document.documentElement.style.setProperty('--safe-area-inset-top', '32px'); document.documentElement.style.setProperty('--safe-area-inset-bottom', '24px'); };
    if (document.documentElement) set();
    document.addEventListener('DOMContentLoaded', set);
  });
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await settingsGroup(page, 'About');
  await page.getByRole('button', { name: 'Check this device' }).click();
  const dialog = page.getByRole('dialog', { name: 'Check this device' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Make report' })).toBeEnabled({ timeout: 10_000 });
  // The layout check runs live, and again when the window changes size (folding, rotating).
  const vp = page.viewportSize()!;
  await expect(dialog.locator('.dc-fit')).toContainText(`Layout: fits this screen (${vp.width} × ${vp.height}, system bars 32 and 24 px)`);
  await page.setViewportSize({ width: 720, height: 800 });
  await expect(dialog.locator('.dc-fit')).toContainText('Layout: fits this screen (720 × 800');

  // A pen stroke: an event every 8 ms with rising pressure and some tilt.
  await page.locator('.dc-pad').evaluate(async (pad) => {
    const r = pad.getBoundingClientRect();
    const fire = (type: string, i: number) => pad.dispatchEvent(new PointerEvent(type, {
      pointerId: 3, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true,
      clientX: r.left + 20 + i * 4, clientY: r.top + 40 + 20 * Math.sin(i / 5),
      pressure: type === 'pointerup' ? 0 : 0.2 + i / 100, tiltX: 25, tiltY: -10, buttons: type === 'pointerup' ? 0 : 1,
    }));
    fire('pointerdown', 0);
    for (let i = 1; i < 50; i++) { await new Promise((res) => setTimeout(res, 8)); fire('pointermove', i); }
    fire('pointerup', 50);
  });
  await expect(dialog.locator('.dc-count')).toContainText('samples');
  await dialog.getByRole('button', { name: 'Make report' }).click();

  const report = dialog.getByLabel('Device report');
  await expect(report).toContainText('Inkwright device check');
  await expect(report).toContainText('Pointer: pen');
  await expect(report).toContainText(/Events: \d+ per second/);
  await expect(report).toContainText(/Pressure: yes \(0\.2–0\.\d+\)/);
  await expect(report).toContainText('Tilt: yes (up to 25°)');
  await expect(report).toContainText('Safe area (app): top 32, right 0, bottom 24, left 0');
  await expect(report).toContainText(/Pixel ratio: [\d.]+/);
  await expect(report).toContainText(/WebGL: /);
  await expect(report).toContainText(/Audio: /);
  await expect(report).toContainText('Fit: everything fits between the system bars');

  // Copy the report and the JSON (reading the clipboard back is Chromium-only in Playwright).
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await dialog.getByRole('button', { name: 'Copy report' }).click();
    await expect(page.locator('.toasts')).toContainText('Report copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('Pressure: yes');
    await dialog.getByRole('button', { name: 'Copy JSON' }).click();
    const json = JSON.parse(await page.evaluate(() => navigator.clipboard.readText()));
    expect(json.input.pressure.available).toBe(true);
    expect(json.facts.safeArea.capacitor.top).toBe(32);
    expect(json.fit.problems).toEqual([]);
  }
  // Check again starts over with a clean pad.
  await dialog.getByRole('button', { name: 'Check again' }).click();
  await expect(dialog.locator('.dc-count')).toHaveText('Draw here');
});
