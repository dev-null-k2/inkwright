import { expect, test, type Page, type Route } from '@playwright/test';
import { editorMenu, newNote, openApp, settingsGroup } from './helpers';

/**
 * Meetings end to end, in every engine: a meeting note with a recording's transcript, enhanced
 * notes (your words marked, AI lines grey with moments), checking off an action item (a hand
 * edit), editing by asking, versions, copying, writing them onto the page in AI ink, recipes,
 * sharing to a webhook, your own recipe in Settings, the Meetings screen with a calendar
 * (coming up, start notes, brief before it) and people and companies. The AI is a mocked
 * OpenAI-compatible provider that answers each prompt the way a model would.
 */

const TRANSCRIPT = [
  { startMs: 4_000, endMs: 10_000, text: 'Thanks for making time, Dana. Tell me about the team.', speaker: 'me' },
  { startMs: 11_000, endMs: 23_000, text: 'We have about forty reps across two regions.', speaker: 'them' },
  { startMs: 24_000, endMs: 40_000, text: 'Everything lives in spreadsheets and everyone hates it.', speaker: 'them' },
  { startMs: 86_000, endMs: 100_000, text: 'Our CFO Priya signs off, and IT does a security review of about three weeks.', speaker: 'them' },
  { startMs: 122_000, endMs: 134_000, text: 'We are at twenty-four dollars per rep per month.', speaker: 'me' },
  { startMs: 150_000, endMs: 160_000, text: 'I will send our SOC 2 report today.', speaker: 'me' },
];

const ENHANCED = `TLDR: Acme wants faster forecasting; pricing fits if security passes.
## About them
- Dana runs sales ops; forty reps in two regions [0:11]
## Pain points
- spreadsheets, hate it
  - Forecasts live in spreadsheets everyone hates [0:24]
## Budget, authority, timeline
- CFO Priya signs off; security review takes about three weeks [1:26]
- $24 per rep per month [2:02]
## Action items
- [ ] Send the SOC 2 report — You [2:30]`;

interface Mock { chats: Array<{ system: string; user: string }>; hooks: string[] }

async function mockAI(page: Page): Promise<Mock> {
  const m: Mock = { chats: [], hooks: [] };
  const preflight = (route: Route) => route.fulfill({ status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS' } });
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    // WebKit and Firefox send the CORS preflight through the route too.
    if (route.request().method() === 'OPTIONS') return preflight(route);
    const body = route.request().postDataJSON();
    const system = String(body.messages?.[0]?.content ?? '');
    const user = String(body.messages?.at(-1)?.content ?? '');
    m.chats.push({ system, user });
    let reply = 'OK.';
    if (system.includes('You write clear meeting notes')) reply = ENHANCED;
    else if (system.includes('You edit meeting notes')) reply = ENHANCED.replace(/^TLDR: .*$/m, 'TLDR: Shorter: Acme fits if security passes.');
    else if (system.includes('get more out of their meeting notes')) reply = user.includes('Answer this question') ? 'Customers asked for faster forecasting [M1].' : 'Subject: Thanks, Dana\n\nThanks for your time today. I will send the SOC 2 report [2:30].';
    else if (system.includes('prepare someone for a meeting')) reply = '**Last time** — Dana wants faster forecasting [M1].';
    const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (body.stream) {
      let sse = '';
      for (const w of reply.split(/(?<=\n| )/)) sse += chunk({ content: w });
      sse += chunk({}, 'stop') + 'data: [DONE]\n\n';
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }) });
    }
  });
  await page.route('https://hooks.example.test/**', async (route: Route) => {
    if (route.request().method() === 'OPTIONS') return preflight(route);
    m.hooks.push(route.request().postData() ?? '');
    await route.fulfill({ status: 200, headers: { 'access-control-allow-origin': '*' }, body: 'ok' });
  });
  return m;
}

/** The library's Settings or Meetings button (in the drawer on a phone). */
async function libraryButton(page: Page, name: string) {
  const b = page.getByRole('button', { name, exact: true });
  if (!(await b.isVisible())) await page.getByRole('button', { name: 'Menu' }).click();
  await b.click();
}

async function addProvider(page: Page) {
  await libraryButton(page, 'Settings');
  await settingsGroup(page, 'AI');
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill('mock-1');
  await page.getByRole('button', { name: 'Save provider' }).click();
}

