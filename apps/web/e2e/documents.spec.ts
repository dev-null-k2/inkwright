import { expect, test, type Page, type Route } from '@playwright/test';
import { strFromU8, unzipSync, zipSync, strToU8 } from 'fflate';
import { PDFDocument } from 'pdf-lib';
import { isEngineNoise, modKey, openApp } from './helpers.ts';

/**
 * Documents: typed, formatted notes with ink on top (docs/VAULT_FORMAT.md › Documents). Created
 * from the library's New menu, the editor's "+" and the search palette; edited with the toolbar
 * and the keyboard; saved as Markdown in the note; annotated with the pen; exported to PDF,
 * Word, Markdown and HTML; files imported; and edited by the assistant through edit_document.
 */

const body = (page: Page) => page.evaluate(() => {
  const t = ((window as any).__inkwright.doc.page(0).texts ?? []).find((x: any) => x.role === 'document');
  return (t?.text ?? '') as string;
});

/** New document from the library's New menu (the "More ways to create" sheet at any width). */
async function newDocument(page: Page) {
  const more = page.getByRole('button', { name: 'More ways to create' });
  await more.click();
  await page.getByRole('button', { name: 'New document' }).click();
  await expect(page.locator('.doc-prose')).toBeVisible();
  await page.waitForFunction(() => !!(window as any).__inkwright?.docEditor);
}

async function download(page: Page, open: () => Promise<void>): Promise<{ name: string; bytes: Buffer }> {
  const [d] = await Promise.all([page.waitForEvent('download'), open()]);
  const stream = await d.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return { name: d.suggestedFilename(), bytes: Buffer.concat(chunks) };
}

async function more(page: Page, item: string | RegExp) {
  await page.locator('.ed-top').getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menu').getByRole('menuitem', { name: item }).click();
}

