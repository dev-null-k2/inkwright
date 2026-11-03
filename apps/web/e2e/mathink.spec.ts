import { expect, test, type Page, type Route } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { circle, line, newNote, openApp, pen, settingsGroup, type Pt } from './helpers.ts';

/**
 * Handwritten maths, read on the device: write, lasso, Solve. ML Kit can't run in a desktop
 * browser, so the Android plugin is replaced by a scripted stand-in (e2e builds read
 * `window.__inkwrightFakeRecognizer`; see smart/inkmath.ts) that answers like ML Kit does for
 * single symbols — ranked candidates with lower-is-better scores, and the usual confusions
 * ("t" before "+", "l" before "1"). It recognises the test's own glyphs by their shape. Grouping
 * strokes into symbols, the layout (the fraction), the grammar and the solver all run for real.
 */
async function installFakeMlKit(page: Page) {
  await page.addInitScript(() => {
    type Ink = { strokes: { x: number[]; y: number[] }[] };
    const calls: number[] = [];
    (window as any).__mlkitCalls = calls;
    const straight = (s: { x: number[]; y: number[] }) => {
      const n = s.x.length - 1;
      const chord = Math.hypot(s.x[n]! - s.x[0]!, s.y[n]! - s.y[0]!);
      let len = 0;
      for (let i = 1; i <= n; i++) len += Math.hypot(s.x[i]! - s.x[i - 1]!, s.y[i]! - s.y[i - 1]!);
      return len > 0 && chord / len > 0.95;
    };
    const answer = (ink: Ink) => {
      const ss = ink.strokes;
      const c = (...xs: [string, number][]) => ({ candidates: xs.map(([text, score]) => ({ text, score })) });
      if (ss.length === 2 && ss.every(straight)) {
        const s0 = ss[0]!, s1 = ss[1]!;
        const flat = (s: typeof s0) => Math.abs(s.y[s.y.length - 1]! - s.y[0]!) < Math.abs(s.x[s.x.length - 1]! - s.x[0]!) * 0.3;
        // Two diagonals: x. One flat and one upright: a plus, which a text model often reads "t".
        if (!flat(s0) && !flat(s1) && Math.abs(s0.x[0]! - s0.x[s0.x.length - 1]!) > 4) return c(['x', 0.6], ['X', 1.4], ['×', 2.1]);
        return c(['t', 1.1], ['+', 1.35], ['f', 3.2]);
      }
      if (ss.length === 2) return c(['4', 0.5], ['y', 2.4], ['9', 3]);
      const s = ss[0]!;
      if (straight(s)) return c(['l', 0.9], ['1', 1.0], ['|', 2.2]);
      // One curved stroke: a "2" ends to the right of where it began, a "3" to the left.
      return s.x[s.x.length - 1]! > s.x[0]! ? c(['2', 0.4], ['z', 2.0], ['Z', 2.6]) : c(['3', 0.45], ['B', 2.3], ['}', 3.1]);
    };
    (window as any).__inkwrightFakeRecognizer = {
      async prepareRecognizer() { return { state: 'ready' }; },
      async recognize(o: { lines: unknown[] }) { return { lines: o.lines.map(() => '') }; },
      async recognizeSymbols(o: { inks: Ink[] }) { calls.push(o.inks.length); return { results: o.inks.map(answer) }; },
    };
  });
}

