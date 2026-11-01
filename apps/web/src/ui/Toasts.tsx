import { useApp } from '../state/app.ts';
import { cx } from './primitives.tsx';

export function Toasts() {
  const { toasts, dismissToast } = useApp();
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', t.tone && `is-${t.tone}`)}>
          <span>{t.text}</span>
          {t.action && <button type="button" className="toast-action" onClick={() => { t.action!.run(); dismissToast(t.id); }}>{t.action.label}</button>}
        </div>
      ))}
    </div>
  );
}
