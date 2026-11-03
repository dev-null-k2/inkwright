import { expect, test, type Browser, type Page } from '@playwright/test';
import { editorMenu, modKey, newNote, openApp, pen, pointer, word } from './helpers.ts';
import { startMailbox, startNtfy, type LocalRelay } from './relay.ts';

/**
 * Two devices in one test: two browser contexts (separate storage, separate identity keys) in the
 * same Chromium, connected by real WebRTC data channels.
 *
 * Short codes meet through a relay the test runs on 127.0.0.1 — an ntfy-compatible server (what
 * ntfy.sh speaks) or the real `inkwright-mcp --signal-token` mailbox — so nothing here contacts a
 * public service, and the test can read everything the relay saw. The long codes under Advanced
 * need no relay: the test carries them from page to page, as a person would.
 *
 * STUN is cleared so the devices use host candidates only (a LAN-only setup), and Chromium is
 * told not to hide local addresses behind mDNS names, which two contexts of a headless browser
 * can't resolve for each other.
 */
// Chromium only: two contexts talking over real WebRTC with host candidates needs a Chromium flag; WebKit/Firefox WebRTC is covered by the unit tests' in-memory link.
test.skip(({ browserName }) => browserName !== 'chromium', 'Chromium-only launch flags');

test.use({ launchOptions: { args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] } });
test.describe.configure({ mode: 'serial' });
test.setTimeout(120_000);

const RELAY_TOKEN = 'e2e-relay-token-0123456789';

interface Relays { ntfy?: string; mailbox?: string }

async function device(browser: Browser, name: string, relays: Relays = {}): Promise<Page> {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
  const page = await ctx.newPage();
  // Errors shown as toasts disappear after a few seconds; keep them in the test's output.
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log(`[${name}] ${m.text()}`); });
  await openApp(page);
  // Name the device (Settings › Authorship).
  await page.evaluate((name) => {
    const s = JSON.parse(localStorage.getItem('inkwright.settings.v1') ?? '{}');
    localStorage.setItem('inkwright.settings.v1', JSON.stringify({ ...s, authorship: { ...s.authorship, deviceName: name } }));
  }, name);
  await page.reload();
  await expect(page.locator('.library')).toBeVisible();
  await openDevices(page);
  // No STUN server (LAN only), and the test's relay, set the way a person would.
  const stun = page.getByLabel(/STUN servers/);
  await stun.fill('');
  await expect(stun).toHaveValue('');
  if (relays.ntfy) await page.getByLabel(/Relay for short codes/).fill(relays.ntfy);
  if (relays.mailbox) {
    await page.getByLabel('Signalling server (optional)').fill(relays.mailbox);
    const token = page.getByLabel('Signalling token');
    await token.fill(RELAY_TOKEN);
    await token.blur();
  }
  return page;
}

async function openDevices(page: Page) {
  await page.goto('/?e2e#settings/devices');
  await expect(page.getByRole('heading', { name: 'Pair and join' })).toBeVisible();
}

/** The short code a host page is showing. */
async function shownCode(page: Page): Promise<string> {
  const code = page.locator('.code-big');
  await expect(code).toBeVisible({ timeout: 15_000 });
  return (await code.getAttribute('data-code'))!;
}

