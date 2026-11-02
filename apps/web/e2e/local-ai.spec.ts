import { expect, test, type Page, type Route } from '@playwright/test';
import { openApp } from './helpers.ts';

/** Picks MiniLM as this device's search model (smallest; same files for every device class). */
async function useMiniLM(page: Page) {
  await page.addInitScript(() => localStorage.setItem('inkstone.localai.v1', JSON.stringify({ embedModel: 'minilm-l6', embeddings: 'off' })));
}

/**
 * Relays Hugging Face requests through Node, so they use this machine's network settings.
 * Playwright can only hand a page a few hundred MB per response, so file downloads are relayed in
 * slices of at most 16 MB: a cut-short response is exactly what the app's resumable downloader
 * recovers from (it asks for the rest with an HTTP Range request).
 */
const SLICE = 16 << 20;
async function relayToHuggingFace(route: Route) {
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
  if (!asked) return route.fulfill({ status: 200, headers: out, body }); // whole file, or its first slice
  out['content-range'] = `bytes ${from}-${from + body.length - 1}/${total}`;
  await route.fulfill({ status: 206, headers: out, body });
}

async function openAISettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'On this device' })).toBeVisible();
}

test('model downloads show their size, survive an interruption and resume where they stopped', async ({ page }) => {
  // Resuming needs OPFS. Playwright's WebKit runs ephemeral sessions, where WebKit refuses OPFS
  // (like Safari private windows); the app then downloads through transformers.js's cache instead.
  test.skip(test.info().project.name.startsWith('webkit'), 'OPFS is unavailable in WebKit ephemeral sessions');
  // In Firefox the download requests the AI worker makes were not intercepted by page.route here
  // (the progress stayed at 0 B), so the mocked interruption cannot be staged.
  test.skip(test.info().project.name.startsWith('firefox'), 'worker fetches are not routed in Firefox');
  // A stand-in for the Hugging Face repository: small files, and the weights cut off half-way the
  // first time (like a dropped connection). The second attempt must ask only for the rest.
  const weights = Buffer.alloc(3_000_000, 7);
  const files: Record<string, Buffer> = {
    'config.json': Buffer.from('{"model_type":"bert"}'),
    'tokenizer.json': Buffer.from('{}'),
    'tokenizer_config.json': Buffer.from('{}'),
    'onnx/model_quantized.onnx': weights,
  };
  const ranges: (string | null)[] = [];
  let cut = true;
  await page.route('https://huggingface.co/**', async (route: Route) => {
    const url = new URL(route.request().url());
    const cors = { 'access-control-allow-origin': '*', 'access-control-expose-headers': 'content-length, content-range' };
    if (url.pathname.startsWith('/api/models/Xenova/all-MiniLM-L6-v2/tree')) {
      return route.fulfill({ status: 200, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify([...Object.entries(files).map(([path, b]) => ({ type: 'file', path, size: b.length })), { type: 'file', path: 'README.md', size: 10 }]) });
    }
    const m = /\/Xenova\/all-MiniLM-L6-v2\/resolve\/main\/(.+)$/.exec(url.pathname);
    const body = m && files[m[1]!];
    if (!body) return route.fulfill({ status: 404, headers: cors, body: '' });
    const range = route.request().headers()['range'] ?? null;
    if (m![1] === 'onnx/model_quantized.onnx') ranges.push(range);
    if (range) {
      const from = Number(/bytes=(\d+)-/.exec(range)![1]);
      return route.fulfill({ status: 206, headers: { ...cors, 'content-range': `bytes ${from}-${body.length - 1}/${body.length}` }, body: body.subarray(from) });
    }
    if (m![1] === 'onnx/model_quantized.onnx' && cut) {
      cut = false;
      return route.fulfill({ status: 200, headers: cors, body: body.subarray(0, 1_000_000) });
    }
    return route.fulfill({ status: 200, headers: cors, body });
  });
  await useMiniLM(page);
  await openApp(page);
  await openAISettings(page);
  const row = page.locator('.lai-row', { has: page.getByRole('combobox', { name: 'Search model' }) });
  await expect(row.locator('select')).toHaveValue('minilm-l6');
  // The size is shown before anything is downloaded.
  await row.getByRole('button', { name: 'Download · 24 MB' }).click();
  await expect(row.locator('.lai-error')).toContainText('resume');
  await expect(row.getByRole('button', { name: /Resume/ })).toBeVisible();
  await row.getByRole('button', { name: /Resume/ }).click();
  await expect(row).toContainText('On this device');
  expect(ranges).toEqual([null, 'bytes=1000000-']);
  // Stored in the private file system, complete.
  const size = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await (await root.getDirectoryHandle('inkstone-models')).getDirectoryHandle('Xenova__all-MiniLM-L6-v2');
    return (await (await dir.getFileHandle('onnx__model_quantized.onnx')).getFile()).size;
  });
  expect(size).toBe(weights.length);
  // Delete frees it again.
  await row.getByRole('button', { name: /Delete MiniLM/ }).click();
  await page.locator('.dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(row.getByRole('button', { name: 'Download · 24 MB' })).toBeVisible();
});

