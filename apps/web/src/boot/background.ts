import { useSyncExternalStore } from 'react';
import { whenIdle } from './lazy.ts';

/**
 * The moment background work may start.
 *
 * Right after the library appears, the main thread belongs to the person: a tap on a note or a
 * scroll must be handled at once, and on a mid-range phone evaluating a 100 kB chunk is a long
 * task. So module activation (routines, plugins, peers…), app-wide overlays and chunk preloading
 * wait until the library has had a quiet moment — `BACKGROUND_DELAY_MS`, then the next idle
 * period — or until the person goes somewhere else: once the opened screen is up (a note,
 * Settings), or at once for the search palette, which is itself one of those overlays.
 * docs/PERFORMANCE.md has the measurements.
 */

/** How long the library has to itself before background work starts. */
export const BACKGROUND_DELAY_MS = 1200;

let released = false;
let scheduled = false;
const queue: Array<() => void> = [];
const subscribers = new Set<() => void>();

/** Lets background work start now (idempotent). */
export function releaseBackground(): void {
  if (released) return;
  released = true;
  for (const fn of queue.splice(0)) {
    try { fn(); } catch (e) { console.error(e); }
  }
  for (const s of subscribers) s();
}

/**
 * Lets background work start at the next idle moment: after leaving the library, so the screen
 * being opened (a note's first stroke) is evaluated and painted before anything else competes.
 */
export function releaseBackgroundSoon(): void {
  if (!released) whenIdle(releaseBackground, 1000);
}

/** Starts the countdown once the first screen is up (idempotent). */
export function scheduleBackground(delay = BACKGROUND_DELAY_MS): void {
  if (scheduled || released) return;
  scheduled = true;
  setTimeout(() => whenIdle(releaseBackground), delay);
}

/** Runs `fn` once background work may start (immediately if it already may). */
export function onBackground(fn: () => void): void {
  if (released) fn();
  else queue.push(fn);
}

export const backgroundReleased = (): boolean => released;

/** React: true once background work may start, so app-wide overlays mount then. */
export function useBackgroundReady(): boolean {
  return useSyncExternalStore((cb) => { subscribers.add(cb); return () => subscribers.delete(cb); }, backgroundReleased, () => false);
}
