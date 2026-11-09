import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { handwrite } from '../../../packages/core/src/handwrite.ts';
import { editorMenu, newNote, openApp } from './helpers';
import { addProvider, libraryButton, mockAI } from './mtg-helpers';

/**
 * Screenshots of Meetings for the website (docs/media/screens/meeting-*.png), taken from the real
 * app: handwritten notes, a recorded call's transcript and the enhanced notes beside them, the
 * Meetings screen with a calendar, and the panel on a phone. Opt-in: SITE_SHOTS=1.
 */
test.skip(!process.env.SITE_SHOTS, 'Set SITE_SHOTS=1 to update the website screenshots');

const OUT = join(process.cwd(), '..', '..', 'docs', 'media', 'screens');
mkdirSync(OUT, { recursive: true });

const TRANSCRIPT = [
  { startMs: 4_000, endMs: 10_000, text: 'Thanks for making time, Dana. Tell me about the team.', speaker: 'me' },
  { startMs: 11_000, endMs: 23_000, text: 'I run sales operations. We have about forty reps across two regions.', speaker: 'them' },
  { startMs: 24_000, endMs: 40_000, text: 'Everything lives in spreadsheets and honestly everyone hates it. Forecasts take two days every month.', speaker: 'them' },
  { startMs: 41_000, endMs: 54_000, text: 'We tried Salesforce a few years ago but the rollout stalled.', speaker: 'them' },
  { startMs: 86_000, endMs: 100_000, text: 'Our CFO, Priya, signs off on anything over twenty thousand a year, and IT does a security review. That usually takes about three weeks.', speaker: 'them' },
  { startMs: 122_000, endMs: 134_000, text: 'On price, we are at twenty-four dollars per rep per month for the team plan.', speaker: 'me' },
  { startMs: 135_000, endMs: 141_000, text: 'That is within budget if the security review passes.', speaker: 'them' },
  { startMs: 150_000, endMs: 160_000, text: 'Great. I will send our SOC 2 report today, and you will introduce me to Priya.', speaker: 'me' },
  { startMs: 170_000, endMs: 178_000, text: 'And we agreed to start a pilot with the east region in December.', speaker: 'them' },
];

/** Writes the meeting notes on page 1 in a real hand (the app's own pen) and adds the call. */
async function handwrittenMeeting(page: Page) {
  await newNote(page);
  const lines = ['acme - 40 reps', 'spreadsheets, hate it', 'security review?', 'price', 'pilot?'];
  const strokes = lines.flatMap((t, i) => handwrite(t, { x: 90, y: 150 + i * 92, xHeight: 13, style: 'script', pen: 'fountain', size: 2.3, slant: 8, messiness: 0.55, seed: 7 + i, startTime: Date.now() - 170_000 + i * 30_000, color: '#FF2B2330' }).strokes);
  const id: string = await page.evaluate(({ strokes }) => {
    const doc = (window as any).__inkwright.doc;
    doc.rename('Acme discovery call');
    doc.updateMeta((m: any) => ({ ...m, tags: ['meeting'], meeting: { template: 'sales-call', attendees: [{ name: 'Dana Ross', email: 'dana@acme.com' }], event: { uid: 'acme@1', start: Date.now() - 180_000, end: Date.now() + 1_620_000, link: 'https://acme.zoom.us/j/99887766' } } }));
    doc.commit(0, { label: 'notes', strokes: { removed: [], added: strokes.map((item: any, k: number) => ({ index: k, item })) } }, 'other');
    doc.setRecognizedText(doc.pages[0].id, 'acme - 40 reps\nspreadsheets, hate it\nsecurity review?\nprice\npilot?', 'sample', []);
    return doc.meta.id;
  }, { strokes });
  await page.waitForFunction(() => !!(window as any).__inkwrightMeetings);
  await page.evaluate(({ id, segs }) => (window as any).__inkwrightMeetings.seedRecording(id, segs, 180_000), { id, segs: TRANSCRIPT });
  return id;
}

const ENHANCED = `TLDR: Acme wants forecasting in an afternoon instead of two days; $24 per rep fits their budget once IT’s security review passes.
## About them
- acme - 40 reps
  - Dana runs sales operations; forty reps across two regions [0:11]
## Pain points
- spreadsheets, hate it
  - Forecasts take two days every month [0:24]
  - Tried Salesforce a few years ago; the rollout stalled [0:41]
## Budget, authority, timeline
- security review?
  - CFO Priya signs off on anything over $20k a year [1:26]
  - IT security review usually takes about three weeks [1:26]
- price
  - $24 per rep per month (team plan), within budget if security passes [2:02]
## Action items
- [ ] Send the SOC 2 report today — You [2:30]
- [ ] Introduce us to Priya next week — Dana Ross [2:30]
- [ ] Start the east-region pilot in December — Dana Ross [2:50]`;

