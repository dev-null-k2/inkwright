import { expect, test, type Page } from '@playwright/test';
import { newNote, openApp, pen, word } from './helpers.ts';

/**
 * The assistant with a small on-device model, the way the founder's Razr Fold runs it: a LiteRT-LM
 * model behind the Android plugin (scripted here: e2e builds read `window.__inkwrightFakeNativeAI`),
 * and handwriting recognized on the device (the browser Handwriting Recognition API, shimmed with
 * fixed answers per line). Covers Gemma- and Qwen-style tool calls never reaching the screen,
 * recognizing the page before asking, chats that survive a restart, and Settings › AI download
 * states and AICore errors. What the real models answer is measured by the real-model evals
 * (docs/LOCAL_AI.md › Real-model evals).
 */

interface Reply { when?: string; text: string }
interface FakeOpts {
  replies?: Reply[];
  nano?: 'available' | 'downloadable' | 'downloading' | 'unavailable';
  tasks?: 'available' | 'downloadable';
  /** Gemini Nano downloads: fail with AICore's IPC error this many times first. */
  nanoIpcFailures?: number;
  /** Pause between download progress events. */
  stepMs?: number;
  /** Handwriting recognizer answers by line: lines whose first point is within [minY, maxY]. */
  handwriting?: Array<{ minY: number; maxY: number; text: string }>;
}

const IPC = '[ErrorCode 6] AICore failed with error type 1-DOWNLOAD_ERROR and error code 6-IPC_ERROR: AICore service disconnected';

async function installFakes(page: Page, o: FakeOpts) {
  await page.addInitScript(({ o, IPC }) => {
    const listeners: Record<string, Set<(e: unknown) => void>> = {};
    const emit = (ev: string, data: unknown) => listeners[ev]?.forEach((l) => l(data));
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const calls: { method: string; args: any }[] = [];
    const used = new Set<number>();
    let ipcLeft = o.nanoIpcFailures ?? 0;
    const status = {
      engines: [{ id: 'gemini-nano', state: o.nano ?? 'unavailable', contextTokens: 4000 }],
      tasks: { summarize: o.tasks ?? 'unavailable', proofread: o.tasks ?? 'unavailable', rewrite: 'unavailable', 'describe-image': o.tasks ?? 'unavailable' },
      models: [{ id: 'gemma-4-e2b', label: 'Gemma 4 E2B', bytes: 2_588_147_712, licence: 'Apache-2.0', params: '5B (2B effective)', blurb: 'Google’s open model for phones.', contextTokens: 4096, minRamGb: 7, state: o.nano === 'unavailable' || !o.nano ? 'available' : 'downloadable', partialBytes: 0, loaded: true, backend: 'gpu' }],
      recommendedModel: 'gemma-4-e2b',
      ramGb: 7.4,
      speech: { available: false, onDevice: false, fileInput: false },
    };
    (window as any).__nativeCalls = calls;
    (window as any).__inkwrightFakeNativeAI = {
      async addListener(ev: string, cb: (e: unknown) => void) { (listeners[ev] ??= new Set()).add(cb); return { remove: async () => void listeners[ev]!.delete(cb) }; },
      async aiStatus() { return JSON.parse(JSON.stringify(status)); },
      async aiDownload(args: { target: string }) {
        calls.push({ method: 'aiDownload', args });
        emit('aiDownload', { target: args.target, phase: 'started', loaded: 0, total: 0 });
        if (args.target === 'gemini-nano' && ipcLeft-- > 0) {
          await sleep(100);
          emit('aiDownload', { target: args.target, phase: 'failed', error: IPC, code: 'service' });
          throw Object.assign(new Error(IPC), { code: 'service' });
        }
        const total = 50_000_000;
        for (const f of [0.2, 0.4, 0.68, 0.9, 1]) { await sleep(o.stepMs ?? 250); emit('aiDownload', { target: args.target, phase: 'download', loaded: total * f, total }); }
        if (args.target === 'gemini-nano') status.engines[0]!.state = 'available';
        if (args.target.startsWith('task:')) (status.tasks as any)[args.target.slice(5)] = 'available';
        emit('aiDownload', { target: args.target, phase: 'done', loaded: 1, total: 1 });
        return { state: 'available' };
      },
      async aiCancelDownload(args: unknown) { calls.push({ method: 'aiCancelDownload', args }); },
      async aiDeleteModel() {},
      async aiUnload() {},
      async aiGenerate(args: { requestId: string; messages: { role: string; content: string }[] }) {
        calls.push({ method: 'aiGenerate', args });
        const last = args.messages.at(-1)?.content ?? '';
        const i = (o.replies ?? []).findIndex((r, k) => !used.has(k) && (!r.when || new RegExp(r.when).test(last)));
        const text = i >= 0 ? o.replies![i]!.text : 'Done.';
        if (i >= 0) used.add(i);
        // Streamed in small pieces, so tool syntax arrives split across deltas as it does on a phone.
        for (let k = 0; k < text.length; k += 5) { await sleep(5); emit('aiDelta', { requestId: args.requestId, delta: text.slice(k, k + 5) }); }
        return { text };
      },
      async aiTask() { return { text: '' }; },
      async aiCancel() {},
      async speechStart() { return { onDevice: false }; }, async speechStop() { return { text: '' }; }, async speechCancel() {}, async speechTranscribe() { return { text: '' }; },
    };
    // The browser Handwriting Recognition API, answering per line by where the line starts.
    if (o.handwriting) {
      (window as any).__recognized = 0;
      (window as any).HandwritingStroke = class { pts: { x: number; y: number }[] = []; addPoint(p: { x: number; y: number }) { this.pts.push(p); } };
      (navigator as any).queryHandwritingRecognizer = async () => ({ textAlternatives: true });
      (navigator as any).createHandwritingRecognizer = async () => ({
        startDrawing: () => {
          const strokes: { pts: { x: number; y: number }[] }[] = [];
          return {
            addStroke: (s: { pts: { x: number; y: number }[] }) => strokes.push(s),
            getPrediction: async () => {
              (window as any).__recognized++;
              const y = strokes[0]?.pts[0]?.y ?? -1;
              const hit = o.handwriting!.find((h) => y >= h.minY && y <= h.maxY);
              return hit ? [{ text: hit.text }] : [];
            },
            clear() {},
          };
        },
      });
    }
  }, { o, IPC });
}

