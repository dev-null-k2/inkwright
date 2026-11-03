import { expect, test, type Locator, type Page } from '@playwright/test';
import { editorMenu, editorMenuCommands, isEngineNoise, line, newNote, openApp, pen } from './helpers.ts';

/**
 * "Click everything": an audit of every screen on the Razr Fold's inner screen (720×800 with its
 * system bars). It opens every menu entry, sheet and dialog it can reach — the library, the
 * editor's top bar, ••• menu and pen dock, the "+" menu, the AI panel, every Settings section, the
 * document editor — and checks that:
 *
 *  - nothing logs an error or throws;
 *  - no button is a dead end: a disabled control says why (a title, a description, or a hint next
 *    to it), and an enabled one changes something when pressed;
 *  - whatever opens fits between the system bars and scrolls when it is long (as e2e/fit.spec.ts).
 *
 * Buttons that leave the app's sandbox (file pickers, downloads, the microphone, sign-in, deleting
 * or resetting things) are pressed only where a dedicated spec covers them, and skipped here.
 */

const INSETS = { top: 32, bottom: 24 };
test.use({ viewport: { width: 720, height: 800 } });
test.describe.configure({ timeout: 240_000 });

/** Labels never pressed in the sweep: they pick files, download, record, sign in, delete, reset, run or leave. */
const SKIP = /^(Image$|Add folder|Back|Back to|Close|Done|Cancel|Skip|Delete|Remove|Reset|Clear|Erase|Revoke|Uninstall|Disconnect|Sign (in|out)|Choose|Pick|Import|Export|Download|Install|Record|Dictate|Start|Stop|Run|Test|Check|Copy|Share|Open|Sync now|Pair|Connect|Save|Send|Ask|Verify|Move to Trash|Delete forever|Restore|Duplicate|Try|Add sample|Upload|Print|Lock|Unlock|Rescan|Scan|Measure|Generate|Compile|Approve|Reject|Undo|Redo|Apply|Use|Retry|Get|Load|Mount|Forget|Rebuild|Re-check|Recheck|Trash|Make|Create|New|Insert|Read aloud|Listen|Play|Pause|Learn more|Help|Show the|Report|Explain)/i;

async function insets(page: Page) {
  await page.addInitScript((v) => {
    const set = () => { const s = document.documentElement.style; s.setProperty('--safe-area-inset-top', `${v.top}px`); s.setProperty('--safe-area-inset-bottom', `${v.bottom}px`); };
    if (document.documentElement) set();
    document.addEventListener('DOMContentLoaded', set);
  }, INSETS);
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() !== 'error' || isEngineNoise(m.text())) return;
    // Requests the sandbox blocks on purpose (no network in tests) are not app errors.
    if (/Failed to load resource|net::ERR_|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED/.test(m.text())) return;
    errors.push(`console: ${m.text()}`);
  });
  return errors;
}

/** Every open overlay sits between the system bars, on screen, and scrolls if it is long. */
async function overlaysFit(page: Page, label: string) {
  const bad = await page.evaluate(({ top, bottom }) => {
    const out: string[] = [];
    const h = innerHeight, w = innerWidth;
    for (const el of document.querySelectorAll<HTMLElement>('.popover, .dialog, [role="dialog"], [role="menu"], .palette')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      if (el.matches('[role="menu"]') && el.parentElement?.closest('.popover, .dialog')) continue;
      const name = `${el.getAttribute('aria-label') ?? el.className}`.slice(0, 60);
      if (r.top <= 0 && r.bottom >= h - 1) {
        const cs = getComputedStyle(el);
        if (parseFloat(cs.paddingTop) < top - 1) out.push(`${name}: full-screen content under the status bar`);
        if (parseFloat(cs.paddingBottom) < bottom - 1) out.push(`${name}: full-screen content under the gesture bar`);
        continue;
      }
      if (r.top < top - 1) out.push(`${name}: top ${Math.round(r.top)} under the status bar`);
      if (r.bottom > h - bottom + 1 && !el.classList.contains('is-sheet')) out.push(`${name}: bottom ${Math.round(r.bottom)} under the gesture bar`);
      if (r.right > w + 1 || r.left < -1) out.push(`${name}: off the side`);
      if (el.scrollHeight > el.clientHeight + 2) {
        const oy = getComputedStyle(el).overflowY;
        if (oy !== 'auto' && oy !== 'scroll' && !el.parentElement?.closest('.popover, .dialog')) out.push(`${name}: content cut off and it doesn't scroll`);
      }
    }
    return out;
  }, INSETS);
  expect(bad, label).toEqual([]);
}

/**
 * Disabled controls in `scope` that don't say why: no title, no description, and no hint text in
 * the row or group around them.
 */