test('write a formatted document; it is saved as Markdown and survives a reload', async ({ page }) => {
  const errors: string[] = [];
  page.on('console', (m) => { if (m.type() === 'error' && !isEngineNoise(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  await openApp(page);
  await newDocument(page);
  const prose = page.locator('.doc-prose');
  await prose.click();

  await page.getByRole('combobox', { name: 'Text style' }).selectOption('h1');
  await page.keyboard.type('Trip plan');
  await page.keyboard.press('Enter');
  await page.keyboard.type('We leave on ');
  await page.getByRole('button', { name: /^Bold/ }).click();
  await page.keyboard.type('Friday');
  await page.getByRole('button', { name: /^Bold/ }).click();
  await page.keyboard.type('.');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Checklist' }).click();
  await page.keyboard.type('Tent');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Stove');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  // Markdown shortcuts work too.
  await page.keyboard.type('## Budget');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Table' }).click();
  await page.keyboard.type('Item');
  await page.keyboard.press('Tab');
  await page.keyboard.type('Cost');

  await expect.poll(() => body(page), { timeout: 5000 }).toContain('## Budget');
  await expect.poll(() => body(page)).toContain('# Trip plan\n\nWe leave on **Friday**.\n\n- [ ] Tent\n- [ ] Stove');
  const md = await body(page);
  expect(md).toMatch(/\| Item \| Cost \|/);
  // The word count follows (shown in the top bar on wide screens).
  await expect(page.locator('.doc-count')).toContainText('words');

  // The outline lists the headings and jumps to them.
  await page.getByRole('button', { name: 'Outline' }).click();
  const outline = page.getByRole('complementary', { name: 'Outline' });
  await expect(outline.locator('.doc-outline-list button')).toHaveText(['Trip plan', 'Budget']);
  await outline.getByRole('button', { name: 'Budget' }).click();

  // Saved in the vault: reopen after a reload.
  const id = await page.evaluate(() => (window as any).__inkwright.doc.meta.id);
  await page.keyboard.press(`${await modKey(page)}+s`);
  await page.reload();
  await page.waitForFunction(() => !!(window as any).__inkwright?.docEditor);
  await expect(page.locator('.doc-prose h1')).toHaveText('Trip plan');
  await expect(page.locator('.doc-prose ul[data-type="taskList"] li')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).__inkwright.doc.meta.id)).toBe(id);
  // The library shows it among the notes and search finds its words.
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.getByRole('searchbox', { name: 'Search notes' }).fill('Stove');
  await expect(page.locator('.hit-title').first()).toHaveText(/Document/);
  expect(errors).toEqual([]);
});

test('annotate a document with the pen, erase, and export PDF, Word, Markdown and HTML', async ({ page }) => {
  await openApp(page);
  await newDocument(page);
  await page.locator('.doc-prose').click();
  await page.keyboard.type('Ink goes on top of these words.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Second line with café and naïve.');

  // Annotate: the pen writes on the document.
  await page.getByRole('button', { name: 'Annotate' }).click();
  await expect(page.getByRole('toolbar', { name: 'Ink tools' })).toBeVisible();
  const ink = page.locator('.doc-ink');
  const box = (await ink.boundingBox())!;
  await page.evaluate(({ x, y }) => {
    const el = document.querySelector('.doc-ink')!;
    const fire = (type: string, dx: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: 3, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, clientX: x + dx, clientY: y, pressure: 0.6, buttons: type === 'pointerup' ? 0 : 1 }));
    fire('pointerdown', 0);
    for (let i = 1; i < 30; i++) fire('pointermove', i * 6);
    fire('pointerup', 180);
  }, { x: box.x + 60, y: box.y + 70 });
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes.length)).toBe(1);
  await expect(page.locator('.doc-ink path[data-stroke]')).toHaveCount(1);
  // Eraser takes it off; Undo ink brings it back.
  await page.getByRole('toolbar', { name: 'Ink tools' }).getByRole('button', { name: 'Eraser' }).click();
  await page.evaluate(({ x, y }) => {
    const el = document.querySelector('.doc-ink')!;
    const fire = (type: string, dx: number) => el.dispatchEvent(new PointerEvent(type, { pointerId: 4, pointerType: 'mouse', isPrimary: true, bubbles: true, cancelable: true, clientX: x + dx, clientY: y, buttons: type === 'pointerup' ? 0 : 1, button: 0 }));
    fire('pointerdown', 80); fire('pointermove', 90); fire('pointerup', 90);
  }, { x: box.x + 60, y: box.y + 70 });
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes.length)).toBe(0);
  await page.getByRole('button', { name: 'Undo ink' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes.length)).toBe(1);
  await page.getByRole('button', { name: 'Done annotating' }).click();

  // PDF: real pages with the words as text.
  const pdf = await download(page, () => more(page, 'Export PDF'));
  expect(pdf.name).toMatch(/\.pdf$/);
  const parsed = await PDFDocument.load(pdf.bytes);
  expect(parsed.getPageCount()).toBe(1);
  expect(parsed.getTitle()).toMatch(/Document/);
  expect(pdf.bytes.subarray(0, 5).toString()).toBe('%PDF-');

  // Word.
  const docx = await download(page, () => more(page, /Export Word document/));
  expect(docx.name).toMatch(/\.docx$/);
  const xml = strFromU8(unzipSync(new Uint8Array(docx.bytes))['word/document.xml']!);
  expect(xml).toContain('Ink goes on top of these words.');
  expect(xml).toContain('café and naïve');

  // Markdown and HTML.
  const md = await download(page, () => more(page, /Export Markdown/));
  expect(md.bytes.toString()).toBe('Ink goes on top of these words.\n\nSecond line with café and naïve.\n');
  const html = await download(page, () => more(page, /Export web page/));
  expect(html.bytes.toString()).toMatch(/<!doctype html>[\s\S]*<p>Ink goes on top of these words\.<\/p>/);

  // Print uses the browser's print dialog (stubbed here).
  await page.evaluate(() => { (window as any).__printed = 0; window.print = () => { (window as any).__printed++; }; });
  await more(page, 'Print');
  await expect.poll(() => page.evaluate(() => (window as any).__printed)).toBe(1);
});

