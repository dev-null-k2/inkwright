import { expect, test, type Browser, type Page } from '@playwright/test';
import { modKey, newNote, openApp, pen, pointer, word } from './helpers.ts';

/**
 * Two devices in one test: two browser contexts (separate storage, separate identity keys) in
 * the same Chromium, connected by real WebRTC data channels. The "signalling" is this test:
 * it carries each code from one page to the other, exactly as a person would with QR codes or
 * copy and paste — no server is involved. STUN is cleared so the devices use host candidates
 * only (a LAN-only setup), and Chromium is told not to hide local addresses behind mDNS names,
 * which two contexts of a headless browser can't resolve for each other.
 */
// Chromium only: two contexts talking over real WebRTC with host candidates needs a Chromium flag; WebKit/Firefox WebRTC is covered by the unit tests' in-memory link.
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only launch flags');

test.use({ launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } });
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

async function device(browser: Browser, name: string): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  // Errors shown as toasts disappear after a few seconds; keep them in the test's output.
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name}] ${m.text()}`); });
  await openApp(page);
  // Name the device (Settings › Authorship) and use no STUN server (LAN only).
  await page.evaluate((name) => {
    const s = JSON.parse(localStorage.getItem('inkwright.settings.v1') ?? '{}');
    localStorage.setItem('inkwright.settings.v1', JSON.stringify({ ...s, authorship: { ...s.authorship, deviceName: name } }));
  }, name);
  await page.reload();
  await expect(page.locator('.library')).toBeVisible();
  await openDevices(page);
  const stun = page.getByLabel(/STUN servers/);
  await stun.fill('');
  await expect(stun).toHaveValue('');
  return page;
}

async function openDevices(page: Page) {
  await page.goto('/?e2e#settings/devices');
  await expect(page.getByRole('heading', { name: 'Pair, sync and join' })).toBeVisible();
}

const codeText = (page: Page, label: string) => page.getByLabel(`${label} (text)`).inputValue();

/** Enters a code into the first visible "enter a code" field and continues. */
async function enter(page: Page, label: RegExp, code: string) {
  const field = page.locator('.peer-read', { has: page.getByLabel(label) });
  await field.getByLabel(label).fill(code);
  await field.getByRole('button', { name: 'Continue' }).click();
}

interface StrokeView { id: string; author: string | null; n: number }

const doc = (page: Page): Promise<StrokeView[]> => page.evaluate(() => {
  const d = (window as any).__inkwright.doc;
  return d.page(0).strokes.map((s: any) => ({ id: s.id, author: s.author?.name ?? null, n: s.points.length }));
});

/** Pairs A and B: A shows a code, B answers, A completes. */
async function pair(a: Page, b: Page) {
  await a.getByRole('button', { name: 'Pair a new device' }).click();
  const offer = await codeText(a, 'Connection code');
  expect(offer).toMatch(/^ink[01]:/);
  await enter(b, /Code from another device/, offer);
  await b.getByRole('button', { name: 'Pair', exact: true }).click();
  const answer = await codeText(b, 'Answer code');
  await enter(a, /Then enter the code it shows/, answer);
  await expect(a.getByText(/Paired with “Tablet”/)).toBeVisible({ timeout: 30_000 });
  await expect(b.getByText(/Paired with “Laptop”/)).toBeVisible({ timeout: 30_000 });
  await a.getByRole('button', { name: 'Done' }).click();
  await b.getByRole('button', { name: 'Done' }).click();
}

/** `from` starts a sync with `to` (manual codes both ways) and waits for it to finish. */
async function sync(from: Page, to: Page, toName: string) {
  await openDevices(from);
  await openDevices(to);
  const row = from.locator('.peer-device', { hasText: toName });
  await row.getByRole('button', { name: 'Sync now' }).click();
  const code = await codeText(from, 'Sync code');
  await enter(to, /Code from another device/, code);
  const answer = await codeText(to, 'Answer code');
  await enter(from, /Then enter the code it shows/, answer);
  await expect(from.locator('.peer-status').last()).toHaveText(/Synced with|Up to date with/, { timeout: 30_000 });
}

/** Back to the library (a full reload from the settings URL), ready for clicks. */
async function home(page: Page) {
  await page.goto('/?e2e');
  await expect(page.locator('.library')).toBeVisible();
}

async function openNote(page: Page, title: string) {
  await home(page);
  await page.getByRole('button', { name: `Open ${title}` }).click();
  await page.waitForFunction((t) => (window as any).__inkwright?.doc?.meta.title === t, title);
}

async function rename(page: Page, title: string) {
  await page.locator('.ed-title').click();
  await page.getByLabel('Title').fill(title);
  await page.getByRole('button', { name: 'Rename' }).click();
  await expect(page.locator('.ed-title-text')).toHaveText(title);
}

test('two devices pair by code and sync a note both ways over WebRTC, with no server', async ({ browser }) => {
  const a = await device(browser, 'Laptop');
  const b = await device(browser, 'Tablet');
  await pair(a, b);
  // Both remember each other by key.
  await expect(a.locator('.peer-device', { hasText: 'Tablet' })).toBeVisible();
  await expect(b.locator('.peer-device', { hasText: 'Laptop' })).toBeVisible();

  // A writes a note.
  await home(a);
  await newNote(a);
  await pen(a, word(200, 220, 200));
  await pen(a, word(200, 280, 160));
  const written = await doc(a);
  expect(written).toHaveLength(2);
  const title = 'Field notes from the laptop';
  await rename(a, title);
  await a.keyboard.press(`${await modKey(a)}+s`);

  // A syncs with B: the note appears on B.
  await sync(a, b, 'Tablet');
  await openNote(b, title);
  expect((await doc(b)).map((s) => s.id)).toEqual(written.map((s) => s.id));

  // B adds a line; B starts this sync, and the edit comes back to A.
  await pen(b, word(200, 360, 180));
  await b.keyboard.press(`${await modKey(b)}+s`);
  const onB = await doc(b);
  expect(onB).toHaveLength(3);
  await sync(b, a, 'Laptop');
  await openNote(a, title);
  expect((await doc(a)).map((s) => s.id)).toEqual(onB.map((s) => s.id));
  // Synced devices are one person's: no stroke is attributed to a collaborator.
  expect((await doc(a)).every((s) => s.author === null)).toBe(true);
});

test('two people write on one page at the same time and end with identical pages', async ({ browser }) => {
  const a = await device(browser, 'Ada');
  const b = await device(browser, 'Grace');
  await home(a);
  await newNote(a);
  await pen(a, word(180, 160, 200));

  // Ada shares the note live (write permission) from the ••• menu.
  await a.getByRole('button', { name: 'More', exact: true }).click();
  await a.getByRole('menuitem', { name: /Share live/ }).click();
  await a.getByRole('button', { name: 'Make an invite' }).click();
  const invite = await codeText(a, 'Invitation code');

  // Grace joins from Settings › Devices & sharing.
  await enter(b, /Code from another device/, invite);
  await expect(b.getByText(/Ada invites you to write on this note live/)).toBeVisible();
  await b.getByRole('button', { name: 'Join', exact: true }).click();
  const answer = await codeText(b, 'Answer code');
  await enter(a, /Then enter the code their device shows/, answer);
  await expect(a.getByText('Grace joined')).toBeVisible({ timeout: 30_000 });
  await a.getByRole('button', { name: 'Done' }).click();
  // Grace lands in her copy of the note, with Ada's ink.
  await b.waitForFunction(() => (window as any).__inkwright?.doc?.page(0).strokes.length === 1, null, { timeout: 30_000 });
  await expect(b.locator('.live-pill')).toContainText('Live with');

  // A stroke in progress on one side shows on the other before pen-up.
  await pen(b, word(200, 420, 160), { noUp: true });
  await expect(a.locator('.live-ink path')).toHaveCount(1, { timeout: 10_000 });
  await pointer(b, 'pointerup', [360, 420]);

  // Both write at once, several strokes each.
  await Promise.all([
    (async () => { for (let i = 0; i < 4; i++) await pen(a, word(160, 220 + i * 40, 120)); })(),
    (async () => { for (let i = 0; i < 4; i++) await pen(b, word(420, 230 + i * 40, 120)); })(),
  ]);

  // Same strokes in the same order on both pages.
  await expect.poll(async () => {
    const [x, y] = await Promise.all([doc(a), doc(b)]);
    return x.length === 10 && JSON.stringify(x.map((s) => s.id)) === JSON.stringify(y.map((s) => s.id));
  }, { timeout: 20_000 }).toBe(true);

  // Each device knows whose handwriting is whose.
  const onA = await doc(a);
  const onB = await doc(b);
  expect(onA.filter((s) => s.author === 'Grace')).toHaveLength(5);
  expect(onA.filter((s) => s.author === null)).toHaveLength(5);
  expect(onB.filter((s) => s.author === 'Ada')).toHaveLength(5);
  expect(onB.filter((s) => s.author === null)).toHaveLength(5);
  // Live ink is gone once the strokes are committed; the collaborator's cursor is shown by name.
  await expect(a.locator('.live-ink path')).toHaveCount(0);
});
