/**
 * The OAuth redirect for connected apps lands on the app's own address with `?code=…&state=…`.
 * In the sign-in popup we hand the parameters to the main window (BroadcastChannel, which survives
 * authorization servers that cut the opener link, plus postMessage) and close; after a full-page
 * sign-in (popups blocked) we stash them for the app to finish once it has loaded.
 */
import { parseOAuthCallback } from '@inkwright/ai';
import { safeStorage } from '../../platform/env.ts';
import { OAUTH_CALLBACK_KEY, OAUTH_CHANNEL } from './mcp.ts';

/** Returns true when this window only exists to finish a sign-in (don't start the app in it). */
export function handleOAuthRedirect(): boolean {
  if (typeof location === 'undefined' || !location.search) return false;
  const cb = parseOAuthCallback(location.search);
  if (!cb) return false;
  const search = location.search;
  const isPopup = window.name === 'inkwright-mcp-signin' || !!window.opener;
  if (isPopup) {
    try { new BroadcastChannel(OAUTH_CHANNEL).postMessage({ search }); } catch { /* old browser */ }
    try { window.opener?.postMessage({ type: OAUTH_CHANNEL, search }, location.origin); } catch { /* opener gone */ }
    document.title = 'Signed in — Inkwright';
    const root = document.getElementById('root');
    if (root) root.innerHTML = '<p style="font: 15px system-ui; padding: 32px; text-align: center">You’re signed in. You can close this window.</p>';
    setTimeout(() => window.close(), 300);
    return true;
  }
  safeStorage.set(OAUTH_CALLBACK_KEY, search);
  const back = safeStorage.get('inkwright.mcp.return') ?? '';
  safeStorage.remove('inkwright.mcp.return');
  history.replaceState(null, '', `${location.pathname}${back}`);
  return false;
}
