import { expect, type Page } from '@playwright/test';

export type Pt = [number, number];

/**
 * Playwright's Linux WebKit plays Web Audio through GStreamer, and in a container without a sound
 * server starting the writing-sound AudioWorklet (which opening a note does) sometimes blocks the
 * page's main thread for good: tests then time out at random (about one note in eight under load).
 * Without an AudioContext the app simply runs silent. Safari on Apple devices (Core Audio) is not
 * affected, and Chromium and Firefox keep their audio.
 */
async function withoutLinuxWebKitAudio(page: Page) {
  if (process.platform !== 'linux' || page.context().browser()?.browserType().name() !== 'webkit') return;
  await page.addInitScript(() => { delete (window as any).AudioContext; delete (window as any).webkitAudioContext; });
}

/** Opens the app with the test hook enabled and waits for the library. */
export async function openApp(page: Page) {
  await withoutLinuxWebKitAudio(page);
  await page.goto('/?e2e');
  await expect(page.locator('.library')).toBeVisible();
}

/** Creates a blank note and waits for the editor's engine. */
export async function newNote(page: Page) {
  const btn = page.locator('.new-btn');
  if (await btn.isVisible()) await btn.click();
  else await page.locator('.fab').click();
  await page.waitForFunction(() => !!(window as any).__inkwright?.engine);
}

export interface PenOpts {
  type?: 'pen' | 'touch' | 'mouse';
  id?: number;
  buttons?: number;
  pressure?: number;
  hold?: boolean;
  noUp?: boolean;
}

/** Synthetic stylus stroke in canvas-relative CSS px. */
export async function pen(page: Page, pts: Pt[], opts: PenOpts = {}) {
  await page.evaluate(({ pts, opts }) => {
    const el = document.querySelector('.ed-canvas') as HTMLElement;
    const r = el.getBoundingClientRect();
    const fire = (type: string, p: [number, number], i: number) =>
      el.dispatchEvent(new PointerEvent(type, {
        pointerId: opts.id ?? 7, pointerType: opts.type ?? 'pen', isPrimary: true, bubbles: true, cancelable: true,
        clientX: r.left + p[0], clientY: r.top + p[1],
        pressure: type === 'pointerup' ? 0 : opts.pressure ?? 0.3 + 0.5 * Math.sin((Math.PI * i) / pts.length),
        buttons: type === 'pointerup' ? 0 : opts.buttons ?? 1, button: type === 'pointermove' ? -1 : 0, tiltX: 20, tiltY: 10,
        width: 1, height: 1,
      }));
    fire('pointerdown', pts[0]!, 0);
    for (let i = 1; i < pts.length; i++) fire('pointermove', pts[i]!, i);
    if (!opts.noUp) fire('pointerup', pts[pts.length - 1]!, pts.length);
  }, { pts, opts });
}

export async function pointer(page: Page, type: string, p: Pt, opts: PenOpts = {}) {
  await page.evaluate(({ type, p, opts }) => {
    const el = document.querySelector('.ed-canvas') as HTMLElement;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent(type, { pointerId: opts.id ?? 7, pointerType: opts.type ?? 'pen', isPrimary: true, bubbles: true, cancelable: true, clientX: r.left + p[0], clientY: r.top + p[1], pressure: type === 'pointerup' ? 0 : 0.5, buttons: opts.buttons ?? (type === 'pointerup' ? 0 : 1), button: type === 'pointermove' ? -1 : 0 }));
  }, { type, p, opts });
}

export const line = (a: Pt, b: Pt, n = 40): Pt[] => Array.from({ length: n + 1 }, (_, i) => [a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n]);
export const word = (x: number, y: number, w: number): Pt[] => Array.from({ length: 80 }, (_, i) => [x + (w * i) / 79, y + 9 * Math.sin((i / 79) * 12 * Math.PI)]);
export function scribble(x0: number, x1: number, y0: number, y1: number, passes: number): Pt[] {
  const c: Pt[] = [];
  for (let i = 0; i <= passes; i++) c.push([i % 2 ? x1 : x0, y0 + ((y1 - y0) * i) / passes]);
  let out: Pt[] = [];
  for (let i = 1; i < c.length; i++) out = out.concat(line(c[i - 1]!, c[i]!, 12));
  return out;
}
export const circle = (cx: number, cy: number, r: number): Pt[] => Array.from({ length: 90 }, (_, i) => [cx + r * Math.cos((i / 84) * Math.PI * 2) * (1 + 0.04 * Math.sin(i)), cy + r * Math.sin((i / 84) * Math.PI * 2)]);

export const strokes = (page: Page, pageIndex = 0) => page.evaluate((i) => (window as any).__inkwright.doc.page(i).strokes.map((s: any) => ({ id: s.id, pen: s.pen, shape: s.shape, n: s.points.length, color: s.color })), pageIndex);
export const texts = (page: Page, pageIndex = 0) => page.evaluate((i) => ((window as any).__inkwright.doc.page(i).texts ?? []).map((t: any) => t.text), pageIndex);
export const noteId = (page: Page) => page.evaluate(() => (window as any).__inkwright.doc.meta.id as string);

/**
 * The shortcut modifier the app listens for in this browser: ⌘ (Meta) on Macs, iPads and iPhones,
 * Ctrl elsewhere. Mirrors platform/env.ts, which decides from the user agent (the WebKit projects
 * run on Linux but present Apple user agents).
 */
export const modKey = (page: Page) =>
  page.evaluate(() => (/Macintosh|Mac OS X|iPhone|iPad|iPod/.test(navigator.userAgent) ? 'Meta' : 'Control'));

/**
 * Console messages browsers print that are not app errors. Safari reports the viewport meta's
 * `interactive-widget` key (Chromium on Android honours it to keep the editor above the on-screen
 * keyboard) as unrecognised, and ignores it. Firefox logs every CSP-blocked eval as an error, even
 * the one a library (zod) makes inside try/catch to detect whether eval is allowed; our CSP blocking
 * it is intended.
 */
export const isEngineNoise = (text: string) =>
  /Viewport argument key "interactive-widget" not recognized/.test(text) ||
  /Content-Security-Policy: The page.s settings blocked a JavaScript eval/.test(text);
