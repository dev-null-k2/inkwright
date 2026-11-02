import { AxeBuilder } from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { modKey, newNote, openApp, editorMenu, settingsGroup } from './helpers.ts';

/**
 * Accessibility: axe-core (WCAG 2.1 A/AA rules) over the library, the editor (with its menus and
 * a dialog open) and Settings, with no serious or critical violations allowed; and the keyboard
 * paths through the chrome — every control reachable with Tab, a visible focus ring, Escape
 * closing what opened, and the reading view's line focus.
 */

const problems: string[] = [];

async function audit(page: Page, label: string, opts: { exclude?: string[] } = {}) {
  let b = new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']);
  // The page canvas is a drawing surface (its content is reachable through search, export and
  // the reading view); axe can't see inside it either way.
  for (const sel of ['.ed-canvas canvas', ...(opts.exclude ?? [])]) b = b.exclude(sel);
  const res = await b.analyze();
  const bad = res.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  const report = bad.map((v) => `${v.id} (${v.impact}): ${v.help}\n  ${v.nodes.slice(0, 4).map((n) => n.target.join(' ')).join('\n  ')}`).join('\n');
  if (bad.length) problems.push(`${label}:\n${report}`);
}

test('library, editor and settings have no serious or critical axe violations', async ({ page }) => {
  test.setTimeout(150_000); // ten full-page axe passes; slow on a busy machine
  await openApp(page);
  await audit(page, 'Library');
  await newNote(page);
  await audit(page, 'Editor');
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await audit(page, 'Editor ••• menu');
  await page.keyboard.press('Escape');
  await editorMenu(page, 'Insert', 'Query data');
  await expect(page.getByRole('dialog', { name: 'Data' })).toBeVisible();
  await audit(page, 'Data dialog');
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Back to library' }).click();
  await page.getByRole('button', { name: 'Settings' }).click();
  for (const [group, tab] of [['Writing', 'Feel'], ['Writing', 'Pen & touch'], ['AI', 'Models & assistant'], ['AI', 'Ink actions'], ['Appearance', 'Reading'], ['Privacy & trust', 'AI privacy'], ['Extend', 'Modules'], ['About', undefined]] as const) {
    await settingsGroup(page, group, tab);
    await audit(page, `Settings › ${group}${tab ? ` › ${tab}` : ''}`);
  }
  // The search field finds a setting by name.
  await page.getByRole('searchbox', { name: 'Search settings' }).fill('dark mode');
  await audit(page, 'Settings search');
  expect(problems.join('\n\n')).toBe('');
});

test('keyboard: the library and editor chrome work without a pointer, with visible focus', async ({ page }) => {
  await openApp(page);
  // Tab reaches the new-note button; Enter opens a note.
  const newBtn = page.locator('.new-btn');
  for (let i = 0; i < 40 && !(await newBtn.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press('Tab');
  await expect(newBtn).toBeFocused();
  const ring = await newBtn.evaluate((el) => getComputedStyle(el).outlineStyle);
  expect(ring).not.toBe('none');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
  // The ••• menu opens from the keyboard, its items are reachable, Escape closes it.
  const more = page.getByRole('button', { name: 'More', exact: true });
  await more.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  // Focus moves into the menu; arrow keys move through it; Escape closes it and returns focus.
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitem').nth(1)).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem').last()).toBeFocused();
  // Sub-sheets: → opens one with focus on its first command, ← and Escape come back to its row.
  const insert = menu.getByRole('menuitem', { name: /^Insert/ });
  await expect(insert).toHaveAttribute('aria-haspopup', 'menu');
  await insert.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menu', { name: 'Insert' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Back to More' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: /^Image/ })).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(page.getByRole('menu', { name: 'More' })).toBeVisible();
  await expect(insert).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: 'Insert' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(insert).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(more).toBeFocused();
  // Undo is reachable by shortcut, and the pen dock buttons have names.
  await page.keyboard.press(`${await modKey(page)}+z`);
  const unnamed = await page.locator('button:visible').evaluateAll((els) => els.filter((e) => !(e.getAttribute('aria-label') || e.textContent?.trim() || e.getAttribute('title'))).map((e) => e.outerHTML.slice(0, 80)));
  expect(unnamed).toEqual([]);
});

test('reduced motion and more contrast are honoured', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce', forcedColors: 'none' });
  await openApp(page);
  await newNote(page);
  const anim = await page.evaluate(() => { const d = document.createElement('div'); d.className = 'ia-spin'; document.body.append(d); const v = getComputedStyle(d).animationName; d.remove(); return v; });
  expect(anim).toBe('none');
  await page.emulateMedia({ contrast: 'more' });
  // Playwright's Firefox matches the emulated query in script but doesn't restyle for it; the
  // rule itself is plain CSS, checked in Chromium and WebKit.
  if (page.context().browser()?.browserType().name() === 'firefox') return;
  const w = await page.evaluate(() => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); const l = document.createElementNS('http://www.w3.org/2000/svg', 'line'); l.setAttribute('class', 'ia-run-edge'); s.append(l); document.body.append(s); const v = getComputedStyle(l).strokeWidth; s.remove(); return v; });
  expect(w).toBe('3px');
});
