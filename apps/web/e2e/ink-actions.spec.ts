import { expect, test, type Page, type Route } from '@playwright/test';
import * as XLSX from 'xlsx';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { line, modKey, newNote, openApp, pen, type Pt } from './helpers.ts';

/**
 * Ink that does things (docs/INK_ACTIONS.md): AI answers in ink, executable diagrams, the data
 * sandbox, photo to ink, read aloud and the reading view, and the paper workbench — each through
 * the UI a person uses, with a scripted OpenAI-compatible model where an AI is involved.
 */

/** A scripted OpenAI-compatible server; `reply` sees each request body. Streams when asked to. */
async function mockLLM(page: Page, reply: (body: any, n: number) => string) {
  const requests: any[] = [];
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON();
    requests.push(body);
    const text = reply(body, requests.length);
    if (body.stream) {
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: chunk({ role: 'assistant', content: text }) + chunk({}, 'stop') + 'data: [DONE]\n\n' });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }] }) });
    }
  });
  return requests;
}

const lastUser = (body: any): string => {
  const m = [...body.messages].reverse().find((x: any) => x.role === 'user');
  return typeof m?.content === 'string' ? m.content : (m?.content ?? []).map((p: any) => p.text ?? '').join('\n');
};

async function addProvider(page: Page) {
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

const ink = (page: Page, i = 0): Promise<{ id: string; origin: string | null; color: string; n: number }[]> => page.evaluate((k) => (window as any).__inkstone.doc.page(k).strokes.map((s: any) => ({ id: s.id, origin: s.origin ?? null, color: s.color, n: s.points.length })), i);
const objects = (page: Page, i = 0) => page.evaluate((k) => (window as any).__inkstone.doc.page(k).objects ?? [], i);

/** Adds a typed text box through the document (what the text tool produces). */
const typeBox = (page: Page, text: string, x: number, y: number, width = 150) => page.evaluate(({ text, x, y, width }) => {
  const d = (window as any).__inkstone.doc;
  d.upsertText(0, { id: `t${Math.round(x)}${Math.round(y)}`, x, y, width, text, fontSize: 14, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() });
}, { text, x, y, width });

async function moreMenu(page: Page, item: string | RegExp) {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: item }).click();
}

/** Screen position (canvas px) of a page point. */
const toScreen = (page: Page, x: number, y: number) => page.evaluate(({ x, y }) => {
  const r = (window as any).__inkstone.engine.pageRectToScreen(0, { minX: x, minY: y, maxX: x, maxY: y });
  return [r.x, r.y] as [number, number];
}, { x, y });

