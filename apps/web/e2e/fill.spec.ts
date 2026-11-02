import { expect, test, type Page } from '@playwright/test';
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFTextField, StandardFonts } from 'pdf-lib';
import { openApp } from './helpers.ts';

/** A one-page form: a printed label, a text field, a checkbox, a dropdown and a signature line. */
async function formPdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const p = pdf.addPage([612, 792]);
  p.drawText('Membership form', { x: 72, y: 740, size: 18, font });
  p.drawText('Full name', { x: 72, y: 712, size: 10, font });
  const form = pdf.getForm();
  const name = form.createTextField('name');
  name.enableRequired();
  name.addToPage(p, { x: 72, y: 685, width: 240, height: 22, font });
  const agree = form.createCheckBox('agree');
  agree.addToPage(p, { x: 72, y: 650, width: 16, height: 16 });
  const state = form.createDropdown('state');
  state.addOptions(['TX', 'NJ', 'CA']);
  state.addToPage(p, { x: 72, y: 610, width: 120, height: 22, font });
  p.drawText('Signature', { x: 72, y: 548, size: 10, font });
  p.drawLine({ start: { x: 72, y: 560 }, end: { x: 320, y: 560 }, thickness: 1 });
  return Buffer.from(await pdf.save());
}

/** Client coordinates of a point given in page units on page `i`. */
async function pagePoint(page: Page, i: number, x: number, y: number): Promise<[number, number]> {
  return page.evaluate(({ i, x, y }) => {
    const { engine } = (window as any).__inkstone;
    const host = document.querySelector('.ed-canvas') as HTMLElement;
    const r = host.getBoundingClientRect();
    const s = engine.pageRectToScreen(i, { minX: x, minY: y, maxX: x + 1, maxY: y + 1 });
    return [r.left + s.x, r.top + s.y] as [number, number];
  }, { i, x, y });
}

