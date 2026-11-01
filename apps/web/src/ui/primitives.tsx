import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

export function IconButton(props: {
  label: string;
  onClick?: (e: React.MouseEvent<HTMLButtonElement>) => void;
  active?: boolean;
  disabled?: boolean;
  children: ReactNode;
  className?: string;
  shortcut?: string;
  tone?: 'default' | 'seal';
  id?: string;
}) {
  const title = props.shortcut ? `${props.label} (${props.shortcut})` : props.label;
  return (
    <button
      id={props.id}
      type="button"
      className={cx('icon-btn', props.active && 'is-active', props.tone === 'seal' && 'is-seal', props.className)}
      aria-label={props.label}
      aria-pressed={props.active}
      title={title}
      disabled={props.disabled}
      onClick={props.onClick}
    >
      {props.children}
    </button>
  );
}

export function Switch({ checked, onChange, label, hint, id }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string; id?: string }) {
  return (
    <label className="row-switch">
      <span className="row-text">
        <span className="row-label">{label}</span>
        {hint && <span className="row-hint">{hint}</span>}
      </span>
      <input id={id} type="checkbox" role="switch" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span className="switch" aria-hidden />
    </label>
  );
}

export function Slider({ value, min, max, step, onChange, label, format }: { value: number; min: number; max: number; step: number; onChange: (v: number) => void; label: string; format?: (v: number) => string }) {
  return (
    <label className="row-slider">
      <span className="row-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={value} onChange={(e) => onChange(Number(e.target.value))} aria-label={label} />
      <output>{format ? format(value) : value}</output>
    </label>
  );
}

export function Segmented<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string; icon?: ReactNode }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} className={cx(value === o.value && 'is-on')} onClick={() => onChange(o.value)}>
          {o.icon}
          <span>{o.label}</span>
        </button>
      ))}
    </div>
  );
}

/**
 * Anchored popover on wide screens, bottom sheet on phones. Closes on outside press / Escape.
 */
export function Popover({ anchor, open, onClose, children, className, placement = 'auto', title }: {
  anchor: HTMLElement | null;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
  className?: string;
  placement?: 'auto' | 'right' | 'below' | 'above';
  title?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [sheet, setSheet] = useState(false);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const narrow = window.innerWidth < 700;
      setSheet(narrow);
      if (narrow || !anchor || !ref.current) return setPos(null);
      const a = anchor.getBoundingClientRect();
      const r = ref.current.getBoundingClientRect();
      let left: number, top: number;
      const p = placement === 'auto' ? (a.left < 120 ? 'right' : a.top > window.innerHeight / 2 ? 'above' : 'below') : placement;
      if (p === 'right') { left = a.right + 10; top = a.top + a.height / 2 - r.height / 2; }
      else if (p === 'above') { left = a.left + a.width / 2 - r.width / 2; top = a.top - r.height - 10; }
      else { left = a.left + a.width / 2 - r.width / 2; top = a.bottom + 10; }
      left = Math.max(8, Math.min(window.innerWidth - r.width - 8, left));
      top = Math.max(8, Math.min(window.innerHeight - r.height - 8, top));
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open, anchor, placement]);
  useEffect(() => {
    if (!open) return;
    const down = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor?.contains(t)) return;
      onClose();
    };
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const id = setTimeout(() => window.addEventListener('pointerdown', down, true), 0);
    window.addEventListener('keydown', key);
    return () => { clearTimeout(id); window.removeEventListener('pointerdown', down, true); window.removeEventListener('keydown', key); };
  }, [open, anchor, onClose]);
  if (!open) return null;
  return createPortal(
    <>
      {sheet && <div className="sheet-scrim" onClick={onClose} />}
      <div
        ref={ref}
        role="dialog"
        aria-label={title}
        className={cx('popover', sheet && 'is-sheet', className)}
        style={sheet ? undefined : pos ? { left: pos.left, top: pos.top } : { visibility: 'hidden', left: 0, top: 0 }}
      >
        {sheet && <div className="sheet-grip" aria-hidden />}
        {children}
      </div>
    </>,
    document.body,
  );
}

export function Dialog({ open, title, children, onClose, actions, wide }: { open: boolean; title: string; children: ReactNode; onClose: () => void; actions?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [open, onClose]);
  if (!open) return null;
  return createPortal(
    <div className="dialog-scrim" onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={cx('dialog', wide && 'is-wide')} role="dialog" aria-modal="true" aria-label={title}>
        <h2 className="dialog-title">{title}</h2>
        <div className="dialog-body">{children}</div>
        {actions && <div className="dialog-actions">{actions}</div>}
      </div>
    </div>,
    document.body,
  );
}

export function Menu({ items, onClose }: { items: ({ label: string; icon?: ReactNode; onClick: () => void; danger?: boolean; hint?: string; disabled?: boolean } | 'sep')[]; onClose: () => void }) {
  return (
    <div className="menu" role="menu">
      {items.map((it, i) =>
        it === 'sep' ? <div key={i} className="menu-sep" role="separator" /> : (
          <button key={i} type="button" role="menuitem" disabled={it.disabled} className={cx('menu-item', it.danger && 'is-danger')} onClick={() => { onClose(); it.onClick(); }}>
            {it.icon && <span className="menu-icon">{it.icon}</span>}
            <span className="menu-label">{it.label}</span>
            {it.hint && <span className="menu-hint">{it.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

export function useMediaQuery(q: string) {
  const [m, setM] = useState(() => typeof matchMedia !== 'undefined' && matchMedia(q).matches);
  useEffect(() => {
    const mq = matchMedia(q);
    const f = () => setM(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [q]);
  return m;
}

export function relativeTime(t: number, now = Date.now()) {
  const d = (now - t) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86400) return `${Math.round(d / 3600)} h ago`;
  const days = Math.round(d / 86400);
  if (days < 7) return days === 1 ? 'yesterday' : `${days} days ago`;
  return new Date(t).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: new Date(t).getFullYear() === new Date(now).getFullYear() ? undefined : 'numeric' });
}
