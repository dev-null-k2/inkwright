import { useEffect, useState } from 'react';
import { Download, Sparkles } from 'lucide-react';
import { Dialog } from '../ui/primitives.tsx';
import { APP_VERSION, safeStorage } from '../platform/env.ts';
import { ReleaseNotes } from './ReleaseNotes.tsx';
import { applyWebUpdate, dismissUpdated, fetchRelease, useWebUpdates, type WebRelease } from './web.ts';
import './updates.css';

const LATER = 'inkwright.web.later';

/**
 * The library's update banner for the web app and Home Screen apps (src/updates/web.ts): the same
 * words and buttons as the Android one: "Inkwright 0.9.1 is ready" · What's new · Later · Update.
 * After an update it says "Updated to 0.9.1" once, with What's new.
 */
export default function WebUpdateBanner() {
  const available = useWebUpdates((s) => s.available);
  const updatedFrom = useWebUpdates((s) => s.updatedFrom);
  const applying = useWebUpdates((s) => s.applying);
  const [notesFor, setNotesFor] = useState<WebRelease | null>(null);
  const [later, setLater] = useState(() => safeStorage.get(LATER));

  if (available && later !== available.version) {
    return (
      <section className="update-banner" aria-label="Update" aria-busy={applying}>
        <Download size={18} aria-hidden className="update-banner-icon" />
        <div className="update-banner-text">
          <p className="update-banner-title" role="status">{applying ? 'Updating Inkwright…' : `Inkwright ${available.version} is ready`}</p>
          {!applying && <p className="update-banner-detail">Takes a few seconds. Your notes stay as they are.</p>}
        </div>
        {!applying && (
          <div className="update-banner-actions">
            <button type="button" className="btn btn-ghost" onClick={() => setNotesFor(available)}>What’s new</button>
            <button type="button" className="btn btn-ghost" onClick={() => { safeStorage.set(LATER, available.version); setLater(available.version); }}>Later</button>
            <button type="button" className="btn btn-primary" onClick={() => void applyWebUpdate()}>Update</button>
          </div>
        )}
        <WebNotesDialog release={notesFor} onClose={() => setNotesFor(null)} onUpdate={() => void applyWebUpdate()} />
      </section>
    );
  }
  if (updatedFrom) return <UpdatedNotice />;
  return null;
}

/** "Updated to 0.9.1" with the notes, shown once after an update. */
function UpdatedNotice() {
  const [release, setRelease] = useState<WebRelease | null>(null);
  const [open, setOpen] = useState(false);
  // The notes are the deployment's; they describe this version only when it is the one served.
  useEffect(() => { void fetchRelease().then((r) => setRelease(r && r.version === APP_VERSION ? r : null)); }, []);
  const version = APP_VERSION;
  return (
    <section className="update-banner" aria-label="Updated">
      <Sparkles size={18} aria-hidden className="update-banner-icon" />
      <div className="update-banner-text">
        <p className="update-banner-title" role="status">{`Updated to Inkwright ${version}`}</p>
      </div>
      <div className="update-banner-actions">
        {release?.notes ? <button type="button" className="btn btn-ghost" onClick={() => setOpen(true)}>What’s new</button> : null}
        <button type="button" className="btn btn-ghost" onClick={dismissUpdated}>Done</button>
      </div>
      <WebNotesDialog release={open ? release : null} onClose={() => { setOpen(false); dismissUpdated(); }} />
    </section>
  );
}

export function WebNotesDialog({ release, onClose, onUpdate }: { release: WebRelease | null; onClose: () => void; onUpdate?: () => void }) {
  return (
    <Dialog open={!!release} title={`What’s new in ${release?.version ?? ''}`} onClose={onClose} actions={
      <>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        {onUpdate && <button type="button" className="btn btn-primary" onClick={() => { onClose(); onUpdate(); }}>Update</button>}
      </>
    }>
      <div className="update-notes-scroll">
        <ReleaseNotes markdown={release?.notes ?? ''} />
      </div>
      <p className="muted small">
        <a href="https://github.com/dev-null-k2/inkwright/releases" target="_blank" rel="noopener noreferrer">All releases on GitHub</a>
      </p>
    </Dialog>
  );
}
