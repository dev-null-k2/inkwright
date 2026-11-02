import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';

/**
 * Thin adb helpers for the Android smoke suite. The device is ANDROID_SERIAL (run-smoke.sh exports
 * it); screenshots go to test-artifacts/android/ (git-ignored).
 */
const ADB = join(process.env.ANDROID_HOME ?? '/opt/android-sdk', 'platform-tools', 'adb');
export const ARTIFACTS = process.env.INKSTONE_ANDROID_ARTIFACTS ?? join(import.meta.dirname, '..', 'test-artifacts', 'android');
mkdirSync(ARTIFACTS, { recursive: true });

export function adb(...args: string[]): string {
  return execFileSync(ADB, args, { encoding: 'utf8', timeout: 180_000, maxBuffer: 64 * 1024 * 1024 });
}

/** Full-device screenshot (system bars and native overlays included), as a user would see it. */
export function screencap(name: string): string {
  const png = execFileSync(ADB, ['exec-out', 'screencap', '-p'], { timeout: 120_000, maxBuffer: 64 * 1024 * 1024 });
  const path = join(ARTIFACTS, `${name}.png`);
  writeFileSync(path, png);
  return path;
}

export function setSystemDarkMode(dark: boolean) {
  adb('shell', 'cmd', 'uimode', 'night', dark ? 'yes' : 'no');
}

export function logcat(): string {
  return adb('logcat', '-d', '-v', 'threadtime', '-b', 'main', '-b', 'system', '-b', 'crash');
}

/**
 * Maps CSS px in the page to screen px for `adb shell input`. Calibrated with one real stylus tap
 * (swallowed before the app sees it): the WebView's offset on screen depends on system bars and
 * edge-to-edge handling, so it is measured rather than assumed.
 */
export interface ScreenMap { dpr: number; dx: number; dy: number }

export async function calibrate(page: Page): Promise<ScreenMap> {
  const dpr = await page.evaluate(() => devicePixelRatio);
  const size = adb('shell', 'wm', 'size').match(/(\d+)x(\d+)\s*$/m);
  const [w, h] = size ? [Number(size[1]), Number(size[2])] : [1000, 1000];
  const sx = Math.round(w / 2), sy = Math.round(h / 2);
  await page.evaluate(() => {
    const w = window as any;
    w.__calib = null;
    w.__calibStop = (e: PointerEvent) => { e.stopImmediatePropagation(); e.preventDefault(); if (e.type === 'pointerdown') w.__calib = { x: e.clientX, y: e.clientY, type: e.pointerType }; };
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'click']) window.addEventListener(t, w.__calibStop, { capture: true });
  });
  adb('shell', 'input', 'stylus', 'tap', String(sx), String(sy));
  await page.waitForFunction(() => (window as any).__calib, null, { timeout: 60_000 });
  const c = await page.evaluate(() => {
    const w = window as any;
    for (const t of ['pointerdown', 'pointermove', 'pointerup', 'click']) window.removeEventListener(t, w.__calibStop, { capture: true });
    return w.__calib as { x: number; y: number; type: string };
  });
  return { dpr, dx: sx - c.x * dpr, dy: sy - c.y * dpr };
}

export const toScreen = (m: ScreenMap, x: number, y: number): [number, number] => [Math.round(x * m.dpr + m.dx), Math.round(y * m.dpr + m.dy)];

/** A real stylus stroke (MotionEvent tool type STYLUS) from `input stylus swipe`, in page CSS px. */
export function stylusSwipe(m: ScreenMap, from: [number, number], to: [number, number], ms = 900) {
  const [x1, y1] = toScreen(m, ...from);
  const [x2, y2] = toScreen(m, ...to);
  adb('shell', 'input', 'stylus', 'swipe', String(x1), String(y1), String(x2), String(y2), String(ms));
}
