/**
 * Takes a join link's code out of the address bar before the app routes. A link someone sent
 * (`…/app/#join=K7PM-2Q9X`) carries the code in the URL fragment, which browsers never send to
 * the server hosting the app; the router would replace that fragment with a route, so this module
 * — imported first by main.tsx — keeps it for the join sheet (PeerGlobal) and removes it from the
 * address bar and history. Nothing connects until the person taps Join.
 */
let pending: string | null = null;

const isJoin = (hash: string) => /^#(?:.*&)?join=/.test(hash);

if (typeof location !== 'undefined' && isJoin(location.hash)) {
  pending = location.hash.slice(1);
  history.replaceState(history.state, '', location.pathname + location.search);
}

/** The join fragment the app was opened with, once. */
export function takePendingJoin(): string | null {
  const p = pending;
  pending = null;
  return p;
}

/** Calls `on` with join fragments that arrive while the app is open (a link opened in this tab). */
export function watchJoinLinks(on: (fragment: string) => void): () => void {
  const onHash = () => {
    if (!isJoin(location.hash)) return;
    const frag = location.hash.slice(1);
    history.replaceState(history.state, '', location.pathname + location.search);
    on(frag);
  };
  window.addEventListener('hashchange', onHash);
  return () => window.removeEventListener('hashchange', onHash);
}
