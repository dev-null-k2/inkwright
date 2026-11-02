import { useEffect } from 'react';
import { Cpu, X } from 'lucide-react';
import { formatBytes } from '@inkstone/ai';
import { cancelDownload, chatChoice, downloadModel, embedChoice, initLocalAI, isInstalled, localAISupported, modelKey, refOf, useLocalAI } from '../lib/localai.ts';

/**
 * The one-time offer to run the assistant privately on this device: names the model, says how big
 * the download is before anything is fetched, shows progress with cancel, and resumes a download
 * that was interrupted. Downloads the search model alongside when it is missing (it is small).
 */
export function LocalAISetup({ onReady, compact }: { onReady?: () => void; compact?: boolean }) {
  const st = useLocalAI();
  useEffect(() => { void initLocalAI(); }, []);
  if (!localAISupported() || !st.ready) return null;
  const chat = chatChoice();
  if (!chat) {
    return st.hardware ? <p className="lai-note muted">This device doesn’t have enough memory for an on-device assistant. Search still works, and you can connect an AI provider instead.</p> : null;
  }
  const embed = embedChoice();
  const chatKey = modelKey(refOf(chat));
  const dl = st.downloads[chatKey];
  const embedMissing = !!embed && !isInstalled(embed);
  const total = chat.variant.bytes + (embedMissing && embed ? embed.variant.bytes : 0);
  const partial = st.onDevice[chatKey] ?? 0;
  const start = async () => {
    if (embedMissing && embed) void downloadModel(embed);
    if (await downloadModel(chat)) onReady?.();
  };
  return (
    <div className={compact ? 'lai-offer is-compact' : 'lai-offer'}>
      <div className="lai-offer-head">
        <Cpu size={18} aria-hidden />
        <div>
          <p className="lai-offer-title">Use AI privately on this device</p>
          <p className="muted">{chat.spec.label} runs {chat.variant.device === 'webgpu' ? 'on your graphics chip' : 'on your processor'}. Nothing you write leaves this device, and it works offline once downloaded.</p>
        </div>
      </div>
      {dl && !dl.error ? (
        <div className="lai-progress" role="status" aria-live="polite">
          <div className="lai-bar"><span style={{ width: `${Math.min(100, (dl.loaded / Math.max(1, dl.total)) * 100).toFixed(1)}%` }} /></div>
          <span className="lai-progress-text">{formatBytes(dl.loaded)} of {formatBytes(dl.total)}</span>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => cancelDownload(chat)} aria-label="Cancel download"><X size={14} /> Cancel</button>
        </div>
      ) : (
        <div className="lai-offer-actions">
          <button type="button" className="btn btn-primary" onClick={() => void start()}>
            {partial > 0 ? `Resume download (${formatBytes(Math.max(0, chat.variant.bytes - partial))} left)` : `Download ${formatBytes(total)}`}
          </button>
          {dl?.error && <p className="lai-error" role="alert">{dl.error}</p>}
          <p className="muted small">One-time download{embedMissing && embed ? ` (assistant ${formatBytes(chat.variant.bytes)}, search ${formatBytes(embed.variant.bytes)})` : ''} · {chat.spec.licence} licence · remove it any time in Settings › AI.</p>
        </div>
      )}
    </div>
  );
}
