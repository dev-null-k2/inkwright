import { expect, test, type Page } from '@playwright/test';
import { PDFCheckBox, PDFDocument, PDFDropdown, PDFTextField, StandardFonts } from 'pdf-lib';
import { openApp, editorMenu } from './helpers.ts';

/** PDF rendering and form reading run in the background; give them time on a busy machine. */
const SLOW = { timeout: 15_000 };

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
    const { engine } = (window as any).__inkwright;
    const host = document.querySelector('.ed-canvas') as HTMLElement;
    const r = host.getBoundingClientRect();
    const s = engine.pageRectToScreen(i, { minX: x, minY: y, maxX: x + 1, maxY: y + 1 });
    return [r.left + s.x, r.top + s.y] as [number, number];
  }, { i, x, y });
}

async function openForm(page: Page) {
  await openApp(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Membership.pdf', mimeType: 'application/pdf', buffer: await formPdf() });
  await page.waitForFunction(() => (window as any).__inkwright?.doc?.pageCount === 1, null, { timeout: 20000 });
}

test('fill a PDF form, sign it and export a filled PDF', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openForm(page);

  // A quiet chip offers to fill in the form.
  const chip = page.locator('.fill-chip');
  await expect(chip).toContainText('3 fields', SLOW);
  await chip.getByRole('button', { name: 'Fill in' }).click();
  await expect(page.getByRole('toolbar', { name: 'Fill and sign' })).toBeVisible(SLOW);

  // Type, tick and choose.
  const name = page.locator('.fill-field[data-field="name"]');
  await name.fill('Ada Lovelace');
  await name.press('Enter');
  await page.locator('.fill-field[data-field="agree"]').click();
  await expect(page.locator('.fill-field[data-field="agree"]')).toHaveAttribute('aria-checked', 'true');
  await page.locator('.fill-field[data-field="state"]').selectOption('NJ');
  await expect.poll(() => page.evaluate(() => Object.values((window as any).__inkwright.doc.meta.forms ?? {})[0]), SLOW).toEqual({ name: 'Ada Lovelace', agree: true, state: 'NJ' });

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
  const before = await page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes.length);
  // Just above the printed line (PDF y 560pt → page units (792 − 560) × 4/3).
  const [sx, sy] = await pagePoint(page, 0, 150, (792 - 560) * (4 / 3) - 12);
  await page.mouse.click(sx, sy);
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes.length), SLOW).toBeGreaterThan(before);
  // It sits on the line: the ink's lowest point is near the line.
  const bottom = await page.evaluate(() => Math.max(...(window as any).__inkwright.doc.page(0).strokes.flatMap((s: any) => s.points.map((p: any) => p.y))));
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

/** Dark pixels on the page canvas inside a client-space rectangle. */
async function inkIn(page: Page, r: { x: number; y: number; width: number; height: number }): Promise<number> {
  return page.evaluate((r) => {
    const c = document.querySelector('.ink-base') as HTMLCanvasElement;
    const cr = c.getBoundingClientRect();
    const k = c.width / cr.width;
    const d = c.getContext('2d')!.getImageData(Math.round((r.x - cr.left + 4) * k), Math.round((r.y - cr.top + 3) * k), Math.round((r.width - 8) * k), Math.round((r.height - 6) * k)).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! + d[i + 1]! + d[i + 2]! < 300) n++;
    return n;
  }, r);
}

test('values are kept when the note is opened again, and the canvas shows them', async ({ page }) => {
  await openForm(page);
  await page.locator('.fill-chip').getByRole('button', { name: 'Fill in' }).click();
  const field = page.locator('.fill-field[data-field="name"]');
  const rect = (await field.boundingBox())!;
  await page.getByRole('button', { name: 'Done' }).click();
  expect(await inkIn(page, rect)).toBe(0); // an empty field on the page
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fill & sign' }).click();
  await field.fill('Grace Hopper');
  await field.press('Enter');
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.fill-field')).toHaveCount(0);
  // pdf.js draws the value into the page, like a viewer would.
  await expect.poll(() => inkIn(page, rect), SLOW).toBeGreaterThan(20);
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.locator('.note-card', { hasText: 'Membership' }).locator('.note-open').click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.doc);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fill & sign' }).click();
  await expect(page.locator('.fill-field[data-field="name"]')).toHaveValue('Grace Hopper');
});

test('writing with the pen over a field lays down ink (it stays ink without a recognizer)', async ({ page }) => {
  await openForm(page);
  await page.locator('.fill-chip').getByRole('button', { name: 'Fill in' }).click();
  const r = (await page.locator('.fill-field[data-field="name"]').boundingBox())!;
  await page.evaluate((r) => {
    const field = document.querySelector('.fill-field[data-field="name"]') as HTMLElement;
    const canvas = document.querySelector('.ed-canvas') as HTMLElement;
    const ev = (type: string, x: number, y: number) => new PointerEvent(type, { pointerId: 9, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, pressure: type === 'pointerup' ? 0 : 0.5, buttons: type === 'pointerup' ? 0 : 1 });
    // The pen lands on the field (which hands it to the canvas); the rest of the stroke goes to
    // the canvas, as pointer capture does on a device.
    field.dispatchEvent(ev('pointerdown', r.x + 10, r.y + r.height / 2));
    for (let i = 1; i <= 20; i++) canvas.dispatchEvent(ev('pointermove', r.x + 10 + i * 6, r.y + r.height / 2 + 4 * Math.sin(i)));
    canvas.dispatchEvent(ev('pointerup', r.x + 130, r.y + r.height / 2));
  }, r);
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes.length), SLOW).toBe(1);
  await expect(page.locator('.fill-field[data-field="name"]')).not.toBeFocused(SLOW);
});

