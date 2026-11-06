import { beforeEach, describe, expect, it, vi } from 'vitest';
import { finishRedirectSignIn, redirectSignInUrl, redirectUri } from './google.ts';

describe('Google sign-in by redirect (Home Screen apps on iPhone and iPad)', () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); history.replaceState(null, '', '/inkwright/app/'); });

  it('returns to the app folder with a token and the state', () => {
    expect(redirectUri('https://dev-null-k2.github.io/inkwright/app/index.html#note/x')).toBe('https://dev-null-k2.github.io/inkwright/app/');
    const u = new URL(redirectSignInUrl('id.apps.googleusercontent.com', 'abc', 'https://dev-null-k2.github.io/inkwright/app/#settings'));
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('response_type')).toBe('token');
    expect(u.searchParams.get('redirect_uri')).toBe('https://dev-null-k2.github.io/inkwright/app/');
    expect(u.searchParams.get('state')).toBe('abc');
    expect(u.searchParams.get('scope')).toContain('drive.file');
  });

  it('takes the token only with the state it sent, and puts the address back', () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ email: 'a@b.c', name: 'A' }))));
    localStorage.setItem('inkwright.google.redirect', JSON.stringify({ state: 's1', back: '#settings', at: Date.now() }));
    history.replaceState(null, '', '/inkwright/app/#access_token=wrong&state=other');
    expect(finishRedirectSignIn()).toBe(false);
    history.replaceState(null, '', '/inkwright/app/#access_token=tok&expires_in=3599&token_type=Bearer&state=s1');
    expect(finishRedirectSignIn()).toBe(true);
    expect(location.hash).toBe('#settings');
    expect(JSON.parse(sessionStorage.getItem('inkwright.google.token')!).value).toBe('tok');
    expect(localStorage.getItem('inkwright.google.redirect')).toBeNull();
    vi.unstubAllGlobals();
  });

  it('a cancelled sign-in just goes back', () => {
    localStorage.setItem('inkwright.google.redirect', JSON.stringify({ state: 's2', back: '', at: Date.now() }));
    history.replaceState(null, '', '/inkwright/app/#error=access_denied&state=s2');
    expect(finishRedirectSignIn()).toBe(true);
    expect(location.hash).toBe('');
    expect(sessionStorage.getItem('inkwright.google.token')).toBeNull();
  });

  it('ignores ordinary addresses', () => {
    history.replaceState(null, '', '/inkwright/app/#note/abc');
    expect(finishRedirectSignIn()).toBe(false);
  });
});
