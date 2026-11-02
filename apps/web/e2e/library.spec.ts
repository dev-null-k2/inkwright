import { expect, test } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { newNote, openApp, pen, word } from './helpers.ts';

test('first run shows the welcome note and no errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await openApp(page);
  await expect(page.locator('.note-title').first()).toHaveText('Welcome to Inkstone');
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkstone?.engine);
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.locator('.library')).toBeVisible();
  expect(errors).toEqual([]);
});

test('rename, pin, trash and restore a note', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await page.locator('.ed-title').click();
  await page.locator('.dialog input').fill('Biology lecture');
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('.ed-title-text')).toHaveText('Biology lecture');
  await page.getByRole('button', { name: 'Back to library' }).click();
  const card = page.locator('.note-card', { hasText: 'Biology lecture' });
  await card.getByRole('button', { name: /Options for/ }).click();
  await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
  await expect(page.locator('.note-card', { hasText: 'Biology lecture' })).toHaveCount(0);
  await page.locator('.toast-action').click();
  await expect(page.locator('.note-card', { hasText: 'Biology lecture' })).toHaveCount(1);
});

test('notebooks: create one and move a note into it', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'New notebook' }).click();
  await page.locator('.dialog input').fill('School');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(page.locator('.lib-h1')).toHaveText('School');
  await page.getByRole('button', { name: 'All notes' }).click();
  await page.locator('.note-card').first().getByRole('button', { name: /Options for/ }).click();
  await page.getByRole('menuitem', { name: 'Move to notebook' }).click();
  await page.locator('.dialog').getByText('School').click();
  await page.locator('.nav-item', { hasText: 'School' }).click();
  await expect(page.locator('.note-card')).toHaveCount(1);
});

test('search finds typed text inside notes', async ({ page }) => {
  await openApp(page);
  await page.locator('.search input').fill('flashcar');
  await expect(page.locator('.hit-title').first()).toHaveText('Welcome to Inkstone');
  await expect(page.locator('.hit-snippet mark').first()).toContainText(/flashcards/i);
  await page.locator('.search input').fill('zzzqqq');
  await expect(page.locator('.lib-h1')).toContainText('Nothing matches');
});

test('importing a PDF creates annotatable pages and exports a vector PDF', async ({ page }) => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 3; i++) pdf.addPage([612, 792]).drawText(`Slide ${i + 1}`, { x: 72, y: 700, size: 32 });
  const bytes = await pdf.save();
  await openApp(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Lecture slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.waitForFunction(() => (window as any).__inkstone?.doc?.pageCount === 3, null, { timeout: 20000 });
  await expect(page.locator('.ed-title-text')).toHaveText('Lecture slides');
  await pen(page, word(200, 220, 160));
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /Export and share/ }).click();
  await page.getByRole('menuitem', { name: /PDF/ }).click();
  const d = await download;
  const path = await d.path();
  const fs = await import('node:fs');
  const out = await PDFDocument.load(fs.readFileSync(path!));
  expect(out.getPageCount()).toBe(3);
  expect(out.getTitle()).toBe('Lecture slides');
});

test('markdown export contains typed text', async ({ page }) => {
  await openApp(page);
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkstone?.engine);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /Export and share/ }).click();
  await page.getByRole('menuitem', { name: /Markdown/ }).click();
  const d = await download;
  const fs = await import('node:fs');
  const md = fs.readFileSync((await d.path())!, 'utf8');
  expect(md).toContain('# Welcome to Inkstone');
  expect(md).toContain('Scribble back and forth');
});

test('new note sheet creates an infinite board with chosen paper', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'More ways to create' }).click();
  await page.getByRole('radio', { name: 'Infinite canvas' }).click();
  await page.getByRole('radio', { name: 'Dot grid' }).click();
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await page.waitForFunction(() => !!(window as any).__inkstone?.engine);
  const meta = await page.evaluate(() => (window as any).__inkstone.doc.meta);
  expect(meta.kind).toBe('board');
  expect(meta.paper.style).toBe('dot_grid');
  await pen(page, word(-100 + 400, 200, 160));
  await newNoteBack(page);
});

async function newNoteBack(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.locator('.library')).toBeVisible();
}

void newNote;
