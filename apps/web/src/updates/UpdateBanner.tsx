import { useState } from 'react';
import { Download } from 'lucide-react';
import { snoozeOffer, useUpdates } from './store.ts';
import { DownloadProgress, PERMISSION_HELP, WhatsNewDialog, phaseText, updater } from './UpdateParts.tsx';

/**
 * The library's update banner: "Inkwright 0.9.0-beta.6 is ready" with What's new, Later (24 h) and
 * Update, which then shows the download, the checks and the install in place. Calm on purpose: no
 * colour alarm, one line on a phone, and it goes away when the update is done or postponed.
 * Loaded only when there is something to show (slot.tsx).
 */
export default function UpdateBanner() {
  const offer = useUpdates((s) => s.offer);
  const phase = useUpdates((s) => s.phase);
  const silent = useUpdates((s) => s.silentInstall);
  const [notes, setNotes] = useState(false);
  if (!offer) return null;
  const update = () => void updater().then((u) => u.startUpdate());

  let detail: React.ReactNode = null;
  let actions: React.ReactNode;
  switch (phase.kind) {
    case 'downloading':
      detail = <DownloadProgress loaded={phase.loaded} total={phase.total} />;
      actions = <button type="button" className="btn btn-ghost" onClick={() => void updater().then((u) => u.cancelUpdate())}>Cancel</button>;
      break;
    case 'verifying':
    case 'installing':
      actions = null;
      break;
    case 'permission':
      detail = <p className="update-banner-detail">{PERMISSION_HELP}</p>;
      actions = <button type="button" className="btn btn-primary" onClick={() => void updater().then((u) => u.allowInstalls())}>Open Android settings</button>;
      break;
    case 'ready':
      actions = <button type="button" className="btn btn-primary" onClick={update}>Install</button>;
      break;
    case 'failed':
      detail = <p className="update-banner-detail">{phase.reason}</p>;
      actions = (
        <>
          <button type="button" className="btn btn-ghost" onClick={() => snoozeOffer()}>Later</button>
          <button type="button" className="btn btn-primary" onClick={update}>Try again</button>
        </>
      );
      break;
    default:
      actions = (
        <>
          <button type="button" className="btn btn-ghost" onClick={() => setNotes(true)}>What’s new</button>
          <button type="button" className="btn btn-ghost" onClick={() => snoozeOffer()}>Later</button>
          <button type="button" className="btn btn-primary" onClick={update}>Update</button>
        </>
      );
  }
  const busy = phase.kind === 'verifying' || phase.kind === 'installing';
  return (
    <section className="update-banner" aria-label="Update" aria-busy={busy || phase.kind === 'downloading'}>
      <Download size={18} aria-hidden className="update-banner-icon" />
      <div className="update-banner-text">
        <p className="update-banner-title" role="status">{phaseText(phase, offer, silent)}</p>
        {detail}
      </div>
      {actions && <div className="update-banner-actions">{actions}</div>}
      <WhatsNewDialog offer={offer} open={notes} onClose={() => setNotes(false)} onUpdate={phase.kind === 'available' ? update : undefined} />
    </section>
  );
}
