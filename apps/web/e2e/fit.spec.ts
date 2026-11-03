import { expect, test, type Page } from '@playwright/test';
import { editorMenu, editorMenuCommands, line, modKey, newNote, openApp, pen } from './helpers.ts';

/**
 * Everything fits on real screens: menus, sheets, dialogs and settings never run under the system
 * bars or past the edge, and long ones scroll so their last item can be reached.
 *
 * The Android app draws edge to edge: Capacitor's SystemBars plugin reports the status bar and the
 * gesture bar as --safe-area-inset-* on <html>. We set the same values here (as on a Razr Fold, a
 * phone and a tablet) so the layout is checked the way it runs on the device.
 */

const SCREENS = [
  { name: 'fold open (Razr Fold inner screen)', width: 720, height: 800, insets: { top: 32, bottom: 24 } },
  { name: 'phone', width: 412, height: 915, insets: { top: 40, bottom: 24 } },
  { name: 'tablet landscape', width: 1180, height: 820, insets: { top: 24, bottom: 20 } },
];

// Every section (as tabs inside their groups since Settings was grouped), plus the start page.
const SETTINGS = ['', 'writing', 'input', 'handwriting', 'ai', 'sync', 'devices', 'agents', 'trust', 'authorship', 'appearance', 'knowledge', 'ink-actions', 'reading', 'modules', 'plugins', 'code', 'developer', 'about'];

/**
 * Editor menu commands left out of the "every dialog fits" sweep: they pick files, save
 * downloads, use the microphone or speakers, or leave the note. Everything else is opened.
 */
const NOT_DIALOGS = /^(Insert › (Image|Photo from camera|Scan document|PDF pages|Add data|Blank page|Text box)|Share & export › (PDF|PNG image|SVG|Markdown)|Audio › (Record audio|Dictate|Read aloud)|Note › (Duplicate note|Save now)|Page › Fit to width|Study › Study this note|Move to Trash)$/;

/** Fixed chrome sits between the system bars: nothing under the status bar or the gesture bar. */
async function chromeFits(page: Page, selector: string, label: string, i: { top: number; bottom: number }) {
  const r = await page.locator(selector).first().boundingBox();
  expect(r, `${label} is on screen`).not.toBeNull();
  const h = page.viewportSize()!.height;
  expect(r!.y, `${label}: top under the status bar`).toBeGreaterThanOrEqual(i.top - 1);
  expect(r!.y + r!.height, `${label}: bottom under the gesture bar`).toBeLessThanOrEqual(h - i.bottom + 1);
}

/** Closes whatever a menu command opened: dialogs, popovers, the palette, side panels. */
async function closeOverlays(page: Page) {
  const open = page.locator('[role="dialog"], .palette, .side-panel');
  for (let k = 0; k < 3; k++) {
    if (!(await open.count())) return;
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
  }
  // Some close only from their own button (focus in a field that keeps Escape, full-screen views).
  for (const sel of ['[role="dialog"] button[aria-label="Close"]', '[role="dialog"] button[aria-label^="Close"]', '.side-panel .side-head button[aria-label^="Close"]']) {
    const close = page.locator(sel);
    if (await close.count()) { await close.first().click(); await page.waitForTimeout(150); }
  }
  await expect(open, 'an overlay that could not be closed').toHaveCount(0);
}

async function insets(page: Page, i: { top: number; bottom: number }) {
  await page.addInitScript((v) => {
    const set = () => {
      const s = document.documentElement.style;
      s.setProperty('--safe-area-inset-top', `${v.top}px`);
      s.setProperty('--safe-area-inset-bottom', `${v.bottom}px`);
    };
    if (document.documentElement) set();
    document.addEventListener('DOMContentLoaded', set);
  }, i);
}

