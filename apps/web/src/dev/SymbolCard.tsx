import { Check, Copy } from 'lucide-react';
import { formatCodeLink, resolveCodeTarget, type CodeRefState, type CodeSymbol, type CodeTarget } from '@inkstone/core';
import { useApp } from '../state/app.ts';
import { cx } from '../ui/primitives.tsx';
import { useDev } from './store.ts';

const STATUS: Record<CodeRefState['status'], string> = {
  ok: 'Matches the code',
  new: 'Matches the code',
  changed: 'Signature changed since this note was written',
  missing: 'No longer in the code',
  moved: 'Moved to another file',
  unresolved: 'Not found in your code sources',
  unknown: 'No code source on this device covers this file',
};

export const driftWord = (s: CodeRefState['status']) => (s === 'changed' ? 'Changed' : s === 'missing' ? 'Gone' : s === 'moved' ? 'Moved' : null);

/**
 * A code symbol, read-only: what it is, where, its signature and source — and, when the link has
 * drifted, the signature the note was written against next to the one in the code now, with
 * "Mark reviewed". Nothing here edits the note's text.
 */
export function SymbolCard({ target, state, onReviewed }: { target: CodeTarget; state?: CodeRefState; onReviewed?: () => void }) {
  const indexes = useDev((s) => s.indexes);
  const toast = useApp((s) => s.toast);
  const sym: CodeSymbol | null = state?.current ?? resolveCodeTarget(target, indexes).symbol;
  const status = state?.status ?? (sym ? 'ok' : indexes.length ? 'unresolved' : 'unknown');
  const drifted = status === 'changed' || status === 'missing' || status === 'moved';
  const copy = () => {
    void navigator.clipboard?.writeText(formatCodeLink(target)).then(() => toast({ text: 'Link copied' }), () => {});
  };
  return (
    <div className={cx('dev-symbol', drifted && 'is-drift')} data-testid="symbol-card">
      <div className="dev-symbol-head">
        <span className="dev-symbol-name">{sym?.qualified ?? target.symbol ?? target.path}</span>
        {sym && <span className="dev-symbol-kind">{sym.kind}</span>}
      </div>
      <div className="dev-symbol-where">{target.path}{sym ? `:${sym.line}` : ''}</div>
      <p className={cx('dev-symbol-status', drifted && 'is-drift')} role="status">{STATUS[status]}</p>
      {status === 'changed' && state?.baseline && sym && (
        <div className="dev-compare" aria-label="Signature then and now">
          <div><span className="dev-compare-label">When written</span><code className="dev-sig is-old">{state.baseline.signature}</code></div>
          <div><span className="dev-compare-label">Now</span><code className="dev-sig is-new">{sym.signature}</code></div>
        </div>
      )}
      {(status === 'missing' || status === 'moved') && state?.baseline && (
        <div className="dev-compare">
          <div><span className="dev-compare-label">When written</span><code className="dev-sig is-old">{state.baseline.signature}</code></div>
          {state.movedTo?.map((m) => <div key={m.id}><span className="dev-compare-label">Now in</span><code className="dev-sig is-new">{m.id}</code></div>)}
        </div>
      )}
      {sym?.doc && <p className="dev-symbol-doc">{sym.doc}</p>}
      {!drifted && sym && <code className="dev-sig">{sym.signature}</code>}
      {sym?.source && <pre className="dev-source" tabIndex={0} aria-label={`Source of ${sym.qualified}`}><code>{sym.source}</code></pre>}
      <div className="dev-symbol-actions">
        {drifted && onReviewed && <button type="button" className="btn btn-sm btn-primary" onClick={onReviewed}><Check size={14} /> Mark reviewed</button>}
        <button type="button" className="btn btn-sm btn-ghost" onClick={copy}><Copy size={14} /> Copy link</button>
      </div>
    </div>
  );
}