/** Glyphs drawn like a hand would, in canvas px; (x, y) is the top-left of a symbol ~40 px tall. */
const curve = (pts: Pt[], n = 12): Pt[] => pts.slice(1).flatMap((b, i) => { const a = pts[i]!; return Array.from({ length: n }, (_, k) => [a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n] as Pt); }).concat([pts[pts.length - 1]!]);
const two = (x: number, y: number) => curve([[x, y + 10], [x + 8, y], [x + 22, y + 2], [x + 24, y + 13], [x + 2, y + 40], [x + 26, y + 40]]);
const three = (x: number, y: number) => curve([[x + 3, y + 4], [x + 14, y], [x + 22, y + 9], [x + 10, y + 19], [x + 23, y + 28], [x + 15, y + 40], [x + 1, y + 37]]);
const four = (x: number, y: number): Pt[][] => [curve([[x + 16, y], [x, y + 26], [x + 26, y + 26]]), line([x + 18, y + 12], [x + 18, y + 40], 16)];
const plus = (x: number, y: number): Pt[][] => [line([x, y + 20], [x + 24, y + 20], 16), line([x + 12, y + 8], [x + 12, y + 32], 16)];
const equals = (x: number, y: number): Pt[][] => [line([x, y + 15], [x + 26, y + 15], 16), line([x, y + 26], [x + 26, y + 26], 16)];
const ex = (x: number, y: number): Pt[][] => [line([x, y + 14], [x + 20, y + 40], 16), line([x + 20, y + 14], [x, y + 40], 16)];
const one = (x: number, y: number) => line([x + 6, y], [x + 6, y + 40], 20);

async function write(page: Page, strokes: Pt[][]) {
  for (const s of strokes) await pen(page, s);
}

async function lassoAndSolve(page: Page, cx: number, cy: number, r: number) {
  await page.keyboard.press('l');
  await pen(page, circle(cx, cy, r), { type: 'mouse' });
  await page.locator('.sel-btn', { hasText: 'Solve' }).click();
}

const results = (page: Page) => page.evaluate(() => ((window as any).__inkwright.doc.page(0).objects ?? []).filter((o: any) => o.type === 'math'));

/** A cloud vision AI is set up too: reading on the device must not send it the picture. */
async function cloudVisionAI(page: Page) {
  const reqs: unknown[] = [];
  await page.route('https://mock-llm.test/v1/chat/completions', async (route: Route) => {
    reqs.push(route.request().postDataJSON());
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: '{"plain":"15↓"}' }, finish_reason: 'stop' }] }) });
  });
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('button', { name: 'AI', exact: true }).click();
  await page.getByRole('button', { name: 'Add an AI provider' }).click();
  await page.locator('.add-provider select').selectOption('custom');
  await page.locator('.add-provider').getByPlaceholder('https://…/v1').fill('https://mock-llm.test/v1');
  await page.locator('.add-provider input[list]').fill('mock-vision-1');
  await page.getByRole('button', { name: 'Save provider' }).click();
  await expect(page.locator('.prov-row')).toHaveCount(1);
  await page.getByRole('button', { name: 'Back' }).click();
  return reqs;
}

test.beforeEach(async ({ page }) => {
  await installFakeMlKit(page);
});

test('write 2+2= → lasso → Solve gives 4, read on this device (the AI is not asked)', async ({ page }) => {
  await openApp(page);
  const reqs = await cloudVisionAI(page);
  await newNote(page);
  await write(page, [two(200, 300), ...plus(240, 300), two(280, 300), ...equals(322, 300)]);
  await lassoAndSolve(page, 275, 320, 110);

  await expect.poll(async () => (await results(page)).length).toBe(1);
  const [m] = await results(page);
  // ML Kit's first guess for the plus was "t"; the maths grammar chose "+".
  expect(m).toMatchObject({ input: '2+2=', result: '= 4', origin: 'solver', readBy: 'ML Kit on this device' });
  expect(await page.evaluate(() => (window as any).__mlkitCalls)).toEqual([3]);
  expect(reqs).toHaveLength(0);
  // Who read it is visible on the result.
  await expect(page.getByRole('button', { name: /^Result = 4/ })).toHaveAttribute('title', 'Read by ML Kit on this device, solved on this device');
});

