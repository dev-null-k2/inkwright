import { expect, test, type Page } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { editorMenu, isEngineNoise, modKey, newNote, openApp } from './helpers.ts';

/**
 * The founder's Razr Fold feedback: a one-tap theme switch, a "+" for a new note on every page,
 * and Sign a document as a front door (library New menu, the editor's "+", the search palette,
 * the welcome) — with the top bars kept uncluttered on the folded (412 px) and open (720 px)
 * screens.
 */

const theme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'));
const themeButton = (page: Page, scope: string) => page.locator(scope).getByRole('button', { name: /^Theme:/ });

/** Press and hold (pointer down, wait, up) as a finger would. */
async function hold(page: Page, selector: string) {
  const b = (await page.locator(selector).boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await page.mouse.up();
}

async function letterPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p = pdf.addPage([612, 792]);
  p.drawText('Consent form', { x: 72, y: 720, size: 18, font });
  p.drawText('Signature', { x: 72, y: 548, size: 10, font });
  p.drawLine({ start: { x: 72, y: 560 }, end: { x: 320, y: 560 }, thickness: 1 });
  return Buffer.from(await pdf.save());
}

/** A small PNG (a grey page with a dark line), as a phone photo of a document would arrive. */
async function pagePhoto(page: Page): Promise<Buffer> {
  const b64 = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 600; c.height = 800;
    const g = c.getContext('2d')!;
    g.fillStyle = '#f4f4f0'; g.fillRect(0, 0, 600, 800);
    g.fillStyle = '#222'; g.fillRect(60, 560, 300, 2);
    return c.toDataURL('image/png').split(',')[1]!;
  });
  return Buffer.from(b64, 'base64');
}

test('theme: one tap in the library and the editor cycles Light, Dark, System and is remembered', async ({ page }) => {
  await openApp(page);
  const lib = themeButton(page, '.lib-top');
  await expect(lib).toHaveAccessibleName(/^Theme: System\. Switch to light/);
  await lib.click();
  await expect.poll(() => theme(page)).toBe('light');
  await lib.click();
  await expect.poll(() => theme(page)).toBe('dark');
  await page.reload();
  await expect(page.locator('.library')).toBeVisible();
  await expect.poll(() => theme(page)).toBe('dark');

  // In the editor too, next to "+" and AI.
  await newNote(page);
  const ed = themeButton(page, '.ed-top');
  await expect(ed).toHaveAccessibleName(/^Theme: Dark/);
  await ed.click();
  await expect.poll(() => theme(page)).toBeNull(); // System: follows the device
  await expect(page.locator('.toast')).toContainText('Following your device');
  await ed.click();
  await expect.poll(() => theme(page)).toBe('light');
});

test('theme: with reduced motion the switch is instant (no fade)', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openApp(page);
  await page.evaluate(() => {
    (window as any).__fades = 0;
    (document as any).startViewTransition = () => { (window as any).__fades++; };
    new MutationObserver(() => { if (document.documentElement.classList.contains('theme-fading')) (window as any).__fades++; }).observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  });
  await themeButton(page, '.lib-top').click();
  expect(await theme(page)).toBe('light');
  expect(await page.evaluate(() => (window as any).__fades)).toBe(0);
});