/** A meeting note with typed notes and a recorded call's transcript (no microphone needed). */
async function meetingNote(page: Page, title = 'Acme discovery call') {
  await newNote(page);
  const id: string = await page.evaluate((title) => {
    const doc = (window as any).__inkwright.doc;
    doc.rename(title);
    doc.updateMeta((m: any) => ({ ...m, tags: ['meeting'], meeting: { template: 'sales-call', attendees: [{ name: 'Dana Ross', email: 'dana@acme.com' }] } }));
    doc.upsertText(0, { id: 'mynotes', x: 60, y: 80, width: 400, text: 'acme 40 reps\nspreadsheets, hate it', fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() }, 'notes');
    return doc.meta.id;
  }, title);
  await page.waitForFunction(() => !!(window as any).__inkwrightMeetings);
  await page.evaluate(({ id, segs }) => (window as any).__inkwrightMeetings.seedRecording(id, segs, 170_000), { id, segs: TRANSCRIPT });
  return id;
}

test('enhanced notes: your words, the details, moments, edits, versions, page, recipes, share', async ({ page, context, browserName }) => {
  test.setTimeout(120_000);
  const mock = await mockAI(page);
  await openApp(page);
  await addProvider(page);
  await openApp(page);
  const noteId = await meetingNote(page);

  await editorMenu(page, 'Audio', 'Meeting notes');
  const panel = page.getByRole('complementary', { name: 'Meeting' });
  await expect(panel).toBeVisible({ timeout: 20_000 });
  await expect(panel.locator('.mtg-chip').first()).toContainText('Sales call');
  await expect(panel.locator('.mtg-person')).toContainText('Dana Ross');

  // Enhance: the prompt has the template's sections, the notes and the transcript with speakers.
  await panel.getByRole('button', { name: 'Enhance notes' }).click();
  await expect(panel.locator('.mtg-tldr')).toHaveText('Acme wants faster forecasting; pricing fits if security passes.', { timeout: 20_000 });
  const req = mock.chats.find((c) => c.system.includes('You write clear meeting notes'))!;
  expect(req.system).toContain('## Pain points');
  expect(req.user).toContain('acme 40 reps');
  expect(req.user).toContain('[0:11] Dana Ross: We have about forty reps');
  expect(req.user).toContain('You: Thanks for making time');
  // Your line is yours (ink colour); the AI's detail is grey, with its moment.
  await expect(panel.locator('.mtg-item.is-mine')).toContainText(['spreadsheets, hate it']);
  const detail = panel.locator('.mtg-item.is-ai', { hasText: 'Forecasts live in spreadsheets' });
  await expect(detail).toHaveClass(/is-sub/);
  await expect(detail.locator('.mtg-cite')).toHaveText('0:24');
  // "acme 40 reps" was only paraphrased by the AI: it is kept, word for word, above its detail.
  await expect(panel.locator('.mtg-item.is-mine', { hasText: 'acme 40 reps' })).toHaveCount(1);
  await expect(panel.locator('.mtg-section', { hasText: 'Action items' }).locator('.mtg-owner')).toHaveText('You');

  // Check off the action item: saved as your edit, a new version.
  await panel.getByRole('button', { name: 'Mark done' }).click();
  await expect(panel.locator('.mtg-item.is-done')).toContainText('Send the SOC 2 report');
  await expect(panel.locator('.mtg-by')).toContainText('Edited by you');

  // Ask for a change.
  await panel.getByRole('textbox', { name: 'Ask to change the notes' }).fill('Make the summary shorter');
  await panel.getByRole('button', { name: 'Change the notes' }).click();
  await expect(panel.locator('.mtg-tldr')).toHaveText('Shorter: Acme fits if security passes.');
  await expect(panel.locator('.mtg-by')).toContainText('Changed as asked: “Make the summary shorter”');
  expect(mock.chats.at(-1)!.user).toContain('The request: Make the summary shorter');

  // Versions: go back to the first.
  await panel.getByRole('button', { name: 'Versions' }).click();
  await page.getByRole('menuitem', { name: /^Enhanced/ }).click();
  await expect(panel.locator('.mtg-tldr')).toHaveText('Acme wants faster forecasting; pricing fits if security passes.');

  // Copy as Markdown.
  if (browserName === 'chromium') {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await panel.getByRole('button', { name: 'Copy', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Copy as Markdown' }).click();
    const md = await page.evaluate(() => navigator.clipboard.readText());
    expect(md).toContain('# Acme discovery call');
    expect(md).toContain('- [ ] Send the SOC 2 report — You [2:30]');
  }

  // Write the AI's additions on the page in AI ink.
  const before = await page.evaluate(() => (window as any).__inkwright.doc.pages.flatMap((p: any) => p.strokes).length);
  await panel.getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: 'Write on the page in my handwriting' }).click();
  // The ink is written on with a short animation, then committed as one undo step in AI ink.
  await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.committedPages.flatMap((p: any) => p.strokes).filter((s: any) => s.origin === 'ai').length), { timeout: 15_000 }).toBeGreaterThan(20);
  expect(await page.evaluate(() => (window as any).__inkwright.doc.committedPages.flatMap((p: any) => p.strokes).length)).toBeGreaterThan(before);

  // Recipes: a follow-up email, with its moment linked.
  await panel.getByRole('tab', { name: 'Recipes' }).click();
  await panel.getByRole('button', { name: /^Follow-up email/ }).click();
  await expect(panel.locator('.mtg-result .md')).toContainText('Thanks for your time today');
  await expect(panel.locator('.mtg-result a[href^="#said/"]')).toHaveCount(1);
  await expect(panel.getByRole('button', { name: 'Open in mail' })).toBeVisible();

  // Transcript tab: speakers.
  await panel.getByRole('tab', { name: 'Transcript' }).click();
  await expect(panel.locator('.lis-speaker').first()).toHaveText('You');
  await expect(panel.locator('.lis-speaker').nth(1)).toHaveText('Dana Ross');

  // Share to a webhook (connected in Settings › Meetings).
  await panel.getByRole('tab', { name: 'Notes' }).click();
  await page.getByRole('button', { name: 'Back to library' }).click();
  await libraryButton(page, 'Settings');
  await settingsGroup(page, 'Knowledge', 'Meetings');
  const conn = page.locator('.mtg-set-list li', { hasText: 'Webhook' });
  await conn.getByRole('button', { name: 'Connect' }).click();
  await page.getByRole('dialog', { name: /Connect Webhook/ }).getByLabel('Address').fill('https://hooks.example.test/catch/1');
  await page.getByRole('button', { name: 'Connect', exact: true }).last().click();
  await expect(conn).toContainText('Connected');
  await page.evaluate((id) => { location.hash = `#note/${id}`; }, noteId);
  await page.waitForFunction((id) => (window as any).__inkwright?.doc?.meta.id === id, noteId);
  await editorMenu(page, 'Audio', 'Meeting notes');
  await panel.getByRole('button', { name: 'Share' }).click();
  const share = page.getByRole('dialog', { name: 'Share the notes' });
  await share.getByRole('radio', { name: /Webhook/ }).click();
  await expect(share.locator('.mtg-share-preview')).toContainText('# Acme discovery call');
  await share.getByRole('button', { name: 'Send' }).click();
  await expect(share).toContainText('Sent to your webhook');
  await expect.poll(() => mock.hooks.length).toBe(1);
  const sent = JSON.parse(mock.hooks[0]!);
  expect(sent).toMatchObject({ type: 'inkwright.meeting', title: 'Acme discovery call' });
  expect(sent.actionItems).toEqual([{ text: 'Send the SOC 2 report', owner: 'You' }]);
});

