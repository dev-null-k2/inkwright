/**
 * Calm, accurate words for on-device model downloads and their errors.
 *
 * Android's AICore reports its own restarts as errors. While it was still downloading Gemini Nano
 * on a Razr Fold, Settings showed, in red, "On-device AI failed: [ErrorCode 6] AICore failed with
 * error type 1-DOWNLOAD_ERROR and error code 6-IPC_ERROR: AICore service disconnected" — next to
 * downloads that were progressing fine. That is not a failure: the service reconnects and the
 * download continues. These functions turn every state into one of four plain situations
 * (downloading, preparing, retrying automatically, really failed with something to do), keep the
 * raw error for a "Details" disclosure, and pace automatic retries.
 */

/** Stable codes from the Kotlin bridge (AiException.code), plus `retrying` set by the web layer. */
export type DownloadIssueKind = 'transient' | 'network' | 'storage' | 'update' | 'unsupported' | 'memory' | 'failed';

const TRANSIENT_CODES = new Set(['service', 'busy', 'quota', 'background', 'download']);
const TRANSIENT_TEXT = /IPC_ERROR|service disconnected|DeadObject|binder|not connected to (the )?service|temporarily|try again (later|in a moment)/i;
const NETWORK_TEXT = /network|offline|timed? ?out|connection|unreachable|host|DNS|SSL|socket/i;

/** What kind of problem an error is, from its code and (for AICore) its text. */
export function classifyDownloadError(code: string | undefined, message: string | undefined): DownloadIssueKind {
  const m = message ?? '';
  if (code === 'disk' || (code !== 'service' && /not enough (free )?(disk|storage|space)/i.test(m))) return 'storage';
  if (code === 'update') return 'update';
  if (code === 'unsupported') return 'unsupported';
  if (code === 'memory') return 'memory';
  if (code === 'network' || (code !== 'service' && NETWORK_TEXT.test(m) && !TRANSIENT_TEXT.test(m))) return 'network';
  if ((code && TRANSIENT_CODES.has(code)) || TRANSIENT_TEXT.test(m)) return 'transient';
  return 'failed';
}

/** Kinds worth retrying on our own (with backoff) before asking the person to do anything. */
export function retriesOnItsOwn(kind: DownloadIssueKind): boolean {
  return kind === 'transient' || kind === 'network';
}

/** Delay before automatic retry `attempt` (1-based): 3 s, 8 s, 20 s, 45 s, 90 s; null after that. */
export function retryDelayMs(attempt: number): number | null {
  const steps = [3_000, 8_000, 20_000, 45_000, 90_000];
  return attempt >= 1 && attempt <= steps.length ? steps[attempt - 1]! : null;
}

export interface DownloadIssue {
  /** `retrying`: shown calmly, no red; `error`: the person can act. */
  tone: 'retrying' | 'error';
  headline: string;
  /** The raw error, for a Details disclosure (never the headline). */
  detail?: string;
  /** Offer a Retry button. */
  canRetry: boolean;
}

/** The sentence to show for a download problem of `what` ("Gemini Nano", "Qwen3 1.7B"). */
export function describeDownloadIssue(what: string, kind: DownloadIssueKind, raw?: string, retrying = false): DownloadIssue {
  const detail = raw?.trim() || undefined;
  switch (kind) {
    case 'transient':
      return retrying
        ? { tone: 'retrying', headline: `Android’s AI service restarted while preparing ${what}. Retrying automatically…`, detail, canRetry: false }
        : { tone: 'error', headline: `Android’s AI service kept disconnecting, so ${what} isn’t ready yet. Android usually finishes on its own; you can also try again.`, detail, canRetry: true };
    case 'network':
      return retrying
        ? { tone: 'retrying', headline: `The connection dropped. Retrying automatically…`, detail, canRetry: false }
        : { tone: 'error', headline: `${what} couldn’t download: check the connection, then try again. It continues where it stopped.`, detail, canRetry: true };
    case 'storage':
      return { tone: 'error', headline: `Not enough free storage for ${what}. Free some space, then try again.`, detail, canRetry: true };
    case 'update':
      return { tone: 'error', headline: `Update Android System Intelligence (AICore) from the Play Store, then try again.`, detail, canRetry: true };
    case 'unsupported':
      return { tone: 'error', headline: `${what} isn’t available on this phone.`, detail, canRetry: false };
    case 'memory':
      return { tone: 'error', headline: `This phone doesn’t have enough memory for ${what}. Choose a smaller model.`, detail, canRetry: false };
    default:
      return { tone: 'error', headline: `${what} didn’t finish downloading. Try again.`, detail, canRetry: true };
  }
}

export interface ProgressLike {
  phase: string;
  loaded: number;
  total: number;
}

/**
 * What a download button says. Every download in Settings › AI uses this, so none of them can say
 * "Download" while it is downloading again.
 */
export type ButtonState =
  | { kind: 'idle' }
  | { kind: 'active'; label: string; percent: number | null; cancellable: boolean }
  | { kind: 'ready' };

export function downloadButtonState(o: { ready: boolean; progress?: ProgressLike | null; systemDownloading?: boolean; cancellable?: boolean }): ButtonState {
  if (o.ready) return { kind: 'ready' };
  const p = o.progress;
  if (p && p.phase !== 'failed') {
    const percent = p.total > 0 ? Math.max(0, Math.min(100, Math.round((p.loaded / p.total) * 100))) : null;
    const label = p.phase === 'retrying' ? 'Retrying…' : p.phase === 'verify' ? 'Checking…' : percent == null ? (p.phase === 'started' ? 'Starting…' : 'Downloading…') : `Downloading… ${percent}%`;
    return { kind: 'active', label, percent, cancellable: o.cancellable !== false };
  }
  // Android downloads system models (Gemini Nano, the writing tools) itself; we can only wait.
  if (o.systemDownloading) return { kind: 'active', label: 'Downloading…', percent: null, cancellable: false };
  return { kind: 'idle' };
}
