import { describe, expect, it } from 'vitest';
import { WELCOME_STEPS, assistantPreferenceFor, fingerActionFor, welcomeDecision, writingToolFrom } from './welcome.ts';

describe('welcome', () => {
  it('shows on a first run only', () => {
    expect(welcomeDecision({ onboardingDone: false, settingsStored: false, ownNotes: 0 })).toBe('show');
    expect(welcomeDecision({ onboardingDone: true, settingsStored: true, ownNotes: 0 })).toBe('none');
    expect(welcomeDecision({ onboardingDone: true, settingsStored: true, ownNotes: 12 })).toBe('none');
  });

  it('does not walk people who used an earlier version through set-up again', () => {
    expect(welcomeDecision({ onboardingDone: false, settingsStored: true, ownNotes: 0 })).toBe('mark-done');
    expect(welcomeDecision({ onboardingDone: false, settingsStored: false, ownNotes: 3 })).toBe('mark-done');
  });

  it('maps pen or finger to what one finger does', () => {
    expect(fingerActionFor('pen')).toBe('scroll');
    expect(fingerActionFor('finger')).toBe('draw');
    expect(writingToolFrom('draw')).toBe('finger');
    expect(writingToolFrom('scroll')).toBe('pen');
    expect(writingToolFrom('erase')).toBe('pen');
  });

  it('keeps AI on the device by default and changes nothing for "no AI"', () => {
    expect(assistantPreferenceFor('device')).toBe('device');
    expect(assistantPreferenceFor('key')).toBe('auto');
    expect(assistantPreferenceFor('none')).toBeNull();
  });

  it('has three or four short steps', () => {
    expect(WELCOME_STEPS.length).toBeGreaterThanOrEqual(3);
    expect(WELCOME_STEPS.length).toBeLessThanOrEqual(4);
  });
});
