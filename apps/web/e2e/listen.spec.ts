import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page, type Route } from '@playwright/test';
import { newNote, openApp, pen, pointer, word } from './helpers';

/**
 * Notes that listen, end to end in Chromium: a real microphone path (Chromium's fake capture
 * device playing a generated speech-like WAV), live transcription through the provider engine
 * (the transcription endpoint is mocked), transcript lines lined up with the ink written while
 * they were "said", tap a sentence → strokes highlight + audio seeks, tap ink → the sentence,
 * Ask during the recording with the live transcript, and per-page summaries afterwards.
 */

// ---- Fixture: 16 kHz mono WAV of voiced bursts (2.4 s) and pauses (1.2 s), ~30 s ----------------
const SR = 16_000;
function speechLikeWav(): Buffer {
  const plan: [number, boolean][] = [[0.4, false]];
  for (let i = 0; i < 8; i++) plan.push([2.4, true], [1.2, false]);
  const n = Math.round(plan.reduce((a, [s]) => a + s, 0) * SR);
  const pcm = new Int16Array(n);
  let i = 0;
  for (const [sec, talk] of plan) {
    for (let k = 0; k < Math.round(sec * SR); k++, i++) {
      const t = i / SR;
      const v = talk ? 0.25 * (0.55 + 0.45 * Math.sin(2 * Math.PI * 4 * t)) * (Math.sin(2 * Math.PI * 140 * t) * 0.6 + Math.sin(2 * Math.PI * 280 * t) * 0.4) : 0.0008 * Math.sin(i * 1.7);
      pcm[i] = Math.round(v * 0x7fff);
    }
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0); head.writeUInt32LE(36 + n * 2, 4); head.write('WAVE', 8); head.write('fmt ', 12);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(SR, 24); head.writeUInt32LE(SR * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(n * 2, 40);
  return Buffer.concat([head, Buffer.from(pcm.buffer)]);
}
const dir = join(process.cwd(), 'test-results');
mkdirSync(dir, { recursive: true });
const WAV = join(dir, `listen-fixture-${process.pid}.wav`);
writeFileSync(WAV, speechLikeWav());

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`, '--autoplay-policy=no-user-gesture-required'] },
});

const SAID = ['Today we cover convolution.', 'Convolution flips one signal and slides it across the other.', 'In frequency it becomes a multiplication.', 'Homework three is due on Friday.', 'Any questions so far?', 'Let us look at an example.', 'This is the end of the example.', 'Thank you all.'];

/** Mocks the provider: transcription (one sentence per window) and chat (ask, summaries). */
async function mockProvider(page: Page) {
  const transcriptions: number[] = [];
  const chats: any[] = [];
  await page.route('https://mock-llm.test/v1/audio/transcriptions', async (route: Route) => {
    const body = route.request().postDataBuffer();
    transcriptions.push(body?.length ?? 0);
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ text: SAID[(transcriptions.length - 1) % SAID.length] }) });
  });
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    const body = route.request().postDataJSON();
    chats.push(body);
    const sys = String(body.messages?.[0]?.content ?? '');
    const user = String(body.messages?.at(-1)?.content ?? '');
    let reply: string;
    if (sys.includes('short study notes')) reply = '- Convolution flips one signal and slides it.';
    else if (sys.includes('summarize recorded lectures')) reply = JSON.stringify({ summary: 'An introduction to convolution.', keyTerms: ['convolution'], todos: ['Homework three due Friday'] });
    else {
      // Ask: cite the line about convolution by its time, as the prompt asks.
      const line = /\[(\d+:\d{2})\] Convolution flips/.exec(sys + user);
      reply = line ? `She said convolution flips one signal and slides it [${line[1]}].` : 'The transcript does not cover that yet.';
    }
    const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    if (body.stream) {
      let sse = '';
      for (const w of reply.split(/(?<= )/)) sse += chunk({ content: w });
      sse += chunk({}, 'stop') + 'data: [DONE]\n\n';
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' }, body: sse });
    } else {
      await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: reply }, finish_reason: 'stop' }] }) });
    }
  });
  return { transcriptions, chats };
}

async function addProvider(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill('mock-1');
  await page.getByRole('button', { name: 'Save provider' }).click();
  // Speech to text: the provider, and its privacy line says so.
  const speech = page.getByRole('region', { name: 'Speech to text' });
  await speech.getByRole('radio', { name: 'Your provider' }).click();
  await expect(speech.locator('.lis-where')).toContainText('Sent to Custom (OpenAI-compatible)');
}

const strokesNow = (page: Page) => page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes.map((s: any) => ({ id: s.id, createdAt: s.createdAt, x: s.points[0].x, y: s.points[0].y })));

test('live transcript lines up with ink; ask while recording; summaries after', async ({ page }) => {
  test.setTimeout(120_000);
  // Short windows so a test doesn't wait 10 s per line (test builds only).
  await page.addInitScript(() => { (window as any).__inkwrightSpeechTuning = { minWindowMs: 1500, maxWindowMs: 8000, pauseMs: 500 }; });
  const mock = await mockProvider(page);
  await openApp(page);
  await addProvider(page);
  await openApp(page);
  await newNote(page);

  await page.getByRole('button', { name: 'Record audio' }).click();
  const panel = page.getByRole('complementary', { name: 'Transcript' });
  await expect(panel).toBeVisible();
  await expect(panel.locator('.lis-where')).toContainText('Sent to Custom (OpenAI-compatible)');

  // Write while the lecture goes on; lines appear with their times.
  await page.waitForTimeout(1200);
  await pen(page, word(120, 140, 160));
  await expect(panel.locator('.lis-seg')).toHaveCount(1, { timeout: 15_000 });
  await expect(panel.locator('.lis-seg').first()).toContainText('Today we cover convolution.');
  await page.waitForTimeout(1300); // into the second burst of speech
  await pen(page, word(120, 220, 160));
  await expect(panel.locator('.lis-seg')).toHaveCount(2, { timeout: 15_000 });
  await expect(panel.locator('.lis-seg').nth(1)).toContainText('Convolution flips');
  expect(mock.transcriptions.every((n) => n > 1000)).toBe(true); // real audio went to the endpoint

  // Ask while it's happening: the live transcript (with times) goes along; the answer cites it.
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const ai = page.getByRole('complementary', { name: 'AI assistant' });
  await ai.locator('textarea').fill('What did she just say about convolution?');
  await expect(ai.locator('textarea')).toHaveAttribute('placeholder', 'Ask about what was just said');
  await ai.getByRole('button', { name: 'Send' }).click();
  await expect(ai.locator('.ai-msg.is-assistant')).toContainText('She said convolution flips');
  const askReq = mock.chats.find((c) => JSON.stringify(c.messages).includes('What did she just say'))!;
  expect(String(askReq.messages[0].content)).toContain('A recording is in progress');
  expect(String(askReq.messages[0].content)).toMatch(/\[\d:\d{2}\] Convolution flips one signal/);
  const cite = ai.locator('.ai-msg.is-assistant a[href^="#said/"]');
  await expect(cite).toHaveCount(1);
  await cite.click(); // during recording: picks out the ink written then
  await page.waitForFunction(() => (window as any).__inkwright.engine.focusedStrokes.length > 0);

  // Stop: the transcript is saved next to the clip and pages get summaries.
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.locator('.audio-bar')).toBeVisible();
  await page.locator('.ed-top').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: /Transcript/ }).click();
  await expect(panel.locator('.lis-where')).toContainText('Transcribed by your AI provider');
  await expect(panel.locator('.lis-lecture')).toContainText('An introduction to convolution.', { timeout: 20_000 });
  await expect(panel.locator('.lis-todos')).toContainText('Homework three due Friday');
  const n = await panel.locator('.lis-seg').count();
  expect(n).toBeGreaterThanOrEqual(2);

  // Tap a sentence: the strokes written while it was said light up and the audio plays from there.
  const strokes = await strokesNow(page);
  await panel.locator('.lis-seg').nth(1).click();
  await page.waitForFunction(() => (window as any).__inkwright.engine.focusedStrokes.length > 0);
  const focused: string[] = await page.evaluate(() => (window as any).__inkwright.engine.focusedStrokes);
  expect(focused).toContain(strokes[1]!.id);
  expect(focused).not.toContain(strokes[0]!.id);
  await expect(page.locator('.audio-hint')).toHaveText('Tap ink to hear that moment');
  await expect(panel.locator('.lis-seg.is-on')).toHaveCount(1);
  await expect(panel.locator('.lis-seg.is-on')).toContainText('Convolution flips');

  // Tap ink: the transcript moves to what was said when it was written.
  await page.getByRole('button', { name: 'Pause' }).click();
  await panel.locator('.lis-seg').first().click();
  await expect(panel.locator('.lis-seg.is-on')).toContainText('Today we cover');
  await page.getByRole('button', { name: 'Pause' }).click();
  const box = await page.evaluate((id) => { const e = (window as any).__inkwright.engine; const s = e.doc.page(0).strokes.find((x: any) => x.id === id); const p = s.points[Math.floor(s.points.length / 2)]; return e.pageRectToScreen(0, { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y }); }, strokes[1]!.id);
  await pointer(page, 'pointerdown', [box.x, box.y]);
  await pointer(page, 'pointerup', [box.x, box.y]);
  await expect(panel.locator('.lis-seg.is-on')).toContainText('Convolution flips');
  expect((await strokesNow(page)).length).toBe(strokes.length); // the tap didn't write a dot

  // Per-page summary in Pages, and as a page note on request.
  await page.locator('.ed-top').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: /^Pages/ }).click();
  const pages = page.getByRole('complementary', { name: 'Pages' });
  await expect(pages.locator('.page-sum')).toContainText('Convolution flips one signal and slides it.');
  const texts = await page.evaluate(() => ((window as any).__inkwright.doc.page(0).texts ?? []).length);
  await pages.locator('.page-sum').getByRole('button', { name: 'Add to page' }).click();
  expect(await page.evaluate(() => ((window as any).__inkwright.doc.page(0).texts ?? []).map((t: any) => t.text))).toHaveLength(texts + 1);
});

test('search finds what was said and opens that moment', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => { (window as any).__inkwrightSpeechTuning = { minWindowMs: 1500, maxWindowMs: 8000, pauseMs: 500 }; localStorage.setItem('inkwright.speech.v1', JSON.stringify({ engine: 'provider', autoSummary: false, autoOpen: false })); });
  await mockProvider(page);
  await openApp(page);
  await addProvider(page);
  await openApp(page);
  await newNote(page);
  await page.getByRole('button', { name: 'Record audio' }).click();
  await page.waitForTimeout(800);
  await pen(page, word(120, 140, 160));
  await page.locator('.ed-top').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: /Transcript/ }).click();
  await expect(page.locator('.lis-seg')).toHaveCount(2, { timeout: 20_000 });
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(page.locator('.lis-where')).toContainText('Transcribed by your AI provider');
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.keyboard.press('Control+k');
  await page.locator('.pal-input').fill('flips one signal');
  const row = page.locator('.pal-row', { hasText: 'what was said at' }).first();
  await expect(row).toBeVisible();
  await row.click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  // Opening the moment plays the recording from there.
  await expect(page.locator('.audio-hint')).toHaveText('Tap ink to hear that moment');
});

test('dictate puts speech on the page, processed where the indicator says', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__inkwrightSpeechTuning = { minWindowMs: 1500, maxWindowMs: 8000, pauseMs: 500 }; });
  await mockProvider(page);
  await openApp(page);
  await addProvider(page);
  await openApp(page);
  await newNote(page);
  await page.locator('.ed-top').getByRole('button', { name: 'More' }).click();
  await page.getByRole('menuitem', { name: /Dictate/ }).click();
  const bar = page.getByRole('region', { name: 'Dictation' });
  await expect(bar.locator('.lis-where')).toContainText('Sent to Custom');
  await expect(bar.locator('.dict-text')).toContainText('Today we cover convolution.', { timeout: 15_000 });
  await bar.getByRole('button', { name: 'Done' }).click();
  await expect.poll(() => page.evaluate(() => ((window as any).__inkwright.doc.page(0).texts ?? []).map((t: any) => t.text).join(' '))).toContain('Today we cover convolution.');

  // In a text box, dictation goes in at the caret.
  await page.keyboard.press('t');
  await pointer(page, 'pointerdown', [200, 400], { type: 'mouse' });
  await pointer(page, 'pointerup', [200, 400], { type: 'mouse' });
  const ta = page.locator('.text-area');
  await expect(ta).toBeVisible();
  await ta.fill('Notes: end');
  await ta.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(7, 7));
  await page.getByRole('button', { name: 'Dictate' }).click();
  await expect(page.locator('.dict-line')).toContainText(/\w/, { timeout: 15_000 });
  await expect(page.locator('.dict-line .dict-text')).not.toHaveText('Listening…', { timeout: 15_000 });
  await page.getByRole('button', { name: 'Stop dictating' }).click();
  await expect(ta).toHaveValue(/^Notes: \S.* end$/);
});

test('on this device: offers the speech model download and never uploads audio', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('inkwright.speech.v1', JSON.stringify({ engine: 'device' })));
  const uploads: string[] = [];
  page.on('request', (r) => { if (r.url().includes('/audio/transcriptions')) uploads.push(r.url()); });
  await mockProvider(page);
  await openApp(page);
  await addProvider(page); // a provider exists, but "this device" is chosen below
  await page.getByRole('region', { name: 'Speech to text' }).getByRole('radio', { name: 'This device' }).click();
  await expect(page.getByRole('region', { name: 'Speech to text' })).toContainText(/Download (Moonshine|Whisper)/);
  await openApp(page);
  await newNote(page);
  await page.getByRole('button', { name: 'Record audio' }).click();
  const panel = page.getByRole('complementary', { name: 'Transcript' });
  await expect(panel.locator('.lis-offer')).toContainText(/Transcribe privately on this device/);
  await expect(panel.getByRole('button', { name: /^Download · \d+ MB$/ })).toBeVisible();
  await page.waitForTimeout(2500);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  expect(uploads).toEqual([]);
});
