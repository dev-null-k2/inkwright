import { Suspense } from 'react';
import { act, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { lazyNamed } from './lazy.ts';

/**
 * Screens are lazy chunks (boot/screens.ts). What matters for startup: a chunk is fetched once,
 * however often it is preloaded or rendered, and a screen whose chunk is already in renders at
 * once, without passing through the Suspense fallback.
 */

function Hello({ who }: { who: string }) {
  return <p>Hello {who}</p>;
}

describe('lazyNamed', () => {
  it('fetches the chunk once for preload() and render, and reports when it is in', async () => {
    const load = vi.fn(async () => ({ Hello }));
    const Screen = lazyNamed(load, 'Hello');
    expect(Screen.loaded).toBe(false);
    const a = Screen.preload();
    const b = Screen.preload();
    await Promise.all([a, b]);
    expect(Screen.loaded).toBe(true);
    render(<Suspense fallback={<p>loading</p>}><Screen who="you" /></Suspense>);
    expect(screen.getByText('Hello you')).toBeTruthy();
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('renders a preloaded screen in the same commit, never showing the fallback', async () => {
    const Screen = lazyNamed(async () => ({ Hello }), 'Hello');
    await Screen.preload();
    render(<Suspense fallback={<p>loading</p>}><Screen who="there" /></Suspense>);
    // Synchronously after render: no fallback frame (React would hold one for 300 ms).
    expect(screen.queryByText('loading')).toBeNull();
    expect(screen.getByText('Hello there')).toBeTruthy();
  });

  it('still loads on demand when rendered before the chunk is in', async () => {
    let resolve!: (m: { Hello: typeof Hello }) => void;
    const Screen = lazyNamed(() => new Promise<{ Hello: typeof Hello }>((r) => { resolve = r; }), 'Hello');
    render(<Suspense fallback={<p>loading</p>}><Screen who="later" /></Suspense>);
    expect(screen.getByText('loading')).toBeTruthy();
    await act(async () => { resolve({ Hello }); });
    expect(await screen.findByText('Hello later')).toBeTruthy();
  });

  it('retries a chunk that failed to load (offline in the middle of an update)', async () => {
    const load = vi.fn<() => Promise<{ Hello: typeof Hello }>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ Hello });
    const Screen = lazyNamed(load, 'Hello');
    await expect(Screen.preload()).rejects.toThrow('offline');
    expect(Screen.loaded).toBe(false);
    await Screen.preload();
    expect(Screen.loaded).toBe(true);
    expect(load).toHaveBeenCalledTimes(2);
  });
});
