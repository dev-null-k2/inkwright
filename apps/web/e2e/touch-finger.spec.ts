import { expect, test, type Page } from '@playwright/test';
import { editorMenu, line, newNote, openApp, pen, strokes } from './helpers.ts';

/**
 * "Why am I unable to write with my hand?" — fingers scroll by default (palm rejection). The pen
 * dock's "Draw with finger" switches one finger to writing (two fingers then scroll and zoom), it
 * is remembered on this device, the editor's ••• › Page has it too, the welcome's "With my
 * finger" turns it on, and touching the screen with a stylus offers to switch back.
 */

/** A short horizontal line across the middle of the visible page (inside the paper on any screen). */
async function across(page: Page, y: number) {
  const c = (await page.locator('.ed-canvas').boundingBox())!;
  return line([c.width * 0.35, y], [c.width * 0.6, y + 30]);
}

const toggle = (page: Page) => page.locator('.dock').getByRole('button', { name: 'Draw with finger' });

/** Two fingers moving together (a pan / pinch), as synthetic touch pointers. */
async function twoFingers(page: Page) {
  await page.evaluate(() => {
    const el = document.querySelector('.ed-canvas') as HTMLElement;
    const r = el.getBoundingClientRect();
    const fire = (type: string, id: number, x: number, y: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 21, bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, buttons: type === 'pointerup' ? 0 : 1, width: 10, height: 10 }));
    fire('pointerdown', 21, 150, 300);
    fire('pointerdown', 22, 250, 300);
    for (let i = 1; i <= 12; i++) { fire('pointermove', 21, 150, 300 - i * 8); fire('pointermove', 22, 250, 300 - i * 8); }
    fire('pointerup', 21, 150, 204);
    fire('pointerup', 22, 250, 204);
  });
}

test.use({ hasTouch: true });

test('one finger scrolls until "Draw with finger" is on; then it writes and two fingers still pan', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');

  // Off: a finger drag pans, it never writes.
  await pen(page, await across(page, 200), { type: 'touch', id: 11 });
  expect(await strokes(page)).toHaveLength(0);

  // On: the same finger writes.
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.toast')).toContainText('Your finger draws now');
  await pen(page, await across(page, 200), { type: 'touch', id: 12 });
  await expect.poll(async () => (await strokes(page)).length).toBe(1);
  expect(await page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes[0].input)).toBe('touch');

  // Two fingers move the page instead of writing.
  await twoFingers(page);
  expect(await strokes(page)).toHaveLength(1);

  // Remembered on this device.
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');

  // The editor's ••• › Page has the same switch.
  await editorMenu(page, 'Page', 'Draw with finger');
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
});

test('a stylus touching the screen offers to switch back to pen-only writing', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await toggle(page).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  await pen(page, await across(page, 160));
  const prompt = page.locator('.stylus-prompt');
  await expect(prompt).toContainText('Pen detected');
  // The prompt sits on screen, above the pen dock.
  const box = (await prompt.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);
  await prompt.getByRole('button', { name: 'Pen only' }).click();
  await expect(toggle(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(prompt).toHaveCount(0);
  // Fingers scroll again.
  const before = (await strokes(page)).length;
  await pen(page, await across(page, 300), { type: 'touch', id: 13 });
  expect(await strokes(page)).toHaveLength(before);
});

test.describe('first run', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('the welcome\'s "With my finger" turns on Draw with finger', async ({ page }) => {
    await page.goto('/?e2e');
    const w = page.locator('.welcome');
    await expect(w).toBeVisible();
    await w.getByRole('radio', { name: /With my finger/ }).click();
    await w.getByRole('button', { name: 'Skip' }).click();
    await expect(page.locator('.library')).toBeVisible();
    await newNote(page);
    await expect(toggle(page)).toHaveAttribute('aria-pressed', 'true');
  });
});