async function unexplainedDisabled(page: Page, scope: string): Promise<string[]> {
  return page.evaluate((scope) => {
    const out: string[] = [];
    for (const root of document.querySelectorAll(scope)) {
      for (const b of root.querySelectorAll<HTMLElement>('button:disabled, [role="menuitem"][aria-disabled="true"], button[aria-disabled="true"]')) {
        if (!b.getBoundingClientRect().width) continue;
        const name = b.getAttribute('aria-label') ?? b.textContent?.trim() ?? '';
        if (b.title.trim() || b.getAttribute('aria-describedby')) continue;
        // Menu rows carry their reason as the hint on the right.
        if (b.querySelector('.menu-hint')?.textContent?.trim()) continue;
        const row = b.closest('.row-switch, .field-row, .set-row, .set-group, [role="group"], fieldset, form, .dialog-body, .pop-section, .menu, li, .card');
        const hint = row?.querySelector('.row-hint, .muted, .hint, small, .set-note, .field-hint');
        if (hint?.textContent?.trim()) continue;
        // Undo/redo with nothing to undo is self-explanatory (the standard everywhere).
        if (/^(Undo|Redo)/.test(name)) continue;
        out.push(name || b.outerHTML.slice(0, 80));
      }
    }
    return out;
  }, scope);
}

/** The DOM's shape, to tell whether pressing something changed anything. */
const domState = (page: Page) => page.evaluate(() => `${location.hash}|${document.documentElement.getAttribute('data-theme')}|${document.body.innerHTML.length}|${document.body.innerHTML.replace(/\d+/g, '').length}|${document.querySelectorAll('[role="dialog"], [role="menu"], .popover').length}|${[...document.querySelectorAll('[aria-pressed], [aria-checked], [aria-expanded], [aria-selected]')].map((e) => `${e.getAttribute('aria-pressed')}${e.getAttribute('aria-checked')}${e.getAttribute('aria-expanded')}${e.getAttribute('aria-selected')}`).join('')}`);