/** Types a code into the join sheet (opening it from Settings), lower case with a dash, as people do. */
async function typeCode(page: Page, code: string) {
  if (!(await page.getByRole('dialog', { name: 'Join with a code' }).isVisible())) {
    await openDevices(page);
    await page.getByRole('button', { name: 'Join with a code' }).click();
  }
  await page.getByRole('dialog', { name: 'Join with a code' }).getByLabel('Code').fill(`${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase());
}

interface StrokeView { id: string; author: string | null; n: number }

const doc = (page: Page): Promise<StrokeView[]> => page.evaluate(() => {
  const d = (window as any).__inkwright.doc;
  return d.page(0).strokes.map((s: any) => ({ id: s.id, author: s.author?.name ?? null, n: s.points.length }));
});

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

/** Starts a note on the host with one stroke and opens the share sheet. */
async function shareNote(page: Page, title: string, permission: 'Can write' | 'Can view' = 'Can write') {
  await home(page);
  await newNote(page);
  await pen(page, word(180, 160, 200));
  await rename(page, title);
  await editorMenu(page, 'Share & export', 'Share live');
  const sheet = page.getByRole('dialog', { name: 'Share this note live' });
  await expect(sheet).toBeVisible();
  if (permission === 'Can view') await sheet.getByRole('radio', { name: 'Can view' }).click();
  return shownCode(page);
}

/**
 * Everything a relay received, decoded as far as a relay could: the raw text and every base64
 * field inside it. None of it may contain anything readable about the people or the note.
 */
function relayView(relay: LocalRelay): string {
  const decode = (s: string) => {
    try {
      return Buffer.from(s, 'base64url').toString('utf8');
    } catch {
      return '';
    }
  };
  return relay.posted.map((raw) => {
    const out = [raw];
    try {
      const env = JSON.parse(raw) as { d?: string };
      if (env.d) {
        out.push(decode(env.d));
        try {
          for (const v of Object.values(JSON.parse(env.d) as Record<string, unknown>)) if (typeof v === 'string') out.push(decode(v));
        } catch { /* not JSON: a fragment or a claim */ }
      }
    } catch { /* not ours */ }
    return out.join('\n');
  }).join('\n');
}

let relays: LocalRelay[] = [];
test.afterEach(async () => {
  await Promise.all(relays.map((r) => r.close()));
  relays = [];
});

test('two people share a note with one short code typed one way; strokes appear live; the relay sees no plaintext', async ({ browser }) => {
  const relay = await startNtfy();
  relays.push(relay);
  const a = await device(browser, 'Ada', { ntfy: relay.url });
  const b = await device(browser, 'Grace', { ntfy: relay.url });
  const TITLE = 'Lighthouse budget, confidential';

  // Ada: ••• › Share & export › Share live shows a short code (and its QR code and link) at once.
  const code = await shareNote(a, TITLE);
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  await expect(a.locator('.code-card .peer-qr')).toBeVisible();
  await expect(a.getByRole('button', { name: 'Send link' })).toBeVisible();
  // No long strings anywhere in the sheet.
  await expect(a.getByRole('dialog', { name: 'Share this note live' }).locator('textarea:visible')).toHaveCount(0);

  // Grace types it — and she's in, with no code back.
  await typeCode(b, code);
  await expect(a.locator('.share-sheet').getByText('Grace joined.')).toBeVisible({ timeout: 30_000 });
  await expect(a.locator('.live-people')).toContainText('Grace');
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
  await expect(a.locator('.live-ink path')).toHaveCount(0);

  // What the relay saw: hashed room names and sealed blobs — no code, title, names, keys or SDP.
  const seen = relayView(relay);
  expect(relay.posted.length).toBeGreaterThanOrEqual(3);
  for (const secret of [code, code.slice(3), `${code.slice(0, 4)}-${code.slice(4)}`, TITLE, 'Lighthouse', 'Ada', 'Grace', 'a=fingerprint', 'candidate', 'v=0', 'ink1:', 'ink0:']) {
    expect(seen, `the relay saw “${secret}”`).not.toContain(secret);
  }
});

test('a view-only guest joins from a link and can’t change the note', async ({ browser }) => {
  const relay = await startNtfy();
  relays.push(relay);
  const a = await device(browser, 'Ada', { ntfy: relay.url });
  // Grace has no relay set: the link names Ada's, for this join only.
  const b = await device(browser, 'Grace');
  const code = await shareNote(a, 'Read-only minutes', 'Can view');

  // Grace opens the link Ada sent (what "Send link" shares): the join sheet opens with the code.
  await b.goto(`/?e2e#join=${code.slice(0, 4)}-${code.slice(4)}&ntfy=${encodeURIComponent(relay.url)}`);
  const sheet = b.getByRole('dialog', { name: 'Join with a code' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByLabel('Code')).toHaveValue(`${code.slice(0, 4)}-${code.slice(4)}`);
  await sheet.getByRole('button', { name: 'Join', exact: true }).click();
  await expect(a.locator('.share-sheet').getByText('Grace joined.')).toBeVisible({ timeout: 30_000 });
  await expect(a.locator('.live-people')).toContainText('can view');
  await a.getByRole('button', { name: 'Done' }).click();
  await b.waitForFunction(() => (window as any).__inkwright?.doc?.page(0).strokes.length === 1, null, { timeout: 30_000 });
  await expect(b.locator('.live-pill')).toContainText('view only');

  // Ada's writing reaches Grace…
  await pen(a, word(160, 260, 140));
  await expect.poll(async () => (await doc(b)).length, { timeout: 15_000 }).toBe(2);
  // …but what Grace tries to write never reaches Ada, and her own page goes back to Ada's.
  await pen(b, word(420, 320, 140));
  await b.waitForTimeout(1500);
  expect(await doc(a)).toHaveLength(2);
  await expect.poll(async () => (await doc(b)).map((s) => s.id).join(), { timeout: 10_000 }).toBe((await doc(a)).map((s) => s.id).join());
});

test('pair two devices with a short code through the self-hosted relay, then Sync now just works', async ({ browser }) => {
  const relay = await startMailbox(RELAY_TOKEN);
  relays.push(relay);
  const a = await device(browser, 'Laptop', { mailbox: relay.url });
  const b = await device(browser, 'Tablet', { mailbox: relay.url });

  await a.getByRole('button', { name: 'Pair a device' }).click();
  const code = await shownCode(a);
  await typeCode(b, code);
  // Pairing grants a whole vault, so the joining device asks first.
  await expect(b.getByText('Pair with “Laptop”?')).toBeVisible({ timeout: 30_000 });
  await b.getByRole('button', { name: 'Pair', exact: true }).click();
  await expect(a.getByText(/Paired with “Tablet”/)).toBeVisible({ timeout: 30_000 });
  await expect(b.getByText(/Paired with “Laptop”/)).toBeVisible({ timeout: 30_000 });
  // Both screens show the same six digits.
  const sas = async (p: Page) => (await p.getByText(/Both screens show/).textContent())!.match(/(\d{3} \d{3})/)![1];
  expect(await sas(a)).toBe(await sas(b));
  await a.getByRole('button', { name: 'Done' }).click();
  await b.getByRole('button', { name: 'Done' }).click();
  await expect(a.locator('.peer-device', { hasText: 'Tablet' })).toBeVisible();
  await expect(b.locator('.peer-device', { hasText: 'Laptop' })).toBeVisible();
  expect(relay.posted.join('\n')).not.toContain('Laptop');

  // A writes a note; with the relay set, Sync now reaches the tablet on its own.
  await home(a);
  await newNote(a);
  await pen(a, word(200, 220, 200));
  const title = 'Field notes from the laptop';
  await rename(a, title);
  await a.keyboard.press(`${await modKey(a)}+s`);
  await openDevices(a);
  await openDevices(b);
  await a.locator('.peer-device', { hasText: 'Tablet' }).getByRole('button', { name: 'Sync now' }).click();
  await expect(a.locator('.peer-status').last()).toHaveText(/Synced with|Up to date with/, { timeout: 30_000 });
  await openNote(b, title);
  expect(await doc(b)).toHaveLength(1);
});

test('advanced: two devices still pair with long codes and no relay at all', async ({ browser }) => {
  const a = await device(browser, 'Laptop');
  const b = await device(browser, 'Tablet');
  // Without a relay the short-code buttons say why they're off, and the long codes are one tap away.
  await expect(a.getByRole('button', { name: 'Pair a device' })).toBeDisabled();
  for (const p of [a, b]) await p.getByText('Advanced: connect without a relay (long codes)').click();
  await a.getByRole('button', { name: 'Pair a new device' }).click();
  const offer = await a.getByLabel('Connection code (text)').inputValue();
  expect(offer).toMatch(/^ink[01]:/);
  const enter = async (page: Page, label: RegExp, code: string) => {
    const field = page.locator('.peer-read', { has: page.getByLabel(label) });
    await field.getByLabel(label).fill(code);
    await field.getByRole('button', { name: 'Continue' }).click();
  };
  await enter(b, /Code from another device/, offer);
  await b.getByRole('button', { name: 'Pair', exact: true }).click();
  await enter(a, /Then enter the code it shows/, await b.getByLabel('Answer code (text)').inputValue());
  await expect(a.getByText(/Paired with “Tablet”/)).toBeVisible({ timeout: 30_000 });
  await expect(b.getByText(/Paired with “Laptop”/)).toBeVisible({ timeout: 30_000 });
});

test('the share and join sheets fit the Razr Fold’s inner screen between the system bars', async ({ browser }) => {
  const relay = await startNtfy();
  relays.push(relay);
  const insets = { top: 32, bottom: 24 };
  const ctx = await browser.newContext({ viewport: { width: 720, height: 800 }, hasTouch: true });
  const page = await ctx.newPage();
  // What Capacitor's SystemBars plugin reports on the device (as in fit.spec.ts).
  await page.addInitScript((v) => {
    const set = () => {
      document.documentElement.style.setProperty('--safe-area-inset-top', `${v.top}px`);
      document.documentElement.style.setProperty('--safe-area-inset-bottom', `${v.bottom}px`);
    };
    if (document.documentElement) set();
    document.addEventListener('DOMContentLoaded', set);
  }, insets);
  await openApp(page);
  await openDevices(page);
  await page.getByLabel(/Relay for short codes/).fill(relay.url);
  const fits = async (label: string) => {
    const box = (await page.getByRole('dialog').boundingBox())!;
    expect(box.y, `${label}: under the status bar`).toBeGreaterThanOrEqual(insets.top - 1);
    expect(box.y + box.height, `${label}: above the gesture bar`).toBeLessThanOrEqual(800 - insets.bottom + 1);
    expect(box.x + box.width, `${label}: inside the screen`).toBeLessThanOrEqual(721);
  };
  await shareNote(page, 'Fold check');
  // The code, its QR code, Send link and the permission are all on screen at once.
  for (const l of [page.locator('.code-big'), page.locator('.code-card .peer-qr'), page.getByRole('button', { name: 'Send link' }), page.getByRole('radio', { name: 'Can view' })]) await expect(l).toBeInViewport();
  await fits('share sheet');
  await page.screenshot({ path: test.info().outputPath('share-sheet-720x800.png') });
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(page.locator('.live-pill')).toContainText('Waiting for someone to join');
  await page.goto('/?e2e');
  await expect(page.locator('.library')).toBeVisible();
  await page.evaluate(() => (location.hash = 'join=K7PM-2Q9X'));
  await expect(page.getByRole('dialog', { name: 'Join with a code' })).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Code')).toHaveValue('K7PM-2Q9X');
  await fits('join sheet');
  await page.screenshot({ path: test.info().outputPath('join-sheet-720x800.png') });
  await ctx.close();
});
