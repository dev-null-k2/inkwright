import { expect, test, type Page, type Route } from '@playwright/test';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { modKey, newNote, openApp, pen, word } from './helpers.ts';

async function openPalette(page: Page) {
  await page.keyboard.press(`${await modKey(page)}+k`);
  await expect(page.locator('.palette')).toBeVisible();
}

/** The flashed region, in page units, as the engine sees it. */
async function flashed(page: Page) {
  const el = page.locator('.ink-flash');
  await expect(el).toBeVisible();
  return el.boundingBox();
}

test('search everything finds typed text and opens the note at the passage', async ({ page }) => {
  await openApp(page);
  await openPalette(page);
  await page.locator('.pal-input').fill('flashcards');
  const hit = page.locator('.pal-row', { hasText: 'p. 1 · typed text' }).first();
  await expect(hit).toBeVisible();
  await expect(hit.locator('mark')).toContainText(/flashcards/i);
  await hit.click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await expect(page.locator('.palette')).toHaveCount(0);
  const box = await flashed(page);
  const canvas = await page.locator('.ed-canvas').boundingBox();
  // The highlighted passage is on screen.
  expect(box!.y).toBeGreaterThan(canvas!.y - 4);
  expect(box!.y + box!.height).toBeLessThan(canvas!.y + canvas!.height + 4);
});

test('recognized handwriting is searchable and the hit highlights the exact strokes', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await pen(page, word(300, 420, 180));
  await pen(page, word(300, 170, 120));
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes.length)).toBe(2);
  // Simulate a line-by-line recognizer (ML Kit on Android) storing each line with its strokes.
  const bounds = await page.evaluate(() => {
    const { doc } = (window as any).__inkwright;
    const p = doc.page(0);
    const box = (s: any) => {
      const xs = s.points.map((q: any) => q.x), ys = s.points.map((q: any) => q.y);
      return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
    };
    const [low, high] = p.strokes; // written at y=420 and y=170
    doc.setRecognizedText(p.id, 'shopping list\nnyquist sampling theorem', 'test', [
      { text: 'shopping list', strokeIds: [high.id], bounds: box(high) },
      { text: 'nyquist sampling theorem', strokeIds: [low.id], bounds: box(low) },
    ]);
    return box(low);
  });
  await openPalette(page);
  await page.locator('.pal-input').fill('nyquist');
  const hit = page.locator('.pal-row', { hasText: 'handwriting' }).first();
  await expect(hit).toBeVisible({ timeout: 10000 }); // after the autosave re-indexes the page
  await hit.click();
  const box = await flashed(page);
  const expected = await page.evaluate((b) => (window as any).__inkwright.engine.pageRectToScreen(0, b), bounds);
  const canvas = await page.locator('.ed-canvas').boundingBox();
  // The highlight surrounds the stroke the line was recognized from (6px padding).
  expect(Math.abs(box!.x - (canvas!.x + expected.x - 6))).toBeLessThan(3);
  expect(Math.abs(box!.y - (canvas!.y + expected.y - 6))).toBeLessThan(3);
  expect(Math.abs(box!.width - (expected.w + 12))).toBeLessThan(3);
});

test('text of imported PDFs is searchable and opens on the right page', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.addPage([612, 792]).drawText('Course overview', { x: 72, y: 700, size: 24, font });
  pdf.addPage([612, 792]).drawText('Discrete Fourier transform and windowing', { x: 72, y: 400, size: 20, font });
  await openApp(page);
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Signals.pdf', mimeType: 'application/pdf', buffer: Buffer.from(await pdf.save()) });
  await page.waitForFunction(() => (window as any).__inkwright?.doc?.pageCount === 2, null, { timeout: 20000 });
  await openPalette(page);
  await page.locator('.pal-input').fill('windowing');
  const hit = page.locator('.pal-row', { hasText: 'p. 2 · PDF' }).first();
  await expect(hit).toBeVisible({ timeout: 15000 });
  await hit.click();
  await flashed(page);
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.engine.currentPageIndex)).toBe(1);
});

