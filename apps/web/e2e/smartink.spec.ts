import { expect, test, type Page, type Route } from '@playwright/test';
import { circle, line, newNote, openApp, pen, strokes, word, type Pt } from './helpers.ts';

/** A scripted OpenAI-compatible server (vision model) for the AI-read paths. */
async function mockLLM(page: Page, reply: (body: any) => string) {
  const requests: any[] = [];
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const text = reply(body);
    if (body.stream) {
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }) });
    }
  });
  return requests;
}

async function addVisionProvider(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill('mock-vision-1');
  await page.getByRole('button', { name: 'Save provider' }).click();
  await expect(page.locator('.prov-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Back' }).click();
}

const objects = (page: Page) => page.evaluate(() => (window as any).__inkstone.doc.page(0).objects ?? []);

test('draw a grid → it becomes a table → write and type in its cells', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  const [x0, y0, x1, y1] = [200, 200, 500, 380];
  const box: Pt[] = [...line([x0, y0], [x1, y0]), ...line([x1, y0], [x1, y1]).slice(1), ...line([x1, y1], [x0, y1]).slice(1), ...line([x0, y1], [x0, y0 + 2]).slice(1)];
  await pen(page, box);
  await pen(page, line([x0 + 2, 260], [x1 - 2, 261]));
  await pen(page, line([x0, 320], [x1, 320]));
  await pen(page, line([300, y0 + 2], [301, y1 - 2]));
  await pen(page, line([400, y0], [400, y1]));
  await page.getByRole('button', { name: 'Make a table' }).click();

  const [t] = await objects(page);
  expect(t.type).toBe('table');
  expect(t.rows).toHaveLength(3);
  expect(t.cols).toHaveLength(3);
  // The grid's strokes became the table.
  expect(await strokes(page)).toHaveLength(0);

  // Ink written in the middle cell belongs to it (and stays inside it).
  await pen(page, word(318, 290, 60));
  const inCell = await page.evaluate(() => {
    const p = (window as any).__inkstone.doc.page(0);
    const t = p.objects[0];
    const s = p.strokes[0];
    const xs = s.points.map((q: any) => q.x), ys = s.points.map((q: any) => q.y);
    const cx = (Math.min(...xs) + Math.max(...xs)) / 2, cy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const left = t.x + t.cols[0], top = t.y + t.rows[0];
    return { input: s.input, inside: cx > left && cx < left + t.cols[1] && cy > top && cy < top + t.rows[1] };
  });
  expect(inCell).toEqual({ input: 'pen', inside: true });

  // Type into the first cell, then add a row above the written-in row: the ink moves with its cell.
  await page.getByRole('button', { name: 'Edit table' }).click();
  await page.getByRole('button', { name: 'Cell row 1, column 1' }).click();
  await page.keyboard.type('Item');
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await objects(page))[0].cells[0][0].text).toBe('Item');
  const yBefore = await page.evaluate(() => (window as any).__inkstone.doc.page(0).strokes[0].points[0].y);
  await page.getByRole('button', { name: 'Cell row 1, column 2' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Row$/ }).click();
  const after = await objects(page);
  expect(after[0].rows).toHaveLength(4);
  const yAfter = await page.evaluate(() => (window as any).__inkstone.doc.page(0).strokes[0].points[0].y);
  expect(yAfter).toBeGreaterThan(yBefore + 10);

  // Copy as Markdown.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.getByRole('button', { name: 'Copy table' }).click();
  await page.getByRole('menuitem', { name: 'Copy as Markdown' }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('| Item |');
  await page.screenshot({ path: 'test-results/smartink-table.png' });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
});

test('a solved function plots as a live graph that pans and zooms', async ({ page }) => {
  await mockLLM(page, () => JSON.stringify({ plain: 'y = x^2 - 4', latex: 'y=x^2-4', steps: [], answer: '' }));
  await openApp(page);
  await addVisionProvider(page);
  await newNote(page);
  await pen(page, word(160, 200, 120));
  await page.keyboard.press('l');
  await pen(page, circle(220, 200, 90), { type: 'mouse' });
  await page.getByRole('button', { name: 'Solve' }).click();
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  expect((await objects(page))[0].result).toBe('x-intercepts −2, 2; y-intercept −4');
  await page.getByRole('button', { name: /^Result x-intercepts/ }).click();
  await page.getByRole('menuitem', { name: 'Plot' }).click();
  await expect.poll(async () => (await objects(page)).map((o: any) => o.type)).toEqual(['math', 'graph']);
  const g0 = (await objects(page))[1];
  expect(g0.functions[0].expr).toBe('x^2 - 4');
  const graph = page.getByRole('img', { name: /Graph of y = x\^2 - 4/ });
  await graph.hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(async () => { const v = (await objects(page))[1].view; return v.xMax - v.xMin; }).toBeLessThan(g0.view.xMax - g0.view.xMin);
  const box = (await graph.boundingBox())!;
  const v1 = (await objects(page))[1].view;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 4 });
  await page.mouse.up();
  expect((await objects(page))[1].view.xMin).toBeLessThan(v1.xMin);
  await page.screenshot({ path: 'test-results/smartink-graph.png' });
});

