import { isNative } from '../platform/env.ts';
import { useSettings } from '../state/settings.ts';

/**
 * Sign in with Google and get Drive access. Uses Google Identity Services in browsers and the
 * native Google account sheet on Android/iOS. Scope `drive.file` only lets Inkwright see files it
 * created — never the rest of the user's Drive.
 */
export const GOOGLE_SCOPES = ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'];

let token: { value: string; expires: number } | null = null;
let gisLoaded: Promise<void> | null = null;

function loadGis(): Promise<void> {
  if (gisLoaded) return gisLoaded;
  gisLoaded = new Promise((resolve, reject) => {
    if ((window as any).google?.accounts?.oauth2) return resolve();
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => { gisLoaded = null; reject(new Error('Could not reach Google sign-in. Check your connection.')); };
    document.head.appendChild(s);
  });
  return gisLoaded;
}

function clientId(): string {
  const id = useSettings.getState().sync.googleClientId.trim();
  if (!id) throw new Error('Add your Google OAuth client ID in Settings › Sync & devices first.');
  return id;
}

async function webToken(interactive: boolean): Promise<string> {
  await loadGis();
  const google = (window as any).google;
  return new Promise((resolve, reject) => {
    const client = google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: GOOGLE_SCOPES.join(' '),
      prompt: interactive ? 'consent' : '',
      callback: (r: any) => {
        if (r.error) reject(new Error(r.error_description || r.error));
        else {
          token = { value: r.access_token, expires: Date.now() + (Number(r.expires_in) || 3600) * 1000 - 60_000 };
          resolve(r.access_token);
        }
      },
      error_callback: (e: any) => reject(new Error(e?.message || e?.type || 'Sign-in was cancelled')),
    });
    client.requestAccessToken({ prompt: interactive ? 'consent' : '' });
  });
}

let nativeReady = false;
async function nativeToken(interactive: boolean): Promise<string> {
  const { SocialLogin } = await import('@capgo/capacitor-social-login');
  if (!nativeReady) {
    const iosClientId = (import.meta.env?.VITE_GOOGLE_IOS_CLIENT_ID as string | undefined) ?? '';
    const isIOS = (await import('@capacitor/core')).Capacitor.getPlatform() === 'ios';
    await SocialLogin.initialize({ google: isIOS && iosClientId ? { iOSClientId: iosClientId, iOSServerClientId: clientId(), webClientId: clientId() } : { webClientId: clientId() } } as any);
    nativeReady = true;
  }
  if (!interactive) {
    // Background syncs must never pop the account sheet: refresh silently or fail.
    const r: any = await (SocialLogin as any).refresh?.({ provider: 'google', options: { scopes: GOOGLE_SCOPES } });
    const t = r?.result?.accessToken?.token;
    if (!t) throw new Error('Google sign-in expired. Tap “Sync now” to sign in again.');
    token = { value: t, expires: Date.now() + 50 * 60_000 };
    return t;
  }
  const r: any = await SocialLogin.login({ provider: 'google', options: { scopes: GOOGLE_SCOPES } } as any);
  const t = r?.result?.accessToken?.token;
  if (!t) throw new Error('Google did not return an access token');
  token = { value: t, expires: Date.now() + 50 * 60_000 };
  return t;
}

/** A valid access token, refreshing silently when possible. */
export async function getAccessToken(opts: { interactive?: boolean; forceRefresh?: boolean } = {}): Promise<string> {
  if (!opts.forceRefresh && token && token.expires > Date.now()) return token.value;
  try {
    return isNative ? await nativeToken(false) : await webToken(false);
  } catch (e) {
    if (!opts.interactive) throw e;
    return isNative ? nativeToken(true) : webToken(true);
  }
}

export async function signIn(): Promise<{ email: string; name: string; picture?: string }> {
  const t = isNative ? await nativeToken(true) : await webToken(true);
  const r = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${t}` } });
  if (!r.ok) throw new Error(`Google profile request failed (${r.status})`);
  const p = await r.json();
  const account = { email: p.email as string, name: (p.name as string) || p.email, picture: p.picture as string | undefined };
  useSettings.getState().update((s) => ({ sync: { ...s.sync, account, drive: { ...s.sync.drive, enabled: true } } }));
  return account;
}

export async function signOut() {
  try {
    if (token && !isNative) (window as any).google?.accounts?.oauth2?.revoke?.(token.value, () => {});
    if (isNative) { const { SocialLogin } = await import('@capgo/capacitor-social-login'); await SocialLogin.logout({ provider: 'google' } as any); }
  } catch { /* ignore */ }
  token = null;
  useSettings.getState().update((s) => ({ sync: { ...s.sync, account: null, drive: { ...s.sync.drive, enabled: false } } }));
}