test('Meetings screen: calendar, coming up, start notes, brief, people and companies, ask across', async ({ page }) => {
  test.setTimeout(120_000);
  const mock = await mockAI(page);
  await openApp(page);
  await addProvider(page);
  await openApp(page);
  // An earlier meeting with Dana, enhanced.
  await meetingNote(page, 'Acme intro');
  await editorMenu(page, 'Audio', 'Meeting notes');
  await page.getByRole('complementary', { name: 'Meeting' }).getByRole('button', { name: 'Enhance notes' }).click();
  await expect(page.locator('.mtg-tldr')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Back to library' }).click();

  // A calendar with a meeting starting in a minute, with Dana and a Zoom link.
  const start = new Date(Date.now() + 60_000);
  const end = new Date(start.getTime() + 30 * 60_000);
  const z = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ics = ['BEGIN:VCALENDAR', 'BEGIN:VEVENT', 'UID:acme-2', 'SUMMARY:Acme follow-up', `DTSTART:${z(start)}`, `DTEND:${z(end)}`, 'ORGANIZER;CN=Me:mailto:me@inkwright.test', 'ATTENDEE;CN=Dana Ross:mailto:dana@acme.com', 'LOCATION:https://acme.zoom.us/j/99887766', 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  await libraryButton(page, 'Meetings');
  await expect(page.getByRole('heading', { name: 'Meetings', level: 1 })).toBeVisible();
  await page.getByRole('button', { name: 'Connect calendar' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Or import an .ics file' }).click();
  await (await chooser).setFiles({ name: 'work.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  const row = page.locator('.mtv-up', { hasText: 'Acme follow-up' });
  await expect(row).toBeVisible();
  await expect(row).toContainText('Dana Ross');
  await expect(row.getByRole('link', { name: 'Join on Zoom' })).toHaveAttribute('href', 'https://acme.zoom.us/j/99887766');

  // Brief from the earlier meeting with Dana.
  await row.getByRole('button', { name: 'Brief' }).click();
  await expect(row.locator('.mtv-brief')).toContainText('Dana wants faster forecasting');
  await expect(row.locator('.mtv-brief a[href^="#note/"]')).toHaveText('Acme intro');
  expect(mock.chats.find((c) => c.system.includes('prepare someone for a meeting'))!.user).toContain('[M1] Acme intro');

  // People and companies.
  await page.getByRole('radio', { name: /^People/ }).click();
  await expect(page.locator('.mtv-row', { hasText: 'Dana Ross' })).toContainText('Acme');
  await page.getByRole('radio', { name: /^Companies/ }).click();
  const acme = page.locator('.mtv-row', { hasText: 'Acme' });
  await expect(acme).toContainText('acme.com');
  // Ask across that company's meetings.
  await acme.getByRole('button', { name: 'Ask' }).click();
  await page.getByRole('textbox', { name: 'Ask across meetings' }).fill('What do they want?');
  await page.getByRole('button', { name: 'Ask', exact: true }).click();
  await expect(page.locator('.mtv-result .md')).toContainText('Customers asked for faster forecasting');
  await expect(page.locator('.mtv-result a[href^="#note/"]')).toHaveText('Acme intro');

  // Start notes for the coming meeting: title, attendee, call link and a template that fits.
  await page.getByRole('radio', { name: 'Meetings' }).click();
  await page.locator('.mtv-up', { hasText: 'Acme follow-up' }).getByRole('button', { name: /Prepare notes|Take notes/ }).click();
  await page.waitForFunction(() => (window as any).__inkwright?.doc?.meta.title === 'Acme follow-up');
  const meta = await page.evaluate(() => (window as any).__inkwright.doc.meta);
  expect(meta.tags).toContain('meeting');
  expect(meta.meeting.attendees).toEqual([{ name: 'Me', email: 'me@inkwright.test' }, { name: 'Dana Ross', email: 'dana@acme.com' }]);
  expect(meta.meeting.event.link).toBe('https://acme.zoom.us/j/99887766');
});

test('your own recipe and template, from Settings', async ({ page }) => {
  await openApp(page);
  await libraryButton(page, 'Settings');
  await settingsGroup(page, 'Knowledge', 'Meetings');
  await page.getByRole('button', { name: 'New recipe' }).click();
  const dlg = page.getByRole('dialog', { name: 'New recipe' });
  await dlg.getByLabel('Name').fill('Board update');
  await dlg.getByLabel('Instructions').fill('Five bullets for the board.');
  await dlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.mtg-set-list li', { hasText: 'Board update' })).toBeVisible();
  await page.locator('.mtg-set-list li').filter({ has: page.locator('.row-label', { hasText: /^Sales call$/ }) }).getByRole('button', { name: 'Copy' }).click();
  const tdlg = page.getByRole('dialog', { name: /Template: Sales call \(mine\)/ });
  await tdlg.getByLabel('Pick it for meetings whose title has').fill('pipeline');
  await tdlg.getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('.mtg-set-list li', { hasText: 'Sales call (mine)' })).toBeVisible();
  // Kept after a reload (in the vault).
  await page.reload();
  await settingsGroup(page, 'Knowledge', 'Meetings');
  await expect(page.locator('.mtg-set-list li', { hasText: 'Board update' })).toBeVisible();
});
