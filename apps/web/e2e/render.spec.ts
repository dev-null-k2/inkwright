import { expect, test, type Page } from '@playwright/test';
import { line, newNote, openApp, pen, scribble, word } from './helpers.ts';

/** Darkness (0 = white paper, 255 = black ink) of the rendered canvas at a CSS point. */
async function inkAt(page: Page, x: number, y: number): Promise<number> {
  await page.waitForTimeout(80);
  return page.evaluate(([x, y]) => {
    const c = document.querySelector('.ink-base') as HTMLCanvasElement;
    const k = c.width / c.getBoundingClientRect().width;
    const d = c.getContext('2d')!.getImageData(Math.round(x * k), Math.round(y * k), 1, 1).data;
    return 255 - Math.round((d[0]! + d[1]! + d[2]!) / 3);
  }, [x, y] as const);
}

test.describe('what you see is what is stored', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await newNote(page); });

  test('a stroke appears on the page and disappears when erased', async ({ page }) => {
    await page.keyboard.press('5'); // marker
    await pen(page, line([250, 400], [600, 400]));
    expect(await inkAt(page, 420, 400)).toBeGreaterThan(80);
    await page.keyboard.press('e');
    await pen(page, line([420, 360], [420, 440]));
    expect(await inkAt(page, 420, 400)).toBeLessThan(40);
  });

  test('scratched-out ink is gone from the canvas, other ink stays', async ({ page }) => {
    await page.keyboard.press('5');
    await pen(page, word(250, 300, 150));
    await pen(page, line([250, 500], [600, 500]));
    await pen(page, scribble(245, 405, 285, 318, 10));
    expect(await inkAt(page, 420, 500)).toBeGreaterThan(80);
    for (const x of [270, 320, 380]) expect(await inkAt(page, x, 300)).toBeLessThan(60);
  });

  test('undo redraws removed ink and panning keeps it in place', async ({ page }) => {
    await page.keyboard.press('5');
    await pen(page, line([250, 400], [600, 400]));
    await page.keyboard.press('e');
    await pen(page, line([420, 360], [420, 440]));
    await page.keyboard.press('Control+z');
    expect(await inkAt(page, 420, 400)).toBeGreaterThan(80);
    await page.mouse.move(640, 500);
    await page.mouse.wheel(0, 100);
    expect(await inkAt(page, 420, 300)).toBeGreaterThan(80);
    expect(await inkAt(page, 420, 400)).toBeLessThan(40);
  });
});