for (const scheme of ['light', 'dark'] as const) {
  test(`meeting notes beside handwriting (${scheme})`, async ({ page }) => {
    test.setTimeout(120_000);
    await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 1440, height: 900 });
    await mockAI(page, { enhanced: ENHANCED });
    await openApp(page);
    await addProvider(page);
    await openApp(page);
    await handwrittenMeeting(page);
    await editorMenu(page, 'Audio', 'Meeting notes');
    const panel = page.getByRole('complementary', { name: 'Meeting' });
    await panel.getByRole('button', { name: 'Enhance notes' }).click();
    await expect(panel.locator('.mtg-tldr')).toBeVisible({ timeout: 20_000 });
    await page.mouse.move(0, 0);
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(OUT, `meeting-notes-${scheme}.png`) });
  });
}

test('the Meetings screen with a calendar', async ({ page }) => {
  test.setTimeout(120_000);
  await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 860 });
  await mockAI(page, { enhanced: ENHANCED });
  await openApp(page);
  await addProvider(page);
  await openApp(page);
  await handwrittenMeeting(page);
  await editorMenu(page, 'Audio', 'Meeting notes');
  await page.getByRole('complementary', { name: 'Meeting' }).getByRole('button', { name: 'Enhance notes' }).click();
  await expect(page.locator('.mtg-tldr')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: 'Back to library' }).click();
  const z = (d: Date) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const ev = (uid: string, title: string, inMin: number, len: number, who: string[], loc: string) => {
    const s = new Date(Date.now() + inMin * 60_000);
    return ['BEGIN:VEVENT', `UID:${uid}`, `SUMMARY:${title}`, `DTSTART:${z(s)}`, `DTEND:${z(new Date(s.getTime() + len * 60_000))}`, 'ORGANIZER;CN=Me:mailto:me@inkwright.test', ...who.map((w) => `ATTENDEE;CN=${w.split('<')[0]!.trim()}:mailto:${w.split('<')[1]!.replace('>', '')}`), `LOCATION:${loc}`, 'END:VEVENT'];
  };
  const ics = ['BEGIN:VCALENDAR', ...ev('a', 'Acme follow-up', 2, 30, ['Dana Ross <dana@acme.com>', 'Priya Shah <priya@acme.com>'], 'https://acme.zoom.us/j/99887766'), ...ev('b', 'Weekly 1:1 with Sam', 95, 30, ['Sam Lee <sam@inkwright.test>'], 'https://meet.google.com/abc-defg-hij'), ...ev('c', 'Design review: offline sync', 240, 45, ['Ana Ruiz <ana@inkwright.test>', 'Kai Mori <kai@inkwright.test>'], 'Room 4'), 'END:VCALENDAR'].join('\r\n');
  await libraryButton(page, 'Meetings');
  await page.getByRole('button', { name: 'Connect calendar' }).click();
  const chooser = page.waitForEvent('filechooser');
  await page.getByRole('button', { name: 'Or import an .ics file' }).click();
  await (await chooser).setFiles({ name: 'work.ics', mimeType: 'text/calendar', buffer: Buffer.from(ics) });
  await expect(page.locator('.mtv-up')).toHaveCount(3);
  await page.locator('.mtv-up', { hasText: 'Acme follow-up' }).getByRole('button', { name: 'Brief' }).click();
  await expect(page.locator('.mtv-brief')).toContainText('Dana');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: join(OUT, 'meetings-screen.png') });
});

test('the meeting panel on a phone', async ({ browser }) => {
  test.setTimeout(120_000);
  const ctx = await browser.newContext({ viewport: { width: 412, height: 915 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, colorScheme: 'light', reducedMotion: 'reduce', storageState: { cookies: [], origins: [{ origin: (test.info().project.use.baseURL ?? 'http://localhost:4174'), localStorage: [{ name: 'inkwright.settings.v1', value: JSON.stringify({ onboardingDone: true }) }] }] } });
  const page = await ctx.newPage();
  await mockAI(page, { enhanced: ENHANCED });
  await openApp(page);
  await addProvider(page);
  await openApp(page);
  await handwrittenMeeting(page);
  await editorMenu(page, 'Audio', 'Meeting notes');
  await page.getByRole('complementary', { name: 'Meeting' }).getByRole('button', { name: 'Enhance notes' }).click();
  await expect(page.locator('.mtg-tldr')).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(OUT, 'meeting-phone.png') });
  await ctx.close();
});
