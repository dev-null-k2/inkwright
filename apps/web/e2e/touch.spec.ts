import { expect, test } from '@playwright/test';
import { line, newNote, openApp, pen, strokes, word } from './helpers.ts';

test.describe('touch & palm rejection', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await newNote(page); });

  test('a finger scrolls instead of inking', async ({ page }) => {
    const before = await page.evaluate(() => (window as any).__inkstone.engine.viewport.panY);
    await pen(page, line([200, 500], [200, 300], 12), { type: 'touch', id: 11, pressure: 0.5 });
    expect(await strokes(page)).toHaveLength(0);
    const after = await page.evaluate(() => (window as any).__inkstone.engine.viewport.panY);
    expect(after).not.toBe(before);
  });

  test('a palm resting while the pen writes never inks', async ({ page }) => {
    await pen(page, word(300, 200, 120));
    // Palm lands right after the pen lifts.
    await pen(page, line([350, 400], [380, 420], 8), { type: 'touch', id: 12, pressure: 0.5 });
    expect(await strokes(page)).toHaveLength(1);
  });

  test('two-finger tap undoes, three-finger tap redoes', async ({ page }) => {
    await pen(page, word(300, 200, 120));
    await page.waitForTimeout(1300); // pen no longer "near"
    await page.evaluate(() => {
      const el = document.querySelector('.ed-canvas') as HTMLElement;
      const r = el.getBoundingClientRect();
      const ev = (type: string, id: number, x: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + 300, buttons: type === 'pointerup' ? 0 : 1 }));
      ev('pointerdown', 21, 100); ev('pointerdown', 22, 160); ev('pointerup', 21, 100); ev('pointerup', 22, 160);
    });
    expect(await strokes(page)).toHaveLength(0);
    await page.evaluate(() => {
      const el = document.querySelector('.ed-canvas') as HTMLElement;
      const r = el.getBoundingClientRect();
      const ev = (type: string, id: number, x: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + 300, buttons: type === 'pointerup' ? 0 : 1 }));
      ev('pointerdown', 31, 100); ev('pointerdown', 32, 160); ev('pointerdown', 33, 220); ev('pointerup', 31, 100); ev('pointerup', 32, 160); ev('pointerup', 33, 220);
    });
    expect(await strokes(page)).toHaveLength(1);
  });

  test('pinch zooms around the fingers', async ({ page }) => {
    const z0 = await page.evaluate(() => (window as any).__inkstone.engine.zoom);
    await page.evaluate(() => {
      const el = document.querySelector('.ed-canvas') as HTMLElement;
      const r = el.getBoundingClientRect();
      const ev = (type: string, id: number, x: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + 300, buttons: type === 'pointerup' ? 0 : 1 }));
      ev('pointerdown', 41, 150); ev('pointerdown', 42, 250);
      for (let i = 1; i <= 10; i++) { ev('pointermove', 41, 150 - i * 8); ev('pointermove', 42, 250 + i * 8); }
      ev('pointerup', 41, 70); ev('pointerup', 42, 330);
    });
    const z1 = await page.evaluate(() => (window as any).__inkstone.engine.zoom);
    expect(z1).toBeGreaterThan(z0 * 1.5);
    expect(await strokes(page)).toHaveLength(0);
  });
});