/**
 * Opt-in (INKSTONE_REAL_MODELS=1): downloads the real MiniLM model from Hugging Face into the
 * browser's OPFS through the app's worker, embeds every note, and checks that search by meaning
 * finds a passage that shares no keyword with the query. Requests are relayed through Node so they
 * use this machine's network configuration.
 */
test('real on-device embeddings find notes by meaning (opt-in, downloads 24 MB)', async ({ page }) => {
  test.skip(!process.env.INKSTONE_REAL_MODELS, 'set INKSTONE_REAL_MODELS=1 to download a real model');
  test.setTimeout(240_000);
  await page.route('https://huggingface.co/**', relayToHuggingFace);
  await page.addInitScript(() => localStorage.setItem('inkstone.localai.v1', JSON.stringify({ embedModel: 'minilm-l6', embeddings: 'device' })));
  await openApp(page);
  await openAISettings(page);
  const row = page.locator('.lai-row', { has: page.getByRole('combobox', { name: 'Search model' }) });
  await row.getByRole('button', { name: /Download/ }).click();
  // Files over one relay slice arrive in parts; each part is resumed like a dropped connection.
  const done = row.getByText('On this device');
  for (let i = 0; i < 10 && !(await done.isVisible()); i++) {
    const resume = row.getByRole('button', { name: /Resume/ });
    await expect(resume.or(done)).toBeVisible({ timeout: 120_000 });
    if (await resume.isVisible()) await resume.click();
  }
  await expect(done).toBeVisible({ timeout: 180_000 });
  await expect(page.locator('.lai-row', { hasText: 'passages ready' })).toContainText(/(\d+) of \1 passages ready/, { timeout: 120_000 });
  await page.keyboard.press('Control+k');
  // No keyword overlap with "Everything is saved as plain files … sync them with Google Drive".
  await page.locator('.pal-input').fill('where does my data live');
  await expect(page.locator('.pal-foot')).toContainText('Searching by meaning', { timeout: 60_000 });
  await expect(page.locator('.pal-row', { hasText: 'typed text' }).first()).toContainText('plain files');
});

/**
 * Opt-in (INKSTONE_REAL_MODELS=chat): downloads a real chat model (Granite 4.0 350M, ~0.6 GB) and
 * answers an Ask question entirely on the device, through the worker, with citations.
 */
test('real on-device chat answers Ask from the notes (opt-in, downloads ~0.6 GB)', async ({ page }) => {
  test.skip(process.env.INKSTONE_REAL_MODELS !== 'chat', 'set INKSTONE_REAL_MODELS=chat to download a real chat model');
  test.setTimeout(900_000);
  await page.route('https://huggingface.co/**', relayToHuggingFace);
  await page.addInitScript(() => localStorage.setItem('inkstone.localai.v1', JSON.stringify({ chatModel: 'granite-4.0-350m', embedModel: 'minilm-l6', embeddings: 'off' })));
  await openApp(page);
  await page.keyboard.press('Control+k');
  await page.getByRole('radio', { name: 'Ask' }).click();
  await page.locator('.pal-input').fill('How does Inkstone save my notes?');
  await page.locator('.pal-input').press('Enter');
  await page.locator('.lai-offer').getByRole('button', { name: /Download/ }).click();
  // The relay delivers big files in slices; each cut is resumed exactly like a dropped connection.
  const foot = page.locator('.pal-foot', { hasText: 'Answered by' });
  for (let i = 0; i < 80 && !(await foot.isVisible()); i++) {
    const resume = page.locator('.lai-offer').getByRole('button', { name: /Resume download/ });
    await expect(resume.or(foot)).toBeVisible({ timeout: 120_000 });
    if (await resume.isVisible()) { console.log(`resuming (${await resume.innerText()})`); await resume.click(); }
  }
  await expect(page.locator('.pal-foot')).toContainText('Answered by On this device · Granite 4.0 350M', { timeout: 600_000 });
  await expect(page.locator('.pal-sources li').first()).toBeVisible();
  await expect(page.locator('.pal-foot')).not.toContainText('Stop', { timeout: 240_000 });
  const answer = await page.locator('.pal-answer-text').innerText();
  console.log('On-device answer:', answer);
  expect(answer.length).toBeGreaterThan(10);
});
