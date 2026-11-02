import { chromium, expect, test as base, type Browser, type Page } from '@playwright/test';
import { PDFDocument } from 'pdf-lib';
import { line, pen, scribble, strokes, word } from '../e2e/helpers.ts';
import { calibrate, logcat, screencap, setSystemDarkMode, stylusSwipe, type ScreenMap } from './adb.ts';

/**
 * Smoke test of the real Android app: the Capacitor WebView, the InkstoneNative plugin and the
 * activity's native input paths, on an emulator (or a device). Playwright is attached to the app's
 * WebView over CDP; real stylus MotionEvents come from `adb shell input stylus`.
 *
 * Tests run in order on one app instance (like a person using it), so each builds on the last.
 */
const test = base.extend<object, { app: { browser: Browser; page: Page } }>({
  app: [async ({}, use) => {
    const endpoint = process.env.INKSTONE_CDP ?? 'http://127.0.0.1:9333';
    // noDefaults: attach to the WebView as it is. Playwright would otherwise set download behaviour
    // and emulation on the default context, which a WebView rejects ("Browser context management
    // is not supported").
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 120_000, noDefaults: true });
    const pages = browser.contexts().flatMap((c) => c.pages());
    const page = pages.find((p) => p.url().startsWith('https://localhost')) ?? pages[0];
    if (!page) throw new Error(`no WebView page behind ${endpoint}`);
    await use({ browser, page });
    // Detach only: closing would ask the app's WebView to shut down.
  }, { scope: 'worker' }],
});
test.describe.configure({ mode: 'serial' });

const plugin = (page: Page, method: string, arg: object = {}) =>
  page.evaluate(([m, a]) => (window as any).Capacitor.Plugins.InkstoneNative[m](a), [method, arg] as const);

let screen: ScreenMap;

test('the app starts in the native shell with the InkstoneNative plugin', async ({ app: { page } }) => {
  const env = await page.evaluate(() => ({
    native: (window as any).Capacitor?.isNativePlatform?.(),
    platform: (window as any).Capacitor?.getPlatform?.(),
    ua: navigator.userAgent,
  }));
  test.info().annotations.push({ type: 'webview', description: env.ua });
  expect(env.native).toBe(true);
  expect(env.platform).toBe('android');
  const caps = await plugin(page, 'capabilities');
  test.info().annotations.push({ type: 'capabilities', description: JSON.stringify(caps) });
  expect(caps.nativeFeel).toBe(true);
  expect(caps.inkTip).toBe(true); // API 29+
  expect(caps.recognition).toBe(true);
  expect(caps.stylusKeys).toBe(true);
  // Emulators have no vibrator: rich haptics must report false rather than throw.
  expect(typeof caps.richHaptics).toBe('boolean');
});

test('library loads with the welcome note', async ({ app: { page } }) => {
  if (!(await page.locator('.library').isVisible())) {
    await page.evaluate(() => { location.hash = ''; });
  }
  await expect(page.locator('.library')).toBeVisible();
  await expect(page.locator('.note-title', { hasText: 'Welcome to Inkstone' })).toBeVisible();
  setSystemDarkMode(false);
  await page.waitForTimeout(1500);
  screencap('library-light');
});

test('create a note and write with synthetic pen events', async ({ app: { page } }) => {
  const btn = page.locator('.new-btn');
  if (await btn.isVisible()) await btn.click();
  else await page.locator('.fab').click();
  await page.waitForFunction(() => !!(window as any).__inkstone?.engine);
  await pen(page, word(120, 160, 160));
  await pen(page, line([120, 240], [420, 242]));
  expect(await strokes(page)).toHaveLength(2);
});

test('scribbling over a word scratches it out', async ({ app: { page } }) => {
  await pen(page, word(120, 330, 150));
  await pen(page, scribble(115, 275, 315, 348, 10));
  await expect(page.locator('.toast')).toContainText('Scratched out 1 stroke');
  expect(await strokes(page)).toHaveLength(2);
});