test('"+" in the editor: a tap starts a note like this one; hold for the other ways to start', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !isEngineNoise(m.text())) errors.push(m.text()); });
  await openApp(page);
  await newNote(page);
  // Give this note dot-grid paper; the next one should get it too.
  await page.evaluate(() => { const d = (window as any).__inkwright.doc; d.setPaper({ ...d.meta.paper, style: 'dot_grid' }); });
  const first = await page.evaluate(() => (window as any).__inkwright.doc.meta.id);
  await page.locator('.ed-top').getByRole('button', { name: 'New note' }).click();
  await page.waitForFunction((id) => (window as any).__inkwright?.doc?.meta.id && (window as any).__inkwright.doc.meta.id !== id, first);
  expect(await page.evaluate(() => (window as any).__inkwright.doc.meta.paper.style)).toBe('dot_grid');

  // Hold: the other ways to start.
  await hold(page, '.ed-top .new-here');
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem')).toHaveText([/New note/, /New page in this note/, /New note from template/, /New document/, /Open a PDF to sign/]);
  await menu.getByRole('menuitem', { name: /New page in this note/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.pageCount)).toBe(2);

  // Right-click opens it too; no templates yet says how to make one.
  await page.locator('.ed-top .new-here').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /New note from template/ }).click();
  await expect(page.getByRole('dialog', { name: 'New note from template' })).toContainText('Use as template');
  await page.getByRole('dialog', { name: 'New note from template' }).getByRole('button', { name: 'Cancel' }).click();

  // A document from the same menu.
  await page.locator('.ed-top .new-here').focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('menuitem', { name: /New document/ }).click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.docEditor);
  // …and "+" in a document starts another document.
  const doc1 = await page.evaluate(() => (window as any).__inkwright.doc.meta.id);
  await page.locator('.ed-top').getByRole('button', { name: 'New document' }).click();
  await page.waitForFunction((id) => (window as any).__inkwright?.docEditor && (window as any).__inkwright.doc.meta.id !== id, doc1);
  expect(await page.evaluate(() => !!(window as any).__inkwright.doc.meta.document)).toBe(true);
  expect(errors).toEqual([]);
});

for (const vp of [{ width: 412, height: 915, name: 'folded (412 px)' }, { width: 720, height: 800, name: 'open fold (720 px)' }]) {
  test(`top bars stay uncluttered on the ${vp.name} screen`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openApp(page);
    /** Every visible top-bar control on screen, none overlapping, and room left for the title. */
    const check = async (bar: string, label: string) => {
      const r = await page.evaluate((bar) => {
        const top = document.querySelector(bar)!;
        const els = [...top.querySelectorAll<HTMLElement>('button, input, select, .search')].filter((e) => e.getBoundingClientRect().width > 0 && !e.closest('.search')?.isSameNode(e.parentElement) );
        const rects = els.map((e) => ({ name: e.getAttribute('aria-label') ?? e.textContent?.trim() ?? e.tagName, ...e.getBoundingClientRect().toJSON() }));
        const title = top.querySelector('.ed-title-text')?.getBoundingClientRect().width ?? null;
        return { rects, title, width: innerWidth, scroll: document.documentElement.scrollWidth - document.documentElement.clientWidth };
      }, bar);
      expect(r.scroll, `${label}: page scrolls sideways`).toBeLessThanOrEqual(0);
      for (const x of r.rects) {
        expect(x.left, `${label}: ${x.name} off the left`).toBeGreaterThanOrEqual(-1);
        expect(x.right, `${label}: ${x.name} off the right`).toBeLessThanOrEqual(r.width + 1);
      }
      const buttons = r.rects.filter((x) => !/^(INPUT|SELECT)$/.test(x.name));
      for (let i = 0; i < buttons.length; i++) for (let j = i + 1; j < buttons.length; j++) {
        const a = buttons[i]!, b = buttons[j]!;
        const overlap = Math.min(a.right, b.right) - Math.max(a.left, b.left) > 2 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 2;
        expect(overlap, `${label}: ${a.name} overlaps ${b.name}`).toBe(false);
      }
      if (r.title != null) expect(r.title, `${label}: title squeezed`).toBeGreaterThan(60);
      return r;
    };
    await check('.lib-top', 'library');
    await expect(themeButton(page, '.lib-top')).toBeVisible();
    await newNote(page);
    const ed = await check('.ed-top', 'editor');
    // Uncluttered: at most seven controls in the editor's bar.
    expect(ed.rects.length, `editor bar: ${ed.rects.map((x) => x.name).join(', ')}`).toBeLessThanOrEqual(7);
    if (vp.width < 600) {
      // No room for the theme button on the folded screen: it's the first row of •••.
      await expect(themeButton(page, '.ed-top')).toHaveCount(0);
      await editorMenu(page);
      const row = page.getByRole('menuitem', { name: /^Theme:/ });
      await expect(row).toBeVisible();
      const before = await theme(page);
      await row.click();
      await expect.poll(() => theme(page)).not.toBe(before);
    } else {
      await expect(themeButton(page, '.ed-top')).toBeVisible();
    }
    // The document editor's bars too.
    await page.getByRole('button', { name: 'Back to library' }).click();
    await page.getByRole('button', { name: 'More ways to create' }).click();
    await page.getByRole('button', { name: 'New document' }).click();
    await page.waitForFunction(() => !!(window as any).__inkwright?.docEditor);
    await check('.ed-top', 'document editor');
    // The formatting row may scroll on a phone, but Annotate stays in view.
    const ann = (await page.getByRole('button', { name: 'Annotate' }).boundingBox())!;
    expect(ann.x + ann.width).toBeLessThanOrEqual(vp.width + 1);
  });
}