test.describe('AI answers in ink', () => {
  test('lasso a question → the answer is written in AI ink beside it, one undo removes it', async ({ page }) => {
    const reqs = await mockLLM(page, () => 'The capital of France is Paris.');
    await openApp(page);
    await addProvider(page);
    await newNote(page);
    await typeBox(page, 'What is the capital of France?', 80, 100, 300);
    await page.keyboard.press(`${await modKey(page)}+a`);
    await page.getByRole('toolbar', { name: /selected/ }).getByRole('button', { name: 'Answer' }).click();
    await expect.poll(async () => (await ink(page)).length, { timeout: 15000 }).toBeGreaterThan(20);
    const strokes = await ink(page);
    expect(strokes.every((s) => s.origin === 'ai' && s.color === '#FF2D5A8C')).toBe(true);
    // The question went to the model as text from the selection.
    expect(lastUser(reqs[0])).toContain('What is the capital of France?');
    // Written below the question, not over it.
    const top = await page.evaluate(() => Math.min(...(window as any).__inkstone.doc.page(0).strokes.flatMap((s: any) => s.points.map((p: any) => p.y))));
    expect(top).toBeGreaterThan(110);
    await expect(page.getByText('Answered on the page')).toBeVisible();
    await page.keyboard.press(`${await modKey(page)}+z`);
    await expect.poll(async () => (await ink(page)).length).toBe(0);
    await page.screenshot({ path: 'test-results/ink-answer.png' });
  });

  test('"Answer on the page in: typed text" puts an AI text box instead; the assistant panel offers it too', async ({ page }) => {
    await mockLLM(page, (body) => (body.tools ? 'Here is a short answer: 42.' : 'Forty-two.'));
    await openApp(page);
    await addProvider(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'Ink actions' }).click();
    await page.getByRole('radio', { name: 'Typed text' }).click();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await newNote(page);
    await typeBox(page, 'Answer to everything?', 80, 100);
    await page.keyboard.press(`${await modKey(page)}+a`);
    await page.getByRole('toolbar', { name: /selected/ }).getByRole('button', { name: 'Answer' }).click();
    await expect.poll(() => page.evaluate(() => ((window as any).__inkstone.doc.page(0).texts ?? []).map((t: any) => [t.text, t.origin ?? null]))).toContainEqual(['Forty-two.', 'ai']);
    // The assistant panel's reply offers "Write the answer here" too (typed, per the setting).
    await page.locator('.ai-btn').click();
    await page.locator('.ai-input textarea').fill('What is six times seven?');
    await page.locator('.ai-input textarea').press('Enter');
    await page.getByRole('button', { name: 'Write the answer here' }).click();
    await expect.poll(() => page.evaluate(() => ((window as any).__inkstone.doc.page(0).texts ?? []).length)).toBe(3);
  });

  test('the assistant writes on the open page with write_in_ink', async ({ page }) => {
    let i = 0;
    await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
      const body = route.request().postDataJSON();
      const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      let sse: string;
      if (i++ === 0) {
        expect(body.tools.map((t: any) => t.function.name)).toContain('write_in_ink');
        const noteId = /\(id ([^,]+),/.exec(JSON.stringify(body.messages))![1];
        const args = JSON.stringify({ noteId, page: 1, text: 'Remember the milk', near: { x: 60, y: 60, width: 200, height: 30 } });
        sse = chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_in_ink', arguments: args } }] }) + chunk({}, 'tool_calls');
      } else sse = chunk({ role: 'assistant', content: 'I wrote it on your page.' }) + chunk({}, 'stop');
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse + 'data: [DONE]\n\n' });
    });
    await openApp(page);
    await addProvider(page);
    await newNote(page);
    await page.locator('.ai-btn').click();
    await page.locator('.ai-input textarea').fill('Write "remember the milk" on my page in ink');
    await page.locator('.ai-input textarea').press('Enter');
    await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('I wrote it on your page.');
    await expect.poll(async () => (await ink(page)).length).toBeGreaterThan(12);
    expect((await ink(page)).every((s) => s.origin === 'ai')).toBe(true);
  });
});

