import './assistant.css';
import { Check, Download, Loader2, RotateCcw, X } from 'lucide-react';
import { classifyDownloadError, describeDownloadIssue, downloadButtonState, type ProgressLike } from '../../lib/assistant/download-status.ts';
import { cx } from '../primitives.tsx';

/**
 * The action side of a download row in Settings › AI. One component for every download (Gemini
 * Nano, the writing tools, open models on the phone, models in the browser), so the button always
 * tells the truth: "Download" before, "Downloading… 68%" with Cancel during, "Ready" after.
 */
export function DownloadButton({ ready, progress, systemDownloading, onStart, onCancel, startLabel = 'Download', readyLabel = 'Ready', what }: {
  ready: boolean;
  progress?: ProgressLike | null;
  /** Android is downloading it by itself (no progress of ours to show, nothing to cancel). */
  systemDownloading?: boolean;
  onStart: () => void;
  onCancel?: () => void;
  startLabel?: string;
  readyLabel?: string;
  /** For screen readers: "Cancel downloading Gemini Nano". */
  what: string;
}) {
  const st = downloadButtonState({ ready, progress: progress ?? null, systemDownloading: !!systemDownloading, cancellable: !!onCancel });
  if (st.kind === 'ready') return <span className="lai-ok" data-state="ready"><Check size={14} /> {readyLabel}</span>;
  if (st.kind === 'active') {
    return (
      <span className="dl-active" data-state="downloading">
        {/* Not a live region: the row's progress bar already announces progress. */}
        <span className="dl-status"><Loader2 size={14} className="dl-spin" aria-hidden /> {st.label}</span>
        {st.cancellable && onCancel && <button type="button" className="btn btn-sm btn-ghost" aria-label={`Cancel downloading ${what}`} onClick={onCancel}><X size={14} /> Cancel</button>}
      </span>
    );
  }
  return <button type="button" className="btn btn-sm" data-state="idle" onClick={onStart}><Download size={14} /> {startLabel}</button>;
}

/**
 * A download problem in plain words: retries in progress are calm (no red), real failures say what
 * to do, and the raw error (AICore's "[ErrorCode 6] … IPC_ERROR …") is only under Details.
 */
export function DownloadIssueLine({ what, progress, onRetry }: { what: string; progress?: { phase: string; error?: string; code?: string } | null; onRetry?: () => void }) {
  if (!progress || (progress.phase !== 'failed' && progress.phase !== 'retrying') || !progress.error) return null;
  const issue = describeDownloadIssue(what, classifyDownloadError(progress.code, progress.error), progress.error, progress.phase === 'retrying');
  return (
    <div className={cx('dl-issue', issue.tone === 'error' ? 'is-error' : 'is-retrying')} role={issue.tone === 'error' ? 'alert' : 'status'}>
      <p>{issue.headline}</p>
      <div className="dl-issue-row">
        {issue.canRetry && onRetry && <button type="button" className="btn btn-sm btn-ghost" onClick={onRetry}><RotateCcw size={13} /> Try again</button>}
        {issue.detail && (
          <details className="dl-details">
            <summary>Details</summary>
            <code>{issue.detail}</code>
          </details>
        )}
      </div>
    </div>
  );
}