async function openForm(page: Page) {
  await openApp(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Membership.pdf', mimeType: 'application/pdf', buffer: await formPdf() });
  await page.waitForFunction(() => (window as any).__inkstone?.doc?.pageCount === 1, null, { timeout: 20000 });
}

test('fill a PDF form, sign it and export a filled PDF', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openForm(page);

  // A quiet chip offers to fill in the form.
  const chip = page.locator('.fill-chip');
  await expect(chip).toContainText('3 fields');
  await chip.getByRole('button', { name: 'Fill in' }).click();
  await expect(page.getByRole('toolbar', { name: 'Fill and sign' })).toBeVisible();

  // Type, tick and choose.
  const name = page.locator('.fill-field[data-field="name"]');
  await name.fill('Ada Lovelace');
  await name.press('Enter');
  await page.locator('.fill-field[data-field="agree"]').click();
  await expect(page.locator('.fill-field[data-field="agree"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('.fill-field[data-field="state"]').selectOption('NJ');
  await expect.poll(() => page.evaluate(() => Object.values((window as any).__inkstone.doc.meta.forms ?? {})[0])).toEqual({ name: 'Ada Lovelace', agree: true, state: 'NJ' });

  // Draw a signature once, then place it on the signature line.
  await page.getByRole('toolbar', { name: 'Fill and sign' }).getByRole('button', { name: 'Sign' }).click();
  await page.getByRole('button', { name: 'New signature' }).click();
  const pad = page.locator('.sig-pad');
  const box = (await pad.boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 120);
  await page.mouse.down();
  for (let i = 1; i <= 30; i++) await page.mouse.move(box.x + 40 + i * 8, box.y + 120 - 40 * Math.sin(i / 3));
  await page.mouse.up();
  await page.getByRole('button', { name: 'Save signature' }).click();
  await expect(page.locator('.fill-hint')).toHaveText('Tap where to sign');
  const before = await page.evaluate(() => (window as any).__inkstone.doc.page(0).strokes.length);
  // Just above the printed line (PDF y 560pt → page units (792 − 560) × 4/3).
  const [sx, sy] = await pagePoint(page, 0, 150, (792 - 560) * (4 / 3) - 12);
  await page.mouse.click(sx, sy);
  await expect.poll(() => page.evaluate(() => (window as any).__inkstone.doc.page(0).strokes.length)).toBeGreaterThan(before);
  // It sits on the line: the ink's lowest point is near the line.
  const bottom = await page.evaluate(() => Math.max(...(window as any).__inkstone.doc.page(0).strokes.flatMap((s: any) => s.points.map((p: any) => p.y))));
  expect(Math.abs(bottom - (792 - 560) * (4 / 3))).toBeLessThan(14);

  // The signature is reusable: it's in the library now.
  await page.keyboard.press('Escape');

  // Export the filled PDF.
  const download = page.waitForEvent('download');
  await page.getByRole('toolbar', { name: 'Fill and sign' }).getByRole('button', { name: 'Export' }).click();
  await page.getByRole('dialog', { name: 'Export filled PDF' }).getByRole('button', { name: 'Export PDF' }).click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('Membership.pdf');
  const fs = await import('node:fs');
  const out = await PDFDocument.load(fs.readFileSync((await d.path())!));
  const form = out.getForm();
  expect((form.getField('name') as PDFTextField).getText()).toBe('Ada Lovelace');
  expect((form.getField('agree') as PDFCheckBox).isChecked()).toBe(true);
  expect((form.getField('state') as PDFDropdown).getSelected()).toEqual(['NJ']);
  // The signature ink was added to the original page's content.
  const original = await PDFDocument.load(await formPdf());
  const streams = (p: PDFDocument) => (p.getPage(0).node.Contents() as any)?.size?.() ?? 1;
  expect(streams(out)).toBeGreaterThan(streams(original));
  expect(errors).toEqual([]);
});

test('values are kept when the note is opened again, and the canvas shows them', async ({ page }) => {
  await openForm(page);
  await page.locator('.fill-chip').getByRole('button', { name: 'Fill in' }).click();
  await page.locator('.fill-field[data-field="name"]').fill('Grace Hopper');
  await page.locator('.fill-field[data-field="name"]').press('Enter');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.fill-field')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.locator('.note-card', { hasText: 'Membership' }).locator('.note-open').click();
  await page.waitForFunction(() => !!(window as any).__inkstone?.doc);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fill & sign' }).click();
  await expect(page.locator('.fill-field[data-field="name"]')).toHaveValue('Grace Hopper');
});

test('flat PDF: typed text snaps onto the printed line; a checkmark is real ink', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([612, 792]);
  p.drawText('Name', { x: 72, y: 704, size: 10 });
  p.drawLine({ start: { x: 110, y: 700 }, end: { x: 400, y: 700 }, thickness: 1 });
  await openApp(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Flat.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.waitForFunction(() => (window as any).__inkstone?.doc?.pageCount === 1, null, { timeout: 20000 });
  await expect(page.locator('.fill-chip')).toHaveCount(0); // no fields
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fill & sign' }).click();
  const bar = page.getByRole('toolbar', { name: 'Fill and sign' });
  await bar.getByRole('button', { name: 'Text' }).click();
  const lineY = (792 - 700) * (4 / 3);
  const [x, y] = await pagePoint(page, 0, 300, lineY - 10);
  await page.mouse.click(x, y);
  await expect(page.locator('.text-edit textarea')).toBeFocused();
  await page.keyboard.type('Ada');
  await page.keyboard.press('Escape');
  const t = await page.evaluate(() => (window as any).__inkstone.doc.page(0).texts?.[0]);
  expect(t.text).toBe('Ada');
  // Baseline (≈ y + 1.02 × size) just above the line.
  expect(lineY - (t.y + t.fontSize * 1.02)).toBeGreaterThan(0);
  expect(lineY - (t.y + t.fontSize * 1.02)).toBeLessThan(8);
  await bar.getByRole('button', { name: 'Check' }).click();
  const [cx, cy] = await pagePoint(page, 0, 500, 500);
  await page.mouse.click(cx, cy);
  await expect.poll(() => page.evaluate(() => (window as any).__inkstone.doc.page(0).strokes.length)).toBe(1);
});

test('open text and Markdown files; drop a file onto the library', async ({ page }) => {
  await openApp(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Groceries.md', mimeType: 'text/markdown', buffer: Buffer.from('# Groceries\n\n- [ ] Rice\n- [ ] Dal\n') });
  await page.waitForFunction(() => (window as any).__inkstone?.doc?.meta.title === 'Groceries', null, { timeout: 20000 });
  expect(await page.evaluate(() => (window as any).__inkstone.doc.page(0).texts[0].text)).toContain('- [ ] Rice');
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['Dropped words'], 'Dropped.txt', { type: 'text/plain' }));
    const lib = document.querySelector('.library')!;
    for (const type of ['dragenter', 'dragover', 'drop']) lib.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => (window as any).__inkstone?.doc?.meta.title === 'Dropped', null, { timeout: 20000 });
  expect(await page.evaluate(() => (window as any).__inkstone.doc.page(0).texts[0].text)).toBe('Dropped words');
});

test('pages panel: rotate a PDF page and copy pages to a new note', async ({ page }) => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i++) pdf.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 72, y: 700, size: 24 });
  await openApp(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Three.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.waitForFunction(() => (window as any).__inkstone?.doc?.pageCount === 3, null, { timeout: 20000 });
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Pages/ }).click();
  const panel = page.getByRole('complementary', { name: 'Pages' });
  await panel.getByRole('button', { name: 'Rotate page' }).first().click();
  const p0 = await page.evaluate(() => { const p = (window as any).__inkstone.doc.page(0); return { w: p.size.width, h: p.size.height, rot: p.background.rotation }; });
  expect(p0).toEqual({ w: 1056, h: 816, rot: 90 });
  await panel.getByRole('button', { name: 'Select' }).click();
  await panel.getByRole('button', { name: 'Select page 2' }).click();
  await panel.getByRole('button', { name: 'Select page 3' }).click();
  await panel.getByRole('button', { name: 'Copy to new note' }).click();
  await page.locator('.toast-action', { hasText: 'Open' }).click();
  await page.waitForFunction(() => (window as any).__inkstone?.doc?.meta.title === 'Three (pages 2–3)', null, { timeout: 20000 });
  expect(await page.evaluate(() => (window as any).__inkstone.doc.pages.map((p: any) => p.background.pageNumber))).toEqual([2, 3]);
});
