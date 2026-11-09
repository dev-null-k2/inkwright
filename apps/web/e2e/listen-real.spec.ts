import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Route } from '@playwright/test';
import { newNote, openApp } from './helpers';

/**
 * Opt-in (INKWRIGHT_REAL_MODELS=1 or =asr): the real on-device speech model in the app's worker.
 * Downloads Moonshine Tiny (32 MB) into OPFS through Settings › AI, then records a public-domain
 * clip (President Kennedy's 1961 inaugural address) played by Chromium's fake microphone and
 * checks that the live transcript appears, transcribed on this device, with nothing uploaded.
 * Hugging Face requests are relayed through Node so they use this machine's network settings.
 */
const ENABLED = !!process.env.INKWRIGHT_REAL_MODELS;
const WAV = join(process.cwd(), 'test-results', 'listen-jfk.wav');

// Chromium only: the fake microphone (a WAV file as mic input) is a Chromium launch flag.
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only launch flags');

test.use({
  permissions: ['microphone'],
  launchOptions: { args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${WAV}`] },
});

const SLICE = 16 << 20;
async function relay(route: Route) {
  const req = route.request();
  const out: Record<string, string> = { 'access-control-allow-origin': '*' };
  if (!new URL(req.url()).pathname.includes('/resolve/')) {
    const r = await fetch(req.url());
    out['content-type'] = r.headers.get('content-type') ?? 'application/json';
    return route.fulfill({ status: r.status, headers: out, body: Buffer.from(await r.arrayBuffer()) });
  }
  const asked = /bytes=(\d+)-/.exec(req.headers()['range'] ?? '');
  const from = asked ? Number(asked[1]) : 0;
  const r = await fetch(req.url(), { headers: { range: `bytes=${from}-${from + SLICE - 1}` } });
  const body = Buffer.from(await r.arrayBuffer());
  out['content-type'] = 'application/octet-stream';
  if (r.status !== 206) return route.fulfill({ status: r.status, headers: out, body });
  const total = Number(/\/(\d+)$/.exec(r.headers.get('content-range') ?? '')?.[1] ?? body.length);
  if (!asked) return route.fulfill({ status: 200, headers: out, body });
  out['content-range'] = `bytes ${from}-${from + body.length - 1}/${total}`;
  await route.fulfill({ status: 206, headers: out, body });
}

test.beforeAll(async () => {
  if (!ENABLED || existsSync(WAV)) return;
  const r = await fetch('https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav');
  mkdirSync(join(process.cwd(), 'test-results'), { recursive: true });
  writeFileSync(WAV, Buffer.from(await r.arrayBuffer()));
});

test('real on-device live transcript (opt-in, downloads 32 MB)', async ({ page }) => {
  test.skip(!ENABLED, 'set INKWRIGHT_REAL_MODELS=1 to download a real speech model');
  test.setTimeout(300_000);
  const uploads: string[] = [];
  page.on('request', (r) => { if (/audio\/transcriptions|generateContent/.test(r.url())) uploads.push(r.url()); });
  await page.route('https://huggingface.co/**', relay);
  await page.addInitScript(() => {
    localStorage.setItem('inkwright.localai.v1', JSON.stringify({ asrModel: 'moonshine-tiny', embeddings: 'off' }));
    localStorage.setItem('inkwright.speech.v1', JSON.stringify({ engine: 'device', autoSummary: false, language: 'en-US' }));
    (window as any).__inkwrightSpeechTuning = { minWindowMs: 4000, maxWindowMs: 14_000, pauseMs: 500 };
  });
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  const row = page.locator('.lai-row', { has: page.getByRole('combobox', { name: 'Speech model' }) });
  await expect(row.getByRole('combobox', { name: 'Speech model' })).toHaveValue('moonshine-tiny');
  await row.getByRole('button', { name: /Download/ }).click();
  const done = row.getByText('On this device');
  for (let i = 0; i < 10 && !(await done.isVisible()); i++) {
    const resume = row.getByRole('button', { name: /Resume/ });
    await expect(resume.or(done)).toBeVisible({ timeout: 120_000 });
    if (await resume.isVisible()) await resume.click();
  }
  await expect(page.getByRole('region', { name: 'Speech to text' }).locator('.lis-where')).toContainText('On this device · Moonshine Tiny');

  await openApp(page);
  await newNote(page);
  await page.getByRole('button', { name: 'Record audio' }).click();
  const panel = page.getByRole('complementary', { name: 'Meeting' });
  await expect(panel.locator('.lis-where')).toContainText('On this device · Moonshine Tiny');
  await expect(panel.locator('.lis-list')).toContainText(/country/i, { timeout: 180_000 });
  const lines = await panel.locator('.lis-seg').allInnerTexts();
  console.log(`on-device transcript: ${lines.join(' | ')}`);
  await page.getByRole('button', { name: 'Stop recording' }).click();
  await expect(panel.locator('.lis-where')).toContainText('Transcribed on this device', { timeout: 60_000 });
  expect(uploads).toEqual([]);
});
