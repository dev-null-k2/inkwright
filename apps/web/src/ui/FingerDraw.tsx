import { useEffect, useState } from 'react';
import { Pointer } from 'lucide-react';
import { useApp } from '../state/app.ts';
import { useSettings, type Settings } from '../state/settings.ts';
import { safeStorage } from '../platform/env.ts';
import { usePaletteActions } from '../lib/palette.ts';
import { cx } from './primitives.tsx';

/**
 * "Draw with finger": the one-tap switch between writing with a finger and writing with a pen.
 *
 * It is the same setting as Settings › Input › One finger and the welcome's "With a pen / With my
 * finger" choice (`settings.input.fingerAction`), stored in this device's settings only: a phone
 * used with a finger and a tablet used with a pen each keep their own. When it is on, one finger
 * writes and two fingers scroll and zoom (the ink engine turns a second finger into a pinch); when
 * it is off, fingers scroll and a resting palm is ignored.
 */

type FingerAction = Settings['input']['fingerAction'];

/** The finger setting after the toggle: drawing, or back to scrolling (erasing counts as "not drawing"). */
export const toggledFingerAction = (current: FingerAction): FingerAction => (current === 'draw' ? 'scroll' : 'draw');

/** Device-local memory of "keep drawing with my finger even though I have a pen". */
const KEEP_KEY = 'inkwright.fingerDraw.keepWithPen';

export function useFingerDraw() {
  const action = useSettings((s) => s.input.fingerAction);
  const toast = useApp((a) => a.toast);
  const set = (on: boolean, quiet = false) => {
    useSettings.getState().update((x) => ({ input: { ...x.input, fingerAction: on ? 'draw' : 'scroll' } }));
    if (!quiet) toast({ text: on ? 'Your finger draws now. Two fingers scroll and zoom.' : 'Your finger scrolls now. The pen draws.' });
  };
  return { on: action === 'draw', set, toggle: () => set(toggledFingerAction(action) === 'draw') };
}

/** The pen dock's toggle button (it lives on the stone tray, so it uses the dock's own styling). */
export function FingerDrawButton() {
  const f = useFingerDraw();
  usePaletteActions('finger-draw', [
    { id: 'finger-draw', label: f.on ? 'Stop drawing with finger' : 'Draw with finger', keywords: 'touch hand palm rejection scroll write with finger', hint: f.on ? 'On' : 'Off', icon: <Pointer size={16} />, run: f.toggle },
  ]);
  return (
    <button type="button" className={cx('icon-btn', 'finger-toggle', f.on && 'is-active')} aria-pressed={f.on} aria-label="Draw with finger"
      title={f.on ? 'Draw with finger: on — one finger writes, two fingers scroll' : 'Draw with finger: off — fingers scroll, the pen writes'} onClick={f.toggle}>
      <Pointer size={19} />
    </button>
  );
}

/**
 * While finger drawing is on, the first pen contact offers to switch back to pen-only writing
 * (so a resting palm stops leaving marks). Asked once per app session; "Keep finger" is
 * remembered on this device.
 */
let askedThisSession = false;

export function StylusSwitchPrompt() {
  const f = useFingerDraw();
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!f.on || askedThisSession || safeStorage.get(KEEP_KEY) === '1') return;
    const onDown = (e: PointerEvent) => {
      if (e.pointerType !== 'pen') return;
      askedThisSession = true;
      setShow(true);
      window.removeEventListener('pointerdown', onDown, true);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [f.on]);
  useEffect(() => { if (!f.on) setShow(false); }, [f.on]);
  if (!show) return null;
  return (
    <div className="stylus-prompt" role="status">
      <span>Pen detected. Let your finger scroll again?</span>
      <button type="button" className="btn btn-sm btn-primary" onClick={() => { f.set(false); setShow(false); }}>Pen only</button>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => { safeStorage.set(KEEP_KEY, '1'); setShow(false); }}>Keep finger</button>
    </div>
  );
}

/** Test seam: forget that the prompt was shown in this session. */
export function resetStylusPromptForTests(): void {
  askedThisSession = false;
}
