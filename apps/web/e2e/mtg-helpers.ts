import type { Page, Route } from '@playwright/test';
import { newNote, settingsGroup } from './helpers';

/** Shared by meetings.spec.ts and the website's screenshots (site-shots.spec.ts). */

export const TRANSCRIPT = [
  { startMs: 4_000, endMs: 10_000, text: 'Thanks for making time, Dana. Tell me about the team.', speaker: 'me' },
  { startMs: 11_000, endMs: 23_000, text: 'We have about forty reps across two regions.', speaker: 'them' },
  { startMs: 24_000, endMs: 40_000, text: 'Everything lives in spreadsheets and everyone hates it.', speaker: 'them' },
  { startMs: 86_000, endMs: 100_000, text: 'Our CFO Priya signs off, and IT does a security review of about three weeks.', speaker: 'them' },
  { startMs: 122_000, endMs: 134_000, text: 'We are at twenty-four dollars per rep per month.', speaker: 'me' },
  { startMs: 150_000, endMs: 160_000, text: 'I will send our SOC 2 report today.', speaker: 'me' },
];

export const ENHANCED = `TLDR: Acme wants faster forecasting; pricing fits if security passes.
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

export interface Mock { chats: Array<{ system: string; user: string }>; hooks: string[] }

export async function mockAI(page: Page, opts: { enhanced?: string } = {}): Promise<Mock> {
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
    if (system.includes('You write clear meeting notes')) reply = opts.enhanced ?? ENHANCED;
    else if (system.includes('You edit meeting notes')) reply = ENHANCED.replace(/^TLDR: .*$/m, 'TLDR: Shorter: Acme fits if security passes.');
    else if (system.includes('get more out of their meeting notes')) reply = user.includes('Answer this question') ? 'Customers asked for faster forecasting [M1].' : 'Subject: Thanks, Dana\n\nThanks for your time today. I will send the SOC 2 report [2:30].';
    else if (system.includes('Translate each numbered line')) reply = user.split('\n').map((l) => l.replace(/^(\d+)\. /, '$1. ES: ')).join('\n');
    else if (system.includes('prepare someone for a meeting')) reply = '**Who** — Dana Ross runs sales ops at Acme; Priya Shah is the CFO and signs off.\n\n**Last time** — Forecasts take two days; $24 per rep fits if IT’s three-week security review passes [M1].\n\n**Still open** — You: send the SOC 2 report. Dana: intro to Priya [M1].\n\n**To raise** — Has security started? Pilot start date for the east region?';
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
export async function libraryButton(page: Page, name: string) {
  const b = page.getByRole('button', { name, exact: true });
  if (!(await b.isVisible())) await page.getByRole('button', { name: 'Menu' }).click();
  await b.click();
}

export async function addProvider(page: Page) {
  await libraryButton(page, 'Settings');
  await settingsGroup(page, 'AI');
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill('mock-1');
  await page.getByRole('button', { name: 'Save provider' }).click();
}

/** A meeting note with typed notes and a recorded call's transcript (no microphone needed). */
export async function meetingNote(page: Page, title = 'Acme discovery call', marks: number[] = []) {
  await newNote(page);
  const id: string = await page.evaluate((title) => {
    const doc = (window as any).__inkwright.doc;
    doc.rename(title);
    doc.updateMeta((m: any) => ({ ...m, tags: ['meeting'], meeting: { template: 'sales-call', attendees: [{ name: 'Dana Ross', email: 'dana@acme.com' }] } }));
    doc.upsertText(0, { id: 'mynotes', x: 60, y: 80, width: 400, text: 'acme 40 reps\nspreadsheets, hate it', fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() }, 'notes');
    return doc.meta.id;
  }, title);
  await page.waitForFunction(() => !!(window as any).__inkwrightMeetings);
  await page.evaluate(({ id, segs, marks }) => (window as any).__inkwrightMeetings.seedRecording(id, segs, 170_000, marks), { id, segs: TRANSCRIPT, marks });
  return id;
}