test('a stacked fraction is read as a fraction and answered exactly', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  // 3 over 4, then "=".
  await write(page, [three(212, 240), line([200, 290], [246, 291], 20), ...four(210, 300), ...equals(262, 274)]);
  await lassoAndSolve(page, 240, 292, 100);
  await expect.poll(async () => (await results(page)).length).toBe(1);
  const [m] = await results(page);
  expect(m).toMatchObject({ input: '3/4=', latex: '\\frac{3}{4}=', result: '= 3/4 = 0.75', readBy: 'ML Kit on this device' });
});

test('an equation is solved with steps worked out on this device', async ({ page }) => {
  await openApp(page);
  await newNote(page);
  // x + 1 = 3
  await write(page, [...ex(200, 300), ...plus(232, 300), one(266, 300), ...equals(292, 300), three(330, 300)]);
  await lassoAndSolve(page, 270, 320, 120);
  await expect.poll(async () => (await results(page)).length).toBe(1);
  const [m] = await results(page);
  expect(m).toMatchObject({ input: 'x+1=3', result: 'x = 2', stepsBy: 'solver' });
  await page.getByRole('button', { name: /^Result x = 2/ }).click();
  await page.getByRole('menuitem', { name: 'Show steps' }).click();
  const steps = page.getByRole('dialog', { name: 'Steps' });
  await expect(steps).toContainText('Collect x on the left, numbers on the right: x = 2');
  await expect(steps).toContainText('Worked out exactly on this device. Read by ML Kit on this device.');
  await expect(page.locator('.toast')).toHaveCount(0, { timeout: 10_000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: 'test-results/mathink-steps.png' });
});

test('records handwriting samples with what they meant, and shares them as a file', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await settingsGroup(page, 'About');
  await page.getByRole('button', { name: 'Check this device' }).click();
  await page.getByRole('button', { name: 'Record handwriting samples' }).click();
  const dialog = page.getByRole('dialog', { name: 'Record handwriting samples' });
  await expect(dialog).toBeVisible();

  // Write "2+2=" on the pad with the pen.
  const padStrokes = [two(20, 30), ...plus(60, 30), two(100, 30), ...equals(142, 30)];
  await dialog.locator('canvas').evaluate(async (pad, strokes) => {
    const r = pad.getBoundingClientRect();
    for (const s of strokes) {
      const fire = (type: string, p: number[]) => pad.dispatchEvent(new PointerEvent(type, { pointerId: 5, pointerType: 'pen', isPrimary: true, bubbles: true, cancelable: true, clientX: r.left + p[0]!, clientY: r.top + p[1]!, pressure: type === 'pointerup' ? 0 : 0.5, buttons: type === 'pointerup' ? 0 : 1 }));
      fire('pointerdown', s[0]!);
      for (const p of s.slice(1)) fire('pointermove', p);
      fire('pointerup', s[s.length - 1]!);
      await new Promise((res) => setTimeout(res, 5));
    }
  }, padStrokes);
  await expect(dialog.locator('.dc-count')).toHaveText('6 strokes');
  await dialog.getByLabel('What you wrote').fill('2+2=');
  await dialog.getByRole('button', { name: 'Save sample' }).click();
  await expect(dialog.getByRole('list', { name: 'Saved samples' })).toContainText('2+2=');
  // Each sample keeps what the on-device reader made of it.
  await expect(dialog.getByRole('list', { name: 'Saved samples' })).toContainText('read as 2+2=');

  const download = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Share file' }).click();
  const file = JSON.parse(readFileSync(await (await download).path(), 'utf8'));
  expect(file.format).toBe('inkwright-handwriting-samples');
  expect(file.samples).toHaveLength(1);
  expect(file.samples[0]).toMatchObject({ label: '2+2=', read: { plain: '2+2=', engine: 'ml-kit' } });
  expect(file.samples[0].strokes).toHaveLength(6);
  expect(file.samples[0].strokes[0]).toMatchObject({ pointer: 'pen' });
  expect(file.samples[0].strokes[0].points.length).toBeGreaterThan(5);
});