test.describe('executable diagrams', () => {
  test('draw boxes and arrows → confirm the graph → run local and AI steps → keep results', async ({ page }) => {
    await page.route('https://data.test/sales.csv', (route) => route.fulfill({ status: 200, headers: { 'content-type': 'text/csv', 'access-control-allow-origin': '*' }, body: 'region,amount\nNorth,10\nSouth,5\nNorth,7\n' }));
    const reqs = await mockLLM(page, (body) => (lastUser(body).includes('Step: say it in words') ? 'Twenty-two in total.' : 'unexpected'));
    await openApp(page);
    await addProvider(page);
    await newNote(page);
    // Three boxes drawn with the pen (closed loops), labels typed inside.
    const box = async (x: number, y: number) => {
      const [a, b] = await toScreen(page, x, y), [c, d] = await toScreen(page, x + 170, y + 60);
      const pts: Pt[] = [...line([a, b], [c, b]), ...line([c, b], [c, d]).slice(1), ...line([c, d], [a, d]).slice(1), ...line([a, d], [a, b + 2]).slice(1)];
      await pen(page, pts);
    };
    await box(60, 80);
    await box(330, 80);
    await box(330, 260);
    await typeBox(page, 'fetch https://data.test/sales.csv', 70, 95, 150);
    await typeBox(page, 'sum amount', 340, 100, 150);
    await typeBox(page, 'say it in words', 340, 280, 150);
    // Arrows: a V head on the first, a hook (barb in the same stroke) on the second.
    const [s1, t1] = await toScreen(page, 236, 110), [e1, f1] = await toScreen(page, 324, 110);
    await pen(page, line([s1, t1], [e1, f1]));
    await pen(page, [[e1 - 12, f1 - 8], [e1, f1], [e1 - 12, f1 + 8]]);
    const [s2, t2] = await toScreen(page, 415, 146), [e2, f2] = await toScreen(page, 415, 254);
    await pen(page, [...line([s2, t2], [e2, f2]), ...line([e2, f2], [e2 - 8, f2 - 12]).slice(1)]);
    // Ink that sits right of the pipeline must not confuse it.
    await page.keyboard.press(`${await modKey(page)}+a`);
    await page.getByRole('toolbar', { name: /selected/ }).getByRole('button', { name: 'Run' }).click();
    const bar = page.getByRole('region', { name: 'Run the diagram' });
    await expect(bar).toContainText('3 steps, 2 arrows · 1 by AI · 1 from the web');
    await expect(page.locator('.ia-run-edge')).toHaveCount(2);
    await bar.getByRole('button', { name: 'Run', exact: true }).click();
    await expect(page.getByRole('group', { name: 'Step: sum amount' })).toContainText('22');
    await expect(page.getByRole('group', { name: 'Step: say it in words' })).toContainText('Twenty-two in total.');
    // The AI step got the upstream output as its input.
    expect(lastUser(reqs[reqs.length - 1])).toContain('## From “sum amount”\n22');
    // Run one step again: only it runs.
    const before = reqs.length;
    await page.getByRole('button', { name: 'Run “say it in words” again' }).click();
    await expect.poll(() => reqs.length).toBe(before + 1);
    await expect(bar).toContainText('3 done');
    await page.screenshot({ path: 'test-results/ink-canvas-run.png' });
    await bar.getByRole('button', { name: 'Keep results on the page' }).click();
    const objs = await objects(page);
    expect(objs.map((o: any) => [o.type, o.origin])).toEqual(expect.arrayContaining([['table', 'solver'], ['sticky', 'solver'], ['sticky', 'ai']]));
    await expect(bar).toHaveCount(0);
  });

  test('a loop is reported and nothing runs', async ({ page }) => {
    await openApp(page);
    await newNote(page);
    await page.evaluate(() => {
      const d = (window as any).__inkstone.doc;
      const pts = (c: number[][]) => c.flatMap(([x, y], i, a) => (i ? Array.from({ length: 20 }, (_, k) => ({ x: a[i - 1]![0]! + ((x! - a[i - 1]![0]!) * (k + 1)) / 20, y: a[i - 1]![1]! + ((y! - a[i - 1]![1]!) * (k + 1)) / 20, t: k, p: 0.5, tilt: -1, orient: -1 })) : [{ x: x!, y: y!, t: 0, p: 0.5, tilt: -1, orient: -1 }]));
      const s = (id: string, c: number[][], shape?: string) => ({ id, pen: 'ballpoint', color: '#FF000000', size: 2, createdAt: 0, points: pts(c), ...(shape ? { shape } : {}) });
      const strokes = [
        s('a', [[60, 80], [220, 80], [220, 140], [60, 140], [60, 80]], 'rectangle'), s('b', [[330, 80], [490, 80], [490, 140], [330, 140], [330, 80]], 'rectangle'),
        s('s1', [[225, 100], [325, 100]]), s('h1', [[315, 94], [325, 100], [315, 106]]),
        s('s2', [[325, 125], [225, 125]]), s('h2', [[235, 119], [225, 125], [235, 131]]),
      ];
      d.commit(0, { label: 'x', strokes: { removed: [], added: strokes.map((item: any, index: number) => ({ index, item })) } });
    });
    await typeBox(page, '1', 70, 100);
    await typeBox(page, 'sum', 340, 100);
    await page.keyboard.press(`${await modKey(page)}+a`);
    await page.getByRole('toolbar', { name: /selected/ }).getByRole('button', { name: 'Run' }).click();
    const bar = page.getByRole('region', { name: 'Run the diagram' });
    await expect(bar).toContainText('This diagram has a loop');
    await expect(bar.getByRole('button', { name: 'Run', exact: true })).toBeDisabled();
  });
});

