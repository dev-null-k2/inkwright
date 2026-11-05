import { useEffect, useState } from 'react';
import { Switch, relativeTime } from '../ui/primitives.tsx';
import { applyPlan, planToggle, useModule } from '../modules/registry.ts';
import { formatSize } from './messages.ts';
import { updaterPlugin } from './plugin.ts';
import { useUpdates, type CheckNote } from './store.ts';
import { DownloadProgress, PERMISSION_HELP, WhatsNewDialog, phaseText, updater } from './UpdateParts.tsx';

const NOTES: Record<Exclude<CheckNote, null>, string> = {
  offline: 'Couldn’t reach GitHub. Inkwright will try again when you’re online.',
  'rate-limited': 'GitHub is limiting how often this network may ask. Inkwright will try again later.',
  error: 'Couldn’t read the latest release. Inkwright will try again later.',
  'no-apk': 'The newest release has no build for this phone.',
};

/**
 * Settings › About › Updates (Android app from GitHub): the installed version, where an update
 * stands, Check now, the beta channel and automatic checks. Loaded lazily by Settings.
 */
export default function UpdatesSection() {
  const s = useUpdates();
  const auto = useModule('updates');
  const [notes, setNotes] = useState(false);
  const [, tick] = useState(0);
  // "Last checked 2 min ago" stays current while the page is open.
  useEffect(() => { const id = setInterval(() => tick((n) => n + 1), 30_000); return () => clearInterval(id); }, []);
  // The installed version, even when automatic checks are off.
  useEffect(() => {
    if (s.current) return;
    void updaterPlugin()?.appInfo().then((i) => useUpdates.setState({ current: { version: i.version, versionCode: Number(i.build) || 0 } })).catch(() => {});
  }, [s.current]);

  const { phase, offer } = s;
  const busy = phase.kind === 'checking' || phase.kind === 'downloading' || phase.kind === 'verifying' || phase.kind === 'installing';
  const update = () => void updater().then((u) => u.startUpdate());

  return (
    <section className="set-group" aria-labelledby="updates-h">
      <h2 id="updates-h">Updates</h2>
      <div className="set-card updates-card">
        <div className="updates-status">
          <p className="updates-version">
            {s.current ? <>Version {s.current.version} <span className="muted">({s.current.versionCode})</span></> : 'Version unknown'}
          </p>
          <p className="updates-state" role="status" aria-live="polite">
            {phaseText(phase, offer, s.silentInstall)}
            {phase.kind === 'available' && offer ? <span className="muted"> · {formatSize(offer.size)}</span> : null}
          </p>
          {phase.kind === 'downloading' && <DownloadProgress loaded={phase.loaded} total={phase.total} />}
          {phase.kind === 'permission' && <p className="muted small">{PERMISSION_HELP}</p>}
          {phase.kind === 'failed' && <p className="updates-reason">{phase.reason}</p>}
          {s.note && (phase.kind === 'up-to-date' || phase.kind === 'idle' || phase.kind === 'available') && <p className="muted small">{NOTES[s.note]}</p>}
          <p className="muted small">{s.lastChecked ? `Last checked ${relativeTime(s.lastChecked)}` : 'Not checked yet'}</p>
        </div>
        <div className="row-buttons">
          {phase.kind === 'available' && offer && (
            <>
              <button type="button" className="btn btn-primary" onClick={update}>Update</button>
              <button type="button" className="btn" onClick={() => setNotes(true)}>What’s new</button>
            </>
          )}
          {phase.kind === 'downloading' && <button type="button" className="btn" onClick={() => void updater().then((u) => u.cancelUpdate())}>Cancel</button>}
          {phase.kind === 'ready' && <button type="button" className="btn btn-primary" onClick={update}>Install</button>}
          {phase.kind === 'permission' && <button type="button" className="btn btn-primary" onClick={() => void updater().then((u) => u.allowInstalls())}>Open Android settings</button>}
          {phase.kind === 'failed' && <button type="button" className="btn btn-primary" onClick={update}>Try again</button>}
          <button type="button" className="btn" disabled={busy} onClick={() => void updater().then((u) => u.checkForUpdates({ manual: true }))}>Check now</button>
        </div>
        <Switch label="Beta updates" hint="Test releases, before everyone else. Inkwright ships only betas for now." checked={s.beta}
          onChange={(v) => void updater().then((u) => u.setBetaUpdates(v))} />
        <Switch label="Check automatically" hint="After Inkwright starts and every 6 hours while it’s open." checked={auto}
          onChange={(v) => applyPlan(planToggle('updates', v))} />
      </div>
      <p className="set-note">
        Updates come from Inkwright’s releases on GitHub. Each one is checked against its published checksum and installed only if it is signed with the same key as this app.
        {s.silentInstall ? ' Android installs them without asking.' : s.sdk != null && s.sdk < 31 ? ' Android asks you to confirm each one.' : ' Android asks you to confirm the first update; later ones install by themselves.'}
      </p>
      {offer && <WhatsNewDialog offer={offer} open={notes} onClose={() => setNotes(false)} onUpdate={phase.kind === 'available' ? update : undefined} />}
    </section>
  );
}
