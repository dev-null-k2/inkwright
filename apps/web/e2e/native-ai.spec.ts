import { expect, test, type Page } from '@playwright/test';
import { openApp } from './helpers.ts';

/**
 * The Android app's on-device AI, driven in a desktop browser through a scripted stand-in for the
 * Kotlin plugin (e2e builds read `window.__inkstoneFakeNativeAI`; see lib/native-ai.ts). It speaks
 * the same protocol as app/inkstone/ai/AiBridge.kt: status, downloads with `aiDownload` progress
 * events, and streamed answers through `aiDelta` events. What the real engines do on a phone is
 * covered by the JVM tests and must be checked on a device (docs/ANDROID.md).
 */
async function installFakePlugin(page: Page, opts: { nano: 'available' | 'downloadable' | 'unavailable' }) {
  await page.addInitScript((nano) => {
    const listeners: Record<string, Set<(e: unknown) => void>> = {};
    const emit = (ev: string, data: unknown) => listeners[ev]?.forEach((l) => l(data));
    const calls: { method: string; args: any }[] = [];
    const status = {
      engines: [{ id: 'gemini-nano', state: nano, contextTokens: 4000 }],
      tasks: { summarize: nano === 'available' ? 'available' : 'unavailable', proofread: 'unavailable', rewrite: 'unavailable', 'describe-image': 'unavailable' },
      models: [
        { id: 'gemma-4-e2b', label: 'Gemma 4 E2B', bytes: 2_588_147_712, licence: 'Apache-2.0', params: '5B (2B effective)', blurb: 'Google’s open model for phones.', contextTokens: 4096, minRamGb: 7, state: 'downloadable', partialBytes: 0, loaded: false },
        { id: 'gemma-4-e4b', label: 'Gemma 4 E4B', bytes: 3_659_530_240, licence: 'Apache-2.0', params: '8B (4B effective)', blurb: 'Larger.', contextTokens: 4096, minRamGb: 11, state: 'unavailable', partialBytes: 0, loaded: false },
        { id: 'qwen3-0.6b', label: 'Qwen3 0.6B', bytes: 497_516_544, licence: 'Apache-2.0', params: '0.6B', blurb: 'Smallest.', contextTokens: 2048, minRamGb: 3, state: 'downloadable', partialBytes: 0, loaded: false },
      ],
      recommendedModel: 'gemma-4-e2b',
      ramGb: 7.4,
      speech: { available: true, onDevice: true, fileInput: true },
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (window as any).__nativeCalls = calls;
    (window as any).__inkstoneFakeNativeAI = {
      async addListener(ev: string, cb: (e: unknown) => void) {
        (listeners[ev] ??= new Set()).add(cb);
        return { remove: async () => void listeners[ev]!.delete(cb) };
      },
      async aiStatus(args: unknown) { calls.push({ method: 'aiStatus', args }); return JSON.parse(JSON.stringify(status)); },
      async aiDownload(args: { target: string }) {
        calls.push({ method: 'aiDownload', args });
        const m = status.models.find((x) => `litert:${x.id}` === args.target)!;
        emit('aiDownload', { target: args.target, phase: 'started', loaded: 0, total: 0 });
        for (const f of [0.25, 0.5, 0.75, 1]) {
          await sleep(150);
          emit('aiDownload', { target: args.target, phase: 'download', loaded: Math.round(m.bytes * f), total: m.bytes });
        }
        await sleep(150);
        emit('aiDownload', { target: args.target, phase: 'verify', loaded: m.bytes, total: m.bytes });
        await sleep(150);
        m.state = 'available';
        m.partialBytes = m.bytes;
        emit('aiDownload', { target: args.target, phase: 'done', loaded: 1, total: 1 });
        return { state: 'available' };
      },
      async aiCancelDownload(args: unknown) { calls.push({ method: 'aiCancelDownload', args }); },
      async aiDeleteModel(args: { modelId: string }) {
        calls.push({ method: 'aiDeleteModel', args });
        const m = status.models.find((x) => x.id === args.modelId)!;
        m.state = 'downloadable';
        m.partialBytes = 0;
      },
      async aiUnload() { calls.push({ method: 'aiUnload', args: null }); },
      async aiGenerate(args: { requestId: string; engine: string; modelId?: string }) {
        calls.push({ method: 'aiGenerate', args });
        const words = ['You ', 'wrote ', 'about ', 'Inkstone ', '(answered ', 'on ', 'the ', 'phone).'];
        for (const w of words) {
          await sleep(20);
          emit('aiDelta', { requestId: args.requestId, delta: w });
        }
        return { text: words.join('') };
      },
      async aiTask(args: { requestId: string; task: string }) {
        calls.push({ method: 'aiTask', args });
        const text = '- Inkstone keeps notes as plain files\n- Gemini Nano summarized this on the phone';
        emit('aiDelta', { requestId: args.requestId, delta: text });
        return { text };
      },
      async aiCancel(args: unknown) { calls.push({ method: 'aiCancel', args }); },
      async speechStart(args: unknown) { calls.push({ method: 'speechStart', args }); return { onDevice: true }; },
      async speechStop(args: unknown) { calls.push({ method: 'speechStop', args }); return { text: 'hello' }; },
      async speechCancel(args: unknown) { calls.push({ method: 'speechCancel', args }); },
      async speechTranscribe(args: unknown) { calls.push({ method: 'speechTranscribe', args }); return { text: 'hello' }; },
    };
  }, opts.nano);
}

async function openAISettings(page: Page) {
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'On this device' })).toBeVisible();
}

