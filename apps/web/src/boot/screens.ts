/**
 * The app's screens and app-wide overlays as separately loaded chunks (see ./lazy.ts for why).
 *
 * Order in `preloadAfterLibrary` is the order people need them: the editor first (the most common
 * next step, and the one where a delay would be felt on the first stroke), then the search palette
 * (Ctrl/⌘-K), then the app-wide dialogs and bars, then Settings.
 */
import { Suspense, createElement } from 'react';
import { useSettings } from '../state/settings.ts';
import { lazyNamed, preloadInSequence } from './lazy.ts';
import { onBackground, scheduleBackground } from './background.ts';

export const Editor = lazyNamed(() => import('../screens/Editor.tsx'), 'Editor');
export const Settings = lazyNamed(() => import('../screens/Settings.tsx'), 'Settings');
export const Palette = lazyNamed(() => import('../ui/Palette.tsx'), 'Palette');
export const AgentDialogs = lazyNamed(() => import('../ui/agent/shared.tsx'), 'AgentDialogs');
export const CompilerDialogs = lazyNamed(() => import('../compiler/ui/dialogs.tsx'), 'CompilerDialogs');
export const DevGlobal = lazyNamed(() => import('../dev/DevGlobal.tsx'), 'DevGlobal');
export const PeerGlobal = lazyNamed(() => import('../peer/PeerGlobal.tsx'), 'PeerGlobal');
export const RecallGlobal = lazyNamed(() => import('../recall/Global.tsx'), 'RecallGlobal');
const Welcome = lazyNamed(() => import('../welcome/Welcome.tsx'), 'WelcomeGate');

/**
 * The first-run welcome, loaded only for someone who has not been through it: it brings the AI
 * provider and sync setup screens with it, which nobody else needs at startup.
 */
export function WelcomeGate() {
  const done = useSettings((s) => s.onboardingDone);
  return done ? null : createElement(Suspense, { fallback: null }, createElement(Welcome));
}

/**
 * Runs `fn` in the background phase once the editor chunk is in (or failed to load), so module
 * start-up never competes with the editor for the main thread: opening a note is the most likely
 * next step, and the first stroke must not wait behind routines and plugins.
 */
export function afterEditorPreload(fn: () => void): void {
  onBackground(() => { void Editor.preload().catch(() => {}).finally(fn); });
}

let started = false;

/**
 * Once the library is up: starts the countdown to background work (./background.ts) and then
 * fetches the other screens (idempotent). Whoever opens a note sooner loads the editor on demand.
 */
export function preloadAfterLibrary(): void {
  if (started) return;
  started = true;
  scheduleBackground();
  onBackground(() => preloadInSequence([
    Editor.preload, Palette.preload, PeerGlobal.preload, DevGlobal.preload, AgentDialogs.preload, CompilerDialogs.preload, RecallGlobal.preload, Settings.preload,
    // Engine files an update no longer uses (src/engines): free their space.
    () => import('../engines/store.ts').then((m) => m.clearStaleEngineCaches()),
  ]));
}
