import { useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { Dialog } from './primitives.tsx';
import { isNative } from '../platform/env.ts';
import { useApp } from '../state/app.ts';

/**
 * Shown when "Sign in with Google" is tapped in a build that has no Google OAuth client ID.
 *
 * Google only lets an app sign people in after its publisher registers it (a free OAuth client in
 * Google Cloud), so a build without one can't offer sign-in — but a greyed-out button explains
 * nothing. This says what's missing in plain words, points to what works right now (WebDAV, a
 * folder, pairing devices), and lets the publisher paste a client ID to try it out.
 */
export function GoogleSetupDialog({ open, onClose, clientId, onClientId, onSignIn }: {
  open: boolean;
  onClose: () => void;
  clientId: string;
  onClientId: (id: string) => void;
  onSignIn: () => void;
}) {
  const [draft, setDraft] = useState(clientId);
  const navigate = useApp((s) => s.navigate);
  const valid = /^[\w-]+\.apps\.googleusercontent\.com$/.test(draft.trim());
  return (
    <Dialog
      open={open}
      title="Google sign-in isn't set up in this build"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="btn" onClick={onClose}>Close</button>
          {draft.trim() && <button type="button" className="btn btn-primary" disabled={!valid} onClick={() => { onClientId(draft.trim()); onSignIn(); }}>Save and sign in</button>}
        </>
      }
    >
      <div className="google-setup">
        <p>
          Google lets an app sign you in only after its publisher registers it. This copy of Inkwright doesn't have that key yet, so it can't
          open Google's sign-in.
        </p>
        <p className="muted">Your notes are safe on this device. While you wait, these sync without Google:</p>
        <ul className="google-setup-alts">
          <li><button type="button" className="link-btn" onClick={() => { onClose(); navigate({ name: 'settings', section: 'devices' }); }}>Pair your devices</button> — phone and computer sync directly, end-to-end encrypted.</li>
          <li><b>WebDAV</b> (Nextcloud, Synology…) — just below on this page.</li>
          {!isNative && <li><b>A folder</b> on this computer — also below.</li>}
        </ul>
        <details className="google-setup-dev">
          <summary>I publish this app — add the client ID</summary>
          <ol>
            <li>In <a href="https://console.cloud.google.com/apis/credentials" target="_blank" rel="noreferrer">Google Cloud › Credentials <ExternalLink size={12} /></a>, enable the Google Drive API and create a <b>Web application</b> OAuth client{isNative ? <> plus an <b>Android</b> client for <code>app.inkwright</code> with your signing key's SHA-1</> : <> with <code>{location.origin}</code> as an authorized JavaScript origin</>}.</li>
            <li>Paste the <b>web</b> client ID here to try it, or build it in with <code>VITE_GOOGLE_CLIENT_ID</code> so everyone gets the button working (docs/GOOGLE_SETUP.md).</li>
          </ol>
          <label className="field">
            <span className="field-label">Web client ID</span>
            <input value={draft} placeholder="1234-abc.apps.googleusercontent.com" autoComplete="off" spellCheck={false} onChange={(e) => setDraft(e.target.value)} />
            {draft && !valid && <span className="muted small">A client ID ends in .apps.googleusercontent.com</span>}
          </label>
        </details>
      </div>
    </Dialog>
  );
}
