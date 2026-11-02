import { beforeEach, describe, expect, it } from 'vitest';
import { consentCovers, consentFor, forgetConsent, pluginFingerprint, recordConsent } from './consent.ts';

describe('device-local plugin consent (security review SR-01)', () => {
  beforeEach(() => localStorage.clear());

  it('fingerprints the exact manifest and entry script', async () => {
    const a = await pluginFingerprint('{"id":"x"}', 'export default {}');
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await pluginFingerprint('{"id":"x"}', 'export default {}')).toBe(a);
    expect(await pluginFingerprint('{"id":"x"}', 'export default {} ')).not.toBe(a);
    expect(await pluginFingerprint('{"id":"x" }', 'export default {}')).not.toBe(a);
    // The separator keeps "manifest + code" boundaries from being shifted.
    expect(await pluginFingerprint('ab', 'c')).not.toBe(await pluginFingerprint('a', 'bc'));
  });

  it('covers only the approved code and at most the approved permissions', () => {
    recordConsent('p', 'f1', ['notes:read', 'editor:read']);
    const c = consentFor('p');
    expect(consentCovers(c, 'f1', ['notes:read'])).toBe(true);
    expect(consentCovers(c, 'f1', [])).toBe(true);
    // A grant added elsewhere (network) or changed code needs a review here.
    expect(consentCovers(c, 'f1', ['notes:read', 'network'])).toBe(false);
    expect(consentCovers(c, 'f2', ['notes:read'])).toBe(false);
    expect(consentCovers(null, 'f1', [])).toBe(false);
  });

  it('is kept per plugin and forgotten on uninstall; damaged storage means no consent', () => {
    recordConsent('a', 'fa', ['events']);
    recordConsent('b', 'fb', []);
    forgetConsent('a');
    expect(consentFor('a')).toBeNull();
    expect(consentFor('b')).toMatchObject({ fp: 'fb', granted: [] });
    localStorage.setItem('inkwright.plugins.consent.v1', '[1,2');
    expect(consentFor('b')).toBeNull();
  });
});