/** Every open overlay sits inside the area between the system bars, and scrolls if it must. */
async function overlaysFit(page: Page, label: string, i: { top: number; bottom: number }) {
  const bad = await page.evaluate(({ top, bottom }) => {
    const out: string[] = [];
    const h = innerHeight, w = innerWidth;
    for (const el of document.querySelectorAll<HTMLElement>('.popover, .dialog, [role="dialog"], [role="menu"], .palette')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      // A menu inside a popover or dialog scrolls with it; the container is what must fit.
      if (el.matches('[role="menu"]') && el.parentElement?.closest('.popover, .dialog')) continue;
      const name = `${el.className || el.getAttribute('role')}`.slice(0, 60);
      // A full-screen view (study review, the welcome) covers the bars on purpose; its padding
      // must keep the content out from under them.
      if (r.top <= 0 && r.bottom >= h - 1) {
        const cs = getComputedStyle(el);
        if (parseFloat(cs.paddingTop) < top - 1) out.push(`${name}: full-screen view's content under the status bar (padding ${cs.paddingTop})`);
        if (parseFloat(cs.paddingBottom) < bottom - 1) out.push(`${name}: full-screen view's content under the gesture bar (padding ${cs.paddingBottom})`);
        continue;
      }
      if (r.top < top - 1) out.push(`${name}: top ${Math.round(r.top)} under the status bar (${top})`);
      if (r.bottom > h - bottom + 1 && !el.classList.contains('is-sheet')) out.push(`${name}: bottom ${Math.round(r.bottom)} under the gesture bar (${h - bottom})`);
      if (r.right > w + 1 || r.left < -1) out.push(`${name}: off the side (${Math.round(r.left)}–${Math.round(r.right)} of ${w})`);
      // Content taller than the box must be reachable by scrolling it (or an ancestor overlay).
      if (el.scrollHeight > el.clientHeight + 2) {
        const oy = getComputedStyle(el).overflowY;
        const scrollableParent = el.parentElement?.closest('.popover, .dialog');
        if (oy !== 'auto' && oy !== 'scroll' && !scrollableParent) out.push(`${name}: content is cut off (${el.scrollHeight} > ${el.clientHeight}) and it doesn't scroll`);
      }
    }
    return out;
  }, i);
  expect(bad, label).toEqual([]);
}

/** The last thing on a scrolling screen can be scrolled above the gesture bar. */
async function lastItemReachable(page: Page, container: string, label: string, bottomInset: number) {
  const r = await page.evaluate(({ container, bottomInset }) => {
    const c = document.querySelector<HTMLElement>(container);
    if (!c) return { ok: false, why: `${container} not found` };
    c.scrollTop = c.scrollHeight;
    const items = [...c.querySelectorAll<HTMLElement>('button, input, select, textarea, a, p, label')].filter((e) => e.getBoundingClientRect().height > 0);
    const last = items[items.length - 1];
    if (!last) return { ok: true, why: '' };
    const b = last.getBoundingClientRect();
    return { ok: b.bottom <= innerHeight - bottomInset + 1, why: `last item bottom ${Math.round(b.bottom)} vs ${innerHeight - bottomInset}: ${last.textContent?.slice(0, 40)}` };
  }, { container, bottomInset });
  expect(r.ok, `${label}: ${r.why}`).toBe(true);
}

