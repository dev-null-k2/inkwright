import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { openApp } from './helpers.ts';

/**
 * Screenshots of the founder-feedback screens on the Razr Fold's inner screen (720×800, with its
 * system bars), light and dark, for review: the library and editor top bars, the pen dock's
 * "Draw with finger", the document editor and the sign flow. Written to test-results/ux/.
 * Run on its own (`--project desktop e2e/ux-shots.spec.ts`); it asserts only that each screen
 * opened, the pixels are for people to look at.
 */

const DIR = 'test-results/ux';

async function fold(page: Page, scheme: 'light' | 'dark') {
  await page.setViewportSize({ width: 720, height: 800 });
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const set = () => { const s = document.documentElement.style; s.setProperty('--safe-area-inset-top', '32px'); s.setProperty('--safe-area-inset-bottom', '24px'); };
    if (document.documentElement) set();
    document.addEventListener('DOMContentLoaded', set);
  });
}

/** Screenshots wait for passing toasts to go, so they show the screen itself. */
async function shot(page: Page, name: string) {
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${DIR}/${name}.png` });
}

async function samplePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p = pdf.addPage([612, 792]);
  p.drawText('Lease agreement', { x: 72, y: 720, size: 20, font });
  p.drawText('The tenant agrees to the terms above.', { x: 72, y: 680, size: 11, font });
  p.drawText('Signature', { x: 72, y: 548, size: 10, font });
  p.drawLine({ start: { x: 72, y: 560 }, end: { x: 320, y: 560 }, thickness: 1 });
  return Buffer.from(await pdf.save());
}

for (const scheme of ['light', 'dark'] as const) {
  test(`fold screens, ${scheme}`, async ({ page }) => {
    test.setTimeout(90_000);
    await fold(page, scheme);
    await openApp(page);
    await shot(page, `library-topbar-${scheme}`);

    // Editor: top bar with theme, "+", AI, •••; the pen dock with Draw with finger (on).
    await page.locator('.fab').click();
    await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
    await page.locator('.dock').getByRole('button', { name: 'Draw with finger' }).click();
    await page.waitForTimeout(400);
    await shot(page, `editor-topbar-pen-dock-${scheme}`);
    await page.locator('.ed-top').getByRole('button', { name: 'New note' }).click({ button: 'right' });
    await expect(page.getByRole('menu')).toBeVisible();
    await shot(page, `editor-new-menu-${scheme}`);
    await page.keyboard.press('Escape');

    // Document editor with formatting and ink.
    await page.getByRole('button', { name: 'Back to library' }).click();
    await page.getByRole('button', { name: 'More ways to create' }).click();
    await page.getByRole('button', { name: 'New document' }).click();
    await page.waitForFunction(() => !!(window as any).__inkwright?.docEditor);
    await page.evaluate(() => (window as any).__inkwright.docEditor.commands.setContent('<h1>Project brief</h1><p>Inkwright documents take <strong>typed text</strong>, <em>lists</em> and <u>tables</u> — and the pen on top.</p><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>Outline the scope</p></li><li data-type="taskItem" data-checked="false"><p>Review with the team</p></li></ul><h2>Budget</h2><table><tbody><tr><th><p>Item</p></th><th><p>Cost</p></th></tr><tr><td><p>Design</p></td><td><p>$4,000</p></td></tr></tbody></table><blockquote><p>Ship by December.</p></blockquote>', { emitUpdate: true }));
    await page.getByRole('button', { name: 'Annotate' }).click();
    const box = (await page.locator('.doc-ink').boundingBox())!;
    await page.evaluate(({ x, y }) => {
      const el = document.querySelector('.doc-ink')!;
      const fire = (type: string, i: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: 9, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, clientX: x + Math.cos(i / 6) * 120, clientY: y + Math.sin(i / 6) * 26, pressure: 0.6, buttons: type === 'pointerup' ? 0 : 1 }));
      fire('pointerdown', 0);
      for (let i = 1; i < 40; i++) fire('pointermove', i);
      fire('pointerup', 40);
    }, { x: box.x + 220, y: box.y + 150 });
    await page.waitForTimeout(300);
    await shot(page, `document-editor-${scheme}`);
    await page.getByRole('button', { name: 'Done annotating' }).click();

    // Sign flow: pick a PDF → the form layer is on → the signature picker.
    await page.getByRole('button', { name: 'Back to library' }).click();
    await page.getByRole('button', { name: 'More ways to create' }).click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: 'Sign a document' }).click()]);
    await chooser.setFiles({ name: 'Lease.pdf', mimeType: 'application/pdf', buffer: await samplePdf() });
    await expect(page.getByRole('toolbar', { name: 'Fill and sign' })).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(800);
    await shot(page, `sign-flow-${scheme}`);
    await page.getByRole('toolbar', { name: 'Fill and sign' }).getByRole('button', { name: 'Sign' }).click();
    await page.waitForTimeout(300);
    await shot(page, `sign-flow-signature-${scheme}`);
  });
}
