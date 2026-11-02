import { useRef } from 'react';

/**
 * Press-and-hold on a button (pen, finger or mouse): runs `onLong` after `ms` without moving. The
 * click that follows the release is swallowed (`consumed()` returns true once), so a long press
 * never also counts as a tap. Used for the eraser's "what to erase" menu in the pen dock.
 */
export function useLongPress(onLong: () => void, ms = 450) {
  const timer = useRef(0);
  const fired = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const cancel = () => { clearTimeout(timer.current); start.current = null; };
  return {
    handlers: {
      onPointerDown: (e: React.PointerEvent) => {
        fired.current = false;
        start.current = { x: e.clientX, y: e.clientY };
        clearTimeout(timer.current);
        timer.current = window.setTimeout(() => { fired.current = true; start.current = null; onLong(); }, ms);
      },
      onPointerMove: (e: React.PointerEvent) => {
        if (start.current && Math.hypot(e.clientX - start.current.x, e.clientY - start.current.y) > 10) cancel();
      },
      onPointerUp: cancel,
      onPointerCancel: cancel,
      onPointerLeave: cancel,
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
    /** True (once) when the click being handled ends a long press. */
    consumed() {
      const f = fired.current;
      fired.current = false;
      return f;
    },
  };
}
