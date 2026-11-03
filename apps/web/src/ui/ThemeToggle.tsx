import { Moon, SunMedium, SunMoon } from 'lucide-react';
import { useApp } from '../state/app.ts';
import { useSettings, type Settings } from '../state/settings.ts';
import { IconButton } from './primitives.tsx';

/**
 * One-tap light / dark / system switch for the library and editor top bars.
 *
 * Founder feedback from the Razr Fold: reaching Appearance through ••• › Settings was too deep for
 * something people flip at night. The button cycles Light → Dark → System and shows the mode it is
 * in now (its label says what a tap does next), so it is never a mystery icon.
 */

export type ThemeMode = Settings['theme'];

/** The order a tap walks through. Exported for tests and for anything else that cycles the mode. */
export const THEME_CYCLE: readonly ThemeMode[] = ['light', 'dark', 'system'];

export const THEME_NAMES: Record<ThemeMode, string> = { light: 'Light', dark: 'Dark', system: 'System' };

/** The mode after `mode` in {@link THEME_CYCLE}. */
export function nextTheme(mode: ThemeMode): ThemeMode {
  const i = THEME_CYCLE.indexOf(mode);
  return THEME_CYCLE[(i + 1) % THEME_CYCLE.length]!;
}

/** Writes the mode onto <html> exactly as App does, so a transition can capture the new look at once. */
export function applyThemeAttribute(mode: ThemeMode, root: HTMLElement = document.documentElement): void {
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

const prefersReducedMotion = () => typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const twoFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/**
 * Switches the theme with a short cross-fade. Browsers with view transitions fade the whole screen
 * (the canvas included, which CSS transitions can't do); others fade colours with a temporary
 * class. With reduced motion the change is instant. `repaint` redraws anything painted from CSS
 * variables by script, such as the ink canvas's desk.
 */
export function switchTheme(mode: ThemeMode, repaint?: () => void): void {
  const set = () => {
    applyThemeAttribute(mode);
    useSettings.getState().update(() => ({ theme: mode }));
    repaint?.();
  };
  if (prefersReducedMotion()) { set(); return; }
  const doc = document as Document & { startViewTransition?: (cb: () => Promise<void> | void) => unknown };
  if (typeof doc.startViewTransition === 'function') {
    try {
      doc.startViewTransition(async () => { set(); await twoFrames(); });
      return;
    } catch { /* fall through to the CSS fade */ }
  }
  const root = document.documentElement;
  root.classList.add('theme-fading');
  set();
  window.setTimeout(() => root.classList.remove('theme-fading'), 320);
}

const ICONS: Record<ThemeMode, React.ReactNode> = {
  light: <SunMedium size={19} />,
  dark: <Moon size={18} />,
  system: <SunMoon size={19} />,
};

/** The top-bar button. `repaint` is called after the switch (the editor passes its canvas's). */
export function ThemeToggle({ repaint, className }: { repaint?: () => void; className?: string }) {
  const mode = useSettings((s) => s.theme);
  const toast = useApp((a) => a.toast);
  const next = nextTheme(mode);
  return (
    <IconButton
      label={`Theme: ${THEME_NAMES[mode]}. Switch to ${THEME_NAMES[next].toLowerCase()}`}
      className={className ? `theme-toggle ${className}` : 'theme-toggle'}
      onClick={() => {
        switchTheme(next, repaint);
        if (next === 'system') toast({ text: 'Following your device’s light or dark setting' });
      }}
    >
      {ICONS[mode]}
    </IconButton>
  );
}
