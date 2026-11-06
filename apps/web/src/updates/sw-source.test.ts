import { describe, expect, it } from 'vitest';
import { Script } from 'node:vm';
import { serviceWorkerSource } from '../../build/sw.ts';

describe('the service worker build', () => {
  const src = serviceWorkerSource(['assets/index-abc.js', 'assets/index-abc.css'], 'v1');

  it('is valid JavaScript (a syntax error means no browser installs the offline app)', () => {
    expect(() => new Script(src)).not.toThrow();
  });

  it('names a versioned cache and precaches the built files', () => {
    expect(src).toContain("const CACHE = 'inkwright-app-v1';");
    expect(src).toContain('"assets/index-abc.js"');
    expect(src).not.toContain('${');
  });

  it('installs and serves offline from the cache', async () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const stored = new Map<string, string>();
    const cache = { addAll: async (f: string[]) => { f.forEach((x) => stored.set(x, x)); }, put: async () => {} };
    const self = { addEventListener: (t: string, h: (e: unknown) => void) => { handlers[t] = h; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
    const caches = { open: async () => cache, keys: async () => [], delete: async () => true, match: async (r: { url: string } | string) => stored.get(typeof r === 'string' ? r : r.url) ?? null };
    new Script(src).runInNewContext({ self, caches, location: { origin: 'https://x.test' }, URL, Response, fetch: () => Promise.reject(new Error('offline')) });
    let installed: Promise<unknown> = Promise.resolve();
    handlers.install({ waitUntil: (p: Promise<unknown>) => { installed = p; } });
    await installed;
    expect(stored.has('./')).toBe(true);
    let answer: Promise<unknown> = Promise.resolve(null);
    handlers.fetch({ request: { method: 'GET', url: 'https://x.test/app/', mode: 'navigate' }, respondWith: (p: Promise<unknown>) => { answer = p; } });
    expect(await answer).toBe('./');
  });

  it('on activation removes only its own older caches, never downloaded engines or shared files', async () => {
    const handlers: Record<string, (e: unknown) => void> = {};
    const names = ['inkwright-app-v0', 'inkwright-lx2k9q7a', 'inkwright-app-v1', 'inkwright-engines-v1', 'inkwright-share', 'other'];
    const deleted: string[] = [];
    const self = { addEventListener: (t: string, h: (e: unknown) => void) => { handlers[t] = h; }, skipWaiting: async () => {}, clients: { claim: async () => {} } };
    const caches = { keys: async () => names, delete: async (k: string) => { deleted.push(k); return true; } };
    new Script(src).runInNewContext({ self, caches, location: { origin: 'https://x.test' }, URL, Response, fetch });
    let done: Promise<unknown> = Promise.resolve();
    handlers.activate({ waitUntil: (p: Promise<unknown>) => { done = p; } });
    await done;
    expect(deleted.sort()).toEqual(['inkwright-app-v0', 'inkwright-lx2k9q7a']);
  });
});