test.describe('data sandbox', () => {
  test('drop a CSV → a data table; SQL in DuckDB; ask in words with a repair; put results on the page', async ({ page }) => {
    const reqs = await mockLLM(page, (_b, n) => (n === 1 ? '```sql\nSELECT region, sum(amout) AS total FROM sales GROUP BY region\n```' : '```sql\nSELECT region, sum(amount) AS total FROM sales GROUP BY region ORDER BY total DESC\n```'));
    await openApp(page);
    await addProvider(page);
    await newNote(page);
    await page.evaluate(() => {
      const el = document.querySelector('.ed-canvas')!;
      const dt = new DataTransfer();
      dt.items.add(new File(['region,amount,day\nNorth,10.5,2024-01-02\nSouth,5,2024-01-03\nNorth,7,2024-01-04\n'], 'sales.csv', { type: 'text/csv' }));
      const r = el.getBoundingClientRect();
      for (const type of ['dragenter', 'dragover', 'drop']) el.dispatchEvent(new DragEvent(type, { dataTransfer: dt, bubbles: true, cancelable: true, clientX: r.left + 200, clientY: r.top + 200 }));
    });
    await expect.poll(async () => (await objects(page)).map((o: any) => o.data?.table)).toEqual(['sales']);
    const [t] = await objects(page);
    expect(t.data).toMatchObject({ asset: 'sales.csv', rowCount: 3, columns: [{ name: 'region', type: 'text' }, { name: 'amount', type: 'number' }, { name: 'day', type: 'date' }] });
    expect(t.cells[1].map((c: any) => c.text)).toEqual(['North', '10.5', '2024-01-02']);
    await page.getByRole('button', { name: 'Query' }).click();
    const dlg = page.getByRole('dialog', { name: 'Data' });
    await expect(dlg).toContainText('Runs on this device in DuckDB', { timeout: 30000 });
    await dlg.getByLabel('SQL').fill('SELECT count(*) AS n, round(sum(amount), 1) AS total FROM sales');
    await dlg.getByRole('button', { name: 'Run' }).click();
    await expect(dlg.getByRole('table')).toContainText('22.5');
    // A question in words: the first SQL fails, the error goes back, the second works.
    await dlg.getByLabel('Ask about the data in words').fill('total by region');
    await dlg.getByRole('button', { name: 'Ask' }).click();
    await expect(dlg.getByText('2 attempts (fixed after an error)')).toBeVisible();
    expect(lastUser(reqs[1])).toMatch(/amout/);
    await expect(dlg.getByRole('table')).toContainText('North');
    await dlg.getByRole('button', { name: 'Put on page' }).click();
    await expect.poll(async () => (await objects(page)).length).toBe(2);
    await dlg.getByRole('button', { name: 'Chart on page' }).click();
    await expect.poll(() => page.evaluate(() => ((window as any).__inkstone.doc.page(0).images ?? []).map((i: any) => i.origin))).toEqual(['solver']);
    await dlg.getByText('Query history').click();
    await expect(dlg.locator('.ia-history li')).toHaveCount(2);
    await page.screenshot({ path: 'test-results/ink-data.png' });
  });

  test('a spreadsheet becomes one table per sheet', async ({ page }) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['name', 'score'], ['Ann', 91], ['Bo', 78]]), 'Scores');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['k', 'v'], ['a', 1]]), 'Meta');
    const bytes = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
    await openApp(page);
    await newNote(page);
    const chooser = page.waitForEvent('filechooser');
    await moreMenu(page, 'Add data');
    await (await chooser).setFiles({ name: 'grades.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer: bytes });
    await expect.poll(async () => (await objects(page)).map((o: any) => o.data?.table)).toEqual(['grades_scores', 'grades_meta']);
  });
});

test.describe('photo to ink', () => {
  test('a photo of handwriting becomes strokes on a new page, with the photo kept hidden', async ({ page }) => {
    await openApp(page);
    await newNote(page);
    // A "photo": a sheet of paper on a dark desk, slightly rotated, with handwriting-like text.
    const png = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 900; c.height = 700;
      const g = c.getContext('2d')!;
      g.fillStyle = '#4a4440'; g.fillRect(0, 0, 900, 700);
      g.translate(450, 350); g.rotate(0.06); g.translate(-450, -350);
      g.fillStyle = '#f4f1ea'; g.fillRect(120, 70, 660, 560);
      g.fillStyle = '#1d2a4a'; g.font = 'italic 44px serif';
      g.fillText('Ink from a photo', 170, 200);
      g.lineWidth = 4; g.strokeStyle = '#1d2a4a'; g.strokeRect(200, 300, 260, 160);
      return c.toDataURL('image/png').split(',')[1]!;
    });
    await moreMenu(page, 'Photo to ink');
    const chooser = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: 'Choose a photo' }).click();
    await (await chooser).setFiles({ name: 'page.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') });
    const dlg = page.getByRole('dialog', { name: 'Photo to ink' });
    await expect(dlg).toContainText('Found the page');
    // Corners are adjustable from the keyboard.
    const tl = dlg.getByRole('button', { name: /Top-left corner/ });
    await tl.focus();
    await page.keyboard.press('ArrowRight');
    await dlg.getByRole('button', { name: 'Make ink' }).click();
    await expect(dlg).toHaveCount(0, { timeout: 30000 });
    const p1 = await page.evaluate(() => { const p = (window as any).__inkstone.doc.page(1); return { n: p.strokes.length, origins: [...new Set(p.strokes.map((s: any) => s.origin))], underlay: p.underlay, size: p.size }; });
    expect(p1.n).toBeGreaterThan(10);
    expect(p1.origins).toEqual(['import']);
    expect(p1.underlay).toMatchObject({ kind: 'photo' });
    // The photo shows over the ink only on request.
    await moreMenu(page, 'Show the original photo');
    await expect(page.locator('.ia-underlays img')).toHaveCount(1);
    await page.screenshot({ path: 'test-results/ink-photo.png' });
    await moreMenu(page, 'Hide the original photo');
    await expect(page.locator('.ia-underlays')).toHaveCount(0);
  });
});