test('lasso an equation → Solve → a result object next to it (AI reads, device solves)', async ({ page }) => {
  const reqs = await mockLLM(page, () => JSON.stringify({ plain: '2x + 3 = 7', latex: '2x+3=7', steps: ['Subtract 3 from both sides: 2x = 4', 'Divide by 2: x = 2'], answer: 'x = 2' }));
  await openApp(page);
  await addVisionProvider(page);
  await newNote(page);
  await pen(page, word(200, 300, 70));
  await pen(page, line([290, 300], [310, 300], 10));
  await pen(page, word(320, 300, 30));
  await page.keyboard.press('l');
  await pen(page, circle(270, 300, 110), { type: 'mouse' });
  await page.getByRole('button', { name: 'Solve' }).click();
  await expect.poll(async () => (await objects(page)).length).toBe(1);
  const [m] = await objects(page);
  expect(m).toMatchObject({ type: 'math', input: '2x + 3 = 7', result: 'x = 2', origin: 'ai' });
  expect(m.steps).toHaveLength(2);
  // The handwriting itself is untouched, and the vision request carried an image.
  expect((await strokes(page)).length).toBe(3);
  expect(JSON.stringify(reqs[0].messages)).toContain('image_url');
  // Its menu shows the steps.
  await page.getByRole('button', { name: /^Result x = 2/ }).click();
  await page.getByRole('menuitem', { name: 'Show steps' }).click();
  await expect(page.getByRole('dialog', { name: 'Steps' })).toContainText('Divide by 2');
});

test('circle a date → read it → download an .ics event', async ({ page }) => {
  await mockLLM(page, () => 'Signals midterm Sat 14 Nov 2026 3pm');
  await openApp(page);
  await addVisionProvider(page);
  await newNote(page);
  await pen(page, word(240, 300, 120));
  await pen(page, circle(300, 300, 95));
  await page.getByRole('button', { name: 'Read circled writing' }).click();
  const card = page.getByRole('dialog', { name: 'What you circled' });
  await expect(card).toContainText('Add to calendar');
  await expect(card).toContainText('Signals midterm');
  await page.screenshot({ path: 'test-results/smartink-date.png' });
  const download = page.waitForEvent('download');
  await card.getByRole('button', { name: /\.ics/ }).click();
  const d = await download;
  expect(d.suggestedFilename()).toBe('Signals midterm 2026-11-14.ics');
  const fs = await import('node:fs');
  const ics = fs.readFileSync((await d.path())!, 'utf8');
  expect(ics).toContain('BEGIN:VEVENT');
  expect(ics).toContain('SUMMARY:Signals midterm');
  expect(ics).toMatch(/DTSTART:20261114T\d{6}Z/);
  // Google Calendar link is prefilled too.
  const href = await card.getByRole('link', { name: /Google Calendar/ }).getAttribute('href');
  expect(href).toContain('action=TEMPLATE');
});

test('export PDF → verify its authorship certificate; the panel notices later edits', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  await pen(page, word(200, 220, 160));
  await pen(page, word(200, 280, 140));
  await pen(page, word(200, 340, 120), { type: 'mouse' });

  // Sign in the editor's panel: verified, then changed after more writing.
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /Authorship/ }).click();
  const panel = page.getByRole('dialog', { name: 'Authorship' });
  await expect(panel).toContainText('Not signed yet');
  await expect(panel).toContainText('3 strokes (2 with pen pressure), 1 by mouse');
  await panel.getByRole('button', { name: 'Sign certificate' }).click();
  await expect(panel).toContainText('Verified handwriting');
  await panel.getByRole('button', { name: 'Done' }).click();
  await pen(page, word(200, 400, 100));
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /Authorship/ }).click();
  await expect(panel).toContainText('Changed since signing');
  await panel.getByRole('button', { name: 'Done' }).click();

  // Export: the PDF carries a fresh certificate; verify it offline in Settings › Authorship.
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /Export and share/ }).click();
  await page.getByRole('menuitem', { name: /PDF/ }).click();
  const d = await download;
  const path = (await d.path())!;
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Authorship' }).click();
  const own = await page.getByTestId('device-fingerprint').textContent();
  await page.locator('input.auth-file').setInputFiles({ name: 'note.pdf', mimeType: 'application/pdf', buffer: (await import('node:fs')).readFileSync(path) });
  const report = page.getByTestId('verify-report');
  await expect(report).toHaveAttribute('data-status', 'verified');
  await expect(report).toContainText('Verified handwriting');
  await expect(report).toContainText('4 strokes (3 with pen pressure), 1 by mouse');
  await expect(report).toContainText(`${own} — this device`);
  await page.screenshot({ path: 'test-results/smartink-verify.png', fullPage: true });

  // A tampered certificate (more "handwriting" claimed than was written) is rejected.
  const { PDFDocument, PDFName, PDFDict, PDFArray, PDFRawStream, decodePDFRawStream } = await import('pdf-lib');
  const fs = await import('node:fs');
  const pdf = await PDFDocument.load(fs.readFileSync(path));
  const names = pdf.catalog.lookup(PDFName.of('Names'), PDFDict).lookup(PDFName.of('EmbeddedFiles'), PDFDict).lookup(PDFName.of('Names'), PDFArray);
  const spec = names.lookup(1, PDFDict);
  const stream = spec.lookup(PDFName.of('EF'), PDFDict).lookup(PDFName.of('F'));
  if (!(stream instanceof PDFRawStream)) throw new Error('no attachment stream');
  const cert = JSON.parse(Buffer.from(decodePDFRawStream(stream).decode()).toString('utf8'));
  expect(cert.claim.totals.handwritten).toBe(4);
  cert.claim.totals.handwritten = 99;
  await page.locator('input.auth-file').setInputFiles({ name: 'tampered.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(cert)) });
  await expect(report).toHaveAttribute('data-status', 'invalid');
  await expect(report).toContainText('Certificate not valid');
});