test('Android without Gemini Nano: download the open model after a size prompt, then the assistant answers on the phone', async ({ page }) => {
  await installFakePlugin(page, { nano: 'unavailable' });
  await openApp(page);
  await openAISettings(page);
  const native = page.getByTestId('native-ai');
  await expect(native).toContainText('Not offered on this phone');
  await expect(native.getByLabel('Open model')).toContainText('Gemma 4 E2B · 2.6 GB · recommended');
  // A model this phone has too little memory for is listed but can't be chosen.
  await expect(native.locator('option', { hasText: 'Gemma 4 E4B' })).toBeDisabled();
  await expect(native).toContainText('Voice input');

  await native.getByRole('button', { name: /Download · 2\.6 GB/ }).click();
  // Nothing is fetched before the person agrees to the size.
  await expect(page.getByText('Download Gemma 4 E2B?')).toBeVisible();
  await expect(page.getByText(/2\.6 GB from Hugging Face, once\. Apache-2\.0 licence/)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__nativeCalls.some((c: any) => c.method === 'aiDownload'))).toBe(false);
  await page.getByRole('button', { name: 'Download', exact: true }).click();

  await expect(native.getByRole('status')).toBeVisible();
  await expect(native.getByRole('status')).toContainText(/of 2\.6 GB|Checking the download/);
  await expect(native).toContainText('On this phone', { timeout: 10_000 });
  await expect(native.getByRole('button', { name: 'Delete Gemma 4 E2B' })).toBeVisible();

  // The assistant now answers through the phone's runtime, streaming.
  await page.getByRole('button', { name: 'Back' }).click();
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkstone?.engine);
  await page.locator('.ai-btn').click();
  await page.locator('.ai-input textarea').fill('What did I write about?');
  await page.locator('.ai-input textarea').press('Enter');
  await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('answered on the phone');
  const gen = await page.evaluate(() => (window as any).__nativeCalls.find((c: any) => c.method === 'aiGenerate').args);
  expect(gen).toMatchObject({ engine: 'litert', modelId: 'gemma-4-e2b' });
  expect(gen.messages.at(-1).content).toContain('What did I write about?');
});

test('Android with Gemini Nano: it answers without a download and summaries use the summarization API', async ({ page }) => {
  await installFakePlugin(page, { nano: 'available' });
  await openApp(page);
  await openAISettings(page);
  const native = page.getByTestId('native-ai');
  await expect(native).toContainText('Gemini Nano');
  await expect(native).toContainText('Ready');
  await page.getByRole('button', { name: 'Back' }).click();
  await page.locator('.note-open').first().click();
  await page.waitForFunction(() => !!(window as any).__inkstone?.engine);
  await page.locator('.ai-btn').click();
  await page.getByRole('button', { name: 'Summarize' }).click();
  await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('Gemini Nano summarized this on the phone');
  const task = await page.evaluate(() => (window as any).__nativeCalls.find((c: any) => c.method === 'aiTask').args);
  expect(task).toMatchObject({ task: 'summarize', style: 'bullets' });
});