test.describe('reading and read aloud', () => {
  test('reads the page in order and highlights the ink being read; the reading view has line focus', async ({ page }) => {
    // A recording speech engine: each utterance "speaks" for 150 ms.
    await page.addInitScript(() => {
      const said: string[] = [];
      (window as any).__said = said;
      class U { text: string; rate = 1; voice: any = null; lang = ''; onstart: any; onend: any; onerror: any; constructor(t: string) { this.text = t; } }
      const synth = {
        speaking: false, paused: false,
        getVoices: () => [{ name: 'Test voice', lang: 'en-US', voiceURI: 'test' }],
        addEventListener() {},
        speak(u: any) { said.push(u.text); setTimeout(() => { u.onstart?.(); setTimeout(() => u.onend?.(), 150); }, 0); },
        cancel() {}, pause() {}, resume() {},
      };
      Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
      (window as any).SpeechSynthesisUtterance = U;
    });
    await openApp(page);
    await newNote(page);
    await page.evaluate(() => {
      const d = (window as any).__inkstone.doc;
      const mk = (id: string, y: number) => ({ id, pen: 'fountain', color: '#FF000000', size: 2, createdAt: 0, points: Array.from({ length: 30 }, (_, i) => ({ x: 60 + i * 5, y: y + Math.sin(i) * 4, t: i, p: 0.5, tilt: -1, orient: -1 })) });
      d.commit(0, { label: 'x', strokes: { removed: [], added: [mk('w1', 300), mk('w2', 60)].map((item, index) => ({ index, item })) } });
      d.setRecognizedText(d.page(0).id, 'top line\nbottom line', 'test', [
        { text: 'bottom line', strokeIds: ['w1'], bounds: { minX: 60, minY: 290, maxX: 210, maxY: 310 } },
        { text: 'top line', strokeIds: ['w2'], bounds: { minX: 60, minY: 50, maxX: 210, maxY: 70 } },
      ]);
    });
    await typeBox(page, 'Typed in the middle.', 60, 160, 300);
    await moreMenu(page, 'Read aloud');
    const bar = page.getByRole('region', { name: 'Reading aloud' });
    await expect(bar).toBeVisible();
    await expect.poll(() => page.evaluate(() => (window as any).__inkstone.engine.focusedStrokes)).toEqual(['w2']);
    await expect.poll(() => page.evaluate(() => (window as any).__said)).toEqual(['top line', 'Typed in the middle.', 'bottom line']);
    await expect(bar).toHaveCount(0);
    // Reading view: arrow keys move the focused line.
    await moreMenu(page, 'Reading view');
    const reader = page.getByRole('dialog', { name: /Reading:/ });
    await reader.locator('.ia-reader-line').first().focus();
    await page.keyboard.press('ArrowDown');
    await expect(reader.locator('.ia-reader-line.is-focus')).toContainText('Typed in the middle.');
  });
});