test('a real stylus stroke (MotionEvents) inks through the WebView and the native paths', async ({ app: { page } }) => {
  screen = await calibrate(page);
  test.info().annotations.push({ type: 'screen map', description: JSON.stringify(screen) });
  await page.evaluate(() => {
    const w = window as any;
    w.__seen = [];
    document.querySelector('.ed-canvas')!.addEventListener('pointerdown', (e: Event) => w.__seen.push((e as PointerEvent).pointerType), { capture: true });
  });
  const before = (await strokes(page)).length;
  const box = (await page.locator('.ed-canvas').boundingBox())!;
  const y = Math.min(box.height - 60, 470);
  stylusSwipe(screen, [140, y], [440, y + 20], 1200);
  await expect.poll(async () => (await strokes(page)).length, { timeout: 60_000 }).toBe(before + 1);
  expect(await page.evaluate(() => (window as any).__seen)).toContain('pen');
  await page.waitForTimeout(1500);
  screencap('editor-light');
});

test('writing feel popover opens and previews natively', async ({ app: { page } }) => {
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /Writing sound & feel/ }).click();
  const pop = page.locator('.feel-pop');
  await expect(pop).toBeVisible();
  await expect(pop.getByText('Writing sound', { exact: true })).toBeVisible();
  // The sample stroke the panel plays when a setting changes: on Android it is the native synth
  // (InkstoneNative.feelPreview), which opens the writing-sound stream.
  await page.evaluate(() => (window as any).__inkstone.engine.feel.preview());
  await page.waitForTimeout(800);
  screencap('feel-popover-light');
  await page.keyboard.press('Escape');
  await expect(pop).toBeHidden();
});

test('haptics and ink tip calls resolve on a device without a vibrator', async ({ app: { page } }) => {
  await plugin(page, 'grain', { intensity: 1 });
  await plugin(page, 'confirm');
  const tip = await plugin(page, 'inkTipPrepare', { active: true });
  expect(tip.supported).toBe(true);
});

test('dark theme follows the system', async ({ app: { page } }) => {
  setSystemDarkMode(true);
  await expect.poll(() => page.evaluate(() => matchMedia('(prefers-color-scheme: dark)').matches), { timeout: 60_000 }).toBe(true);
  await page.waitForTimeout(1500);
  screencap('editor-dark');
  await page.getByRole('button', { name: 'Back to library' }).click();
  await expect(page.locator('.library')).toBeVisible();
  await page.waitForTimeout(1000);
  screencap('library-dark');
  setSystemDarkMode(false);
});

test('importing a PDF makes annotatable pages', async ({ app: { page } }) => {
  const pdf = await PDFDocument.create();
  for (let i = 0; i < 2; i++) pdf.addPage([612, 792]).drawText(`Slide ${i + 1}`, { x: 72, y: 700, size: 32 });
  const bytes = await pdf.save();
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Lecture slides.pdf', mimeType: 'application/pdf', buffer: Buffer.from(bytes) });
  await page.waitForFunction(() => (window as any).__inkstone?.doc?.pageCount === 2, null, { timeout: 180_000 });
  await expect(page.locator('.ed-title-text')).toHaveText('Lecture slides');
  await pen(page, word(120, 200, 160));
  expect(await strokes(page)).toHaveLength(1);
  await page.waitForTimeout(2000);
  screencap('pdf-light');
  await page.getByRole('button', { name: 'Back to library' }).click();
});

test('settings open', async ({ app: { page } }) => {
  await expect(page.locator('.library')).toBeVisible();
  if (await page.getByRole('button', { name: 'Settings' }).isVisible()) await page.getByRole('button', { name: 'Settings' }).click();
  else { await page.getByRole('button', { name: 'Menu' }).click(); await page.getByRole('button', { name: 'Settings' }).click(); }
  await expect(page.locator('.settings')).toBeVisible();
  await page.waitForTimeout(1000);
  screencap('settings-light');
});

test('logcat: native feel and ink tip ran, nothing crashed', async () => {
  const log = logcat();
  // The writing-sound stream opened (WritingSoundOutput logs its configuration once per open).
  expect(log).toMatch(/InkstoneFeel.*Writing sound: \d+ Hz/);
  expect(log).not.toMatch(/Ink tip overlay failed/);
  expect(log).not.toMatch(/Process: app\.inkstone, PID|ANR in app\.inkstone|Fatal signal.*\(app\.inkstone\)/);
});