for (const screen of SCREENS) {
  test.describe(screen.name, () => {
    test.use({ viewport: { width: screen.width, height: screen.height }, hasTouch: true });

    test('the editor menu, AI panel and search fit between the system bars', async ({ page }) => {
      await insets(page, screen.insets);
      await openApp(page);
      await newNote(page);
      // The top bar's buttons sit below the status bar.
      const back = (await page.getByRole('button', { name: 'Back to library' }).boundingBox())!;
      expect(back.y, 'top bar under the status bar').toBeGreaterThanOrEqual(screen.insets.top - 1);
      await page.getByRole('button', { name: 'More', exact: true }).click();
      await expect(page.getByRole('menuitem', { name: /Move to Trash/ })).toBeAttached();
      await overlaysFit(page, 'editor menu', screen.insets);
      // The last item can be scrolled into view and tapped.
      const trash = page.getByRole('menuitem', { name: /Move to Trash/ });
      await trash.scrollIntoViewIfNeeded();
      const box = (await trash.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(screen.height - screen.insets.bottom + 1);
      await page.keyboard.press('Escape');

      // Each sub-sheet fits too.
      await page.getByRole('button', { name: 'More', exact: true }).click();
      for (const name of ['Insert', 'Page', 'Share & export', 'Note']) {
        await page.getByRole('menu').getByRole('menuitem').filter({ has: page.locator('.menu-label').getByText(name, { exact: true }) }).click();
        await expect(page.getByRole('menu', { name })).toBeVisible();
        await overlaysFit(page, `editor menu › ${name}`, screen.insets);
        await page.locator('.menu-back').click();
      }
      await page.keyboard.press('Escape');

      await page.getByRole('button', { name: 'AI', exact: true }).click();
      await page.waitForTimeout(300);
      await overlaysFit(page, 'AI panel', screen.insets);
      await page.keyboard.press('Escape');
    });

    test('the AI panel scrolls to its end, with the message field above the gesture bar', async ({ page }) => {
      await insets(page, screen.insets);
      await openApp(page);
      await newNote(page);
      await page.getByRole('button', { name: 'AI', exact: true }).click();
      const panel = page.locator('.ai-panel');
      await expect(panel).toBeVisible();
      await page.waitForTimeout(400);
      const r = await panel.evaluate((el, bottom) => {
        // Scroll every scrolling part of the panel (and the panel) to its end.
        for (const s of [el, ...el.querySelectorAll<HTMLElement>('*')]) if (s.scrollHeight > s.clientHeight + 2 && /auto|scroll/.test(getComputedStyle(s).overflowY)) s.scrollTop = s.scrollHeight;
        const box = el.getBoundingClientRect();
        const field = el.querySelector<HTMLElement>('.ai-input')!.getBoundingClientRect();
        const cut = el.scrollHeight > el.clientHeight + 2 && !/auto|scroll/.test(getComputedStyle(el).overflowY);
        return { cut, fieldBottom: field.bottom, fieldTop: field.top, panelBottom: box.bottom, limit: innerHeight - bottom };
      }, screen.insets.bottom);
      expect(r.cut, 'AI panel content is cut off').toBe(false);
      expect(r.fieldBottom, 'message field under the gesture bar').toBeLessThanOrEqual(r.limit + 1);
      expect(r.fieldTop, 'message field outside the panel').toBeLessThanOrEqual(r.panelBottom);
    });

    test('library: top bar, new-note button and its menus fit; nothing scrolls sideways', async ({ page }) => {
      await insets(page, screen.insets);
      await openApp(page);
      const wide = screen.width >= 900;
      await chromeFits(page, '.lib-top .search', 'library search', screen.insets);
      await chromeFits(page, wide ? '.new-btn' : '.fab', 'new note button', screen.insets);
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'sideways scroll').toBeLessThanOrEqual(0);
      if (!wide) {
        await page.getByRole('button', { name: 'Menu' }).click();
        await page.waitForTimeout(250);
        await chromeFits(page, '.lib-nav .lib-brand', 'library drawer top', screen.insets);
        await chromeFits(page, '.lib-nav .lib-account', 'library drawer foot', screen.insets);
        await page.keyboard.press('Escape');
        await expect(page.locator('.drawer')).toHaveCount(0);
      } else {
        await page.getByRole('button', { name: 'More ways to create' }).click();
        await overlaysFit(page, 'new note sheet', screen.insets);
        await page.keyboard.press('Escape');
      }
      // A note's menu and the dialogs it opens.
      await page.locator('.note-more').first().click({ force: true });
      await overlaysFit(page, 'note menu', screen.insets);
      await page.getByRole('menuitem', { name: 'Move to notebook' }).click();
      await expect(page.locator('.dialog')).toBeVisible();
      await overlaysFit(page, 'Move to notebook', screen.insets);
      await page.keyboard.press('Escape');
      await page.locator('.note-more').first().click({ force: true });
      await page.getByRole('menuitem', { name: 'Rename' }).click();
      await expect(page.locator('.dialog')).toBeVisible();
      await overlaysFit(page, 'Rename', screen.insets);
      await page.keyboard.press('Escape');
    });

    test('every dialog and menu the library opens fits between the system bars', async ({ page }) => {
      await insets(page, screen.insets);
      await openApp(page);
      const wide = screen.width >= 900;
      const dialog = page.getByRole('dialog');
      /** The side bar is a drawer on narrow screens: open it to reach its entries. */
      const sidebar = async () => {
        if (wide) return page.locator('.lib-nav');
        if (!(await page.locator('.drawer').count())) await page.getByRole('button', { name: 'Menu' }).click();
        await page.waitForTimeout(250);
        return page.locator('.drawer .lib-nav');
      };
      const closeDrawer = async () => {
        if (!wide && (await page.locator('.drawer').count())) await page.keyboard.press('Escape');
        await expect(page.locator('.drawer')).toHaveCount(0);
      };
      /** Checks the open dialog, then answers it with `button` (or Escape). */
      const check = async (label: string, button?: string) => {
        await expect(dialog).toBeVisible();
        await page.waitForTimeout(200);
        await overlaysFit(page, label, screen.insets);
        if (button) await dialog.getByRole('button', { name: button, exact: true }).click();
        else await page.keyboard.press('Escape');
        await expect(dialog).toHaveCount(0);
      };

      // The side bar: a new notebook (the prompt), then that notebook's menu and its prompts.
      await (await sidebar()).getByRole('button', { name: 'New notebook' }).click();
      await expect(dialog).toBeVisible();
      await dialog.getByRole('textbox').fill('Fit check');
      await check('New notebook', 'Create');
      await closeDrawer();
      await expect(page.locator('.lib-h1')).toHaveText('Fit check');
      await page.getByRole('button', { name: 'Notebook options' }).click();
      await overlaysFit(page, 'notebook menu', screen.insets);
      await page.getByRole('menuitem', { name: 'Rename notebook' }).click();
      await check('Rename notebook');
      await page.getByRole('button', { name: 'Notebook options' }).click();
      await page.getByRole('menuitem', { name: 'New notebook inside' }).click();
      await check('New notebook inside');
      await page.getByRole('button', { name: 'Notebook options' }).click();
      await page.getByRole('menuitem', { name: /^Delete notebook/ }).click();
      await check('Delete notebook', 'Cancel');

      // Papers (the paper workbench), from the side bar.
      await (await sidebar()).getByRole('button', { name: 'Papers' }).click();
      await check('Library of papers');
      await closeDrawer();

      // A note's menu in All notes, and in the Trash.
      await (await sidebar()).getByRole('button', { name: /^All notes/ }).click();
      await closeDrawer();
      await page.locator('.note-more').first().click({ force: true });
      await overlaysFit(page, 'note menu', screen.insets);
      await page.getByRole('menuitem', { name: 'Move to Trash' }).click();
      await (await sidebar()).getByRole('button', { name: /^Trash/ }).click();
      await closeDrawer();
      await page.locator('.note-more').first().click({ force: true });
      await overlaysFit(page, 'note menu in Trash', screen.insets);
      await page.getByRole('menuitem', { name: 'Delete forever' }).click();
      await check('Delete forever', 'Cancel');

      // Search everything (on touch screens the search field opens it).
      await (await sidebar()).getByRole('button', { name: /^All notes/ }).click();
      await closeDrawer();
      await page.keyboard.press(`${await modKey(page)}+k`);
      await expect(page.locator('.palette')).toBeVisible();
      await overlaysFit(page, 'search everything', screen.insets);
      await page.keyboard.press('Escape');
    });

    test('editor: the pen dock and the lasso toolbar sit between the system bars', async ({ page }) => {
      await insets(page, screen.insets);
      await openApp(page);
      await newNote(page);
      await chromeFits(page, '.dock', 'pen dock', screen.insets);
      // Ink across the page, high and low, then select all: the lasso bar must fit.
      const canvas = (await page.locator('.ed-canvas').boundingBox())!;
      const [x0, x1] = [canvas.width * 0.3, canvas.width * 0.7];
      await pen(page, line([x0, canvas.height * 0.2], [x1, canvas.height * 0.22]));
      await pen(page, line([x0, canvas.height * 0.7], [x1, canvas.height * 0.72]));
      await expect.poll(() => page.evaluate(() => (window as any).__inkwright.doc.page(0).strokes.length)).toBeGreaterThan(0);
      await page.keyboard.press(`${await modKey(page)}+a`);
      await expect(page.locator('.sel-bar')).toBeVisible();
      await chromeFits(page, '.sel-bar', 'lasso toolbar', screen.insets);
      const bar = (await page.locator('.sel-bar').boundingBox())!;
      expect(bar.x, 'lasso toolbar off the left edge').toBeGreaterThanOrEqual(-1);
      expect(bar.x + bar.width, 'lasso toolbar off the right edge').toBeLessThanOrEqual(screen.width + 1);
      await chromeFits(page, '.dock', 'pen dock with a selection', screen.insets);
    });

    test('every dialog and sheet the editor menu opens fits between the system bars', async ({ page }) => {
      test.setTimeout(150_000);
      await insets(page, screen.insets);
      await openApp(page);
      await newNote(page);
      await pen(page, line([80, 80], [300, 90]));
      const commands = (await editorMenuCommands(page)).filter((c) => !NOT_DIALOGS.test(c));
      expect(commands.length).toBeGreaterThan(10);
      for (const c of commands) {
        await editorMenu(page, ...c.split(' › '));
        await page.waitForTimeout(400);
        await overlaysFit(page, `editor › ${c}`, screen.insets);
        // A side panel (Pages, Transcript, Links) is a sheet on narrow screens; its header stays on screen.
        if (await page.locator('.side-panel').count()) await chromeFits(page, '.side-panel .side-head', `${c} panel header`, screen.insets);
        await closeOverlays(page);
      }
    });

    test('every settings section scrolls to its end above the gesture bar', async ({ page }) => {
      await insets(page, screen.insets);
      await openApp(page);
      for (const id of SETTINGS) {
        await page.goto(`/?e2e#settings${id ? `/${id}` : ''}`);
        await expect(page.locator('.settings')).toBeVisible();
        await page.waitForTimeout(150);
        const scroller = await page.evaluate(() => {
          document.querySelectorAll('[data-fit-scroller]').forEach((e) => e.removeAttribute('data-fit-scroller'));
          const cands = [...document.querySelectorAll<HTMLElement>('.settings *')].filter((e) => { const s = getComputedStyle(e).overflowY; return (s === 'auto' || s === 'scroll') && e.scrollHeight > e.clientHeight; });
          const main = cands.sort((a, b) => b.clientHeight - a.clientHeight)[0];
          if (!main) return null;
          main.setAttribute('data-fit-scroller', '');
          return true;
        });
        if (scroller) await lastItemReachable(page, '[data-fit-scroller]', `settings › ${id || 'start'}`, screen.insets.bottom);
        await overlaysFit(page, `settings › ${id || 'start'}`, screen.insets);
        await chromeFits(page, '.set-top button', `settings › ${id || 'start'} back button`, screen.insets);
      }
    });

    test.describe('first run', () => {
      test.use({ storageState: { cookies: [], origins: [] } });
      test('every step of the welcome fits, with its button above the gesture bar', async ({ page }) => {
        await insets(page, screen.insets);
        await page.goto('/?e2e');
        const w = page.locator('.welcome');
        await expect(w).toBeVisible();
        for (let step = 0; step < 4; step++) {
          await page.waitForTimeout(250);
          await chromeFits(page, '.welcome-head', `welcome step ${step + 1} header`, screen.insets);
          await w.locator('.welcome-next').scrollIntoViewIfNeeded();
          await chromeFits(page, '.welcome-next', `welcome step ${step + 1} button`, screen.insets);
          expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 'sideways scroll').toBeLessThanOrEqual(0);
          if (step < 3) await w.getByRole('button', { name: 'Next' }).click();
        }
      });
    });
  });
}
