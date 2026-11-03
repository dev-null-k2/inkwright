import { expect, test, type Page } from '@playwright/test';
import { newNote } from './helpers.ts';

/**
 * The first-run welcome: four calm steps (how you write, colours, AI, sync), skippable, and never
 * shown again once finished or skipped. These tests start with a fresh device (no settings).
 */
test.use({ storageState: { cookies: [], origins: [] } });

const settings = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('inkwright.settings.v1') ?? '{}'));

async function open(page: Page) {
  await page.goto('/?e2e');
  await expect(page.getByRole('dialog', { name: 'How do you write?' })).toBeVisible();
}

test('a first run walks through four steps; the choices stick and it never shows again', async ({ page }) => {
  await open(page);
  const welcome = page.locator('.welcome');
  await expect(welcome.getByText('Welcome to Inkwright')).toBeVisible();
  await expect(welcome.getByRole('heading', { name: 'How do you write?' })).toBeFocused();

  // 1 · Finger, left hand.
  await welcome.getByRole('radio', { name: /With my finger/ }).click();
  await welcome.getByRole('radio', { name: 'Left' }).click();
  await welcome.getByRole('button', { name: 'Next' }).click();

  // 2 · Colours, applied at once.
  await expect(welcome.getByRole('heading', { name: 'Choose your colours' })).toBeVisible();
  await welcome.getByRole('radio', { name: /Aizome/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-palette', 'aizome');
  await welcome.getByRole('radio', { name: 'Night' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // Back keeps what was chosen.
  await welcome.getByRole('button', { name: 'Back' }).click();
  await expect(welcome.getByRole('radio', { name: /With my finger/ })).toHaveAttribute('aria-checked', 'true');
  await welcome.getByRole('button', { name: 'Next' }).click();
  await welcome.getByRole('button', { name: 'Next' }).click();

  // 3 · AI: on this device is the default; choose none.
  await expect(welcome.getByRole('heading', { name: 'Where should AI run?' })).toBeVisible();
  await expect(welcome.getByRole('radio', { name: /On this device/ })).toHaveAttribute('aria-checked', 'true');
  await welcome.getByRole('radio', { name: /No AI/ }).click();
  await welcome.getByRole('button', { name: 'Next' }).click();

  // 4 · Sync later, with the sample notebooks.
  await expect(welcome.getByRole('heading', { name: 'Keep your notes in sync' })).toBeVisible();
  await expect(welcome.getByRole('switch', { name: /Start with sample notebooks/ })).toBeChecked();
  await welcome.getByRole('button', { name: 'Start writing' }).click();
  await expect(welcome).toHaveCount(0);
  await expect(page.locator('.library')).toBeVisible();
  await expect(page.locator('.nav-item', { hasText: 'Signals & Systems' })).toBeVisible();

  const s = await settings(page);
  expect(s.onboardingDone).toBe(true);
  expect(s.input.fingerAction).toBe('draw');
  expect(s.hand).toBe('left');
  expect(s.palette).toBe('aizome');
  // "No AI": the assistant is switched off, so the editor has no AI button.
  await newNote(page);
  await expect(page.locator('.ai-btn')).toHaveCount(0);

  await page.reload();
  await expect(page.locator('.library, .editor').first()).toBeVisible();
  await expect(page.locator('.welcome')).toHaveCount(0);
});

test('skip ends it at once, for good', async ({ page }) => {
  await open(page);
  await page.locator('.welcome').getByRole('button', { name: 'Skip' }).click();
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(page.locator('.library')).toBeVisible();
  expect((await settings(page)).onboardingDone).toBe(true);
  await page.reload();
  await expect(page.locator('.library')).toBeVisible();
  await expect(page.locator('.welcome')).toHaveCount(0);
});

test('Google sync without a client ID explains instead of failing; other ways to sync are offered', async ({ page }) => {
  await open(page);
  const welcome = page.locator('.welcome');
  for (let i = 0; i < 3; i++) await welcome.getByRole('button', { name: 'Next' }).click();
  await expect(welcome.getByRole('button', { name: /WebDAV/ })).toBeVisible();
  await expect(welcome.getByRole('button', { name: /Pair with another device/ })).toBeVisible();
  await welcome.getByRole('button', { name: /Google Drive/ }).click();
  const help = page.getByRole('dialog', { name: "Google sign-in isn't set up in this build" });
  await expect(help).toBeVisible();
  await help.getByRole('button', { name: 'Close' }).click();
  await expect(help).toHaveCount(0);
  // The welcome is still there; "Pair with another device" finishes it and opens pairing.
  await welcome.locator('.row-switch', { hasText: 'Start with sample notebooks' }).click();
  await expect(welcome.getByRole('switch', { name: /Start with sample notebooks/ })).not.toBeChecked();
  await welcome.getByRole('button', { name: /Pair with another device/ }).click();
  await expect(page.locator('.welcome')).toHaveCount(0);
  await expect(page.getByRole('tab', { name: 'Devices & sharing', selected: true })).toBeVisible();
});

test('a link into a note or Settings is honoured; the welcome waits for the library', async ({ page }) => {
  await page.goto('/?e2e#settings/about');
  await expect(page.locator('.settings')).toBeVisible();
  await expect(page.locator('.welcome')).toHaveCount(0);
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'How do you write?' })).toBeVisible();
});