test('open a Word file as a document, and insert Markdown into it', async ({ page }) => {
  await openApp(page);
  // A minimal .docx written by hand: a heading, a bold run and a bulleted list.
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
  const docx = zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>'),
    'word/document.xml': strToU8(`<?xml version="1.0"?><w:document xmlns:w="${W}"><w:body>
      <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Minutes</w:t></w:r></w:p>
      <w:p><w:r><w:t xml:space="preserve">Agreed: </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>ship it</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Ada</w:t></w:r></w:p>
      <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Grace</w:t></w:r></w:p>
    </w:body></w:document>`),
    'word/styles.xml': strToU8(`<?xml version="1.0"?><w:styles xmlns:w="${W}"><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style></w:styles>`),
    'word/numbering.xml': strToU8(`<?xml version="1.0"?><w:numbering xmlns:w="${W}"><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`),
  });
  await page.keyboard.press(`${await modKey(page)}+k`);
  await page.locator('.palette input').fill('Open a Word');
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.locator('.palette').getByText('Open a Word, Markdown or HTML file').click()]);
  await chooser.setFiles({ name: 'Minutes.docx', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: Buffer.from(docx) });
  await page.waitForFunction(() => !!(window as any).__inkwright?.docEditor);
  await expect(page.locator('.doc-prose h1')).toHaveText('Minutes');
  await expect.poll(() => body(page)).toBe('# Minutes\n\nAgreed: **ship it**\n\n- Ada\n- Grace\n');
  await expect(page.locator('.ed-title-text')).toHaveText('Minutes');

  // Insert a Markdown file at the end.
  await page.locator('.doc-prose').click();
  await page.keyboard.press(`${await modKey(page)}+End`);
  const [md] = await Promise.all([page.waitForEvent('filechooser'), more(page, /Insert a file/)]);
  await md.setFiles({ name: 'more.md', mimeType: 'text/markdown', buffer: Buffer.from('## Actions\n\n1. Book room\n') });
  await expect.poll(() => body(page)).toContain('## Actions\n\n1. Book room');
});

/** A fake OpenAI-compatible server that streams scripted tool calls (see ai.spec.ts). */
async function mockLLM(page: Page, replies: ({ text: string } | { tool: string; args: object })[]) {
  let i = 0;
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const req = route.request().postDataJSON();
    const r = replies[Math.min(i++, replies.length - 1)]!;
    const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    let sse = '';
    if ('tool' in r) {
      sse += chunk({ role: 'assistant', tool_calls: [{ index: 0, id: `call_${i}`, type: 'function', function: { name: r.tool, arguments: JSON.stringify(r.args) } }] });
      sse += chunk({}, 'tool_calls');
    } else {
      sse += chunk({ content: r.text });
      sse += chunk({}, 'stop');
    }
    sse += 'data: [DONE]\n\n';
    if (req.stream) await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse });
    else await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ index: 0, message: 'tool' in r ? { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: r.tool, arguments: JSON.stringify(r.args) } }] } : { role: 'assistant', content: r.text }, finish_reason: 'tool' in r ? 'tool_calls' : 'stop' }] }) });
  });
}

test('the assistant reads and edits the open document, and the change can be undone', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill('mock-1');
  await page.getByRole('button', { name: 'Save provider' }).click();
  await page.getByRole('button', { name: 'Back' }).click();
  await newDocument(page);
  await page.locator('.doc-prose').click();
  await page.keyboard.type('Sales rose.');
  await expect.poll(() => body(page)).toBe('Sales rose.\n');
  const id = await page.evaluate(() => (window as any).__inkwright.doc.meta.id);
  await mockLLM(page, [
    { tool: 'read_document', args: { note_id: id } },
    { tool: 'edit_document', args: { note_id: id, operation: 'replace_text', find: 'Sales rose.', replace: 'Sales rose by **12 %**.' } },
    { text: 'Done: the document now says sales rose by 12 %.' },
  ]);
  await page.locator('.ai-btn').click();
  await page.locator('.ai-input textarea').fill('Say sales rose 12 %');
  await page.locator('.ai-input textarea').press('Enter');
  await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('sales rose by 12 %');
  await expect(page.locator('.ai-tool').filter({ hasText: 'Edited a document' })).toHaveCount(1);
  // The editor shows the change at once, and it is in the saved body.
  await expect(page.locator('.doc-prose strong')).toHaveText('12 %');
  expect(await body(page)).toBe('Sales rose by **12 %**.\n');

  // Undo from the chat puts the sentence back as it was, in the editor too.
  await page.locator('.ai-tool', { hasText: 'change logged in Activity' }).getByRole('button', { name: 'Undo' }).click();
  await expect.poll(() => body(page)).toBe('Sales rose.\n');
  await expect(page.locator('.doc-prose strong')).toHaveCount(0);
  await expect(page.locator('.doc-prose')).toContainText('Sales rose.');
});