test.describe('paper workbench', () => {
  const BIB = String.raw`@article{lecun2015,
  title = {Deep learning}, author = {LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey},
  journal = {Nature}, volume = {521}, number = {7553}, pages = {436--444}, year = {2015}, doi = {10.1038/nature14539}
}
@book{knuth1984, author = {Donald E. Knuth}, title = {The {\TeX}book}, publisher = {Addison-Wesley}, year = {1984}}`;

  test('import BibTeX → paper notes; attach a PDF by DOI; cite with [@ autocomplete; bibliography in APA and IEEE; export BibTeX', async ({ page }) => {
    const pdf = await PDFDocument.create();
    const pg = pdf.addPage([400, 300]);
    pg.drawText('Deep learning. doi:10.1038/nature14539', { x: 20, y: 250, size: 12, font: await pdf.embedFont(StandardFonts.Helvetica) });
    const pdfBytes = Buffer.from(await pdf.save());
    await openApp(page);
    await page.getByRole('button', { name: 'Papers' }).click();
    const dlg = page.getByRole('dialog', { name: 'Library of papers' });
    let chooser = page.waitForEvent('filechooser');
    await dlg.getByRole('button', { name: 'Import references' }).click();
    await (await chooser).setFiles({ name: 'library.bib', mimeType: 'application/x-bibtex', buffer: Buffer.from(BIB) });
    await expect(dlg).toContainText('Added 2, updated 0');
    chooser = page.waitForEvent('filechooser');
    await dlg.getByRole('button', { name: 'Choose PDFs' }).click();
    await (await chooser).setFiles({ name: 'scan-0042.pdf', mimeType: 'application/pdf', buffer: pdfBytes });
    await expect(dlg).toContainText('scan-0042.pdf → Deep learning (by DOI)');
    await dlg.getByRole('button', { name: 'Show papers' }).click();
    await expect(page.locator('.note-card')).toHaveCount(2);
    // Cite it from a new note.
    await page.getByRole('button', { name: 'All notes' }).click();
    await newNote(page);
    await page.keyboard.press('t');
    const [x, y] = await toScreen(page, 80, 100);
    await page.locator('.ed-canvas').click({ position: { x, y } });
    const ta = page.locator('.text-edit textarea');
    await ta.pressSequentially('As shown in [@le');
    const list = page.getByRole('listbox', { name: 'Cite a paper' });
    await expect(list.getByRole('option').first()).toContainText('@lecun2015');
    await ta.press('Enter');
    await expect(ta).toHaveValue('As shown in [@lecun2015]');
    await ta.pressSequentially(' and [@kn');
    await ta.press('Enter');
    await expect(ta).toHaveValue('As shown in [@lecun2015] and [@knuth1984]');
    await page.keyboard.press('Escape');
    await page.locator('.ed-canvas').click({ position: { x: 600, y: 600 } });
    await expect.poll(() => page.evaluate(() => ((window as any).__inkstone.doc.page(0).texts ?? []).map((t: any) => t.text))).toEqual(['As shown in [@lecun2015] and [@knuth1984]']);
    await moreMenu(page, 'Bibliography');
    const bib = page.getByRole('dialog', { name: 'Bibliography' });
    await expect(bib.getByRole('list', { name: 'References' })).toContainText('Knuth, D. E. (1984). The TeXbook. Addison-Wesley.');
    await expect(bib.getByRole('list', { name: 'References' })).toContainText('LeCun, Y., Bengio, Y., & Hinton, G. (2015). Deep learning. Nature, 521(7553), 436–444. https://doi.org/10.1038/nature14539');
    await bib.getByRole('radio', { name: 'IEEE' }).click();
    await expect(bib.locator('li').first()).toContainText('[1] Y. LeCun, Y. Bengio, and G. Hinton, “Deep learning,” Nature, vol. 521');
    const download = page.waitForEvent('download');
    await bib.getByRole('button', { name: 'Export BibTeX' }).click();
    const file = await download;
    const text = await (await file.createReadStream())!.toArray().then((c) => Buffer.concat(c).toString('utf8'));
    expect(text).toContain('@article{lecun2015,');
    expect(text).toContain('@book{knuth1984,');
    await page.screenshot({ path: 'test-results/ink-papers.png' });
  });
});

test('every ink action can be switched off in Settings › Modules', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'Modules' }).click();
  for (const name of ['AI answers in ink', 'Executable diagrams', 'Data sandbox', 'Photo to ink', 'Reading and read aloud', 'Paper workbench']) {
    const row = page.locator('.row-switch', { hasText: name });
    await row.click();
    await expect(row.getByRole('switch')).not.toBeChecked();
  }
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Papers' })).toHaveCount(0);
  await newNote(page);
  await page.getByRole('button', { name: 'More', exact: true }).click();
  for (const item of ['Write the answer here', 'Run diagram', 'Add data', 'Photo to ink', 'Read aloud', 'Bibliography']) await expect(page.getByRole('menuitem', { name: item })).toHaveCount(0);
});
