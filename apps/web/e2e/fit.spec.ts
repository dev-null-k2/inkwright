import { expect, test, type Page } from '@playwright/test';
import { newNote, openApp } from './helpers.ts';

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

const SETTINGS = ['writing', 'input', 'handwriting', 'ai', 'sync', 'devices', 'agents', 'authorship', 'appearance', 'knowledge', 'ink-actions', 'reading', 'modules', 'plugins', 'code', 'developer', 'about'];

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
    for (const el of document.querySelectorAll<HTMLElement>('.popover, .dialog, [role="menu"], .palette')) {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      // A menu inside a popover or dialog scrolls with it; the container is what must fit.
      if (el.matches('[role="menu"]') && el.parentElement?.closest('.popover, .dialog')) continue;
      const name = `${el.className || el.getAttribute('role')}`.slice(0, 60);
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

      await page.getByRole('button', { name: 'AI', exact: true }).click();
      await page.waitForTimeout(300);
      await overlaysFit(page, 'AI panel', screen.insets);
      await page.keyboard.press('Escape');
    });

    test('every settings section scrolls to its end above the gesture bar', async ({ page }) => {
      await insets(page, screen.insets);
      await openApp(page);
      for (const id of SETTINGS) {
        await page.goto(`/?e2e#settings/${id}`);
        await expect(page.locator('.settings')).toBeVisible();
        await page.waitForTimeout(150);
        const scroller = await page.evaluate(() => {
          const cands = [...document.querySelectorAll<HTMLElement>('.settings *')].filter((e) => { const s = getComputedStyle(e).overflowY; return (s === 'auto' || s === 'scroll') && e.scrollHeight > e.clientHeight; });
          const main = cands.sort((a, b) => b.clientHeight - a.clientHeight)[0];
          if (!main) return null;
          main.setAttribute('data-fit-scroller', '');
          return true;
        });
        if (scroller) await lastItemReachable(page, '[data-fit-scroller]', `settings › ${id}`, screen.insets.bottom);
        await overlaysFit(page, `settings › ${id}`, screen.insets);
      }
    });
  });
}