test('flat PDF: typed text snaps onto the printed line; a checkmark is real ink', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const p = pdf.addPage([612, 792]);
  p.drawText('Name', { x: 72, y: 704, size: 10 });
  p.drawLine({ start: { x: 110, y: 700 }, end: { x: 400, y: 700 }, thickness: 1 });
  await openApp(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Flat.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.waitForFunction(() => (window as any).__inkwright?.doc?.pageCount === 1, null, { timeout: 20000 });
  await expect(page.locator('.fill-chip')).toHaveCount(0); // no fields
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Fill & sign' }).click();
  const bar = page.getByRole('toolbar', { name: 'Fill and sign' });
  await bar.getByRole('button', { name: 'Text' }).click();
  const lineY = (792 - 700) * (4 / 3);
  const [x, y] = await pagePoint(page, 0, 300, lineY - 10);
  await page.mouse.click(x, y);
  await expect(page.locator('.text-edit textarea')).toBeFocused(SLOW);
  await page.keyboard.type('Ada');
  await page.keyboard.press('Escape');
  const t = await page.evaluate(() => (window as any).__inkwright.doc.page(0).texts?.[0]);
  expect(t.text).toBe('Ada');
  // Baseline (≈ y + 1.02 × size) just above the line.
  expect(lineY - (t.y + t.fontSize * 1.02)).toBeGreaterThan(0);
  expect(lineY - (t.y + t.fontSize * 1.02)).toBeLessThan(8);
  await bar.getByRole('button', { name: 'Check' }).click();
  const [cx, cy] = await pagePoint(page, 0, 500, 500);
  await page.mouse.click(cx, cy);
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes.length), SLOW).toBe(1);
});

test('open text and Markdown files; drop files onto the library and onto a note', async ({ page }) => {
  await openApp(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Groceries.md', mimeType: 'text/markdown', buffer: Buffer.from('# Groceries\n\n- [ ] Rice\n- [ ] Dal\n') });
  await page.waitForFunction(() => (window as any).__inkwright?.doc?.meta.title === 'Groceries', null, { timeout: 20000 });
  expect(await page.evaluate(() => (window as any).__inkwright.doc.page(0).texts[0].text)).toContain('- [ ] Rice');
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.items.add(new File(['Dropped words'], 'Dropped.txt', { type: 'text/plain' }));
    const lib = document.querySelector('.library')!;
    for (const type of ['dragenter', 'dragover', 'drop']) lib.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true }));
  });
  await page.waitForFunction(() => (window as any).__inkwright?.doc?.meta.title === 'Dropped', null, { timeout: 20000 });
  expect(await page.evaluate(() => (window as any).__inkwright.doc.page(0).texts[0].text)).toBe('Dropped words');
  // Dropping a PDF onto the open note adds its pages after the current one.
  const pdf = await PDFDocument.create();
  pdf.addPage([612, 792]);
  pdf.addPage([612, 792]);
  const bytes = [...await pdf.save()];
  await page.evaluate((bytes) => {
    const dt = new DataTransfer();
    dt.items.add(new File([new Uint8Array(bytes)], 'Two.pdf', { type: 'application/pdf' }));
    const ed = document.querySelector('.editor')!;
    for (const type of ['dragenter', 'dragover', 'drop']) ed.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: 600, clientY: 400 }));
  }, bytes);
  await page.waitForFunction(() => (window as any).__inkwright.doc.pageCount === 3, null, { timeout: 20000 });
  expect(await page.evaluate(() => (window as any).__inkwright.doc.pages.map((p: any) => p.background?.kind ?? 'paper'))).toEqual(['paper', 'pdf', 'pdf']);
});

test('pages panel: rotate a PDF page and copy pages to a new note', async ({ page }) => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i++) pdf.addPage([612, 792]).drawText(`Page ${i + 1}`, { x: 72, y: 700, size: 24 });
  await openApp(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Three.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.waitForFunction(() => (window as any).__inkwright?.doc?.pageCount === 3, null, { timeout: 20000 });
  await editorMenu(page, 'Pages');
  const panel = page.getByRole('complementary', { name: 'Pages' });
  await panel.getByRole('button', { name: 'Rotate page' }).first().click();
  const p0 = await page.evaluate(() => { const p = (window as any).__inkwright.doc.page(0); return { w: p.size.width, h: p.size.height, rot: p.background.rotation }; });
  expect(p0).toEqual({ w: 1056, h: 816, rot: 90 });
  await panel.getByRole('button', { name: 'Select' }).click();
  await panel.getByRole('button', { name: 'Select page 2' }).click();
  await panel.getByRole('button', { name: 'Select page 3' }).click();
  await panel.getByRole('button', { name: 'Copy to new note' }).click();
  await page.locator('.toast-action', { hasText: 'Open' }).click();
  await page.waitForFunction(() => (window as any).__inkwright?.doc?.meta.title === 'Three (pages 2–3)', null, { timeout: 20000 });
  expect(await page.evaluate(() => (window as any).__inkwright.doc.pages.map((p: any) => p.background.pageNumber))).toEqual([2, 3]);
});
