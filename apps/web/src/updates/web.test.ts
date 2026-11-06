import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { changelogNotes } from '../../build/changelog.ts';
import { checkWebUpdate, isNewer, noteRunningVersion, useWebUpdates } from './web.ts';

const CHANGELOG = `# Changelog

## Unreleased

### iPhone and iPad
- Home Screen app updates.

## 0.9.0-beta.6 — in-app updates
- Android updates itself.

## 0.9.0-beta.5
- Older.
`;

describe('web app updates', () => {
  beforeEach(() => { localStorage.clear(); useWebUpdates.setState({ available: null, updatedFrom: null, checking: false, lastChecked: null, offline: false, applying: false }); });
  afterEach(() => vi.unstubAllGlobals());

  it('takes the notes of the version, else Unreleased', () => {
    expect(changelogNotes(CHANGELOG, '0.9.0-beta.6')).toBe('- Android updates itself.');
    expect(changelogNotes(CHANGELOG, '0.9.0-beta.6+3.gabc123')).toBe('- Android updates itself.');
    expect(changelogNotes(CHANGELOG, '0.9.0-beta.7+1.gdef456')).toContain('Home Screen app updates.');
    expect(changelogNotes(CHANGELOG, '0.9.0-beta.7')).not.toContain('Older');
  });

  it('any other published version is an update; empty or equal is not', () => {
    expect(isNewer('0.9.0-beta.7', '0.9.0-beta.6')).toBe(true);
    expect(isNewer('0.9.0-beta.6', '0.9.0-beta.6')).toBe(false);
    expect(isNewer('', '0.9.0-beta.6')).toBe(false);
    expect(isNewer(undefined, '0.9.0-beta.6')).toBe(false);
  });

  it('remembers the running version and reports the one it replaced', () => {
    expect(noteRunningVersion('1.0.0')).toBeNull();
    expect(noteRunningVersion('1.0.0')).toBeNull();
    expect(noteRunningVersion('1.0.1')).toBe('1.0.0');
  });

  it('offers a newer deployment and asks the server, not a cache', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ version: '9.9.9', notes: '- New' })));
    vi.stubGlobal('fetch', fetchMock);
    const rel = await checkWebUpdate();
    expect(rel?.version).toBe('9.9.9');
    expect(useWebUpdates.getState().available?.notes).toBe('- New');
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toMatch(/version\.json\?t=\d+/);
    expect(init.cache).toBe('no-store');
  });

  it('says offline and keeps any earlier offer when the server cannot be reached', async () => {
    useWebUpdates.setState({ available: { version: '9.9.9', notes: '' } });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Load failed'); }));
    expect(await checkWebUpdate()).toBeNull();
    expect(useWebUpdates.getState().offline).toBe(true);
    expect(useWebUpdates.getState().available?.version).toBe('9.9.9');
  });

  it('drops the offer when the server serves the running version', async () => {
    useWebUpdates.setState({ available: { version: '9.9.9', notes: '' } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '1.0.0' }))));
    await checkWebUpdate();
    expect(useWebUpdates.getState().available).toBeNull();
  });
});
