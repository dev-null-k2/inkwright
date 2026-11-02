/**
 * When the welcome shows, and what its choices change. Kept apart from the screen so the rules
 * are unit-tested.
 */

/**
 * The welcome is for a first run: it shows once, on a device whose settings say it hasn't been
 * finished or skipped. Someone updating from a version without the welcome is not walked through
 * set-up again: they already have saved settings, or notes of their own (besides the "Welcome to
 * Inkwright" page every new library starts with), and are marked as done instead.
 */
export function welcomeDecision(s: { onboardingDone: boolean; settingsStored: boolean; ownNotes: number }): 'show' | 'mark-done' | 'none' {
  if (s.onboardingDone) return 'none';
  return s.settingsStored || s.ownNotes > 0 ? 'mark-done' : 'show';
}

/** The tag of the page a new library starts with (lib/welcome.ts); it is not one of the person's notes. */
export const STARTER_TAG = 'start here';

/** How the person writes: with a pen (the finger scrolls) or with a finger (it writes). */
export type WritingTool = 'pen' | 'finger';

export const fingerActionFor = (tool: WritingTool): 'scroll' | 'draw' => (tool === 'finger' ? 'draw' : 'scroll');
export const writingToolFrom = (fingerAction: string): WritingTool => (fingerAction === 'draw' ? 'finger' : 'pen');

/** Where AI runs: on this device (private, the default), through the person's own key, or not at all. */
export type AIChoice = 'device' | 'key' | 'none';

/**
 * The assistant preference each AI choice sets (lib/localai.ts). "None" leaves it alone: the
 * assistant module is switched off instead, which hides every AI entry point until it is on again.
 */
export const assistantPreferenceFor = (c: AIChoice): 'device' | 'auto' | null => (c === 'device' ? 'device' : c === 'key' ? 'auto' : null);

export const WELCOME_STEPS = ['writing', 'look', 'ai', 'sync'] as const;
export type WelcomeStep = (typeof WELCOME_STEPS)[number];