async function closeOverlays(page: Page) {
  for (let k = 0; k < 4; k++) {
    if (!(await page.locator('[role="dialog"], .palette, .popover').count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(120);
  }
  for (const sel of ['[role="dialog"] button[aria-label^="Close"]', '[role="dialog"] button:text-is("Cancel")', '[role="dialog"] button:text-is("Close")', '[role="dialog"] button:text-is("Done")']) {
    const c = page.locator(sel);
    if (await c.count()) { await c.first().click().catch(() => {}); await page.waitForTimeout(120); }
  }
}

/**
 * Presses every enabled button in `scope` whose label isn't in SKIP, one at a time from a fresh
 * state (`reset`), and reports the ones that change nothing.
 */
async function pressAll(page: Page, scope: string, label: string, reset: () => Promise<void>, errors: string[]): Promise<string[]> {
  /** Marks the pressable controls in `scope` with their index (the same order every time) and returns their labels. */
  const tag = () => page.evaluate((scope) => {
    const root = document.querySelector(scope);
    if (!root) return [] as string[];
    const els = [...root.querySelectorAll<HTMLElement>('button:not(:disabled), [role="switch"]:not(:disabled)')]
      .filter((b) => b.getBoundingClientRect().width > 0)
      // The option or tab already chosen has nothing to do when pressed again.
      .filter((b) => !(b.getAttribute('aria-checked') === 'true' && b.getAttribute('role') === 'radio') && b.getAttribute('aria-selected') !== 'true' && !b.getAttribute('aria-current'));
    document.querySelectorAll('[data-audit]').forEach((e) => e.removeAttribute('data-audit'));
    return els.map((b, i) => { b.setAttribute('data-audit', String(i)); return (b.getAttribute('aria-label') ?? b.textContent ?? '').trim().replace(/\s+/g, ' '); });
  }, scope);
  const dead: string[] = [];
  const total = (await tag()).length;
  for (let i = 0; i < total; i++) {
    // Let a screen that was just reopened finish mounting before marking its controls.
    await page.waitForTimeout(150);
    let names = await tag();
    if (!(await page.locator(`[data-audit="${i}"]`).count())) { await page.waitForTimeout(500); names = await tag(); }
    const name = names[i];
    if (!name || SKIP.test(name)) continue;
    const loc = page.locator(`[data-audit="${i}"]`);
    const before = await domState(page);
    const errCount = errors.length;
    const pressed = await loc.click({ timeout: 3000 }).then(() => true, (e: Error) => e.message.split('\n').filter((l) => /intercepts|Timeout|not visible|detached/.test(l)).slice(-2).join(' ').slice(0, 200));
    await page.waitForTimeout(300);
    const after = await domState(page);
    if (pressed !== true) dead.push(`${label} › ${name} (couldn't be pressed: ${pressed})`);
    else if (after === before && errors.length === errCount) dead.push(`${label} › ${name}`);
    if (await page.locator('[role="dialog"], .popover, .palette').count()) await overlaysFit(page, `${label} › ${name}`);
    await closeOverlays(page);
    await reset();
  }
  return dead;
}

test('library: every top-bar control, the drawer, the New sheet and note menus work and fit', async ({ page }) => {
  await insets(page);
  const errors = watchErrors(page);
  await openApp(page);
  const back = async () => {
    if (!(await page.locator('.library').count())) await page.goto('/?e2e');
    await expect(page.locator('.library')).toBeVisible();
  };
  // Top bar (search and New are covered elsewhere: here the buttons that open things).
  for (const name of ['Menu', 'More ways to create']) {
    await page.locator('.lib-top').getByRole('button', { name }).click();
    await page.waitForTimeout(250);
    await overlaysFit(page, `library › ${name}`);
    expect(await unexplainedDisabled(page, '.popover, .drawer, [role="dialog"]'), `library › ${name}: disabled without a reason`).toEqual([]);
    await page.keyboard.press('Escape');
  }
  // Every drawer entry goes somewhere.
  await page.getByRole('button', { name: 'Menu' }).click();
  const entries = page.locator('.drawer .lib-nav > button.nav-item, .drawer .lib-nav-foot > button');
  const labels = await entries.evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
  await page.keyboard.press('Escape');
  for (const [i, e] of labels.entries()) {
    await back();
    await page.getByRole('button', { name: 'Menu' }).click();
    const before = await domState(page);
    await entries.nth(i).click();
    await page.waitForTimeout(300);
    expect(await domState(page), `drawer › ${e} did nothing`).not.toBe(before);
    await overlaysFit(page, `drawer › ${e}`);
    await closeOverlays(page);
  }
  await back();
  // A note's menu.
  await page.locator('.note-more').first().click({ force: true });
  await overlaysFit(page, 'note menu');
  await page.keyboard.press('Escape');
  expect(errors).toEqual([]);
});

test('editor: top bar, every ••• command, the "+" menu and the pen dock', async ({ page }) => {
  await insets(page);
  const errors = watchErrors(page);
  await openApp(page);
  await newNote(page);
  await pen(page, line([200, 200], [400, 210]));
  const noteUrl = page.url();
  const reset = async () => {
    if (page.url() !== noteUrl || !(await page.locator('.ed-top').count())) { await page.goto(noteUrl); await page.waitForFunction(() => !!(window as any).__inkwright?.engine); }
  };

  // Every ••• command: opens what it says and it fits (file pickers, downloads and the microphone excluded).
  // Fit to width only moves the canvas (no DOM change to see), so it isn't judged here.
  const NOT_PRESSED = /^(Page › Fit to width|Insert › (Image|Photo from camera|Scan document|PDF pages|Add data)|Share & export › (PDF|PNG image|SVG|Markdown)|Audio › (Record audio|Dictate|Read aloud)|Note › (Duplicate note|Save now)|Move to Trash)$/;
  const commands = (await editorMenuCommands(page)).filter((c) => !NOT_PRESSED.test(c));
  expect(commands.length).toBeGreaterThan(15);
  const dead: string[] = [];
  for (const c of commands) {
    await reset();
    const before = await domState(page);
    const errCount = errors.length;
    await editorMenu(page, ...c.split(' › '));
    await page.waitForTimeout(400);
    if ((await domState(page)) === before && errors.length === errCount) dead.push(c);
    await overlaysFit(page, `editor › ${c}`);
    expect(await unexplainedDisabled(page, '[role="dialog"], .popover, .side-panel'), `editor › ${c}: disabled without a reason`).toEqual([]);
    await closeOverlays(page);
    if (await page.locator('.side-panel').count()) await page.locator('.side-panel .side-head button[aria-label^="Close"]').first().click().catch(() => {});
  }
  // The ••• menu itself: disabled rows say why.
  await editorMenu(page);
  expect(await unexplainedDisabled(page, '[role="menu"]'), 'editor ••• menu').toEqual([]);
  await page.keyboard.press('Escape');

  // "+": hold for its menu; each entry that stays in the app does something.
  await page.locator('.ed-top .new-here').click({ button: 'right' });
  await overlaysFit(page, 'editor › + menu');
  await page.getByRole('menuitem', { name: /New note from template/ }).click();
  await overlaysFit(page, 'editor › + › New note from template');
  await closeOverlays(page);

  // Pen dock and top bar: every control does something.
  dead.push(...await pressAll(page, '.dock', 'pen dock', reset, errors));
  dead.push(...await pressAll(page, '.ed-top', 'top bar', reset, errors));
  expect(dead, 'controls that did nothing').toEqual([]);
  expect(await unexplainedDisabled(page, '.dock, .ed-top'), 'editor chrome: disabled without a reason').toEqual([]);
  expect(errors).toEqual([]);
});

test('AI panel: every control without a provider, and it fits', async ({ page }) => {
  await insets(page);
  const errors = watchErrors(page);
  await openApp(page);
  await newNote(page);
  const noteUrl = page.url();
  const open = async () => {
    if (page.url() !== noteUrl) { await page.goto(noteUrl); await page.waitForFunction(() => !!(window as any).__inkwright?.engine); }
    if (!(await page.locator('.ai-panel').count())) await page.getByRole('button', { name: 'AI', exact: true }).click();
    await expect(page.locator('.ai-panel')).toBeVisible();
  };
  await open();
  await overlaysFit(page, 'AI panel');
  expect(await unexplainedDisabled(page, '.ai-panel'), 'AI panel: disabled without a reason').toEqual([]);
  const dead = await pressAll(page, '.ai-panel', 'AI panel', open, errors);
  expect(dead, 'AI panel controls that did nothing').toEqual([]);
  expect(errors).toEqual([]);
});

// Every Settings section (as in e2e/fit.spec.ts), one test per few so failures point somewhere.
const SECTIONS = ['', 'writing', 'input', 'handwriting', 'ai', 'sync', 'devices', 'agents', 'trust', 'authorship', 'appearance', 'knowledge', 'ink-actions', 'reading', 'modules', 'plugins', 'code', 'developer', 'about'];
for (let i = 0; i < SECTIONS.length; i += 5) {
  const group = SECTIONS.slice(i, i + 5);
  test(`settings: ${group.map((s) => s || 'start').join(', ')}`, async ({ page }) => {
    await insets(page);
    const errors = watchErrors(page);
    await openApp(page);
    const dead: string[] = [];
    for (const id of group) {
      const url = `/?e2e#settings${id ? `/${id}` : ''}`;
      const go = async () => {
        if (!page.url().endsWith(url.slice(1)) || !(await page.locator('.settings').count())) {
          await page.goto(url);
          await expect(page.locator('.settings')).toBeVisible();
          await page.waitForTimeout(150);
        }
      };
      await page.goto(url);
      await expect(page.locator('.settings')).toBeVisible();
      await page.waitForTimeout(250);
      await overlaysFit(page, `settings › ${id || 'start'}`);
      const scope = (await page.locator('.set-main').count()) ? '.set-main' : '.settings';
      expect(await unexplainedDisabled(page, scope), `settings › ${id || 'start'}: disabled without a reason`).toEqual([]);
      dead.push(...await pressAll(page, scope, `settings › ${id || 'start'}`, go, errors));
    }
    expect(dead, 'controls that did nothing').toEqual([]);
    expect(errors).toEqual([]);
  });
}

test('document editor: toolbar, ••• and every menu entry', async ({ page }) => {
  await insets(page);
  const errors = watchErrors(page);
  await openApp(page);
  await page.getByRole('button', { name: 'More ways to create' }).click();
  await page.getByRole('button', { name: 'New document' }).click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.docEditor);
  await page.locator('.doc-prose').click();
  await page.keyboard.type('Heading text');
  const url = page.url();
  const reset = async () => {
    if (page.url() !== url || !(await page.locator('.doc-prose').count())) { await page.goto(url); await page.waitForFunction(() => !!(window as any).__inkwright?.docEditor); }
    // Leave annotating (Escape), so the text takes the click again.
    if (await page.locator('.doc-ink.is-active').count()) await page.keyboard.press('Escape');
    await page.locator('.doc-prose').click();
    await page.keyboard.press('End');
  };
  const dead = await pressAll(page, '.doc-toolbar', 'document toolbar', reset, errors);
  expect(await unexplainedDisabled(page, '.doc-toolbar, .ed-top'), 'document editor: disabled without a reason').toEqual([]);
  for (const name of ['More', 'More formatting']) {
    await page.getByRole('button', { name, exact: true }).click();
    await overlaysFit(page, `document › ${name}`);
    await page.keyboard.press('Escape');
  }
  await page.getByRole('button', { name: 'More', exact: true }).click();
  await page.getByRole('menuitem', { name: /^Outline/ }).click();
  await expect(page.getByRole('complementary', { name: 'Outline' })).toBeVisible();
  expect(dead, 'controls that did nothing').toEqual([]);
  expect(errors).toEqual([]);
});