test('Sign a document: library New menu → a photo of a page → sign → export the signed PDF', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'More ways to create' }).click();
  const sheet = page.getByRole('dialog', { name: 'New note' });
  await expect(sheet.getByRole('button', { name: 'New document' })).toBeVisible();
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), sheet.getByRole('button', { name: 'Sign a document' }).click()]);
  // Photos and PDFs are offered.
  expect(await chooser.element().getAttribute('accept')).toContain('image/*');
  await chooser.setFiles({ name: 'Permission slip.png', mimeType: 'image/png', buffer: await pagePhoto(page) });
  // The editor opens with the form layer on, on a PDF made from the photo.
  const bar = page.getByRole('toolbar', { name: 'Fill and sign' });
  await expect(bar).toBeVisible({ timeout: 15_000 });
  expect(await page.evaluate(() => (window as any).__inkwright.doc.page(0).background?.kind)).toBe('pdf');
  await expect(page.locator('.ed-title-text')).toHaveText('Permission slip');

  // Draw a signature once and place it.
  await bar.getByRole('button', { name: 'Sign' }).click();
  await page.getByRole('button', { name: 'New signature' }).click();
  const pad = page.locator('.sig-pad');
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + 40 + i * 8, box.y + 120 - 40 * Math.sin(i / 3));
  await page.mouse.up();
  await page.getByRole('button', { name: 'Save signature' }).click();
  await expect(page.locator('.fill-hint')).toHaveText('Tap where to sign');
  const canvas = (await page.locator('.ed-canvas').boundingBox())!;
  await page.mouse.click(canvas.x + canvas.width * 0.4, canvas.y + canvas.height * 0.55);
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes.length)).toBeGreaterThan(0);

  // Export: the original document with the signature, as a PDF to save or share.
  await page.keyboard.press('Escape');
  const download = page.waitForEvent('download');
  await bar.getByRole('button', { name: 'Export' }).click();
  await page.getByRole('dialog', { name: 'Export filled PDF' }).getByRole('button', { name: 'Export PDF' }).click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('Permission slip.pdf');
  const fs = await import('node:fs');
  const out = await PDFDocument.load(fs.readFileSync((await d.path())!));
  expect(out.getPageCount()).toBe(1);
});

test('Sign a document from the search palette and from the editor\'s "+" opens a PDF ready to sign', async ({ page }) => {
  await openApp(page);
  await page.keyboard.press(`${await modKey(page)}+k`);
  await page.locator('.palette input').fill('sign');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.palette').getByText('Sign a document').click()]);
  await chooser.setFiles({ name: 'Consent.pdf', mimeType: 'application/pdf', buffer: await letterPdf() });
  await expect(page.getByRole('toolbar', { name: 'Fill and sign' })).toBeVisible({ timeout: 15_000 });

  await page.locator('.ed-top .new-here').click({ button: 'right' });
  const [again] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('menuitem', { name: /Open a PDF to sign/ }).click()]);
  await again.setFiles({ name: 'Second.pdf', mimeType: 'application/pdf', buffer: await letterPdf() });
  await expect(page.locator('.ed-title-text')).toHaveText('Second');
  await expect(page.getByRole('toolbar', { name: 'Fill and sign' })).toBeVisible({ timeout: 15_000 });
});

test.describe('first run', () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test('the welcome offers Sign a document on its last step', async ({ page }) => {
    await page.goto('/?e2e');
    const w = page.locator('.welcome');
    for (let i = 0; i < 3; i++) await w.getByRole('button', { name: 'Next' }).click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), w.getByRole('button', { name: 'Sign a document' }).click()]);
    await chooser.setFiles({ name: 'Form.pdf', mimeType: 'application/pdf', buffer: await letterPdf() });
    await expect(page.getByRole('toolbar', { name: 'Fill and sign' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.welcome')).toHaveCount(0);
  });
});
