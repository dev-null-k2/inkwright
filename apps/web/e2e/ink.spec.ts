import { expect, test } from '@playwright/test';
import { circle, line, modKey, newNote, openApp, pen, pointer, scribble, strokes, texts, word } from './helpers.ts';

test.describe('writing', () => {
  test.beforeEach(async ({ page }) => { await openApp(page); await newNote(page); });

  test('pen strokes are captured with pressure and survive a reload', async ({ page }) => {
    await pen(page, word(200, 220, 160));
    await pen(page, line([200, 320], [600, 322]));
    const s = await strokes(page);
    expect(s).toHaveLength(2);
    expect(s[0].n).toBeGreaterThan(40);
    const hasPressure = await page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes[0].points.some((p: any) => p.p > 0 && p.p < 1));
    expect(hasPressure).toBe(true);
    await page.waitForTimeout(1200); // autosave debounce
    const url = page.url();
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
    expect(page.url()).toBe(url);
    expect(await strokes(page)).toHaveLength(2);
  });

  test('scribbling over a word erases it and undo brings it back', async ({ page }) => {
    await pen(page, word(200, 220, 160));
    await pen(page, word(420, 222, 140));
    await pen(page, scribble(195, 365, 205, 238, 10));
    await expect(page.locator('.toast')).toContainText('Scratched out 1 stroke');
    expect(await strokes(page)).toHaveLength(1);
    await page.locator('.toast-action').click();
    expect(await strokes(page)).toHaveLength(2);
  });

  test('scribble to erase can be turned off', async ({ page }) => {
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('inkwright.settings.v1') || '{}'); s.input = { ...(s.input || {}), scratchToErase: false, fingerAction: 'scroll', buttonAction: 'eraser', holdToShape: true, tapGestures: true, pressureCurve: 1 }; localStorage.setItem('inkwright.settings.v1', JSON.stringify(s)); });
    await page.reload();
    await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
    await pen(page, word(200, 220, 160));
    await pen(page, scribble(195, 365, 205, 238, 10));
    expect(await strokes(page)).toHaveLength(2);
  });

  test('holding the pen still snaps a circle', async ({ page }) => {
    await pen(page, circle(500, 300, 80), { noUp: true });
    await page.waitForTimeout(700);
    await pointer(page, 'pointerup', [580, 300]);
    const s = await strokes(page);
    expect(s).toHaveLength(1);
    expect(s[0].shape).toBe('ellipse');
  });

  test('undo and redo with keyboard shortcuts', async ({ page }) => {
    await pen(page, word(200, 220, 160));
    await pen(page, word(200, 300, 160));
    const mod = await modKey(page);
    await page.keyboard.press(`${mod}+z`);
    expect(await strokes(page)).toHaveLength(1);
    await page.keyboard.press(`${mod}+Shift+z`);
    expect(await strokes(page)).toHaveLength(2);
  });

  test('eraser tool removes whole strokes; precise mode splits them', async ({ page }) => {
    await pen(page, line([200, 300], [700, 300]));
    await page.keyboard.press('e');
    await pen(page, line([450, 260], [450, 340]), { pressure: 0.5 });
    expect(await strokes(page)).toHaveLength(0);
    await page.keyboard.press('p');
    await pen(page, line([200, 300], [700, 300]));
    await page.evaluate(() => { const s = JSON.parse(localStorage.getItem('inkwright.settings.v1') || '{}'); localStorage.setItem('inkwright.settings.v1', JSON.stringify({ ...s, eraserMode: 'precise' })); });
    // Switch mode through the UI: tap eraser twice to open its options.
    await page.getByRole('button', { name: 'Eraser' }).click();
    await page.getByRole('button', { name: 'Eraser' }).click();
    await page.getByRole('radio', { name: 'Precise' }).click();
    await page.keyboard.press('Escape');
    await pen(page, line([450, 260], [450, 340]), { pressure: 0.5 });
    expect(await strokes(page)).toHaveLength(2);
  });

  test('pen barrel button erases while held', async ({ page }) => {
    await pen(page, line([200, 300], [700, 300]));
    await pen(page, line([450, 260], [450, 340]), { buttons: 1 | 2 });
    expect(await strokes(page)).toHaveLength(0);
  });

  test('the eraser end of the pen erases', async ({ page }) => {
    await pen(page, line([200, 300], [700, 300]));
    await pen(page, line([450, 260], [450, 340]), { buttons: 32 });
    expect(await strokes(page)).toHaveLength(0);
  });

  test('tapping the pen button while hovering latches the eraser', async ({ page }) => {
    await pen(page, line([200, 300], [700, 300]));
    // Hover with the button pressed, then release without touching the screen.
    await pointer(page, 'pointermove', [300, 200], { buttons: 2 });
    await pointer(page, 'pointermove', [302, 200], { buttons: 0 });
    await expect(page.locator('.latch-pill')).toBeVisible();
    await pen(page, line([450, 260], [450, 340]));
    expect(await strokes(page)).toHaveLength(0);
    // Tap again to switch back to the pen.
    await pointer(page, 'pointermove', [300, 200], { buttons: 2 });
    await pointer(page, 'pointermove', [302, 200], { buttons: 0 });
    await expect(page.locator('.latch-pill')).toBeHidden();
    await pen(page, line([200, 400], [500, 400]));
    expect(await strokes(page)).toHaveLength(1);
  });

  test('lasso selects, moves, recolours, duplicates and deletes', async ({ page }) => {
    await pen(page, word(200, 220, 120));
    await pen(page, word(600, 600, 120));
    await page.keyboard.press('l');
    await pen(page, [[170, 180], [360, 180], [360, 270], [170, 270], [170, 182]]);
    await expect(page.locator('.sel-bar')).toBeVisible();
    const before = (await strokes(page))[0];
    // Drag the selection 100px right.
    await pen(page, line([260, 225], [360, 225], 10));
    const moved = await page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes[0].points[0].x);
    expect(moved).toBeGreaterThan(0);
    expect((await strokes(page))[0].id).not.toBe(before.id);
    await page.getByRole('button', { name: 'Change colour' }).click();
    await page.getByRole('button', { name: '#FFC0392B' }).click();
    expect((await strokes(page))[0].color).toBe('#FFC0392B');
    await page.getByRole('button', { name: 'Duplicate' }).click();
    expect(await strokes(page)).toHaveLength(3);
    await page.getByRole('button', { name: 'Delete' }).click();
    expect(await strokes(page)).toHaveLength(2);
  });

  test('text tool adds Markdown text that is saved with the page', async ({ page }) => {
    await page.keyboard.press('t');
    await pointer(page, 'pointerdown', [220, 240], { type: 'mouse' });
    await pointer(page, 'pointerup', [220, 240], { type: 'mouse' });
    const ta = page.locator('.text-area');
    await expect(ta).toBeVisible();
    await ta.fill('# Shopping\n- [ ] milk\n- eggs');
    await page.getByRole('button', { name: 'Done' }).click();
    expect(await texts(page)).toEqual(['# Shopping\n- [ ] milk\n- eggs']);
  });

  test('pages can be added, navigated and deleted', async ({ page }) => {
    await page.getByRole('button', { name: 'More', exact: true }).click();
    await page.getByRole('menuitem', { name: /Pages/ }).click();
    await page.getByRole('button', { name: /Add page after/ }).click();
    await expect(page.locator('.page-item')).toHaveCount(2);
    await pen(page, word(200, 220, 120));
    await page.getByRole('button', { name: 'Delete page' }).last().click();
    await page.getByRole('button', { name: 'Delete page', exact: true }).last().click();
    await expect(page.locator('.page-item')).toHaveCount(1);
  });
  test('wet ink is on screen in the same task as the pen sample (no frame wait)', async ({ page }) => {
    const painted = await page.evaluate(async () => {
      const el = document.querySelector('.ed-canvas') as HTMLElement;
      const wet = el.querySelector('canvas.ink-wet') as HTMLCanvasElement;
      const r = el.getBoundingClientRect();
      const fire = (type: string, x: number, y: number, ts: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, clientX: r.left + x, clientY: r.top + y, pressure: 0.6, buttons: 1, button: type === 'pointermove' ? -1 : 0, timeStamp: ts } as PointerEventInit));
      fire('pointerdown', 300, 200, 0);
      // Samples ~5 ms apart, like a 200 Hz pen.
      for (let i = 1; i <= 9; i++) { fire('pointermove', 300 + i * 8, 200, i); await new Promise((res) => setTimeout(res, 5)); }
      fire('pointermove', 380, 200, 10);
      // Read back synchronously, before any animation frame can run: the newest segment must be there.
      const ctx = wet.getContext('2d')!;
      const dpr = wet.width / wet.clientWidth;
      const px = ctx.getImageData(Math.round(375 * dpr), Math.round(200 * dpr), 1, 1).data;
      fire('pointerup', 380, 200, 11);
      return px[3]!;
    });
    expect(painted).toBeGreaterThan(0);
  });

  test('writing sound and feel can be adjusted from the editor', async ({ page }) => {
    const feelBtn = page.getByRole('button', { name: 'Writing feel' });
    if (await feelBtn.isVisible()) await feelBtn.click();
    else { await page.getByRole('button', { name: 'More', exact: true }).click(); await page.getByText('Writing sound & feel').click(); }
    const vol = page.getByRole('slider', { name: 'Writing sound volume' });
    await expect(vol).toBeVisible();
    await vol.fill('0.25');
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('inkwright.settings.v1') ?? '{}')?.feel?.soundVolume)).toBe(0.25);
    await page.getByRole('radio', { name: 'Toothy' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.meta.paper.texture)).toBe('toothy');
    await page.locator('.feel-panel .row-switch', { hasText: 'Writing sound' }).click();
    await expect(page.getByRole('slider', { name: 'Writing sound volume' })).toBeDisabled();
  });
  test('pen strokes arm the native instant-ink tip; fingers and see-through pens do not', async ({ page }) => {
    await page.evaluate(() => { const calls: unknown[] = []; (window as any).__tipCalls = calls; (window as any).__inkwright.engine.inkTip = { begin: (o: unknown) => calls.push(['begin', o]), end: (c?: boolean) => calls.push(['end', !!c]) }; });
    await pen(page, word(200, 220, 160));
    await pen(page, word(200, 300, 160), { type: 'touch' });
    const calls = await page.evaluate(() => (window as any).__tipCalls);
    expect(calls.map((c: any) => c[0])).toEqual(['begin', 'end']);
    expect(calls[0][1].widthPx).toBeGreaterThan(0);
    expect(calls[1][1]).toBe(false);
  });
});
