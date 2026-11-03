/**
 * A menu with sub-sheets: the editor's ••• menu keeps a handful of entries at the top and moves
 * the rest one level down (Page, Insert, Share & export…), opened in place inside the same popover
 * or bottom sheet rather than as a cascading flyout, which would not fit a phone or a folded screen.
 *
 * It follows the WAI-ARIA menu pattern like {@link Menu} in primitives.tsx: focus starts on the
 * first item; ↑ ↓ Home End move; → Enter or Space open a sub-sheet; ← or Escape go back up (Escape
 * at the top closes the popover, which owns that key). A sub-sheet's first row is a "back" item
 * named after the sheet it returns to, so screen-reader users always know where they are.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from './primitives.tsx';

/** A command: runs and closes the menu. */
export interface MenuLeaf {
  label: string;
  icon?: ReactNode;
  hint?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: () => void;
}

/** A sub-sheet: a named group of further entries. */
export interface MenuBranch {
  label: string;
  icon?: ReactNode;
  /** Shown at the right of the row, e.g. a short summary of what is inside. */
  hint?: string;
  items: MenuNode[];
}

export type MenuNode = MenuLeaf | MenuBranch | 'sep';

export const isBranch = (n: MenuNode): n is MenuBranch => n !== 'sep' && 'items' in n;

const ITEM = '[role="menuitem"]:not(:disabled)';

export function MenuTree({ items, onClose, label }: { items: MenuNode[]; onClose: () => void; label: string }) {
  // The open sub-sheets, outermost first, and the row each was opened from (focus returns there).
  const [path, setPath] = useState<{ branch: MenuBranch; from: number }[]>([]);
  const ref = useRef<HTMLDivElement>(null);
  const focusIndex = useRef<number | null>(null);
  const level = path.length ? path[path.length - 1]!.branch : null;
  const current = level ? level.items : items;
  const parentLabel = path.length > 1 ? path[path.length - 2]!.branch.label : label;

  // On open the popover is invisible (unfocusable) until it has placed itself: wait a frame.
  useEffect(() => {
    const id = requestAnimationFrame(() => ref.current?.querySelector<HTMLButtonElement>(ITEM)?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(id);
  }, []);

  // After moving between levels: the sub-sheet's first entry, or the row we came back to.
  useLayoutEffect(() => {
    const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>(ITEM) ?? [])];
    const want = focusIndex.current;
    focusIndex.current = null;
    if (want == null) return;
    all[Math.min(want, all.length - 1)]?.focus({ preventScroll: true });
    ref.current?.scrollTo?.({ top: 0 });
  }, [path]);

  const open = (branch: MenuBranch, from: number) => {
    focusIndex.current = 1; // the row after "back"
    setPath((p) => [...p, { branch, from }]);
  };
  const back = () => {
    if (!path.length) return false;
    focusIndex.current = path[path.length - 1]!.from;
    setPath((p) => p.slice(0, -1));
    return true;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const all = [...(ref.current?.querySelectorAll<HTMLButtonElement>(ITEM) ?? [])];
    if (!all.length) return;
    const i = all.indexOf(document.activeElement as HTMLButtonElement);
    // Keys the menu handles stay in the menu: the editor turns pages on ← → and closes panels on Escape.
    const keep = () => { e.preventDefault(); e.stopPropagation(); e.nativeEvent.stopImmediatePropagation(); };
    if (e.key === 'ArrowLeft' || (e.key === 'Escape' && path.length)) {
      // Escape inside a sub-sheet goes up one level; the popover must not also close.
      back();
      keep();
      return;
    }
    if (e.key === 'ArrowRight') {
      keep();
      const el = all[i];
      if (el?.getAttribute('aria-haspopup')) el.click();
      return;
    }
    const to = e.key === 'ArrowDown' ? (i + 1) % all.length : e.key === 'ArrowUp' ? (i - 1 + all.length) % all.length : e.key === 'Home' ? 0 : e.key === 'End' ? all.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    all[to]!.focus();
  };

  // Row indices count only items (not separators) so "from" maps back to a focusable row.
  let row = path.length ? 1 : 0;
  return (
    <div className={cx('menu menu-tree', level && 'is-sub')} role="menu" aria-label={level ? level.label : label} ref={ref} onKeyDown={onKeyDown} key={path.length}>
      {level && (
        <button type="button" role="menuitem" className="menu-item menu-back" aria-label={`Back to ${parentLabel}`} onClick={() => back()}>
          <span className="menu-icon"><ChevronLeft size={16} /></span>
          <span className="menu-label menu-sheet-title">{level.label}</span>
        </button>
      )}
      {current.map((it, i) => {
        if (it === 'sep') return <div key={`s${i}`} className="menu-sep" role="separator" />;
        const at = row++;
        if (isBranch(it)) {
          return (
            <button key={i} type="button" role="menuitem" aria-haspopup="menu" aria-expanded={false} className="menu-item is-branch" onClick={() => open(it, at)}>
              {it.icon && <span className="menu-icon">{it.icon}</span>}
              <span className="menu-label">{it.label}</span>
              {it.hint && <span className="menu-hint">{it.hint}</span>}
              <span className="menu-chevron" aria-hidden><ChevronRight size={15} /></span>
            </button>
          );
        }
        return (
          <button key={i} type="button" role="menuitem" disabled={it.disabled} className={cx('menu-item', it.danger && 'is-danger')} onClick={() => { onClose(); it.onClick(); }}>
            {it.icon && <span className="menu-icon">{it.icon}</span>}
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        );
      })}
    </div>
  );
}
