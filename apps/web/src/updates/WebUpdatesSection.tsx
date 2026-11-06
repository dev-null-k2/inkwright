import { useState } from 'react';
import { Switch, relativeTime } from '../ui/primitives.tsx';
import { applyPlan, planToggle, useModule } from '../modules/registry.ts';
import { APP_VERSION } from '../platform/env.ts';
import { applyWebUpdate, checkWebUpdate, useWebUpdates } from './web.ts';
import { WebNotesDialog } from './WebUpdateBanner.tsx';
import './updates.css';

/**
 * Settings › About › Updates for the web app and Home Screen apps (src/updates/web.ts): the running
 * version, whether a newer one is published, Check now, Update and automatic checks. The same
 * place and words as the Android app's section.
 */
export default function WebUpdatesSection() {
  const s = useWebUpdates();
  const auto = useModule('updates');
  const [notes, setNotes] = useState(false);
  const status = s.applying ? 'Updating…'
    : s.checking ? 'Checking…'
      : s.available ? `Inkwright ${s.available.version} is ready`
        : s.offline ? 'Couldn’t check: offline. Inkwright will try again when you’re online.'
          : s.lastChecked ? 'Up to date' : 'Not checked yet';
  return (
    <section className="set-group" aria-labelledby="updates-h">
      <h2 id="updates-h">Updates</h2>
      <div className="set-card updates-card">
        <div className="updates-status">
          <p className="updates-version">Version {APP_VERSION}</p>
          <p className="updates-state" role="status" aria-live="polite">{status}</p>
          <p className="muted small">{s.lastChecked ? `Last checked ${relativeTime(s.lastChecked)}` : ''}</p>
        </div>
        <div className="row-buttons">
          {s.available && !s.applying && (
            <>
              <button type="button" className="btn btn-primary" onClick={() => void applyWebUpdate()}>Update</button>
              <button type="button" className="btn" onClick={() => setNotes(true)}>What’s new</button>
            </>
          )}
          <button type="button" className="btn" disabled={s.checking || s.applying} onClick={() => void checkWebUpdate()}>Check now</button>
        </div>
        <Switch label="Check automatically" hint="After Inkwright starts, when you come back to it, and every 30 minutes while it’s open." checked={auto}
          onChange={(v) => applyPlan(planToggle('updates', v))} />
      </div>
      <p className="set-note">
        The web app and Home Screen apps update from the published site. A new version also opens by itself the next time Inkwright starts while online; your notes are never touched.
      </p>
      <WebNotesDialog release={notes ? s.available : null} onClose={() => setNotes(false)} onUpdate={() => void applyWebUpdate()} />
    </section>
  );
}
