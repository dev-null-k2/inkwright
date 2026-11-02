import { expect, test } from '@playwright/test';
import { openApp, settingsGroup } from './helpers.ts';
import { GROUPS, SECTION_LABELS, SETTINGS_INDEX, type SectionId } from '../src/settings/groups.ts';

/**
 * Settings: eight groups with tabs, a search field that jumps to any setting, and links from
 * before the regrouping (#settings/<old id>) that still land in the right place.
 */

/** Every section id Settings had before it was grouped. */
const OLD_IDS: SectionId[] = ['writing', 'input', 'handwriting', 'ai', 'sync', 'devices', 'agents', 'authorship', 'appearance', 'knowledge', 'ink-actions', 'reading', 'modules', 'plugins', 'code', 'about'];

test('the search field finds a setting by name or by the words people use, and jumps to it', async ({ page }) => {
  await openApp(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const search = page.getByRole('searchbox', { name: 'Search settings' });

  // By name: Enter takes the first result, opens Writing › Pen & touch and focuses the switch.
  await search.fill('scribble');
  await expect(page.getByRole('button', { name: /^Scribble to erase/ })).toContainText('Writing › Pen & touch');
  await search.press('Enter');
  await expect(page.getByRole('tab', { name: 'Pen & touch', selected: true })).toBeVisible();
  const row = page.locator('.row-switch', { hasText: 'Scribble to erase' });
  await expect(row).toBeInViewport();
  await expect(row.getByRole('switch')).toBeFocused();

  // By what people call it: "dark mode" is the theme.
  await search.fill('dark mode');
  await page.getByRole('button', { name: /^Theme/ }).click();
  await expect(page.getByRole('tab', { name: 'Theme & paper', selected: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Theme', exact: true })).toBeInViewport();

  // From the keyboard: ↓ moves into the results; nothing found says so plainly.
  await search.fill('backup');
  await search.press('ArrowDown');
  await expect(page.getByRole('button', { name: /^Backup/ })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { name: 'Sync & backup', selected: true })).toBeVisible();
  await search.fill('zebra crossing');
  await expect(page.locator('.set-search-empty')).toContainText('No setting matches');
  await search.press('Escape');
  await expect(search).toHaveValue('');
});

test('links to the old sections open inside their group', async ({ page }) => {
  await openApp(page);
  for (const id of OLD_IDS) {
    await page.goto(`/?e2e#settings/${id}`);
    const group = GROUPS.find((g) => g.sections.includes(id))!;
    await expect(page.locator('.set-page-title'), id).toHaveText(group.label);
    if (group.sections.length > 1) await expect(page.getByRole('tab', { name: SECTION_LABELS[id], selected: true }), id).toBeVisible();
  }
  // Group ids work as links too.
  await page.goto('/?e2e#settings/privacy');
  await expect(page.getByRole('tab', { name: 'AI privacy', selected: true })).toBeVisible();
});

test('every indexed setting is on the page the index points to', async ({ page }) => {
  test.setTimeout(90_000);
  await openApp(page);
  const sections = [...new Set(SETTINGS_INDEX.map((e) => e.section))];
  const missing: string[] = [];
  for (const section of sections) {
    await page.goto(`/?e2e#settings/${section}`);
    await expect(page.locator('.set-main')).toBeVisible();
    // A section a default-off module owns (Developer) is not shown; its entries are not searched either.
    if (GROUPS.find((g) => g.sections.includes(section))!.sections.length > 1 && !(await page.getByRole('tab', { name: SECTION_LABELS[section], selected: true }).count())) continue;
    // A browser on a computer: no Android app; folder access where the browser has it.
    const folderAccess = await page.evaluate(() => 'showDirectoryPicker' in window);
    for (const e of SETTINGS_INDEX.filter((x) => x.section === section && !x.optional && (x.requires === 'folder-access' ? folderAccess : !x.requires))) {
      const text = e.target ?? e.label;
      const found = await page.locator('.set-main').evaluate(async (root, text) => {
        for (let i = 0; i < 30; i++) {
          const hit = [...root.querySelectorAll('h2, h3, .row-label, .field-label, button')].some((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim() === text);
          if (hit) return true;
          await new Promise((r) => setTimeout(r, 50));
        }
        return false;
      }, text);
      if (!found) missing.push(`${section}: “${text}”`);
    }
  }
  expect(missing).toEqual([]);
});

test('on a phone: the group list with what is inside, a group full screen, Back to the list', async ({ page }) => {
  await page.setViewportSize({ width: 412, height: 860 });
  await openApp(page);
  await page.goto('/?e2e#settings');
  const groups = page.getByRole('navigation', { name: 'Settings groups' });
  await expect(groups.getByRole('button')).toHaveCount(GROUPS.length);
  await expect(groups.getByRole('button', { name: /^Writing/ })).toContainText('Feel, pen and touch, handwriting');
  await settingsGroup(page, 'Privacy & trust', 'Authorship');
  await expect(page.locator('.set-top h1')).toHaveText('Privacy & trust');
  await expect(page.getByRole('heading', { name: 'Verify a certificate' })).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(groups).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search settings' })).toBeVisible();
});