test('actions run from the palette', async ({ page }) => {
  await openApp(page);
  await openPalette(page);
  await page.locator('.pal-input').fill('writing sound');
  await page.locator('.pal-row', { hasText: 'Turn writing sound off' }).click();
  await expect(page.locator('.palette')).toHaveCount(0);
  await openPalette(page);
  await page.locator('.pal-input').fill('writing sound');
  await expect(page.locator('.pal-row', { hasText: 'Turn writing sound on' })).toBeVisible();
  // Keyboard: move to the action and run it with Enter.
  await page.locator('.pal-input').fill('new note');
  const rows = page.locator('.pal-row');
  const index = await rows.evaluateAll((els) => els.findIndex((e) => e.textContent?.includes('New note')));
  for (let i = 0; i < index; i++) await page.locator('.pal-input').press('ArrowDown');
  await expect(page.locator('.pal-row.is-active')).toContainText('New note');
  await page.locator('.pal-input').press('Enter');
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
});

async function mockLLM(page: Page, reply: string) {
  const requests: any[] = [];
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    let sse = '';
    for (const w of reply.split(/(?<= )/)) sse += chunk({ content: w });
    sse += chunk({}, 'stop') + 'data: [DONE]\n\n';
    await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse });
  });
  return requests;
}

test('Ask answers from all notes with citations that open the cited place', async ({ page }) => {
  const reqs = await mockLLM(page, 'Your notes are saved as plain files [1], and any AI agent can read them [1].');
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill('mock-1');
  await page.getByRole('button', { name: 'Save provider' }).click();
  await openPalette(page);
  await page.locator('.pal-input').fill('How are my notes saved as plain files?');
  await page.locator('.pal-input').press('Tab');
  await expect(page.getByRole('radio', { name: 'Ask' })).toHaveAttribute('aria-checked', 'true');
  await page.locator('.pal-input').press('Enter');
  await expect(page.locator('.pal-answer-text')).toContainText('saved as plain files');
  await expect(page.locator('.pal-foot')).toContainText('Answered by Custom (OpenAI-compatible) · mock-1');
  await expect(page.locator('.pal-sources li').first()).toContainText('Welcome to Inkwright');
  // The model got numbered passages from the notes.
  const user = reqs[0].messages.find((m: any) => m.role === 'user').content;
  expect(user).toContain('[1] "Welcome to Inkwright", page 1');
  expect(user).toContain('plain files');
  await page.locator('.pal-cite').first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await flashed(page);
  await expect(page.locator('.ed-title-text')).toHaveText('Welcome to Inkwright');
});

test('links to a place in a note (as the assistant writes them) open it and flash the region', async ({ page }) => {
  await openApp(page);
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  const id = await page.evaluate(() => (window as any).__inkwright.doc.meta.id);
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.locator('.library')).toBeVisible();
  await page.evaluate((nid) => {
    const a = document.createElement('a');
    a.textContent = 'Welcome, p. 1';
    a.className = 'test-cite';
    a.href = `#mem/${nid}/1/64,560,640,60`;
    document.body.append(a);
  }, id);
  await page.locator('.test-cite').click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  await flashed(page);
});

test('without any AI, Ask offers the private on-device model with its size', async ({ page }) => {
  await openApp(page);
  await openPalette(page);
  await page.getByRole('radio', { name: 'Ask' }).click();
  await page.locator('.pal-input').fill('What did I write about AI?');
  await page.locator('.pal-input').press('Enter');
  const offer = page.locator('.lai-offer');
  await expect(offer).toBeVisible();
  await expect(offer).toContainText('Use AI privately on this device');
  await expect(offer.getByRole('button', { name: /Download \d+(\.\d)? (MB|GB)/ })).toBeVisible();
});
