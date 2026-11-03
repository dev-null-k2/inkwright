import { createElement, lazy, useState, type ComponentProps, type ComponentType, type FunctionComponent } from 'react';

/**
 * Code-splitting helpers for startup.
 *
 * The library is the first screen, so the initial bundle carries only what it needs. Every other
 * screen and app-wide dialog is a separate chunk that is (1) fetched in the background as soon as
 * the library is idle — so opening a note or pressing Ctrl/⌘-K never waits for the network — and
 * (2) still loaded on demand if someone gets there first (deep links, `#new`, a fast tap).
 *
 * See docs/PERFORMANCE.md for the measurements behind this split and the budget that guards it.
 */

/** A lazily loaded component that can also be fetched ahead of time with `preload()`. */
export type PreloadableComponent<T extends ComponentType<any>> = FunctionComponent<ComponentProps<T>> & {
  /** Starts (or joins) the chunk download; resolves once the module is evaluated. */
  preload: () => Promise<unknown>;
  /** Whether the chunk has been evaluated, so it renders without suspending. */
  readonly loaded: boolean;
};

/**
 * `React.lazy` for a named export, with `preload()`. The import runs at most once: `preload()` and
 * the first render share the same promise, so preloading never fetches twice.
 *
 * Once the chunk is in, new instances render the component directly instead of through
 * `React.lazy`. A lazy component suspends on its first render even when its promise has long
 * resolved, and React then keeps the Suspense fallback on screen for at least 300 ms (its fallback
 * throttling): opening a preloaded editor took ~300 ms longer than when it was in the startup
 * bundle. Which of the two an instance uses is fixed when it mounts, so it never remounts.
 */
export function lazyNamed<M, K extends keyof M>(load: () => Promise<M>, name: K): PreloadableComponent<M[K] & ComponentType<any>> {
  type C = M[K] & ComponentType<any>;
  let promise: Promise<{ default: C }> | null = null;
  let resolved: C | null = null;
  const start = () =>
    (promise ??= load().then((m) => {
      resolved = m[name] as C;
      return { default: resolved };
    }, (e) => {
      promise = null; // a failed chunk (offline mid-update) can be retried on the next render
      throw e;
    }));
  const Lazy = lazy(start);
  const component = ((props: ComponentProps<C>) => {
    const [direct] = useState(() => resolved);
    return createElement((direct ?? Lazy) as ComponentType<ComponentProps<C>>, props);
  }) as PreloadableComponent<C>;
  component.displayName = `Preloadable(${String(name)})`;
  component.preload = start;
  Object.defineProperty(component, 'loaded', { get: () => resolved !== null });
  return component;
}

type IdleWindow = Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number };

/**
 * Runs `fn` when the main thread is idle (or after `timeout` ms at the latest), so background
 * chunk fetches and module evaluation never compete with the first paint or the first stroke.
 */
export function whenIdle(fn: () => void, timeout = 2000): void {
  const w = window as IdleWindow;
  if (typeof w.requestIdleCallback === 'function') w.requestIdleCallback(fn, { timeout });
  else setTimeout(fn, Math.min(timeout, 200));
}

/**
 * Preloads chunks one after another at idle time. Sequential on purpose: evaluating a large chunk
 * is a long task on a slow phone, and several at once would make the app janky exactly when
 * someone starts scrolling.
 */
export function preloadInSequence(loaders: Array<() => Promise<unknown>>): void {
  const next = (i: number) => {
    if (i >= loaders.length) return;
    whenIdle(() => {
      loaders[i]!().catch(() => {}).finally(() => next(i + 1));
    });
  };
  next(0);
}