const lastGenerate = (page: Page) => page.evaluate(() => (window as any).__nativeCalls.filter((c: any) => c.method === 'aiGenerate').at(-1)?.args);
const generates = (page: Page) => page.evaluate(() => (window as any).__nativeCalls.filter((c: any) => c.method === 'aiGenerate').map((c: any) => c.args));

async function typeOnPage(page: Page, text: string) {
  await page.evaluate((text) => {
    const d = (window as any).__inkwright.doc;
    d.upsertText(0, { id: `t${Date.now()}`, x: 64, y: 120, width: 600, text, fontSize: 16, color: '#FF1B1F24', font: 'sans', createdAt: Date.now() });
  }, text);
}

async function ask(page: Page, q: string) {
  await page.locator('.ai-input textarea').fill(q);
  await page.locator('.ai-input textarea').press('Enter');
  await expect(page.locator('.ai-typing')).toHaveCount(0, { timeout: 15_000 });
}

const RAW = /tool_call|call:|<\|"\|>|\{"name"/;

test.describe('assistant with an on-device model', () => {
  test('Gemma-style tool calls are run, never shown, and the answer cites the note', async ({ page }) => {
    await installFakes(page, {
      replies: [
        { when: 'what is it for car', text: '<|tool_call>call:tool_search_memory{query:{"query": "car budget"}}<tool_call|>' },
        { text: 'Your car budget is 4000$ [1].' },
      ],
    });
    await openApp(page);
    await newNote(page);
    await typeOnPage(page, 'Budget\nCar 4000$');
    await page.locator('.ai-btn').click();
    await expect(page.locator('.ai-model')).toContainText('Gemma 4 E2B');
    await ask(page, 'I had written a budget, what is it for car');
    await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('Your car budget is 4000$');
    await expect(page.locator('.ai-tool').first()).toContainText('Searched everything you wrote');
    for (const t of await page.locator('.ai-log').allInnerTexts()) expect(t).not.toMatch(RAW);
    // Retrieval first: the page's text was in the very first prompt, numbered to cite.
    const first = (await generates(page))[0];
    expect(first.messages.at(-1).content).toMatch(/Context from my notes:[\s\S]*Car 4000\$[\s\S]*Question: I had written a budget/);
    // A compact tool set for a 4k-token model.
    expect(first.messages[0].content).toMatch(/### create_note/);
    expect(first.messages[0].content).not.toMatch(/### trash_note|### list_notebooks/);
  });

  test('Qwen-style tool call creates a note; the confirmation comes from the tool run', async ({ page }) => {
    await installFakes(page, {
      replies: [
        { when: 'Groceries', text: '<tool_call>\n{"name": "create_note", "arguments": {"title": "Groceries", "text": "- [ ] milk\\n- [ ] eggs"}}\n</tool_call>' },
      ],
    });
    await openApp(page);
    await newNote(page);
    await page.locator('.ai-btn').click();
    await ask(page, 'Make a new note called Groceries with milk and eggs');
    // The confirmation is written from what the tool did, not by the model.
    await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('Created the note “Groceries”.');
    expect(await generates(page)).toHaveLength(1);
    await expect(page.locator('.ai-tool').first()).toContainText('Created a note');
    for (const t of await page.locator('.ai-log').allInnerTexts()) expect(t).not.toMatch(RAW);
    // An action asks the small model for a tool call on the first turn.
    expect((await generates(page))[0].messages[0].content).toMatch(/You must call at least one tool now/);
    await page.getByRole('button', { name: 'Back' }).click();
    await expect(page.locator('.library')).toContainText('Groceries');
  });

  test('the page is recognized before asking, and a dodge never reaches the person', async ({ page }) => {
    await installFakes(page, {
      handwriting: [{ minY: 0, maxY: 260, text: 'Budget Car 4000$' }],
      // A model that only answers when it was given the page's text.
      replies: [{ when: 'Question: What', text: 'The budget is 4000$ [1].' }, { text: 'Please provide more context.' }, { text: 'Could you clarify what you mean?' }],
    });
    await openApp(page);
    await newNote(page);
    await pen(page, word(80, 160, 220));
    await pen(page, word(320, 160, 140));
    expect(await page.evaluate(() => (window as any).__inkwright.doc.page(0).recognizedText ?? '')).toBe('');
    await page.locator('.ai-btn').click();
    await ask(page, 'What\'s the budget here?');
    await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('The budget is 4000$');
    expect(await page.evaluate(() => (window as any).__inkwright.doc.page(0).recognizedText)).toBe('Budget Car 4000$');
    expect((await lastGenerate(page)).messages.at(-1).content).toContain('(the page you are on):\nBudget Car 4000$');

    // Same page, a model that dodges: the person still gets what the page says.
    await page.evaluate(() => { (window as any).__nativeCalls.length = 0; });
    await ask(page, 'And what is written about the car?');
    await expect(page.locator('.ai-msg.is-assistant').last()).not.toContainText('provide more context');
    await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('Car 4000$');
  });

  test('chats survive a restart, carry history to the model, and can be started anew', async ({ page }) => {
    await installFakes(page, { replies: [{ when: 'Question: What is the budget', text: 'Your car budget is 4000$ [1].' }, { when: 'Question: And what is half', text: 'Half of 4000$ is 2000$.' }] });
    await openApp(page);
    await newNote(page);
    await typeOnPage(page, 'Budget\nCar 4000$');
    await page.locator('.ai-btn').click();
    await ask(page, 'What is the budget here?');
    await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('4000$');
    await page.evaluate(() => (window as any).__inkwright.doc.rename('Car budget'));
    await page.waitForTimeout(1200); // autosave and chat save

    // A restart: the app loads again from scratch.
    await page.goto('/?e2e');
    await expect(page.locator('.library')).toBeVisible();
    await page.getByRole('button', { name: 'Open Car budget' }).first().click();
    await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
    await page.locator('.ai-btn').click();
    await expect(page.locator('.ai-msg.is-user').first()).toContainText('What is the budget here?');
    await expect(page.locator('.ai-msg.is-assistant').first()).toContainText('Your car budget is 4000$');

    await ask(page, 'And what is half of that?');
    await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('2000$');
    const msgs = (await lastGenerate(page)).messages.map((m: any) => `${m.role}:${m.content.slice(0, 40)}`);
    expect(msgs.slice(1, 3)).toEqual(['user:What is the budget here?', 'assistant:Your car budget is 4000$ [1].']);

    await page.getByRole('button', { name: 'Chats' }).click();
    await page.getByRole('menuitem', { name: 'New chat about this note' }).click();
    await expect(page.locator('.ai-msg')).toHaveCount(0);
    await page.getByRole('button', { name: 'Chats' }).click();
    await page.getByRole('menuitem', { name: /What is the budget here\?/ }).click();
    await expect(page.locator('.ai-msg.is-assistant').last()).toContainText('2000$');
  });
});

test.describe('Settings › AI on Android', () => {
  async function openAISettings(page: Page) {
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.getByRole('button', { name: 'AI', exact: true }).click();
    await expect(page.getByTestId('native-ai')).toBeVisible();
  }

  test('AICore disconnecting while Gemini Nano downloads is retried calmly; raw codes only in Details', async ({ page }) => {
    test.setTimeout(60_000);
    await installFakes(page, { nano: 'downloadable', nanoIpcFailures: 1 });
    await openApp(page);
    await openAISettings(page);
    const row = page.getByTestId('native-ai').locator('.lai-row').first();
    await row.getByRole('button', { name: 'Download' }).click();
    await expect(row.locator('.dl-issue.is-retrying')).toContainText('Retrying automatically');
    await expect(row.locator('.dl-issue p')).not.toContainText('ErrorCode');
    await expect(row.locator('[role="alert"]')).toHaveCount(0);
    await row.locator('.dl-details summary').click();
    await expect(row.locator('.dl-details code')).toContainText('IPC_ERROR');
    await expect(row.locator('[data-state="downloading"]')).toContainText('Retrying…');
    // The retry (after 3 s) downloads with progress, then Ready.
    await expect(row.locator('[data-state="downloading"]')).toContainText(/Downloading… \d+%/, { timeout: 10_000 });
    await expect(row.locator('[data-state="ready"]')).toContainText('Ready', { timeout: 10_000 });
    await expect(row.locator('.dl-issue')).toHaveCount(0);
  });

  test('writing tools: the button turns into "Downloading… n%" with Cancel, then Ready', async ({ page }) => {
    await installFakes(page, { nano: 'available', tasks: 'downloadable', stepMs: 500 });
    await openApp(page);
    await openAISettings(page);
    const row = page.getByTestId('native-ai').locator('.lai-row', { hasText: 'Writing tools' });
    await row.getByRole('button', { name: 'Download' }).click();
    await expect(row.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
    await expect(row.locator('[data-state="downloading"]')).toContainText(/Starting…|Downloading…/);
    await expect(row.getByRole('button', { name: 'Cancel downloading the writing tools' })).toBeVisible();
    await expect(row.locator('[data-state="downloading"]')).toContainText(/Downloading… \d+%/);
    // Three tools one after another: one progress for all of them, never back to "Download".
    const seen: number[] = [];
    while (await row.locator('[data-state="downloading"]').count()) {
      // allTextContents doesn't wait: the element may be gone by now (the download finished).
      const m = /(\d+)%/.exec((await row.locator('[data-state="downloading"]').allTextContents()).join(' '));
      if (m) seen.push(Number(m[1]));
      expect(await row.getByRole('button', { name: 'Download', exact: true }).count()).toBe(0);
      await page.waitForTimeout(150);
    }
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every((v, i) => i === 0 || v >= seen[i - 1]!)).toBe(true);
    await expect(row.locator('[data-state="ready"]')).toContainText('Ready');
  });
});
