import { Dialog } from '../ui/primitives.tsx';
import { ReleaseNotes } from './ReleaseNotes.tsx';
import { formatSize } from './messages.ts';
import type { UpdateOffer, UpdatePhase } from './store.ts';
import './updates.css';

/** The updater's actions, loaded on first use (the module has usually loaded them already). */
export const updater = () => import('./service.ts');

export function DownloadProgress({ loaded, total }: { loaded: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.floor((loaded / total) * 100)) : 0;
  return (
    <div className="update-progress" role="progressbar" aria-label="Downloading the update" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      <span className="update-bar"><span style={{ width: `${pct}%` }} /></span>
      <span className="update-progress-text">{pct}% of {formatSize(total)}</span>
    </div>
  );
}

/** "What's new": the release's notes from the CHANGELOG, with a link to the release page. */
export function WhatsNewDialog({ offer, open, onClose, onUpdate }: { offer: UpdateOffer; open: boolean; onClose: () => void; onUpdate?: () => void }) {
  return (
    <Dialog open={open} title={`What’s new in ${offer.version}`} onClose={onClose} actions={
      <>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        {onUpdate && <button type="button" className="btn btn-primary" onClick={() => { onClose(); onUpdate(); }}>Update</button>}
      </>
    }>
      <div className="update-notes-scroll">
        <ReleaseNotes markdown={offer.notes} />
      </div>
      <p className="muted small">
        {offer.published ? `Published ${new Date(offer.published).toLocaleDateString()} · ` : ''}{formatSize(offer.size)} ·{' '}
        <a href={offer.pageUrl} target="_blank" rel="noopener noreferrer">Release page on GitHub</a>
      </p>
    </Dialog>
  );
}

/** One plain line for where an update stands (Settings and the banner share the wording). */
export function phaseText(phase: UpdatePhase, offer: UpdateOffer | null, silentInstall: boolean): string {
  const v = offer ? `Inkwright ${offer.version}` : 'The update';
  switch (phase.kind) {
    case 'idle': return 'Not checked yet';
    case 'checking': return 'Checking for updates…';
    case 'up-to-date': return 'Inkwright is up to date';
    case 'available': return `${v} is ready`;
    case 'downloading': return `Downloading ${v}…`;
    case 'verifying': return 'Checking the download…';
    case 'ready': return `${v} is ready to install`;
    case 'permission': return 'Allow Inkwright to install updates';
    case 'installing': return silentInstall ? `Installing ${v}…` : `Installing ${v}… Confirm on Android’s screen if it asks.`;
    case 'failed': return 'The update didn’t finish';
  }
}

export const PERMISSION_HELP = 'Android asks once before an app may install updates. Turn on “Allow from this source” for Inkwright, then come back here.';
